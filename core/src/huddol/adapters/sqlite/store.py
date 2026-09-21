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
from huddol.ports.store import DiscussionPage, PendingAcknowledgement

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
    reminded_json TEXT NOT NULL DEFAULT '[]',
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
        self._depth = 0
        self._rollback_only = False

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
            if self._depth or self._connection.in_transaction:
                self._rollback_only = True
                raise RuntimeError(
                    "Cannot execute a script inside an active transaction"
                )
            self._connection.executescript(sql)

    def commit(self) -> None:
        with self._lock:
            if self._depth:
                self._rollback_only = True
                raise RuntimeError("Only the outermost transaction can commit")
            self._connection.commit()

    def close(self) -> None:
        with self._lock:
            if self._depth:
                self._rollback_only = True
                raise RuntimeError("Cannot close an active transaction")
            self._connection.close()

    def transaction(self, *, immediate: bool = True) -> Transaction:
        return Transaction(self, immediate=immediate)

    def __enter__(self) -> Self:
        return self._enter(immediate=True)

    def _enter(self, *, immediate: bool) -> Self:
        with self._lock:
            if self._depth == 0:
                self._connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
                self._rollback_only = False
            self._depth += 1
            self._lock.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        try:
            self._rollback_only = self._rollback_only or exc_type is not None
            self._depth -= 1
            if self._depth == 0:
                try:
                    if self._rollback_only:
                        if exc_type is None:
                            raise RuntimeError("A nested transaction failed")
                    else:
                        self._connection.commit()
                finally:
                    if self._connection.in_transaction:
                        self._connection.rollback()
        finally:
            self._lock.release()


