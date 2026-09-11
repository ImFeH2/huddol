from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from huddol.adapters.sqlite.migrate import backup, migrate, safe_filename, verify

LEGACY = """
CREATE TABLE members (id INTEGER PRIMARY KEY, type TEXT, name TEXT, deleted INTEGER,
    paused INTEGER);
CREATE TABLE discussions (id INTEGER PRIMARY KEY, topic TEXT);
CREATE TABLE discussion_members (discussion_id INTEGER, position INTEGER,
    member_id INTEGER, active INTEGER, joined_after_message_id INTEGER);
CREATE TABLE messages (discussion_id INTEGER, id INTEGER, sender_id INTEGER,
    body TEXT, sender_name TEXT, created_at TEXT, recipient_snapshot_known INTEGER);
CREATE TABLE mentions (discussion_id INTEGER, message_id INTEGER, position INTEGER,
    member_id INTEGER, read INTEGER, acked INTEGER, reminded INTEGER);
CREATE TABLE message_mention_acknowledgements (discussion_id INTEGER,
    message_id INTEGER, member_id INTEGER, source TEXT);
CREATE TABLE message_read_receipts (discussion_id INTEGER, message_id INTEGER,
    member_id INTEGER, source TEXT, agent_run_id TEXT);
CREATE TABLE agent_runs (agent_id INTEGER, sequence INTEGER, run_id TEXT, status TEXT,
    started_at TEXT, completed_at TEXT, reminder_json TEXT, messages_json TEXT,
    usage_json TEXT, error TEXT);
CREATE TABLE agent_todos (agent_id INTEGER, id INTEGER, subject TEXT, description TEXT,
    status TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
CREATE TABLE library_documents (id INTEGER PRIMARY KEY, title TEXT, content TEXT,
    revision INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE model_settings (id INTEGER, api_type TEXT, base_url TEXT, api_key TEXT,
    model TEXT, context_window INTEGER);
CREATE TABLE execution_settings (id INTEGER, backend TEXT);
CREATE TABLE execution_write_directories (position INTEGER, path TEXT);
CREATE TABLE organization_admin_assignments (member_id INTEGER, granted_at TEXT);
CREATE TABLE organization_audit_events (id INTEGER, kind TEXT);
"""


@pytest.fixture
def legacy(tmp_path: Path) -> Path:
    directory = tmp_path / "legacy"
    directory.mkdir()
    db = sqlite3.connect(directory / "huddol.sqlite3")
    db.executescript(LEGACY)
    db.executemany(
        "INSERT INTO members VALUES (?, ?, ?, ?, ?)",
        [
            (1, "human", "You", 0, 0),
            (13, "agent", "Main", 0, 0),
            (36, "agent", "TM", 0, 0),
        ],
    )
    db.execute("INSERT INTO discussions VALUES (1, 'topic')")
    db.executemany(
        "INSERT INTO discussion_members VALUES (?, ?, ?, ?, ?)",
        [(1, 0, 1, 1, None), (1, 1, 13, 1, None), (1, 2, 36, 0, 4)],
    )
    db.executemany(
        "INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, 1, "@Main first", "You", "2026-08-01T00:00:00Z", 1),
            (1, 2, 1, "@Main second", "You", "2026-08-02T00:00:00Z", 1),
        ],
    )
    db.executemany(
        "INSERT INTO mentions VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(1, 1, 0, 13, 1, 1, 1), (1, 2, 0, 13, 1, 0, 1)],
    )
    db.execute(
        "INSERT INTO message_mention_acknowledgements VALUES (1, 1, 13, 'agent')"
    )
    db.executemany(
        "INSERT INTO message_read_receipts VALUES (?, ?, ?, ?, ?)",
        [(1, 1, 13, "agent", "r1"), (1, 2, 13, "agent", "r1")],
    )
    db.executemany(
        "INSERT INTO agent_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                13,
                1,
                "r1",
                "completed",
                "2026-08-01T00:00:01Z",
                "2026-08-01T00:01:00Z",
                "{}",
                '[{"kind":"request"}]',
                None,
                None,
            ),
            (
                13,
                2,
                "r2",
                "running",
                "2026-08-02T00:00:01Z",
                None,
                "{}",
                "[]",
                None,
                None,
            ),
        ],
    )
    db.executemany(
        "INSERT INTO agent_todos VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (13, 1, "ship it", "with tests and docs", "completed", "t", "t", "t"),
            (13, 2, "next up", "the detail survives", "in_progress", "t", "t", None),
        ],
    )
    db.executemany(
        "INSERT INTO library_documents VALUES (?, ?, ?, ?, ?, ?)",
        [
            (1, "组织协作规范", "shared content", 3, "t", "t"),
            (2, "with/slash: bad", "other", 1, "t", "t"),
        ],
    )
    db.execute("INSERT INTO model_settings VALUES (1, 'openai', 'u', 'k', 'm', 200000)")
    db.execute("INSERT INTO execution_settings VALUES (1, 'wsl')")
    db.executemany(
        "INSERT INTO execution_write_directories VALUES (?, ?)",
        [(0, "/workspace/app"), (1, "/tmp")],
    )
    db.execute("INSERT INTO organization_admin_assignments VALUES (13, 't')")
    db.commit()
    db.close()

    memory = directory / "agents" / "13" / "memory"
    memory.mkdir(parents=True)
    (memory / "MEMORY.md").write_text("- index", encoding="utf-8")
    return directory


