from __future__ import annotations

import random
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from huddol.adapters.sqlite.store import SqliteStore
from huddol.core.discussion import MessageMention
from huddol.core.mention import Mention
from huddol.core.pending import Ack, ack_keys, pending_for
from huddol.ports.store import OrganizationStore


@pytest.fixture
def store(tmp_path: Path) -> SqliteStore:
    created = SqliteStore(tmp_path / "huddol.sqlite3")
    yield created
    created.close()


def reference_pending(
    store: SqliteStore, member_id: int
) -> tuple[tuple[int, int], ...]:
    discussions = {
        item.id: item for item in store.list_discussions(include_archived=True)
    }
    mentions: list[Mention] = []
    acks: list[Ack] = []
    for discussion in discussions.values():
        for message_id, members in store.mentions_by_message(discussion.id).items():
            for other in members:
                mentions.append(Mention(discussion.id, message_id, other, 0, 0))
        for row in store._db.execute(
            "SELECT message_id, member_id FROM acks WHERE discussion_id = ?",
            (discussion.id,),
        ):
            acks.append(
                Ack(discussion.id, int(row["message_id"]), int(row["member_id"]))
            )
    found = pending_for(member_id, mentions, ack_keys(acks), discussions)
    return tuple(sorted((item.discussion_id, item.message_id) for item in found))


def sql_pending(store: SqliteStore, member_id: int) -> tuple[tuple[int, int], ...]:
    return tuple(
        sorted(
            (item.discussion_id, item.message_id) for item in store.pending(member_id)
        )
    )


def test_sql_pending_matches_the_core_formula_under_random_operations(
    store: SqliteStore,
) -> None:
    rng = random.Random(20260830)
    human = store.create_member("human", "You")
    agents = [store.create_member("agent", f"Agent{index}") for index in range(4)]
    everyone = [human, *agents]
    rooms = [
        store.create_discussion(f"topic {index}", [human.id, *[a.id for a in agents]])
        for index in range(3)
    ]

    for _ in range(300):
        action = rng.random()
        room = rng.choice(rooms)
        member = rng.choice(everyone)
        if action < 0.45:
            target = rng.choice(agents)
            store.append_message(room.id, member.id, f"hello @{target.name} please")
        elif action < 0.6:
            pending = store.pending(member.id)
            if pending:
                pick = rng.choice(pending)
                store.ack(pick.discussion_id, [pick.message_id], member.id)
        elif action < 0.7:
            pending_any = store._db.execute(
                "SELECT discussion_id, message_id, member_id FROM acks LIMIT 5"
            )
            if pending_any:
                row = rng.choice(pending_any)
                store.revoke_ack(
                    int(row["discussion_id"]),
                    [int(row["message_id"])],
                    int(row["member_id"]),
                )
        elif action < 0.85:
            current = store.get_discussion(room.id)
            assert current is not None
            ids = set(current.member_ids)
            victim = rng.choice(agents)
            if victim.id in ids and len(ids) > 1:
                ids.discard(victim.id)
            else:
                ids.add(victim.id)
            store.set_discussion_members(room.id, sorted(ids))
        else:
            current = store.get_discussion(room.id)
            assert current is not None
            store.set_archived(room.id, not current.archived)

        for candidate in everyone:
            assert sql_pending(store, candidate.id) == reference_pending(
                store, candidate.id
            ), f"divergence for member {candidate.id}"


def test_removing_a_member_clears_pending_without_touching_acks(
    store: SqliteStore,
) -> None:
    human = store.create_member("human", "You")
    agent = store.create_member("agent", "Main")
    room = store.create_discussion("topic", [human.id, agent.id])
    store.append_message(room.id, human.id, "@Main first")
    store.append_message(room.id, human.id, "@Main second")
    assert len(store.pending(agent.id)) == 2

    store.ack(room.id, [1], agent.id)
    assert [item.message_id for item in store.pending(agent.id)] == [2]

    store.set_discussion_members(room.id, [human.id])
    assert store.pending(agent.id) == ()

    store.set_discussion_members(room.id, [human.id, agent.id])
    assert [item.message_id for item in store.pending(agent.id)] == [2]


