from __future__ import annotations

import json
import re
import shutil
import sqlite3
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

from huddol.adapters.execution.manager import environment_key
from huddol.adapters.files.tree import MarkdownTree
from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore
from huddol.core.member import name_key

LEGACY_TABLES = (
    "members",
    "discussions",
    "discussion_members",
    "messages",
    "mentions",
    "message_mention_acknowledgements",
    "message_read_receipts",
    "agent_runs",
    "agent_todos",
    "library_documents",
    "model_settings",
    "execution_settings",
    "execution_write_directories",
    "observability_settings",
)

_UNSAFE = re.compile(r"[^\w一-鿿 \-.]", re.UNICODE)


@dataclass
class Report:
    counts: dict[str, int] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def record(self, name: str, value: int) -> None:
        self.counts[name] = value

    def note(self, text: str) -> None:
        self.notes.append(text)

    def render(self) -> str:
        lines = [f"  {name:<24} {value}" for name, value in sorted(self.counts.items())]
        return "\n".join([*lines, *(f"  ! {note}" for note in self.notes)])


def _tables(db: sqlite3.Connection) -> frozenset[str]:
    rows = db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    return frozenset(str(row["name"]) for row in rows)


def _rows(
    db: sqlite3.Connection, table: str, present: frozenset[str]
) -> Iterator[sqlite3.Row]:
    if table not in present:
        return iter(())
    return iter(db.execute(f"SELECT * FROM {table}").fetchall())


def safe_filename(title: str, taken: set[str]) -> str:
    cleaned = _UNSAFE.sub(" ", title).strip()
    cleaned = " ".join(cleaned.split()) or "document"
    candidate = f"{cleaned}.md"
    index = 2
    while candidate.casefold() in taken:
        candidate = f"{cleaned} ({index}).md"
        index += 1
    taken.add(candidate.casefold())
    return candidate


