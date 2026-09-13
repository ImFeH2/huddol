from __future__ import annotations

from huddol.core.todo import (
    Todo,
    snapshot,
    validate_detail,
    validate_start,
    validate_title,
)
from huddol.ports.agent import TodoStore


class Todos:
    def __init__(self, store: TodoStore, agent_id: int) -> None:
        self._store = store
        self._agent_id = agent_id

    def list(self) -> tuple[Todo, ...]:
        return self._store.list_todos(self._agent_id)

    def add(self, title: str, detail: str | None = None) -> Todo:
        return self._store.add_todo(
            self._agent_id, validate_title(title), validate_detail(detail)
        )

    def start(self, todo_id: int) -> Todo:
        validate_start(self.list(), todo_id)
        return self._store.set_todo_status(self._agent_id, todo_id, "in_progress")

    def complete(self, todo_id: int) -> Todo:
        return self._store.set_todo_status(self._agent_id, todo_id, "done")

    def remove(self, todo_id: int) -> None:
        self._store.remove_todo(self._agent_id, todo_id)

    def snapshot(self) -> str:
        return snapshot(self.list())
