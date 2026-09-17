from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from huddol.core.todo import Todo, TodoStatus


@dataclass(frozen=True)
class AgentRun:
    agent_id: int
    sequence: int
    run_id: str
    status: str
    started_at: str
    completed_at: str | None
    messages_json: str
    usage_json: str | None
    error: str | None


@dataclass(frozen=True)
class WindowState:
    number: int
    since_sequence: int
    reset_at: str | None
    reason: str | None


@dataclass(frozen=True)
class TurnEffect:
    sequence: int
    ordinal: int
    tool: str
    summary: str
    created_at: str


class TodoStore(Protocol):
    def list_todos(self, agent_id: int) -> tuple[Todo, ...]: ...

    def add_todo(self, agent_id: int, title: str, detail: str = "") -> Todo: ...

    def set_todo_status(
        self, agent_id: int, todo_id: int, status: TodoStatus
    ) -> Todo: ...

    def remove_todo(self, agent_id: int, todo_id: int) -> None: ...

    def clear_todos(self, agent_id: int) -> None: ...


class HistoryStore(Protocol):
    def window(self, agent_id: int) -> WindowState: ...

    def reset_window(self, agent_id: int, reason: str) -> WindowState: ...

    def start_run(
        self,
        agent_id: int,
        run_id: str | None = None,
        reminded: Sequence[tuple[int, int]] = (),
    ) -> AgentRun: ...

    def last_reminder(self, agent_id: int) -> frozenset[tuple[int, int]]: ...

    def previously_reminded(
        self, agent_id: int, keys: Sequence[tuple[int, int]]
    ) -> frozenset[int]: ...

    def save_progress(
        self, agent_id: int, sequence: int, messages_json: str
    ) -> None: ...

    def finish_run(
        self,
        agent_id: int,
        sequence: int,
        *,
        status: str,
        messages_json: str,
        usage_json: str | None = None,
        error: str | None = None,
    ) -> None: ...

    def latest_messages(self, agent_id: int) -> str: ...

    def runs(self, agent_id: int, *, limit: int = 50) -> tuple[AgentRun, ...]: ...

    def record_effect(
        self, agent_id: int, sequence: int, tool: str, summary: str
    ) -> None: ...

    def effects(
        self, agent_id: int, *, sequences: Sequence[int] = ()
    ) -> tuple[TurnEffect, ...]: ...

    def usage_total(self, agent_id: int) -> dict[str, int]: ...

    def mark_interrupted(self) -> int: ...

    def search_runs(
        self, agent_id: int, query: str, *, limit: int = 20
    ) -> tuple[AgentRun, ...]: ...


class SettingsStore(Protocol):
    def get_settings(self, section: str) -> dict[str, object] | None: ...

    def set_settings(self, section: str, values: dict[str, object]) -> None: ...
