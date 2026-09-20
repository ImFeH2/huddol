from __future__ import annotations

import os
import signal
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING

from huddol.adapters.sandbox.commands import (
    linux_command,
    macos_command,
    windows_command,
)
from huddol.core.errors import DomainError

if TYPE_CHECKING:
    from huddol.adapters.sandbox.windows import WindowsWriteAccess


def entrypoint() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable]
    return [sys.executable, "-I", "-m", "huddol"]


def dispatch_helper(argv: list[str]) -> int | None:
    if argv and argv[0] == "--windows-write-sandbox" and os.name == "nt":
        from huddol.adapters.sandbox.windows import run_restricted_command

        separator = argv.index("--")
        return run_restricted_command(argv[1], argv[separator + 1 :], os.getcwd())
    return None


class ExecutionBackend:
    def __init__(self, enforce: bool) -> None:
        self._enforce = enforce
        self.name = sys.platform

    def wrap(
        self, argv: Sequence[str], cwd: Path, roots: tuple[Path, ...]
    ) -> list[str]:
        raise DomainError(
            "sandbox_unavailable",
            "Filesystem write protection is unavailable on this platform",
        )

    def spawn(
        self,
        argv: Sequence[str],
        cwd: Path,
        roots: tuple[Path, ...],
        *,
        piped_input: bool,
    ) -> subprocess.Popen[bytes]:
        command = (
            self.wrap(argv, cwd, tuple(root for root in roots if root.is_dir()))
            if self._enforce
            else list(argv)
        )
        return subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.PIPE if piped_input else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=os.name != "nt",
        )

    def terminate(self, process: subprocess.Popen[bytes]) -> None:
        if sys.platform != "win32":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()

    def close(self) -> None:
        pass


class LinuxBackend(ExecutionBackend):
    def wrap(
        self, argv: Sequence[str], cwd: Path, roots: tuple[Path, ...]
    ) -> list[str]:
        return linux_command(argv, cwd, roots)


class MacOSBackend(ExecutionBackend):
    def wrap(
        self, argv: Sequence[str], cwd: Path, roots: tuple[Path, ...]
    ) -> list[str]:
        return macos_command(argv, roots)


class WindowsBackend(ExecutionBackend):
    def __init__(self, enforce: bool) -> None:
        super().__init__(enforce)
        self._windows: dict[tuple[Path, ...], WindowsWriteAccess] = {}

    def wrap(
        self, argv: Sequence[str], cwd: Path, roots: tuple[Path, ...]
    ) -> list[str]:
        from huddol.adapters.sandbox.windows import WindowsWriteAccess

        if roots not in self._windows:
            self._windows[roots] = WindowsWriteAccess(roots)
        return windows_command(self._windows[roots].sid, argv, entrypoint())

    def close(self) -> None:
        for access in self._windows.values():
            access.close()
        self._windows.clear()


def create_backend(enforce: bool) -> ExecutionBackend:
    if sys.platform.startswith("linux"):
        return LinuxBackend(enforce)
    if sys.platform == "darwin":
        return MacOSBackend(enforce)
    if os.name == "nt":
        return WindowsBackend(enforce)
    return ExecutionBackend(enforce)
