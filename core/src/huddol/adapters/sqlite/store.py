from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from types import TracebackType
from typing import Any, Self

from huddol.core.discussion import Discussion, Message, MessageMention
from huddol.core.errors import DomainError
from huddol.core.member import AgentState, Member, MemberType, name_key
from huddol.core.mention import Mention, build_mentions

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    deleted INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'idle'
);
CREATE TABLE IF NOT EXISTS discussions (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS discussion_sequence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_id INTEGER NOT NULL
);
INSERT INTO discussion_sequence (id, last_id)
VALUES (1, (SELECT COALESCE(MAX(id), 0) FROM discussions))
ON CONFLICT (id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id);
CREATE TABLE IF NOT EXISTS discussion_members (
    discussion_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    PRIMARY KEY (discussion_id, member_id)
);
CREATE TABLE IF NOT EXISTS messages (
    discussion_id INTEGER NOT NULL,
    id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (discussion_id, id)
);
CREATE TABLE IF NOT EXISTS mentions (
    discussion_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    length INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (discussion_id, message_id, member_id)
);
CREATE INDEX IF NOT EXISTS mentions_by_member ON mentions (member_id);
CREATE TABLE IF NOT EXISTS acks (
    discussion_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (discussion_id, message_id, member_id)
);
CREATE TABLE IF NOT EXISTS watermarks (
    discussion_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    PRIMARY KEY (discussion_id, member_id)
);
CREATE TABLE IF NOT EXISTS agent_runs (
    agent_id INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    messages_json TEXT NOT NULL DEFAULT '[]',
    usage_json TEXT,
    error TEXT,
    PRIMARY KEY (agent_id, sequence)
);
"""


def first(rows: list[sqlite3.Row]) -> sqlite3.Row | None:
    return rows[0] if rows else None


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class LockedConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self._lock = RLock()

    @property
    def lock(self) -> RLock:
        return self._lock

    def execute(self, sql: str, parameters: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._connection.execute(sql, parameters).fetchall()

    def execute_cursor(
        self, sql: str, parameters: Sequence[Any] = ()
    ) -> sqlite3.Cursor:
        with self._lock:
            return self._connection.execute(sql, parameters)

    def executemany(
        self, sql: str, parameters: Sequence[Sequence[Any]]
    ) -> sqlite3.Cursor:
        with self._lock:
            return self._connection.executemany(sql, parameters)

    def executescript(self, sql: str) -> None:
        with self._lock:
            self._connection.executescript(sql)

    def commit(self) -> None:
        with self._lock:
            self._connection.commit()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def __enter__(self) -> Self:
        self._lock.acquire()
        self._connection.__enter__()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            self._connection.__exit__(exc_type, exc, traceback)
        finally:
            self._lock.release()


class SqliteStore:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self._path, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        self._db = LockedConnection(connection)
        self._db.executescript(SCHEMA)
        if "length" not in {
            row["name"] for row in self._db.execute("PRAGMA table_info(mentions)")
        }:
            self._db.execute(
                "ALTER TABLE mentions ADD COLUMN length INTEGER NOT NULL DEFAULT 0"
            )
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    @contextmanager
    def _write(self) -> Iterator[LockedConnection]:
        with self._db as connection:
            yield connection

    def _next_id(self, table: str) -> int:
        rows = self._db.execute(f"SELECT COALESCE(MAX(id), 0) + 1 AS v FROM {table}")
        return int(rows[0]["v"])

    def _member(self, row: sqlite3.Row) -> Member:
        return Member(
            id=int(row["id"]),
            type=str(row["type"]),  # type: ignore[arg-type]
            name=str(row["name"]),
            deleted=bool(row["deleted"]),
            state=str(row["state"]),  # type: ignore[arg-type]
        )

    def list_members(self, *, include_deleted: bool = False) -> tuple[Member, ...]:
        sql = "SELECT * FROM members"
        if not include_deleted:
            sql += " WHERE deleted = 0"
        sql += " ORDER BY id"
        return tuple(self._member(row) for row in self._db.execute(sql))

    def get_member(self, member_id: int) -> Member | None:
        row = first(
            self._db.execute("SELECT * FROM members WHERE id = ?", (member_id,))
        )
        return self._member(row) if row else None

    def name_taken(self, name: str) -> bool:
        row = first(
            self._db.execute(
                "SELECT 1 FROM members WHERE name_key = ?", (name_key(name),)
            )
        )
        return row is not None

    def create_member(self, member_type: MemberType, name: str) -> Member:
        member_id = self._next_id("members")
        with self._write() as db:
            db.execute(
                "INSERT INTO members (id, type, name, name_key) VALUES (?, ?, ?, ?)",
                (member_id, member_type, name, name_key(name)),
            )
        member = self.get_member(member_id)
        assert member is not None
        return member

    def rename_member(self, member_id: int, name: str) -> Member:
        with self._write() as db:
            db.execute(
                "UPDATE members SET name = ?, name_key = ? WHERE id = ?",
                (name, name_key(name), member_id),
            )
        member = self.get_member(member_id)
        assert member is not None
        return member

    def set_agent_state(self, agent_id: int, state: AgentState) -> None:
        with self._write() as db:
            db.execute("UPDATE members SET state = ? WHERE id = ?", (state, agent_id))

    def delete_member(self, member_id: int) -> None:
        with self._write() as db:
            db.execute("UPDATE members SET deleted = 1 WHERE id = ?", (member_id,))
            db.execute(
                "DELETE FROM discussion_members WHERE member_id = ?", (member_id,)
            )

    def _discussion(self, row: sqlite3.Row) -> Discussion:
        members = self._db.execute(
            "SELECT member_id FROM discussion_members WHERE discussion_id = ?",
            (row["id"],),
        )
        return Discussion(
            id=int(row["id"]),
            topic=str(row["topic"]),
            member_ids=frozenset(int(item["member_id"]) for item in members),
            archived=bool(row["archived"]),
        )

    def list_discussions(
        self,
        *,
        member_id: int | None = None,
        include_archived: bool = False,
        limit: int | None = None,
    ) -> tuple[Discussion, ...]:
        sql = "SELECT d.* FROM discussions d"
        params: list[object] = []
        clauses: list[str] = []
        if member_id is not None:
            sql += " JOIN discussion_members dm ON dm.discussion_id = d.id"
            clauses.append("dm.member_id = ?")
            params.append(member_id)
        if not include_archived:
            clauses.append("d.archived = 0")
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += (
            " ORDER BY (SELECT julianday(m.created_at) FROM messages m"
            " WHERE m.discussion_id = d.id ORDER BY m.id DESC LIMIT 1) DESC, d.id"
        )
        if limit is not None:
            sql += " LIMIT ?"
            params.append(min(limit, 2**63 - 1))
        return tuple(self._discussion(row) for row in self._db.execute(sql, params))

    def get_discussion(self, discussion_id: int) -> Discussion | None:
        row = first(
            self._db.execute("SELECT * FROM discussions WHERE id = ?", (discussion_id,))
        )
        return self._discussion(row) if row else None

    def create_discussion(self, topic: str, member_ids: Sequence[int]) -> Discussion:
        with self._write() as db:
            row = db.execute(
                "UPDATE discussion_sequence SET last_id = MAX(last_id,"
                " (SELECT COALESCE(MAX(id), 0) FROM discussions)) + 1"
                " WHERE id = 1 RETURNING last_id"
            )[0]
            discussion_id = int(row["last_id"])
            db.execute(
                "INSERT INTO discussions (id, topic) VALUES (?, ?)",
                (discussion_id, topic),
            )
            db.executemany(
                "INSERT INTO discussion_members (discussion_id, member_id) VALUES (?, ?)",
                [(discussion_id, member_id) for member_id in dict.fromkeys(member_ids)],
            )
            discussion = self.get_discussion(discussion_id)
            assert discussion is not None
            return discussion

    def _active_member_ids(self, member_ids: Sequence[int]) -> None:
        unknown = sorted(set(member_ids) - {item.id for item in self.list_members()})
        if unknown:
            raise DomainError("not_found", f"Unknown Members: {unknown}")

    def set_discussion_members(
        self, discussion_id: int, member_ids: Sequence[int]
    ) -> Discussion:
        with self._write() as db:
            if self.get_discussion(discussion_id) is None:
                raise DomainError(
                    "not_found", f"Discussion {discussion_id} does not exist"
                )
            self._active_member_ids(member_ids)
            db.execute(
                "DELETE FROM discussion_members WHERE discussion_id = ?",
                (discussion_id,),
            )
            db.executemany(
                "INSERT INTO discussion_members (discussion_id, member_id) VALUES (?, ?)",
                [(discussion_id, member_id) for member_id in dict.fromkeys(member_ids)],
            )
            discussion = self.get_discussion(discussion_id)
            assert discussion is not None
            return discussion

    def change_discussion_members(
        self, discussion_id: int, member_ids: Sequence[int], *, remove: bool = False
    ) -> Discussion:
        with self._write() as db:
            if self.get_discussion(discussion_id) is None:
                raise DomainError(
                    "not_found", f"Discussion {discussion_id} does not exist"
                )
            if not remove:
                self._active_member_ids(member_ids)
            sql = (
                "DELETE FROM discussion_members WHERE discussion_id = ? AND member_id = ?"
                if remove
                else "INSERT OR IGNORE INTO discussion_members (discussion_id, member_id) VALUES (?, ?)"
            )
            db.executemany(
                sql, [(discussion_id, member_id) for member_id in member_ids]
            )
            discussion = self.get_discussion(discussion_id)
            assert discussion is not None
            return discussion

    def set_archived(self, discussion_id: int, archived: bool) -> None:
        with self._write() as db:
            db.execute(
                "UPDATE discussions SET archived = ? WHERE id = ?",
                (1 if archived else 0, discussion_id),
            )

    def _messages(self, sql: str, params: Sequence[object]) -> tuple[Message, ...]:
        rows = self._db.execute(sql, params)
        mentions: dict[tuple[int, int], list[MessageMention]] = {}
        for row in self._db.execute(
            "SELECT m.* FROM mentions m"
            f" JOIN ({sql}) selected ON selected.discussion_id = m.discussion_id"
            " AND selected.id = m.message_id ORDER BY m.position, m.member_id",
            params,
        ):
            mentions.setdefault((row["discussion_id"], row["message_id"]), []).append(
                MessageMention(row["member_id"], row["position"], row["length"])
            )
        return tuple(
            Message(
                discussion_id=int(row["discussion_id"]),
                id=int(row["id"]),
                sender_id=int(row["sender_id"]),
                sender_name=str(row["sender_name"]),
                body=str(row["body"]),
                created_at=str(row["created_at"]),
                mentions=tuple(mentions.get((row["discussion_id"], row["id"]), ())),
            )
            for row in rows
        )

    def append_message(
        self, discussion_id: int, sender_id: int, body: str
    ) -> tuple[Message, tuple[Mention, ...]]:
        sender = self.get_member(sender_id)
        assert sender is not None
        discussion = self.get_discussion(discussion_id)
        assert discussion is not None
        members = [
            member
            for member in self.list_members()
            if member.id in discussion.member_ids
        ]
        row = first(
            self._db.execute(
                "SELECT COALESCE(MAX(id), 0) + 1 AS v FROM messages WHERE discussion_id = ?",
                (discussion_id,),
            )
        )
        assert row is not None
        message_id = int(row["v"])
        mentions = build_mentions(
            discussion_id, message_id, body, members, sender_id=sender_id
        )
        message = Message(
            discussion_id=discussion_id,
            id=message_id,
            sender_id=sender_id,
            sender_name=sender.name,
            body=body,
            created_at=now(),
            mentions=tuple(
                MessageMention(item.member_id, item.position, item.length)
                for item in mentions
            ),
        )
        with self._write() as db:
            db.execute(
                "INSERT INTO messages (discussion_id, id, sender_id, sender_name, body,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    message.discussion_id,
                    message.id,
                    message.sender_id,
                    message.sender_name,
                    message.body,
                    message.created_at,
                ),
            )
            db.executemany(
                "INSERT INTO mentions (discussion_id, message_id, member_id, position, length)"
                " VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        item.discussion_id,
                        item.message_id,
                        item.member_id,
                        item.position,
                        item.length,
                    )
                    for item in mentions
                ],
            )
        return message, mentions

    def messages(
        self,
        discussion_id: int,
        *,
        after: int | None = None,
        before: int | None = None,
        limit: int | None = None,
        latest: bool = False,
    ) -> tuple[Message, ...]:
        sql = "SELECT * FROM messages WHERE discussion_id = ?"
        params: list[object] = [discussion_id]
        if after is not None:
            sql += " AND id > ?"
            params.append(after)
        if before is not None:
            sql += " AND id < ?"
            params.append(before)
        sql += " ORDER BY id DESC" if latest else " ORDER BY id"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        messages = self._messages(sql, params)
        return tuple(reversed(messages)) if latest else messages

    def message_count(self, discussion_id: int) -> int:
        row = first(
            self._db.execute(
                "SELECT COUNT(*) AS v FROM messages WHERE discussion_id = ?",
                (discussion_id,),
            )
        )
        return int(row["v"]) if row else 0

    def mentions_by_message(self, discussion_id: int) -> Mapping[int, frozenset[int]]:
        found: dict[int, set[int]] = {}
        for row in self._db.execute(
            "SELECT message_id, member_id FROM mentions WHERE discussion_id = ?",
            (discussion_id,),
        ):
            found.setdefault(int(row["message_id"]), set()).add(int(row["member_id"]))
        return {key: frozenset(value) for key, value in found.items()}

    def search_messages(
        self,
        query: str,
        *,
        sender_id: int | None = None,
        discussion_id: int | None = None,
        limit: int = 50,
    ) -> tuple[Message, ...]:
        sql = "SELECT * FROM messages WHERE body LIKE ? ESCAPE '\\'"
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        params: list[object] = [f"%{escaped}%"]
        if sender_id is not None:
            sql += " AND sender_id = ?"
            params.append(sender_id)
        if discussion_id is not None:
            sql += " AND discussion_id = ?"
            params.append(discussion_id)
        sql += " ORDER BY discussion_id, id LIMIT ?"
        params.append(limit)
        return self._messages(sql, params)

    def pending(self, member_id: int) -> tuple[Mention, ...]:
        rows = self._db.execute(
            """
            SELECT m.discussion_id, m.message_id, m.member_id, m.position, m.length
            FROM mentions m
            JOIN discussion_members dm
              ON dm.discussion_id = m.discussion_id AND dm.member_id = m.member_id
            JOIN discussions d
              ON d.id = m.discussion_id AND d.archived = 0
            LEFT JOIN acks a
              ON a.discussion_id = m.discussion_id
             AND a.message_id = m.message_id
             AND a.member_id = m.member_id
            WHERE m.member_id = ? AND a.member_id IS NULL
            ORDER BY m.discussion_id, m.message_id
            """,
            (member_id,),
        )
        return tuple(
            Mention(
                int(row["discussion_id"]),
                int(row["message_id"]),
                int(row["member_id"]),
                int(row["position"]),
                int(row["length"]),
            )
            for row in rows
        )

    def ack(
        self, discussion_id: int, message_ids: Sequence[int], member_id: int
    ) -> int:
        stamp = now()
        with self._write() as db:
            cursor = db.executemany(
                "INSERT OR IGNORE INTO acks (discussion_id, message_id, member_id,"
                " created_at) VALUES (?, ?, ?, ?)",
                [
                    (discussion_id, message_id, member_id, stamp)
                    for message_id in message_ids
                ],
            )
            return cursor.rowcount

    def acknowledged(self, discussion_id: int, member_id: int) -> tuple[int, ...]:
        return tuple(
            int(row["message_id"])
            for row in self._db.execute(
                "SELECT message_id FROM acks WHERE discussion_id = ?"
                " AND member_id = ? ORDER BY message_id",
                (discussion_id, member_id),
            )
        )

    def revoke_ack(
        self, discussion_id: int, message_ids: Sequence[int], member_id: int
    ) -> int:
        with self._write() as db:
            cursor = db.executemany(
                "DELETE FROM acks WHERE discussion_id = ? AND message_id = ?"
                " AND member_id = ?",
                [(discussion_id, message_id, member_id) for message_id in message_ids],
            )
            return cursor.rowcount

    def watermark(self, discussion_id: int, member_id: int) -> int:
        row = first(
            self._db.execute(
                "SELECT message_id FROM watermarks WHERE discussion_id = ? AND member_id = ?",
                (discussion_id, member_id),
            )
        )
        return int(row["message_id"]) if row else 0

    def set_watermark(
        self, discussion_id: int, member_id: int, message_id: int
    ) -> None:
        with self._write() as db:
            db.execute(
                "INSERT INTO watermarks (discussion_id, member_id, message_id)"
                " VALUES (?, ?, ?) ON CONFLICT (discussion_id, member_id)"
                " DO UPDATE SET message_id = MAX(message_id, excluded.message_id)",
                (discussion_id, member_id, message_id),
            )

    def unread_counts(self, member_id: int) -> Mapping[int, int]:
        rows = self._db.execute(
            """
            SELECT dm.discussion_id AS discussion_id,
                   COUNT(m.id) AS unread
            FROM discussion_members dm
            LEFT JOIN watermarks w
              ON w.discussion_id = dm.discussion_id AND w.member_id = dm.member_id
            LEFT JOIN messages m
              ON m.discussion_id = dm.discussion_id
             AND m.id > COALESCE(w.message_id, 0)
             AND m.sender_id <> dm.member_id
            WHERE dm.member_id = ?
            GROUP BY dm.discussion_id
            """,
            (member_id,),
        )
        return {int(row["discussion_id"]): int(row["unread"]) for row in rows}
