from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from huddol.core.errors import DomainError

TodoStatus = Literal["pending", "in_progress", "done"]
MAX_TITLE_LENGTH = 200
MAX_DETAIL_LENGTH = 4000


@dataclass(frozen=True)
class Todo:
    id: int
    title: str
    status: TodoStatus
    detail: str = ""


def validate_title(value: object) -> str:
    if not isinstance(value, str):
        raise DomainError("invalid_title", "Todo title must be a string")
    title = " ".join(value.split())
    if not title:
        raise DomainError("invalid_title", "Todo title must not be empty")
    if len(title) > MAX_TITLE_LENGTH:
        raise DomainError(
            "invalid_title", f"Todo title must be at most {MAX_TITLE_LENGTH} characters"
        )
    return title


def validate_detail(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise DomainError("invalid_detail", "Todo detail must be a string")
    if len(value) > MAX_DETAIL_LENGTH:
        raise DomainError(
            "invalid_detail",
            f"Todo detail must be at most {MAX_DETAIL_LENGTH} characters",
        )
    return value.strip()


def in_progress(todos: Sequence[Todo]) -> Todo | None:
    for todo in todos:
        if todo.status == "in_progress":
            return todo
    return None


def validate_start(todos: Sequence[Todo], todo_id: int) -> None:
    current = in_progress(todos)
    if current is not None and current.id != todo_id:
        raise DomainError(
            "todo_already_in_progress",
            f"Todo {current.id} is already in progress; complete it first",
        )


def snapshot(todos: Sequence[Todo]) -> str:
    lines = []
    for todo in todos:
        if todo.status == "done":
            continue
        lines.append(
            f"- [{'>' if todo.status == 'in_progress' else ' '}] {todo.id}. {todo.title}"
        )
        if todo.detail:
            lines.extend(f"  {line}" for line in todo.detail.splitlines())
    return "Todos:\n" + "\n".join(lines) if lines else "Todos: none"
