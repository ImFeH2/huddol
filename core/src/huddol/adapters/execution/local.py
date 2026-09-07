from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from huddol.adapters.sandbox.windows import WindowsWriteAccess

from huddol.adapters.execution.bundle import component
from huddol.adapters.execution.editing import edit_file
from huddol.adapters.sandbox.commands import (
    linux_command,
    macos_command,
    windows_command,
)
from huddol.adapters.sandbox.paths import normalize_directories, normalize_tolerantly
from huddol.core.errors import DomainError
from huddol.ports.execution import EditResult, RunResult

MAX_OUTPUT = 200_000
DEFAULT_TIMEOUT = 120


def entrypoint() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-I", str(component())]


class LocalExecution:
    def __init__(
        self,
        root: Path | str,
        write_directories: Sequence[str] = (),
        *,
        enforce: bool = True,
        tolerant: bool = False,
    ) -> None:
        self._root = Path(root).resolve()
        self._enforce = enforce
        self._windows: WindowsWriteAccess | None = None
        self._lock = threading.RLock()
        self._processes: set[subprocess.Popen[bytes]] = set()
        self._closed = False
        self.skipped: tuple[tuple[str, str], ...] = ()
        if tolerant:
            result = normalize_tolerantly(write_directories)
            self._roots = result.accepted
            self.skipped = result.skipped
        else:
            self._roots = normalize_directories(write_directories)

    @property
    def root(self) -> str:
        return str(self._root)

    @property
    def write_directories(self) -> tuple[str, ...]:
        return tuple(str(item) for item in self._roots)

    def apply_configuration(self, candidate: LocalExecution) -> None:
        with self._lock:
            self._roots = candidate._roots
            self.skipped = candidate.skipped

    @staticmethod
    def _terminate(process: subprocess.Popen[bytes]) -> None:
        if sys.platform != "win32":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for process in self._processes:
                if process.poll() is None:
                    self._terminate(process)
            if self._windows is not None:
                self._windows.close()
                self._windows = None

    def describe_environment(self) -> str:
        listing = "\n".join(f"- {item}" for item in self.write_directories) or "- none"
        return (
            f"Commands and file editing run on {sys.platform}. Always give paths in absolute form. "
            f"Relative paths resolve against {self._root}, which is not a project directory and is not writable.\n"
            "You can read any path the host user can read.\n"
            f"Configured writable directories:\n{listing}"
        )

    def _wrap(self, argv: Sequence[str], cwd: Path) -> list[str]:
        if not self._enforce:
            return list(argv)
        existing = tuple(root for root in self._roots if root.is_dir())
        if sys.platform.startswith("linux"):
            return linux_command(argv, cwd, existing)
        if sys.platform == "darwin":
            return macos_command(argv, existing)
        if os.name == "nt":
            from huddol.adapters.sandbox.windows import WindowsWriteAccess

            if self._windows is None:
                self._windows = WindowsWriteAccess(existing)
            else:
                self._windows.configure(existing)
            return windows_command(self._windows.sid, argv, entrypoint())
        raise DomainError(
            "sandbox_unavailable",
            "Filesystem write protection is unavailable on this platform",
        )

    def _resolve_cwd(self, cwd: str | None) -> Path:
        candidate = Path(cwd) if cwd is not None else self._root
        target = candidate if candidate.is_absolute() else self._root / candidate
        resolved = target.resolve()
        if not resolved.is_dir():
            raise DomainError("invalid_cwd", f"{cwd or self.root} is not a directory")
        return resolved

    def _execute(
        self,
        argv: Sequence[str],
        cwd: str | None,
        timeout: int | None,
        data: bytes | None = None,
    ) -> tuple[int, bytes, bytes]:
        if not argv or not all(
            isinstance(item, str) and "\0" not in item for item in argv
        ):
            raise DomainError(
                "invalid_argv",
                "argv must be a non-empty list of strings without NUL characters",
            )
        if timeout is not None and (type(timeout) is not int or timeout <= 0):
            raise DomainError("invalid_timeout", "timeout must be a positive integer")
        directory = self._resolve_cwd(cwd)
        try:
            with self._lock:
                if self._closed:
                    raise DomainError(
                        "execution_closed", "Execution environment is closed"
                    )
                command = self._wrap(argv, directory)
                process = subprocess.Popen(
                    command,
                    cwd=directory,
                    stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=os.name != "nt",
                )
                self._processes.add(process)
        except FileNotFoundError as error:
            raise DomainError("command_not_found", str(error)) from error
        try:
            stdout, stderr = process.communicate(
                input=data, timeout=timeout or DEFAULT_TIMEOUT
            )
            return process.returncode, stdout, stderr
        except subprocess.TimeoutExpired as error:
            self._terminate(process)
            process.communicate()
            raise DomainError(
                "timeout", f"Command exceeded {timeout or DEFAULT_TIMEOUT} seconds"
            ) from error
        finally:
            with self._lock:
                self._processes.discard(process)

    def run(
        self, argv: Sequence[str], *, cwd: str | None = None, timeout: int | None = None
    ) -> RunResult:
        code, output, errors = self._execute(argv, cwd, timeout)
        stdout, stderr = (
            output.decode("utf-8", "replace"),
            errors.decode("utf-8", "replace"),
        )
        return RunResult(
            code,
            stdout[:MAX_OUTPUT],
            stderr[:MAX_OUTPUT],
            len(stdout) > MAX_OUTPUT or len(stderr) > MAX_OUTPUT,
        )

    def edit(
        self, path: str, old_text: str, new_text: str, *, replace_all: bool = False
    ) -> EditResult:
        if not self._enforce:
            return edit_file(
                path,
                old_text,
                new_text,
                root=self.root,
                directories=list(self.write_directories),
                replace_all=replace_all,
            )
        values = {
            "path": path,
            "old_text": old_text,
            "new_text": new_text,
            "root": self.root,
            "directories": list(self.write_directories),
            "replace_all": replace_all,
        }
        code, output, errors = self._execute(
            [*entrypoint(), "--execution-edit"],
            None,
            None,
            json.dumps(values, ensure_ascii=False).encode("utf-8"),
        )
        if code != 0:
            raise DomainError(
                "edit_failed",
                errors.decode("utf-8", "replace")[:2000] or "File editor failed",
            )
        from huddol.adapters.execution.worker import result_value

        return EditResult(**result_value(output))
