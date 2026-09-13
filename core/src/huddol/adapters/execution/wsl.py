from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import IO, Any

from huddol.adapters.execution.worker import result_value
from huddol.core.errors import DomainError
from huddol.ports.execution import EditResult, RunResult

COMPONENT_SOURCES = (
    "__main__.py",
    "huddol/__init__.py",
    "huddol/core/__init__.py",
    "huddol/core/errors.py",
    "huddol/ports/__init__.py",
    "huddol/ports/execution.py",
    "huddol/adapters/__init__.py",
    "huddol/adapters/sandbox/__init__.py",
    "huddol/adapters/sandbox/paths.py",
    "huddol/adapters/sandbox/commands.py",
    "huddol/adapters/execution/__init__.py",
    "huddol/adapters/execution/editing.py",
    "huddol/adapters/execution/local.py",
    "huddol/adapters/execution/worker.py",
)


def component() -> Path:
    if getattr(sys, "frozen", False):
        return Path(vars(sys)["_MEIPASS"]) / "execution"
    return Path(__file__).resolve().parents[3]


def wsl_output(arguments: Sequence[str]) -> bytes:
    if os.name != "nt":
        raise DomainError("wsl_unavailable", "WSL execution requires Windows")
    try:
        result = subprocess.run(
            ["wsl.exe", *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=10,
            creationflags=0x08000000,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DomainError(
            "wsl_unavailable", "WSL is unavailable or did not respond"
        ) from error
    if result.returncode:
        raise DomainError("wsl_unavailable", "WSL command failed")
    return result.stdout


def distributions() -> list[str]:
    output = wsl_output(["--list", "--quiet"])
    try:
        text = output.decode("utf-16-le" if b"\0" in output else "utf-8")
    except UnicodeError as error:
        raise DomainError(
            "wsl_unavailable", "Cannot read WSL distribution names"
        ) from error
    return [
        line.strip().lstrip("\ufeff")
        for line in text.splitlines()
        if line.strip().lstrip("\ufeff")
    ]


class WslConnection:
    def __init__(
        self,
        distribution: str,
        directories: Sequence[str],
        *,
        tolerant: bool = False,
    ) -> None:
        self.distribution = distribution
        self._roots = tuple(directories)
        self._configured_directories = tuple(directories)
        self.skipped: tuple[tuple[str, str], ...] = ()
        self._tolerant = tolerant
        self._worker: list[str] | None = None
        self._lock = threading.Lock()
        self._processes: dict[subprocess.Popen[bytes], IO[bytes]] = {}
        self._sending: set[subprocess.Popen[bytes]] = set()
        self._closed = False

    def _command(self) -> list[str]:
        with self._lock:
            if self._worker is not None:
                return self._worker
        directory = component()
        if not (directory / "__main__.py").is_file():
            raise DomainError("execution_unavailable", "Execution component is missing")
        translated = (
            wsl_output(
                ["-d", self.distribution, "--exec", "wslpath", "-u", str(directory)]
            )
            .decode("utf-8")
            .strip()
        )
        if not translated.startswith("/"):
            raise DomainError(
                "execution_unavailable",
                "Cannot locate the execution component in WSL",
            )
        worker = [
            "wsl.exe",
            "-d",
            self.distribution,
            "--exec",
            "python3",
            "-I",
            translated,
        ]
        with self._lock:
            self._worker = worker
        return worker

    def _request(
        self,
        operation: str,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        command = self._command()
        payload = {
            "operation": operation,
            "directories": list(
                self._configured_directories if operation == "inspect" else self._roots
            ),
            "tolerant": self._tolerant if operation == "inspect" else False,
            "params": params or {},
        }
        timeout = (params or {}).get("timeout")
        deadline = (
            20
            if operation == "inspect"
            else (timeout + 15 if type(timeout) is int and timeout > 0 else 135)
        )
        pipe = None
        process = None
        sender: threading.Thread | None = None
        write_errors: list[Exception] = []
        try:
            with self._lock:
                if self._closed:
                    raise DomainError(
                        "execution_closed", "Execution environment is closed"
                    )
                process = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    bufsize=0,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    creationflags=0x08000000 if os.name == "nt" else 0,
                )
                pipe = process.stdin
                assert pipe is not None
                process.stdin = None
                self._processes[process] = pipe
                self._sending.add(process)
            encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"

            def send() -> None:
                assert pipe is not None
                try:
                    offset = 0
                    while offset < len(encoded):
                        written = pipe.write(encoded[offset:])
                        if not written:
                            raise BrokenPipeError("Execution input was closed")
                        offset += written
                except (OSError, ValueError) as error:
                    write_errors.append(error)
                finally:
                    with self._lock:
                        self._sending.discard(process)

            sender = threading.Thread(target=send, daemon=True)
            sender.start()
            output, _ = process.communicate(timeout=deadline)
            if write_errors:
                raise DomainError(
                    "execution_unavailable", "The WSL execution connection failed"
                ) from write_errors[0]
            if process.returncode:
                raise DomainError(
                    "execution_unavailable",
                    "WSL execution failed. Python 3.10 or newer and bubblewrap are required.",
                )
            return result_value(output)
        except subprocess.TimeoutExpired as error:
            raise DomainError(
                "execution_timeout", "The WSL execution connection did not respond"
            ) from error
        except OSError as error:
            raise DomainError(
                "execution_unavailable", "The WSL execution connection failed"
            ) from error
        finally:
            if process is not None and sender is not None and sender.is_alive():
                process.kill()
                sender.join(timeout=5)
            if pipe is not None:
                pipe.close()
            if process is not None:
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                if sender is not None:
                    sender.join(timeout=5)
                with self._lock:
                    self._processes.pop(process, None)

    def inspect(self) -> None:
        info = self._request("inspect")
        self._roots = tuple(info["write_directories"])
        self.skipped = tuple(tuple(item) for item in info["skipped"])

    @property
    def write_directories(self) -> tuple[str, ...]:
        return self._roots

    def apply_configuration(self, candidate: WslConnection) -> None:
        self._roots = candidate._roots
        self._configured_directories = candidate._configured_directories
        self.skipped = candidate.skipped
        self._tolerant = candidate._tolerant

    def describe_environment(self) -> str:
        listing = "\n".join(f"- {item}" for item in self.write_directories) or "- none"
        return (
            f"Execution environment: WSL ({self.distribution})\n"
            f"Writable directories:\n{listing}"
        )

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str | None = None,
        timeout: int | None = None,
        write_directories: Sequence[str] | None = None,
    ) -> RunResult:
        params: dict[str, Any] = {"argv": list(argv), "cwd": cwd, "timeout": timeout}
        if write_directories is not None:
            params["write_directories"] = list(write_directories)
        return RunResult(**self._request("run", params))

    def edit(
        self, path: str, old_text: str, new_text: str, *, replace_all: bool = False
    ) -> EditResult:
        return EditResult(
            **self._request(
                "edit",
                {
                    "path": path,
                    "old_text": old_text,
                    "new_text": new_text,
                    "replace_all": replace_all,
                },
            )
        )

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for process, pipe in self._processes.items():
                if process in self._sending and process.poll() is None:
                    process.kill()
                pipe.close()