class Transaction:
    def __init__(self, connection: LockedConnection, *, immediate: bool) -> None:
        self._connection = connection
        self._immediate = immediate

    def __enter__(self) -> LockedConnection:
        return self._connection._enter(immediate=self._immediate)

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._connection.__exit__(exc_type, exc, traceback)


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
        if "reminded_json" not in {
            row["name"] for row in self._db.execute("PRAGMA table_info(agent_runs)")
        }:
            self._db.execute(
                "ALTER TABLE agent_runs ADD COLUMN reminded_json TEXT NOT NULL DEFAULT '[]'"
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

    def _member_discussion(self, discussion_id: int, member_id: int) -> Discussion:
        discussion = self.get_discussion(discussion_id)
        if discussion is None:
            raise DomainError("not_found", f"Discussion {discussion_id} does not exist")
        if member_id not in discussion.member_ids:
            raise DomainError("not_a_member", "You do not belong to this Discussion")
        return discussion

    def _pending_summary(
        self, discussion_id: int, member_id: int, through: int
    ) -> tuple[int, int]:
        row = self._db.execute(
            "SELECT COUNT(*) AS n, COALESCE(MAX(m.message_id), 0) AS last"
            " FROM mentions m JOIN discussions d ON d.id = m.discussion_id"
            " WHERE m.discussion_id = ? AND m.member_id = ?"
            " AND m.message_id <= ? AND d.archived = 0"
            " AND NOT EXISTS (SELECT 1 FROM acks a WHERE"
            " a.discussion_id = m.discussion_id AND a.message_id = m.message_id"
            " AND a.member_id = m.member_id)",
            (discussion_id, member_id, through),
        )[0]
        return int(row["n"]), int(row["last"])

    def discussion_page(
        self,
        discussion_id: int,
        member_id: int,
        *,
        limit: int,
        entry: bool = False,
        before: int | None = None,
        after: int | None = None,
    ) -> DiscussionPage:
        with self._db.transaction(immediate=False) as db:
            discussion = self._member_discussion(discussion_id, member_id)
            read_through = self.watermark(discussion_id, member_id)
            latest_id = int(
                db.execute(
                    "SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE discussion_id = ?",
                    (discussion_id,),
                )[0]["id"]
            )
            unread = first(
                db.execute(
                    "SELECT id FROM messages WHERE discussion_id = ? AND id > ?"
                    " AND sender_id <> ? ORDER BY id LIMIT 1",
                    (discussion_id, read_through, member_id),
                )
            )
            first_unread_id = int(unread["id"]) if unread else None
            if entry and first_unread_id is not None:
                after = first_unread_id - 1
            selected = self.messages(
                discussion_id,
                before=before,
                after=after,
                limit=limit,
                latest=after is None,
            )
            previous = first(
                db.execute(
                    "SELECT sender_id FROM messages WHERE discussion_id = ?"
                    " AND id < ? ORDER BY id DESC LIMIT 1",
                    (discussion_id, selected[0].id if selected else 0),
                )
            )
            has_after = bool(selected and selected[-1].id < latest_id)
            awaiting: list[int] = []
            acknowledged: list[int] = []
            if selected:
                for row in db.execute(
                    "SELECT m.id, a.message_id AS acked, n.message_id AS mentioned"
                    " FROM messages m LEFT JOIN acks a ON a.discussion_id = m.discussion_id"
                    " AND a.message_id = m.id AND a.member_id = ?"
                    " LEFT JOIN mentions n ON n.discussion_id = m.discussion_id"
                    " AND n.message_id = m.id AND n.member_id = ?"
                    " WHERE m.discussion_id = ? AND m.id BETWEEN ? AND ?",
                    (
                        member_id,
                        member_id,
                        discussion_id,
                        selected[0].id,
                        selected[-1].id,
                    ),
                ):
                    if row["acked"] is not None:
                        acknowledged.append(int(row["id"]))
                    elif row["mentioned"] is not None and not discussion.archived:
                        awaiting.append(int(row["id"]))
            pending_count, _ = self._pending_summary(
                discussion_id, member_id, latest_id
            )
            members = tuple(
                (int(row["id"]), str(row["name"]))
                for row in db.execute(
                    "SELECT m.id, m.name FROM members m JOIN discussion_members dm"
                    " ON dm.member_id = m.id WHERE dm.discussion_id = ? ORDER BY m.id",
                    (discussion_id,),
                )
            )
            return DiscussionPage(
                selected,
                read_through,
                first_unread_id,
                latest_id,
                previous is not None,
                has_after,
                int(previous["sender_id"]) if previous else None,
                tuple(awaiting),
                tuple(acknowledged),
                pending_count,
                discussion,
                members,
            )

    def _require_message(self, discussion_id: int, message_id: int) -> None:
        if not self._db.execute(
            "SELECT 1 FROM messages WHERE discussion_id = ? AND id = ?",
            (discussion_id, message_id),
        ):
            raise DomainError("not_found", "Message is not in this Discussion")

    def mark_read(self, discussion_id: int, member_id: int, message_id: int) -> int:
        with self._db:
            self._member_discussion(discussion_id, member_id)
            self._require_message(discussion_id, message_id)
            self._advance_read(discussion_id, member_id, message_id)
            return self.watermark(discussion_id, member_id)

    def _advance_read(
        self, discussion_id: int, member_id: int, message_id: int
    ) -> None:
        self._db.execute(
            "INSERT INTO watermarks (discussion_id, member_id, message_id) VALUES (?, ?, ?)"
            " ON CONFLICT (discussion_id, member_id) DO UPDATE SET"
            " message_id = MAX(message_id, excluded.message_id)",
            (discussion_id, member_id, message_id),
        )

    def ack_pending(
        self, discussion_id: int, member_id: int, through_message_id: int
    ) -> PendingAcknowledgement:
        with self._db as db:
            self._member_discussion(discussion_id, member_id)
            self._require_message(discussion_id, through_message_id)
            count, last = self._pending_summary(
                discussion_id, member_id, through_message_id
            )
            if count:
                db.execute(
                    "INSERT INTO acks (discussion_id, message_id, member_id, created_at)"
                    " SELECT m.discussion_id, m.message_id, m.member_id, ? FROM mentions m"
                    " WHERE m.discussion_id = ? AND m.member_id = ? AND m.message_id <= ?"
                    " AND NOT EXISTS (SELECT 1 FROM acks a WHERE"
                    " a.discussion_id = m.discussion_id AND a.message_id = m.message_id"
                    " AND a.member_id = m.member_id)",
                    (now(), discussion_id, member_id, through_message_id),
                )
                self._advance_read(discussion_id, member_id, last)
            latest = int(
                db.execute(
                    "SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE discussion_id = ?",
                    (discussion_id,),
                )[0]["id"]
            )
            remaining, _ = self._pending_summary(discussion_id, member_id, latest)
            return PendingAcknowledgement(
                count, self.watermark(discussion_id, member_id), remaining
            )

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