def backup(source: Path, destination: Path) -> Path:
    if destination.exists():
        raise FileExistsError(f"{destination} already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
    else:
        shutil.copy2(source, destination)
    return destination


def migrate(legacy_dir: Path, target_dir: Path) -> Report:
    legacy_db_path = legacy_dir / "huddol.sqlite3"
    if not legacy_db_path.is_file():
        raise FileNotFoundError(f"{legacy_db_path} does not exist")
    for stale in ("huddol.sqlite3-wal", "huddol.sqlite3-shm"):
        if (legacy_dir / stale).exists():
            raise RuntimeError(f"{stale} is present; stop Huddol before migrating")

    target_dir.mkdir(parents=True, exist_ok=True)
    target_db_path = target_dir / "huddol.sqlite3"
    if target_db_path.exists():
        raise FileExistsError(f"{target_db_path} already exists")

    legacy = sqlite3.connect(f"file:{legacy_db_path}?mode=ro", uri=True)
    legacy.row_factory = sqlite3.Row
    present = _tables(legacy)

    store = SqliteStore(target_db_path)
    agent_store = SqliteAgentStore(store._db)
    report = Report()

    db = store._db
    with db:
        members = list(_rows(legacy, "members", present))
        for row in members:
            keys = row.keys()
            deleted = int(row["deleted"]) if "deleted" in keys else 0
            db.execute(
                "INSERT INTO members (id, type, name, name_key, deleted, state)"
                " VALUES (?, ?, ?, ?, ?, 'idle')",
                (
                    int(row["id"]),
                    str(row["type"]),
                    str(row["name"]),
                    name_key(str(row["name"])),
                    deleted,
                ),
            )
        report.record("members", len(members))

        discussions = list(_rows(legacy, "discussions", present))
        for row in discussions:
            db.execute(
                "INSERT INTO discussions (id, topic, archived) VALUES (?, ?, 0)",
                (int(row["id"]), str(row["topic"])),
            )
        report.record("discussions", len(discussions))

        memberships = 0
        dropped_frontier = False
        for row in _rows(legacy, "discussion_members", present):
            keys = row.keys()
            if "active" in keys and not int(row["active"]):
                continue
            if "joined_after_message_id" in keys and row["joined_after_message_id"]:
                dropped_frontier = True
            db.execute(
                "INSERT OR IGNORE INTO discussion_members (discussion_id, member_id)"
                " VALUES (?, ?)",
                (int(row["discussion_id"]), int(row["member_id"])),
            )
            memberships += 1
        report.record("discussion_members", memberships)
        if dropped_frontier:
            report.note(
                "joined_after_message_id dropped: existing members can now see"
                " the full history of their discussions"
            )

        messages = list(_rows(legacy, "messages", present))
        for row in messages:
            db.execute(
                "INSERT INTO messages (discussion_id, id, sender_id, sender_name, body,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(row["discussion_id"]),
                    int(row["id"]),
                    int(row["sender_id"]),
                    str(row["sender_name"]),
                    str(row["body"]),
                    str(row["created_at"]),
                ),
            )
        report.record("messages", len(messages))

        mentions = list(_rows(legacy, "mentions", present))
        acked_from_mentions: list[tuple[int, int, int]] = []
        for row in mentions:
            keys = row.keys()
            db.execute(
                "INSERT OR IGNORE INTO mentions (discussion_id, message_id, member_id,"
                " position) VALUES (?, ?, ?, ?)",
                (
                    int(row["discussion_id"]),
                    int(row["message_id"]),
                    int(row["member_id"]),
                    int(row["position"]) if "position" in keys else 0,
                ),
            )
            if "acked" in keys and int(row["acked"]):
                acked_from_mentions.append(
                    (
                        int(row["discussion_id"]),
                        int(row["message_id"]),
                        int(row["member_id"]),
                    )
                )
        report.record("mentions", len(mentions))

        stamp = "1970-01-01T00:00:00.000Z"
        acks = {
            (
                int(row["discussion_id"]),
                int(row["message_id"]),
                int(row["member_id"]),
            )
            for row in _rows(legacy, "message_mention_acknowledgements", present)
        }
        acks.update(acked_from_mentions)
        for discussion_id, message_id, member_id in sorted(acks):
            db.execute(
                "INSERT OR IGNORE INTO acks (discussion_id, message_id, member_id,"
                " created_at) VALUES (?, ?, ?, ?)",
                (discussion_id, message_id, member_id, stamp),
            )
        report.record("acks", len(acks))

        watermarks: dict[tuple[int, int], int] = {}
        for row in _rows(legacy, "message_read_receipts", present):
            key = (int(row["discussion_id"]), int(row["member_id"]))
            watermarks[key] = max(watermarks.get(key, 0), int(row["message_id"]))
        for (discussion_id, member_id), message_id in sorted(watermarks.items()):
            db.execute(
                "INSERT INTO watermarks (discussion_id, member_id, message_id)"
                " VALUES (?, ?, ?)",
                (discussion_id, member_id, message_id),
            )
        report.record("watermarks", len(watermarks))

        runs = list(_rows(legacy, "agent_runs", present))
        for row in runs:
            keys = row.keys()
            payload = "reminder_json" if "reminder_json" in keys else None
            status = str(row["status"])
            db.execute(
                "INSERT INTO agent_runs (agent_id, sequence, run_id, status, started_at,"
                " completed_at, messages_json, usage_json, error)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    int(row["agent_id"]),
                    int(row["sequence"]),
                    str(row["run_id"]),
                    "interrupted" if status == "running" else status,
                    str(row["started_at"]),
                    row["completed_at"],
                    str(row["messages_json"]) if "messages_json" in keys else "[]",
                    row["usage_json"] if "usage_json" in keys else None,
                    row["error"] if "error" in keys else None,
                ),
            )
            del payload
        report.record("agent_runs", len(runs))

        todos = list(_rows(legacy, "agent_todos", present))
        for row in todos:
            keys = row.keys()
            title = str(row["subject"] if "subject" in keys else row["title"])
            detail = str(row["description"]) if "description" in keys else ""
            status = str(row["status"]) if "status" in keys else "pending"
            db.execute(
                "INSERT OR IGNORE INTO agent_todos (agent_id, id, title, detail, status,"
                " created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(row["agent_id"]),
                    int(row["id"]),
                    title,
                    detail,
                    "done" if status == "completed" else status,
                    str(row["created_at"]) if "created_at" in keys else stamp,
                ),
            )
        report.record("agent_todos", len(todos))

    for section, table in (
        ("model", "model_settings"),
        ("execution", "execution_settings"),
        ("observability", "observability_settings"),
    ):
        rows = list(_rows(legacy, table, present))
        if rows:
            columns = list(rows[0].keys())
            values = {key: rows[0][key] for key in columns if not key.startswith("id")}
            agent_store.set_settings(section, values)
    directories = [
        str(row["path"])
        for row in _rows(legacy, "execution_write_directories", present)
        if "path" in list(row.keys())
    ]
    if directories:
        execution = agent_store.get_settings("execution") or {}
        agent_store.set_settings(
            "execution",
            {
                **execution,
                "directories": {
                    environment_key({"kind": "native"}): list(
                        dict.fromkeys(directories)
                    )
                },
            },
        )
    report.record("settings_sections", 3)
    report.record("write_directories", len(directories))

    documents = list(_rows(legacy, "library_documents", present))
    library = MarkdownTree(target_dir / "library")
    taken: set[str] = set()
    for row in documents:
        keys = row.keys()
        title = str(row["title"]) if "title" in keys else f"document {row['id']}"
        content = str(row["content"]) if "content" in keys else ""
        filename = safe_filename(title, taken)
        heading = filename.removesuffix(".md")
        body = (
            content
            if content.lstrip().startswith("#") or heading == title
            else (f"# {title}\n\n{content}")
        )
        library.write(filename, body)
    report.record("library_documents", len(documents))

    legacy_agents = legacy_dir / "agents"
    copied = 0
    if legacy_agents.is_dir():
        target_agents = target_dir / "agents"
        for source in sorted(legacy_agents.iterdir()):
            memory = source / "memory"
            if not memory.is_dir():
                continue
            destination = target_agents / source.name / "memory"
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(memory, destination, dirs_exist_ok=True)
            copied += len(list(destination.rglob("*.md")))
    report.record("memory_files", copied)

    legacy.close()
    store.close()
    return report