@pytest.mark.parametrize("archive_all", [False, True])
def test_discussion_ids_survive_archiving_and_restart(
    tmp_path: Path, archive_all: bool
) -> None:
    path = tmp_path / "ids.sqlite3"
    initial = SqliteStore(path)
    try:
        human = initial.create_member("human", "You")
        rooms = [
            initial.create_discussion(f"Topic {index}", [human.id])
            for index in range(3)
        ]
        assert [room.id for room in rooms] == [1, 2, 3]
        for room in rooms if archive_all else rooms[-1:]:
            initial.set_archived(room.id, True)
    finally:
        initial.close()
    reopened = SqliteStore(path)
    try:
        assert reopened.create_discussion("Next", [human.id]).id == 4
    finally:
        reopened.close()


def test_existing_discussions_initialize_the_counter(
    tmp_path: Path,
) -> None:
    path = tmp_path / "existing.sqlite3"
    original = SqliteStore(path)
    try:
        human = original.create_member("human", "You")
        with original._db:
            original._db.execute("INSERT INTO discussions VALUES (7, 'Keep', 1)")
            original._db.execute("INSERT INTO discussions VALUES (42, 'Latest', 0)")
        original.set_discussion_members(42, [human.id])
        message, _ = original.append_message(42, human.id, "Preserve this message")
        with original._db:
            original._db.execute("DROP TABLE IF EXISTS discussion_sequence")
    finally:
        original.close()
    upgraded = SqliteStore(path)
    try:
        rooms = upgraded.list_discussions(include_archived=True)
        assert [(room.id, room.topic, room.archived) for room in rooms] == [
            (42, "Latest", False),
            (7, "Keep", True),
        ]
        assert upgraded.messages(42) == (message,)
        upgraded.set_archived(42, True)
        assert upgraded.create_discussion("Next", [human.id]).id == 43
        assert upgraded.get_discussion(7) == rooms[1]
    finally:
        upgraded.close()


def test_failed_discussion_creation_rolls_back_the_allocation(
    store: SqliteStore,
) -> None:
    human = store.create_member("human", "You")
    first = store.create_discussion("First", [human.id])
    with pytest.raises(sqlite3.IntegrityError):
        store.create_discussion("Invalid", [None])
    assert store.list_discussions() == (first,)
    assert store.create_discussion("Next", [human.id]).id == 2


@pytest.mark.parametrize("separate_connections", [False, True])
def test_concurrent_discussion_creation_allocates_unique_ids(
    tmp_path: Path, separate_connections: bool
) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    path = tmp_path / "concurrent-ids.sqlite3"
    shared = SqliteStore(path)
    try:
        human = shared.create_member("human", "You")
        barrier = Barrier(4)

        def create(worker: int) -> list[int]:
            connection = SqliteStore(path) if separate_connections else shared
            try:
                barrier.wait(timeout=10)
                return [
                    connection.create_discussion(
                        f"Topic {worker}-{index}", [human.id]
                    ).id
                    for index in range(8)
                ]
            finally:
                if separate_connections:
                    connection.close()

        with ThreadPoolExecutor(max_workers=4) as pool:
            batches = list(pool.map(create, range(4)))
        assert sorted(item for batch in batches for item in batch) == list(range(1, 33))
        assert len(shared.list_discussions()) == 32
    finally:
        shared.close()


def test_archiving_a_discussion_preserves_messages_and_mentions(
    store: SqliteStore,
) -> None:
    human = store.create_member("human", "You")
    agent = store.create_member("agent", "Main")
    room = store.create_discussion("topic", [human.id, agent.id])
    store.append_message(room.id, human.id, "@Main hello")
    assert len(store.pending(agent.id)) == 1
    messages = store.messages(room.id)
    pending = store.pending(agent.id)
    store.set_archived(room.id, True)
    assert store.pending(agent.id) == ()
    assert store.messages(room.id) == messages
    store.set_archived(room.id, False)
    assert store.pending(agent.id) == pending
    assert not hasattr(store, "delete_discussion")
    assert not hasattr(OrganizationStore, "delete_discussion")


def test_message_ids_restart_per_discussion(store: SqliteStore) -> None:
    human = store.create_member("human", "You")
    first = store.create_discussion("a", [human.id])
    second = store.create_discussion("b", [human.id])
    message_a, _ = store.append_message(first.id, human.id, "one")
    message_b, _ = store.append_message(second.id, human.id, "one")
    assert message_a.id == 1
    assert message_b.id == 1


