from __future__ import annotations

import os
import threading
from collections.abc import Callable, Sequence
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


def environment_key(target: dict[str, str]) -> str:
    if target["kind"] == "native":
        return "native"
    return f"wsl:{target['distribution']}"


def directory_map(value: object) -> dict[str, list[str]]:
    if not isinstance(value, dict):
        return {}
    return {
        key: list(items)
        for key, items in value.items()
        if isinstance(key, str)
        and isinstance(items, list)
        and all(isinstance(item, str) for item in items)
    }


class BoundExecution:
    def __init__(self, lookup: Callable[[], ExecutionEnvironment]) -> None:
        self._lookup = lookup

    @property
    def skipped(self) -> tuple[tuple[str, str], ...]:
        return self._lookup().skipped

    @property
    def write_directories(self) -> tuple[str, ...]:
        return self._lookup().write_directories

    def describe_environment(self) -> str:
        return self._lookup().describe_environment()

    def run(
        self, argv: Sequence[str], *, cwd: str, timeout: int | None = None
    ) -> RunResult:
        return self._lookup().run(argv, cwd=cwd, timeout=timeout)

    def edit(
        self, path: str, old_text: str, new_text: str, *, replace_all: bool = False
    ) -> EditResult:
        return self._lookup().edit(path, old_text, new_text, replace_all=replace_all)


class ExecutionManager:
    def __init__(
        self,
        *,
        settings: dict[str, object] | None = None,
        enforce: bool = True,
        tolerant: bool = False,
    ) -> None:
        self._enforce = enforce
        self._lock = threading.RLock()
        self._closed = False
        self._environments: dict[str, LocalExecution | WslConnection] = {}
        self._target: dict[str, str] = {"kind": "invalid"}
        self._key: str | None = None
        stored = settings or {}
        self._directories = directory_map(stored.get("directories"))
        self._error: str | None = None
        try:
            environment = stored.get("environment")
            target = target_value(
                {"kind": "native"} if environment is None else environment
            )
            key = environment_key(target)
            instance = self._create(
                target, self._directories.get(key, []), tolerant=tolerant
            )
            self._target = target
            self._key = key
            self._environments[key] = instance
        except DomainError as error:
            self._error = str(error)

    def _create(
        self,
        target: dict[str, str],
        directories: Sequence[str],
        *,
        tolerant: bool = False,
    ) -> LocalExecution | WslConnection:
        if target["kind"] == "native":
            instance: LocalExecution | WslConnection = LocalExecution(
                directories, enforce=self._enforce, tolerant=tolerant
            )
        else:
            if os.name != "nt":
                raise DomainError("wsl_unavailable", "WSL execution requires Windows")
            connection = WslConnection(
                target["distribution"], directories, tolerant=tolerant
            )
            try:
                connection.inspect()
            except Exception:
                connection.close()
                raise
            instance = connection
        return instance

    def snapshot(self) -> ExecutionEnvironment:
        def lookup() -> ExecutionEnvironment:
            with self._lock:
                key = self._key
                if self._closed:
                    raise DomainError(
                        "execution_closed", "Execution environment is closed"
                    )
                if key is None or key not in self._environments:
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
            key = self._key
            selected = self._environments.get(key) if key is not None else None
            return {
                "environment": self._target,
                "write_directories": list(self._directories.get(key, []))
                if key is not None
                else [],
                "directories": {
                    name: list(items) for name, items in self._directories.items()
                },
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
            key = environment_key(target)
            directories = values.get(
                "write_directories", self._directories.get(key, [])
            )
            if not isinstance(directories, list) or not all(
                isinstance(item, str) for item in directories
            ):
                raise DomainError(
                    "invalid_directory", "Writable directories must be a list of paths"
                )
            candidate = self._create(target, directories)
            stored = {**self._directories, key: list(candidate.write_directories)}
            configured: dict[str, object] = {
                "environment": target,
                "directories": {name: list(items) for name, items in stored.items()},
            }
            try:
                persist(configured)
            except Exception:
                candidate.close()
                raise
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
            self._key = key
            self._directories = stored
            self._error = None
        return self.status()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for instance in self._environments.values():
                instance.close()
