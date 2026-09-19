from __future__ import annotations

import threading
from collections.abc import Callable, Sequence
from typing import Any

from huddol.adapters.execution.local import LocalExecution
from huddol.core.errors import DomainError
from huddol.ports.execution import EditResult, ExecutionEnvironment, RunResult

NATIVE = "native"


def target_value(value: object) -> dict[str, str]:
    if not isinstance(value, dict):
        raise DomainError("invalid_environment", "Choose an execution environment")
    if value == {"kind": NATIVE}:
        return {"kind": NATIVE}
    raise DomainError(
        "invalid_environment", "The native execution environment is the only choice"
    )


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

    def describe_environment(self, labeled: Sequence[tuple[str, str]] = ()) -> str:
        return self._lookup().describe_environment(labeled)

    def run(
        self,
        argv: Sequence[str],
        *,
        cwd: str,
        timeout: int | None = None,
        write_directories: Sequence[str] | None = None,
    ) -> RunResult:
        return self._lookup().run(
            argv, cwd=cwd, timeout=timeout, write_directories=write_directories
        )

    def edit(
        self,
        path: str,
        old_text: str,
        new_text: str,
        *,
        replace_all: bool = False,
        write_directories: Sequence[str] | None = None,
    ) -> EditResult:
        return self._lookup().edit(
            path,
            old_text,
            new_text,
            replace_all=replace_all,
            write_directories=write_directories,
        )


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
        self._environment: LocalExecution | None = None
        self._target: dict[str, str] = {"kind": "invalid"}
        stored = settings or {}
        self._directories = directory_map(stored.get("directories"))
        self._error: str | None = None
        try:
            environment = stored.get("environment")
            self._target = target_value(
                {"kind": NATIVE} if environment is None else environment
            )
            self._environment = LocalExecution(
                self._directories.get(NATIVE, []),
                enforce=self._enforce,
                tolerant=tolerant,
            )
        except DomainError as error:
            self._error = str(error)

    def snapshot(self) -> ExecutionEnvironment:
        def lookup() -> ExecutionEnvironment:
            with self._lock:
                if self._closed:
                    raise DomainError(
                        "execution_closed", "Execution environment is closed"
                    )
                if self._environment is None:
                    raise DomainError(
                        "execution_unavailable",
                        self._error or "Execution environment is unavailable",
                    )
                return self._environment

        return BoundExecution(lookup)

    def status(self) -> dict[str, Any]:
        with self._lock:
            skipped = self._environment.skipped if self._environment else ()
            return {
                "environment": self._target,
                "write_directories": list(self._directories.get(NATIVE, [])),
                "directories": {
                    name: list(items) for name, items in self._directories.items()
                },
                "unusable_write_directories": [
                    {"path": path, "reason": reason} for path, reason in skipped
                ],
                "error": self._error,
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
            directories = values.get(
                "write_directories", self._directories.get(NATIVE, [])
            )
            if not isinstance(directories, list) or not all(
                isinstance(item, str) for item in directories
            ):
                raise DomainError(
                    "invalid_directory", "Writable directories must be a list of paths"
                )
            candidate = LocalExecution(directories, enforce=self._enforce)
            stored = {**self._directories, NATIVE: list(candidate.write_directories)}
            configured: dict[str, object] = {
                "environment": target,
                "directories": {name: list(items) for name, items in stored.items()},
            }
            try:
                persist(configured)
            except Exception:
                candidate.close()
                raise
            if self._environment is None:
                self._environment = candidate
            else:
                self._environment.apply_configuration(candidate)
                candidate.close()
            self._target = target
            self._directories = stored
            self._error = None
        return self.status()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            if self._environment is not None:
                self._environment.close()