def test_names_are_unique_and_survive_deletion(store: SqliteStore) -> None:
    store.create_member("agent", "Main")
    assert store.name_taken("main") is True
    member = store.list_members()[0]
    store.delete_member(member.id)
    assert store.name_taken("Main") is True
    assert store.list_members() == ()
    assert len(store.list_members(include_deleted=True)) == 1


def test_unread_counts_ignore_own_messages(store: SqliteStore) -> None:
    human = store.create_member("human", "You")
    agent = store.create_member("agent", "Main")
    room = store.create_discussion("topic", [human.id, agent.id])
    store.append_message(room.id, human.id, "one")
    store.append_message(room.id, agent.id, "two")
    assert store.unread_counts(human.id)[room.id] == 1
    assert store.unread_counts(agent.id)[room.id] == 1
    store.set_watermark(room.id, human.id, 2)
    assert store.unread_counts(human.id)[room.id] == 0


def test_the_connection_survives_concurrent_threads(store: SqliteStore) -> None:
    import threading

    human = store.create_member("human", "You")
    agent = store.create_member("agent", "Main")
    room = store.create_discussion("concurrent", [human.id, agent.id])
    failures: list[Exception] = []

    def writer() -> None:
        try:
            for index in range(40):
                store.append_message(room.id, human.id, f"@Main item {index}")
        except Exception as error:  # noqa: BLE001
            failures.append(error)

    def reader() -> None:
        try:
            for _ in range(40):
                store.pending(agent.id)
                store.messages(room.id)
                store.unread_counts(agent.id)
        except Exception as error:  # noqa: BLE001
            failures.append(error)

    threads = [threading.Thread(target=writer), threading.Thread(target=reader)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert failures == []
    assert store.message_count(room.id) == 40


def test_mentions_round_trip_in_two_queries_and_stay_with_their_message(
    store: SqliteStore, monkeypatch
) -> None:
    human = store.create_member("human", "You")
    main = store.create_member("agent", "Main")
    manager = store.create_member("agent", "Technical Manager")
    rooms = [
        store.create_discussion(topic, [human.id, main.id, manager.id])
        for topic in ("A", "B")
    ]
    first, mentions = store.append_message(
        rooms[0].id, human.id, "Hi @Technical Manager and @mAiN"
    )
    second, _ = store.append_message(rooms[1].id, human.id, "Hi @Main")
    plain, _ = store.append_message(rooms[0].id, human.id, "Hi nobody")
    assert first.mentions == (
        MessageMention(manager.id, 3, 18),
        MessageMention(main.id, 26, 5),
    )
    assert [(item.member_id, item.position, item.length) for item in mentions] == [
        (manager.id, 3, 18),
        (main.id, 26, 5),
    ]
    assert store.pending(manager.id) == (mentions[0],)
    store.rename_member(manager.id, "Renamed")
    store.delete_member(main.id)
    calls = []
    execute = store._db.execute

    def track(sql, parameters=()):
        calls.append(sql)
        return execute(sql, parameters)

    monkeypatch.setattr(store._db, "execute", track)
    for params, expected in (
        ({}, (first, plain)),
        ({"limit": 1, "latest": True}, (plain,)),
        ({"before": 2}, (first,)),
        ({"after": 1}, (plain,)),
    ):
        calls.clear()
        assert store.messages(rooms[0].id, **params) == expected
        assert len(calls) == 2
    calls.clear()
    assert store.search_messages("Hi") == (first, plain, second)
    assert len(calls) == 2


def test_old_mentions_table_gains_length_without_reparsing(tmp_path: Path) -> None:
    path = tmp_path / "old.sqlite3"
    with closing(sqlite3.connect(path)) as db:
        db.execute(
            "CREATE TABLE mentions (discussion_id INTEGER NOT NULL, message_id INTEGER NOT NULL,"
            " member_id INTEGER NOT NULL, position INTEGER NOT NULL,"
            " PRIMARY KEY (discussion_id, message_id, member_id))"
        )
        db.execute("INSERT INTO mentions VALUES (1, 1, 2, 3)")
        db.commit()
    for _ in range(2):
        store = SqliteStore(path)
        try:
            columns = {
                row["name"]: row
                for row in store._db.execute("PRAGMA table_info(mentions)")
            }
            assert columns["length"]["notnull"] == 1
            assert columns["length"]["dflt_value"] == "0"
            assert tuple(store._db.execute("SELECT * FROM mentions")[0]) == (
                1,
                1,
                2,
                3,
                0,
            )
        finally:
            store.close()