def verify(legacy_dir: Path, target_dir: Path) -> list[str]:
    problems: list[str] = []
    legacy = sqlite3.connect(f"file:{legacy_dir / 'huddol.sqlite3'}?mode=ro", uri=True)
    legacy.row_factory = sqlite3.Row
    target = sqlite3.connect(f"file:{target_dir / 'huddol.sqlite3'}?mode=ro", uri=True)
    target.row_factory = sqlite3.Row
    present = _tables(legacy)

    for table in ("members", "discussions", "messages", "agent_runs", "agent_todos"):
        if table not in present:
            continue
        before = legacy.execute(f"SELECT COUNT(*) AS v FROM {table}").fetchone()["v"]
        after = target.execute(f"SELECT COUNT(*) AS v FROM {table}").fetchone()["v"]
        if before != after:
            problems.append(f"{table}: {before} before, {after} after")

    if "library_documents" in present:
        before = legacy.execute(
            "SELECT COUNT(*) AS v FROM library_documents"
        ).fetchone()["v"]
        after = len(list((target_dir / "library").rglob("*.md")))
        if before != after:
            problems.append(f"library: {before} rows, {after} files")

    for row in target.execute(
        "SELECT agent_id, sequence, messages_json FROM agent_runs"
    ):
        try:
            json.loads(str(row["messages_json"]))
        except json.JSONDecodeError:
            problems.append(
                f"agent_runs {row['agent_id']}/{row['sequence']}: history is not valid JSON"
            )

    legacy.close()
    target.close()
    return problems
