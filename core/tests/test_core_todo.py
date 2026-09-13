from __future__ import annotations

import pytest

from huddol.core.todo import Todo, snapshot


@pytest.mark.parametrize("todos", [[], [Todo(1, "done", "done", "hidden")]])
def test_snapshot_has_no_open_items(todos) -> None:
    assert snapshot(todos) == "Todos: none"


def test_snapshot_preserves_order_and_indents_every_detail_line() -> None:
    assert snapshot(
        [
            Todo(3, "active", "in_progress", "first\n\nlast"),
            Todo(4, "finished", "done", "hidden"),
            Todo(5, "waiting", "pending", "next"),
            Todo(6, "empty detail", "pending"),
        ]
    ) == (
        "Todos:\n- [>] 3. active\n  first\n  \n  last"
        "\n- [ ] 5. waiting\n  next\n- [ ] 6. empty detail"
    )
