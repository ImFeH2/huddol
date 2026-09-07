from __future__ import annotations

import os
import threading
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from huddol.adapters.execution.local import LocalExecution
from huddol.adapters.execution.wsl import WslConnection, distributions
from huddol.core.errors import DomainError
from huddol.ports.execution import EditResult, ExecutionEnvironment, RunResult


def target_value(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise DomainError("invalid_environment", "Choose an execution environment")
    if value == {"kind": "native"}:
        return {"kind": "native"}
    distribution = value.get("distribution")
    if (
        value.get("kind") == "wsl"
        and isinstance(distribution, str)
        and distribution.strip()
        and not any(char in distribution for char in "\0\n\r")
        and set(value) == {"kind", "distribution"}
    ):
        return {"kind": "wsl", "distribution": distribution}
    raise DomainError("invalid_environment", "Choose Native or a WSL distribution")


class BoundExecution:
    def __init__(self, lookup: Callable[[], ExecutionEnvironment]) -> None:
        self._lookup = lookup

    @property
    def root(self) -> str:
        return self._lookup().root

    @property
    def skipped(self) -> tuple[tuple[str, str], ...]:
        return self._lookup().skipped

    @property
    def write_directories(self) -> tuple[str, ...]:
        return self._lookup().write_directories

    def describe_environment(self) -> str:
        return self._lookup().describe_environment()

    def run(
        self, argv: Sequence[str], *, cwd: str | None = None, timeout: int | None = None
    ) -> RunResult:
        return self._lookup().run(argv, cwd=cwd, timeout=timeout)

    def edit(
        self, path: str, old_text: str, new_text: str, *, replace_all: bool = False
    ) -> EditResult:
        return self._lookup().edit(path, old_text, new_text, replace_all=replace_all)


class ExecutionManager:
    def __init__(
        self,
        root: Path,
        directories: Sequence[str] = (),
        *,
        environment: object = None,
        enforce: bool = True,
        tolerant: bool = False,
    ) -> None:
        self._root = root
        self._enforce = enforce
        self._lock = threading.RLock()
        self._closed = False
        self._environments: dict[tuple[str, str], LocalExecution | WslConnection] = {}
        self._target: dict[str, str] = {"kind": "invalid"}
        self._directories = list(directories)
        self._error: str | None = None
        try:
            target = target_value(
                {"kind": "native"} if environment is None else environment
            )
            self._target = target
            instance = self._create(target, directories, tolerant=tolerant)
            self._environments[self._key(target)] = instance
        except DomainError as error:
            self._error = str(error)

    @staticmethod
    def _key(target: dict[str, str]) -> tuple[str, str]:
        return target["kind"], target.get("distribution", "")

    def _create(
        self,
        target: dict[str, str],
        directories: Sequence[str],
        *,
        tolerant: bool = False,
    ) -> LocalExecution | WslConnection:
        if target["kind"] == "native":
            instance: LocalExecution | WslConnection = LocalExecution(
                self._root, directories, enforce=self._enforce, tolerant=tolerant
            )
        else:
            if os.name != "nt":
                raise DomainError("wsl_unavailable", "WSL execution requires Windows")
            connection = WslConnection(
                target["distribution"], self._root, directories, tolerant=tolerant
            )
            try:
                connection.inspect()
            except Exception:
                connection.close()
                raise
            instance = connection
        return instance

    def snapshot(self) -> ExecutionEnvironment:
        key = self._key(self._target)

        def lookup() -> ExecutionEnvironment:
            with self._lock:
                if self._closed:
                    raise DomainError(
                        "execution_closed", "Execution environment is closed"
                    )
                if key not in self._environments:
                    raise DomainError(
                        "execution_unavailable",
                        self._error or "Execution environment is unavailable",
                    )
                return self._environments[key]

        return BoundExecution(lookup)

    def status(self) -> dict[str, Any]:
        names: list[str] = []
        probe_error = None
        if os.name == "nt":
            try:
                names = distributions()
            except DomainError as error:
                probe_error = str(error)
        with self._lock:
            selected = self._environments.get(self._key(self._target))
            return {
                "environment": self._target,
                "write_directories": list(self._directories),
                "working_directory": selected.root if selected else None,
                "unusable_write_directories": [
                    {"path": path, "reason": reason}
                    for path, reason in selected.skipped
                ]
                if selected
                else [],
                "error": self._error,
                "distributions": names,
                "probe_error": probe_error,
            }

    def configure(
        self, values: dict[str, Any], persist: Callable[[dict[str, object]], None]
    ) -> dict[str, Any]:
        if set(values) - {"environment", "write_directories"}:
            raise DomainError("invalid_setting", "Unknown execution setting")
        with self._lock:
            if self._closed:
                raise DomainError("execution_closed", "Execution environment is closed")
            target = target_value(values.get("environment", self._target))
            directories = values.get("write_directories", self._directories)
            if not isinstance(directories, list) or not all(
                isinstance(item, str) for item in directories
            ):
                raise DomainError(
                    "invalid_directory", "Writable directories must be a list of paths"
                )
            candidate = self._create(target, directories)
            configured: dict[str, object] = {
                "environment": target,
                "write_directories": list(candidate.write_directories),
            }
            try:
                persist(configured)
            except Exception:
                candidate.close()
                raise
            key = self._key(target)
            existing = self._environments.get(key)
            if existing is None:
                self._environments[key] = candidate
            else:
                if isinstance(existing, LocalExecution):
                    assert isinstance(candidate, LocalExecution)
                    existing.apply_configuration(candidate)
                else:
                    assert isinstance(candidate, WslConnection)
                    existing.apply_configuration(candidate)
                candidate.close()
            self._target = target
            self._directories = list(candidate.write_directories)
            self._error = None
        return self.status()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for instance in self._environments.values():
                instance.close()