def test_migration_carries_every_table_and_verifies_clean(
    legacy: Path, tmp_path: Path
) -> None:
    report = migrate(legacy, tmp_path / "new")
    assert report.counts["members"] == 3
    assert report.counts["messages"] == 2
    assert report.counts["agent_runs"] == 2
    assert report.counts["memory_files"] == 1
    assert verify(legacy, tmp_path / "new") == []


def test_member_and_message_ids_are_preserved(legacy: Path, tmp_path: Path) -> None:
    migrate(legacy, tmp_path / "new")
    db = sqlite3.connect(tmp_path / "new" / "huddol.sqlite3")
    assert [row[0] for row in db.execute("SELECT id FROM members ORDER BY id")] == [
        1,
        13,
        36,
    ]
    db.close()


def test_acks_combine_both_legacy_sources_and_pending_survives(
    legacy: Path, tmp_path: Path
) -> None:
    from huddol.adapters.sqlite.store import SqliteStore

    migrate(legacy, tmp_path / "new")
    store = SqliteStore(tmp_path / "new" / "huddol.sqlite3")
    assert [item.message_id for item in store.pending(13)] == [2]
    store.close()


def test_read_receipts_collapse_into_a_watermark(legacy: Path, tmp_path: Path) -> None:
    from huddol.adapters.sqlite.store import SqliteStore

    migrate(legacy, tmp_path / "new")
    store = SqliteStore(tmp_path / "new" / "huddol.sqlite3")
    assert store.watermark(1, 13) == 2
    store.close()


def test_inactive_membership_is_dropped(legacy: Path, tmp_path: Path) -> None:
    migrate(legacy, tmp_path / "new")
    db = sqlite3.connect(tmp_path / "new" / "huddol.sqlite3")
    members = {
        row[0]
        for row in db.execute(
            "SELECT member_id FROM discussion_members WHERE discussion_id = 1"
        )
    }
    assert members == {1, 13}
    db.close()


def test_todo_subject_and_description_become_title_and_detail(
    legacy: Path, tmp_path: Path
) -> None:
    migrate(legacy, tmp_path / "new")
    db = sqlite3.connect(tmp_path / "new" / "huddol.sqlite3")
    rows = list(db.execute("SELECT title, detail, status FROM agent_todos ORDER BY id"))
    assert rows[0] == ("ship it", "with tests and docs", "done")
    assert rows[1] == ("next up", "the detail survives", "in_progress")
    db.close()


def test_unfinished_legacy_runs_are_marked_interrupted(
    legacy: Path, tmp_path: Path
) -> None:
    migrate(legacy, tmp_path / "new")
    db = sqlite3.connect(tmp_path / "new" / "huddol.sqlite3")
    statuses = [
        row[0] for row in db.execute("SELECT status FROM agent_runs ORDER BY sequence")
    ]
    assert statuses == ["completed", "interrupted"]
    db.close()


def test_library_rows_become_markdown_files_with_safe_names(
    legacy: Path, tmp_path: Path
) -> None:
    migrate(legacy, tmp_path / "new")
    library = tmp_path / "new" / "library"
    files = sorted(item.name for item in library.rglob("*.md"))
    assert files == ["with slash bad.md", "组织协作规范.md"]

    intact = (library / "组织协作规范.md").read_text(encoding="utf-8")
    assert intact == "shared content"

    sanitized = (library / "with slash bad.md").read_text(encoding="utf-8")
    assert sanitized.startswith("# with/slash: bad")
    assert "other" in sanitized


def test_admin_tables_are_not_carried_over(legacy: Path, tmp_path: Path) -> None:
    migrate(legacy, tmp_path / "new")
    db = sqlite3.connect(tmp_path / "new" / "huddol.sqlite3")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master")}
    assert "organization_admin_assignments" not in tables
    assert "organization_audit_events" not in tables
    db.close()


def test_settings_sections_are_carried_over(legacy: Path, tmp_path: Path) -> None:
    from huddol.adapters.sqlite.agent import SqliteAgentStore
    from huddol.adapters.sqlite.store import SqliteStore

    migrate(legacy, tmp_path / "new")
    store = SqliteStore(tmp_path / "new" / "huddol.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    model = agent_store.get_settings("model")
    assert model is not None
    assert model["model"] == "m"
    assert agent_store.get_settings("execution") == {
        "backend": "wsl",
        "directories": {"native": ["/workspace/app", "/tmp"]},
    }
    store.close()


def test_refuses_to_run_when_a_wal_file_is_present(
    legacy: Path, tmp_path: Path
) -> None:
    (legacy / "huddol.sqlite3-wal").write_bytes(b"")
    with pytest.raises(RuntimeError, match="stop Huddol"):
        migrate(legacy, tmp_path / "new")


def test_refuses_to_overwrite_an_existing_target(legacy: Path, tmp_path: Path) -> None:
    migrate(legacy, tmp_path / "new")
    with pytest.raises(FileExistsError):
        migrate(legacy, tmp_path / "new")


def test_backup_copies_and_refuses_to_clobber(legacy: Path, tmp_path: Path) -> None:
    copy = backup(legacy, tmp_path / "backup")
    assert (copy / "huddol.sqlite3").is_file()
    assert (copy / "agents" / "13" / "memory" / "MEMORY.md").is_file()
    with pytest.raises(FileExistsError):
        backup(legacy, tmp_path / "backup")


def test_safe_filename_deduplicates() -> None:
    taken: set[str] = set()
    assert safe_filename("Notes", taken) == "Notes.md"
    assert safe_filename("Notes", taken) == "Notes (2).md"
    assert safe_filename("a/b:c", taken) == "a b c.md"
