from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Sequence

from huddol.adapters.sqlite.store import LockedConnection, first
from huddol.core.errors import DomainError
from huddol.core.todo import Todo, TodoStatus
from huddol.ports.agent import AgentRun, TurnEffect, WindowState

SCHEMA = """
CREATE TABLE IF NOT EXISTS agent_windows (
    agent_id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL,
    since_sequence INTEGER NOT NULL,
    reset_at TEXT,
    reason TEXT
);
CREATE TABLE IF NOT EXISTS agent_todos (
    agent_id INTEGER NOT NULL,
    id INTEGER NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, id)
);
CREATE TABLE IF NOT EXISTS settings (
    section TEXT PRIMARY KEY,
    values_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminded (
    agent_id INTEGER NOT NULL,
    discussion_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    first_reminded_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, discussion_id, message_id)
);
CREATE TABLE IF NOT EXISTS run_effects (
    agent_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    tool TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, sequence, ordinal)
);
"""


class SqliteAgentStore:
    def __init__(self, db: LockedConnection) -> None:
        self._db = db
        self._db.executescript(SCHEMA)
        self._db.commit()

    def _now(self) -> str:
        from huddol.adapters.sqlite.store import now

        return now()

    def list_todos(self, agent_id: int) -> tuple[Todo, ...]:
        rows = self._db.execute(
            "SELECT id, title, status, detail FROM agent_todos WHERE agent_id = ?"
            " ORDER BY id",
            (agent_id,),
        )
        return tuple(
            Todo(
                int(row["id"]),
                str(row["title"]),
                str(row["status"]),  # type: ignore[arg-type]
                str(row["detail"]),
            )
            for row in rows
        )

    def add_todo(self, agent_id: int, title: str, detail: str = "") -> Todo:
        row = first(
            self._db.execute(
                "SELECT COALESCE(MAX(id), 0) + 1 AS v FROM agent_todos WHERE agent_id = ?",
                (agent_id,),
            )
        )
        assert row is not None
        todo_id = int(row["v"])
        with self._db:
            self._db.execute(
                "INSERT INTO agent_todos (agent_id, id, title, detail, status,"
                " created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
                (agent_id, todo_id, title, detail, self._now()),
            )
        return Todo(todo_id, title, "pending", detail)

    def set_todo_status(self, agent_id: int, todo_id: int, status: TodoStatus) -> Todo:
        with self._db:
            cursor = self._db.execute_cursor(
                "UPDATE agent_todos SET status = ? WHERE agent_id = ? AND id = ?",
                (status, agent_id, todo_id),
            )
        if cursor.rowcount == 0:
            raise DomainError("not_found", f"Todo {todo_id} does not exist")
        row = first(
            self._db.execute(
                "SELECT id, title, status, detail FROM agent_todos WHERE agent_id = ?"
                " AND id = ?",
                (agent_id, todo_id),
            )
        )
        assert row is not None
        return Todo(
            int(row["id"]),
            str(row["title"]),
            str(row["status"]),  # type: ignore[arg-type]
            str(row["detail"]),
        )

    def remove_todo(self, agent_id: int, todo_id: int) -> None:
        with self._db:
            cursor = self._db.execute_cursor(
                "DELETE FROM agent_todos WHERE agent_id = ? AND id = ?",
                (agent_id, todo_id),
            )
        if cursor.rowcount == 0:
            raise DomainError("not_found", f"Todo {todo_id} does not exist")

    def clear_todos(self, agent_id: int) -> None:
        with self._db:
            self._db.execute("DELETE FROM agent_todos WHERE agent_id = ?", (agent_id,))

    def _run(self, row: sqlite3.Row) -> AgentRun:
        return AgentRun(
            agent_id=int(row["agent_id"]),
            sequence=int(row["sequence"]),
            run_id=str(row["run_id"]),
            status=str(row["status"]),
            started_at=str(row["started_at"]),
            completed_at=row["completed_at"],
            messages_json=str(row["messages_json"]),
            usage_json=row["usage_json"],
            error=row["error"],
        )

    def previously_reminded(
        self, agent_id: int, keys: Sequence[tuple[int, int]]
    ) -> frozenset[int]:
        if not keys:
            return frozenset()
        found: set[int] = set()
        for discussion_id, message_id in keys:
            row = first(
                self._db.execute(
                    "SELECT 1 FROM reminded WHERE agent_id = ? AND discussion_id = ?"
                    " AND message_id = ?",
                    (agent_id, discussion_id, message_id),
                )
            )
            if row is not None:
                found.add(message_id)
        return frozenset(found)

    def start_run(
        self,
        agent_id: int,
        run_id: str | None = None,
        reminded: Sequence[tuple[int, int]] = (),
    ) -> AgentRun:
        row = first(
            self._db.execute(
                "SELECT COALESCE(MAX(sequence), 0) + 1 AS v FROM agent_runs WHERE agent_id = ?",
                (agent_id,),
            )
        )
        assert row is not None
        sequence = int(row["v"])
        identifier = run_id or uuid.uuid4().hex
        started = self._now()
        with self._db:
            self._db.execute(
                "INSERT INTO agent_runs (agent_id, sequence, run_id, status, started_at,"
                " messages_json) VALUES (?, ?, ?, 'running', ?, '[]')",
                (agent_id, sequence, identifier, started),
            )
            self._db.executemany(
                "INSERT OR IGNORE INTO reminded (agent_id, discussion_id, message_id,"
                " first_reminded_at) VALUES (?, ?, ?, ?)",
                [
                    (agent_id, discussion_id, message_id, started)
                    for discussion_id, message_id in reminded
                ],
            )
        return AgentRun(
            agent_id, sequence, identifier, "running", started, None, "[]", None, None
        )

    def finish_run(
        self,
        agent_id: int,
        sequence: int,
        *,
        status: str,
        messages_json: str,
        usage_json: str | None = None,
        error: str | None = None,
    ) -> None:
        with self._db:
            self._db.execute(
                "UPDATE agent_runs SET status = ?, completed_at = ?, messages_json = ?,"
                " usage_json = ?, error = ? WHERE agent_id = ? AND sequence = ?",
                (
                    status,
                    self._now(),
                    messages_json,
                    usage_json,
                    error,
                    agent_id,
                    sequence,
                ),
            )

    def window(self, agent_id: int) -> WindowState:
        row = first(
            self._db.execute(
                "SELECT number, since_sequence, reset_at, reason FROM agent_windows"
                " WHERE agent_id = ?",
                (agent_id,),
            )
        )
        if row is None:
            return WindowState(1, 1, None, None)
        return WindowState(
            int(row["number"]),
            int(row["since_sequence"]),
            row["reset_at"],
            row["reason"],
        )

    def reset_window(self, agent_id: int, reason: str) -> WindowState:
        with self._db:
            self._db.execute(
                "INSERT INTO agent_windows (agent_id, number, since_sequence, reset_at, reason)"
                " VALUES (?, 2, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM agent_runs"
                " WHERE agent_id = ?), ?, ?) ON CONFLICT (agent_id) DO UPDATE SET"
                " number = agent_windows.number + 1, since_sequence = excluded.since_sequence,"
                " reset_at = excluded.reset_at, reason = excluded.reason",
                (agent_id, agent_id, self._now(), reason),
            )
            return self.window(agent_id)

    def latest_messages(self, agent_id: int) -> str:
        row = first(
            self._db.execute(
                "SELECT messages_json FROM agent_runs WHERE agent_id = ?"
                " AND sequence >= COALESCE((SELECT since_sequence FROM agent_windows"
                " WHERE agent_id = ?), 1)"
                " AND messages_json NOT IN ('[]', '') ORDER BY sequence DESC LIMIT 1",
                (agent_id, agent_id),
            )
        )
        return str(row["messages_json"]) if row else "[]"

    def runs(self, agent_id: int, *, limit: int = 50) -> tuple[AgentRun, ...]:
        rows = self._db.execute(
            "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY sequence DESC LIMIT ?",
            (agent_id, limit),
        )
        return tuple(self._run(row) for row in rows)

    def record_effect(
        self, agent_id: int, sequence: int, tool: str, summary: str
    ) -> None:
        with self._db:
            row = first(
                self._db.execute(
                    "SELECT COALESCE(MAX(ordinal), 0) AS last FROM run_effects"
                    " WHERE agent_id = ? AND sequence = ?",
                    (agent_id, sequence),
                )
            )
            ordinal = (int(row["last"]) if row is not None else 0) + 1
            self._db.execute(
                "INSERT INTO run_effects (agent_id, sequence, ordinal, tool, summary,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (agent_id, sequence, ordinal, tool, summary, self._now()),
            )

    def effects(
        self, agent_id: int, *, sequences: Sequence[int] = ()
    ) -> tuple[TurnEffect, ...]:
        if sequences:
            placeholders = ",".join("?" for _ in sequences)
            rows = self._db.execute(
                "SELECT sequence, ordinal, tool, summary, created_at FROM run_effects"
                f" WHERE agent_id = ? AND sequence IN ({placeholders})"
                " ORDER BY sequence DESC, ordinal",
                (agent_id, *sequences),
            )
        else:
            rows = self._db.execute(
                "SELECT sequence, ordinal, tool, summary, created_at FROM run_effects"
                " WHERE agent_id = ? ORDER BY sequence DESC, ordinal",
                (agent_id,),
            )
        return tuple(
            TurnEffect(
                int(row["sequence"]),
                int(row["ordinal"]),
                str(row["tool"]),
                str(row["summary"]),
                str(row["created_at"]),
            )
            for row in rows
        )

    def usage_total(self, agent_id: int) -> dict[str, int]:
        row = first(
            self._db.execute(
                "SELECT"
                " COALESCE(SUM(json_extract(usage_json, '$.input_tokens')), 0) AS input,"
                " COALESCE(SUM(json_extract(usage_json, '$.output_tokens')), 0) AS output,"
                " COALESCE(SUM(json_extract(usage_json, '$.cache_read_tokens')), 0) AS cached,"
                " COALESCE(SUM(json_extract(usage_json, '$.requests')), 0) AS requests"
                " FROM agent_runs WHERE agent_id = ? AND usage_json IS NOT NULL",
                (agent_id,),
            )
        )
        if row is None:
            return {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "requests": 0,
                "total_tokens": 0,
            }
        stored = {
            "input_tokens": int(row["input"]),
            "output_tokens": int(row["output"]),
            "cache_read_tokens": int(row["cached"]),
            "requests": int(row["requests"]),
        }
        stored["total_tokens"] = stored["input_tokens"] + stored["output_tokens"]
        return stored

    def mark_interrupted(self) -> int:
        with self._db:
            cursor = self._db.execute_cursor(
                "UPDATE agent_runs SET status = 'interrupted', completed_at = ?"
                " WHERE status = 'running'",
                (self._now(),),
            )
        return cursor.rowcount

    def search_runs(
        self, agent_id: int, query: str, *, limit: int = 20
    ) -> tuple[AgentRun, ...]:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self._db.execute(
            "SELECT * FROM agent_runs WHERE agent_id = ? AND messages_json LIKE ?"
            " ESCAPE '\\' ORDER BY sequence DESC LIMIT ?",
            (agent_id, f"%{escaped}%", limit),
        )
        return tuple(self._run(row) for row in rows)

    def get_settings(self, section: str) -> dict[str, object] | None:
        row = first(
            self._db.execute(
                "SELECT values_json FROM settings WHERE section = ?", (section,)
            )
        )
        if row is None:
            return None
        loaded = json.loads(str(row["values_json"]))
        return loaded if isinstance(loaded, dict) else None

    def set_settings(self, section: str, values: dict[str, object]) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO settings (section, values_json) VALUES (?, ?)"
                " ON CONFLICT (section) DO UPDATE SET values_json = excluded.values_json",
                (section, json.dumps(values, ensure_ascii=False, sort_keys=True)),
            )
