from __future__ import annotations

import sys
from pathlib import Path

import pytest

from huddol.adapters.execution.manager import ExecutionManager
from huddol.adapters.files.tree import DirectoryTree
from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore
from huddol.core.errors import DomainError
from huddol.ports.execution import EditResult, RunResult
from huddol.tools import AgentTools, Dependencies, TurnBinding
from huddol.tools.authorize import Actor, Authorizer

HUMAN = 1
MAIN = 2
OTHER = 3


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "huddol.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Main")
    store.create_member("agent", "Other")

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=store,
        todos=agent_store,
        history=agent_store,
        settings=agent_store,
        execution=ExecutionManager(enforce=False),
        agent_directory_for=agent_directory_for,
        library_tree=DirectoryTree(tmp_path / "library"),
        memory_tree_for=lambda member_id: DirectoryTree(
            tmp_path / "agents" / str(member_id) / "memory", markdown_only=True
        ),
    )
    yield deps
    deps.execution.close()
    store.close()


def tools_for(deps: Dependencies, member_id: int, **kwargs) -> AgentTools:
    member = deps.store.get_member(member_id)
    assert member is not None
    return AgentTools(deps, Actor(member_id, member.is_agent), **kwargs)


@pytest.mark.parametrize("member_id", [MAIN, OTHER])
def test_run_defaults_to_the_agents_directory_on_first_use(
    world, tmp_path: Path, member_id: int
) -> None:
    directory = tmp_path / "agents" / str(member_id)
    assert not directory.exists()
    tools = tools_for(world, member_id)
    for _ in range(2):
        result = tools.run([sys.executable, "-c", "import os; print(os.getcwd())"])
        assert result["exit_code"] == 0
        assert result["stdout"].strip() == str(directory)
    assert directory.is_dir()


def test_run_resolves_relative_cwd_under_the_agents_directory(world) -> None:
    directory = world.agent_directory_for(MAIN) / "nested"
    directory.mkdir()
    result = tools_for(world, MAIN).run(
        [sys.executable, "-c", "import os; print(os.getcwd())"], cwd="nested"
    )
    assert result["exit_code"] == 0
    assert result["stdout"].strip() == str(directory)


def test_run_keeps_absolute_cwd_without_creating_an_agent_directory(
    world, tmp_path: Path
) -> None:
    result = tools_for(world, MAIN).run(
        [sys.executable, "-c", "import os; print(os.getcwd())"], cwd=str(tmp_path)
    )
    assert result["exit_code"] == 0
    assert result["stdout"].strip() == str(tmp_path)
    assert not (tmp_path / "agents" / str(MAIN)).exists()


@pytest.mark.parametrize(
    "path", ["/home/agent/project", r"C:\project", r"\\server\share\project"]
)
def test_tools_forward_absolute_paths_in_both_platform_formats(
    world, tmp_path: Path, monkeypatch, path: str
) -> None:
    tools = tools_for(world, MAIN)
    calls = []

    def run(argv, *, cwd, timeout):
        calls.append((argv, cwd, timeout))
        return RunResult(0, "", "", False)

    def edit(path, old_text, new_text, *, replace_all):
        calls.append((path, old_text, new_text, replace_all))
        return EditResult(path, "", 1)

    environment = world.execution.snapshot()
    monkeypatch.setattr(environment, "run", run)
    monkeypatch.setattr(environment, "edit", edit)
    monkeypatch.setattr(world.execution, "snapshot", lambda: environment)
    tools.run(["pwd"], cwd=path, timeout=7)
    tools.edit(path, "before", "after", replace_all=True)
    assert calls == [(["pwd"], path, 7), (path, "before", "after", True)]
    assert not (tmp_path / "agents" / str(MAIN)).exists()


def test_relative_edit_resolves_under_the_agents_directory_and_is_not_writable(
    world, tmp_path: Path, monkeypatch
) -> None:
    directory = tmp_path / "agents" / str(MAIN)
    tools = tools_for(world, MAIN)
    paths = []
    environment = world.execution.snapshot()
    original = environment.edit

    def edit(path, *args, **kwargs):
        paths.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(environment, "edit", edit)
    monkeypatch.setattr(world.execution, "snapshot", lambda: environment)
    assert not directory.exists()
    with pytest.raises(DomainError) as error:
        tools.edit("file.txt", "before", "after")
    assert paths == [str(directory / "file.txt")]
    assert error.value.code == "not_writable"
    assert directory.is_dir()


def test_existing_tools_follow_environment_and_directory_changes(
    world, tmp_path: Path, monkeypatch
) -> None:
    from huddol.adapters.execution.local import LocalExecution

    manager = world.execution
    original = manager._create

    def create(target, directories, *, tolerant=False):
        if target["kind"] == "wsl":
            environment = LocalExecution(directories, enforce=False)
            monkeypatch.setattr(
                environment,
                "run",
                lambda *args, **kwargs: RunResult(0, "WSL", "", False),
            )
            return environment
        return original(target, directories, tolerant=tolerant)

    monkeypatch.setattr(manager, "_create", create)
    target = tmp_path / "file.txt"
    target.write_text("before", encoding="utf-8")
    tools = tools_for(world, MAIN)
    command = [sys.executable, "-c", "print('native')"]
    assert tools.run(command)["stdout"].strip() == "native"
    with pytest.raises(DomainError, match="outside"):
        tools.edit(str(target), "before", "denied")
    manager.configure({"write_directories": [str(tmp_path)]}, lambda values: None)
    tools.edit(str(target), "before", "native")
    manager.configure(
        {"environment": {"kind": "wsl", "distribution": "test"}}, lambda values: None
    )
    assert tools.run(command)["stdout"] == "WSL"
    with pytest.raises(DomainError, match="outside"):
        tools.edit(str(target), "native", "denied")
    manager.configure({"write_directories": [str(tmp_path)]}, lambda values: None)
    tools.edit(str(target), "native", "wsl")
    manager.configure({"write_directories": []}, lambda values: None)
    with pytest.raises(DomainError, match="outside"):
        tools.edit(str(target), "wsl", "denied")
    manager.configure({"environment": {"kind": "native"}}, lambda values: None)
    assert tools.run(command)["stdout"].strip() == "native"
    tools.edit(str(target), "wsl", "after")
    assert target.read_text(encoding="utf-8") == "after"


def test_edit_keeps_absolute_paths(world, tmp_path: Path) -> None:
    directory = tmp_path / "writable"
    directory.mkdir()
    target = directory / "file.txt"
    target.write_text("before", encoding="utf-8")
    world.execution.configure(
        {"write_directories": [str(directory)]}, lambda values: None
    )
    result = tools_for(world, MAIN).edit(str(target), "before", "after")
    assert result["path"] == str(target)
    assert target.read_text(encoding="utf-8") == "after"
    assert not (tmp_path / "agents" / str(MAIN)).exists()


@pytest.mark.parametrize("actor_id", [HUMAN, MAIN])
def test_discussion_list_orders_last_message_and_limits_after_filtering(
    world, monkeypatch, actor_id
) -> None:
    human = tools_for(world, HUMAN)
    empty = [human.create_discussion("Empty", [MAIN])["id"] for _ in range(2)]
    rooms = []

    def send(room, stamp):
        monkeypatch.setattr("huddol.adapters.sqlite.store.now", lambda: stamp)
        world.store.append_message(room, HUMAN, "@You @Main needle")

    for day in range(1, 26):
        room = human.create_discussion(f"Room {day}", [MAIN])["id"]
        rooms.append(room)
        send(room, f"2026-01-{day:02}T01:00:00Z")
    send(rooms[0], "2026-01-29T00:00:00Z")
    send(rooms[0], "2026-01-01T20:00:00-05:00")
    archived = human.create_discussion("Archived", [MAIN])["id"]
    send(archived, "2026-01-30T00:00:00Z")
    human.archive_discussion(archived)
    hidden = world.store.create_discussion("Hidden", [OTHER])
    monkeypatch.setattr(
        "huddol.adapters.sqlite.store.now", lambda: "2026-01-31T00:00:00Z"
    )
    world.store.append_message(hidden.id, OTHER, "needle")
    actor = tools_for(world, actor_id)
    pending = world.store.pending(actor_id)
    watermarks = [world.store.watermark(room, actor_id) for room in rooms]
    expected = list(reversed(rooms[2:])) + rooms[:2] + empty
    assert [item["id"] for item in actor.list_discussions()] == expected
    assert [item["id"] for item in actor.list_discussions(limit=3)] == expected[:3]
    assert [item["id"] for item in actor.list_discussions(limit=100)] == expected
    assert [item["id"] for item in actor.list_discussions(limit=10**30)] == expected
    assert [item["id"] for item in actor.list_discussions(True, limit=1)] == [archived]
    assert len(actor.search_messages("needle")) == 28
    assert world.store.pending(actor_id) == pending
    assert [world.store.watermark(room, actor_id) for room in rooms] == watermarks


@pytest.mark.parametrize("limit", [0, -1, True, "2", 1.5])
def test_discussion_list_rejects_invalid_limits(world, limit) -> None:
    with pytest.raises(DomainError) as error:
        tools_for(world, MAIN).list_discussions(limit=limit)
    assert error.value.code == "invalid_pagination"


@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ({"limit": 2}, [5, 6]),
        ({"before": 5, "limit": 2}, [3, 4]),
        ({"after": 2, "limit": 2}, [3, 4]),
        ({"after": 0, "limit": 2}, [1, 2]),
        ({"after": 2, "before": 5}, [3, 4]),
        ({"after": 1, "before": 6, "limit": 2}, [2, 3]),
        ({"before": 1}, []),
        ({"after": 6}, []),
        ({"message_id": 3, "limit": 1}, [1, 2, 3, 4, 5, 6]),
    ],
)
def test_reading_pages_keeps_order_and_exclusive_boundaries(
    world, params, expected
) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("pages", [MAIN])
    for number in range(6):
        human.send_message(room["id"], f"Message {number}")
    page = tools_for(world, MAIN).read_discussion(room["id"], **params)
    assert [item["id"] for item in page["messages"]] == expected
    assert page["total_messages"] == 6
    assert world.store.watermark(room["id"], MAIN) == (max(expected) if expected else 0)


@pytest.mark.parametrize(
    "params",
    [
        {"before": -1},
        {"after": True},
        {"before": "2"},
        {"limit": 0},
        {"limit": -1},
        {"limit": 1.5},
        {"message_id": 1, "before": 2},
        {"message_id": 1, "after": 0},
    ],
)
def test_invalid_pagination_does_not_advance_read_state(world, params) -> None:
    room = tools_for(world, HUMAN).create_discussion("pages", [MAIN])
    tools_for(world, HUMAN).send_message(room["id"], "@Main read this")
    with pytest.raises(DomainError) as error:
        tools_for(world, MAIN).read_discussion(room["id"], **params)
    assert error.value.code == "invalid_pagination"
    assert world.store.watermark(room["id"], MAIN) == 0
    assert len(world.store.pending(MAIN)) == 1


@pytest.mark.parametrize("actor_id", [HUMAN, MAIN])
def test_discussion_management_preserves_history_and_pending(world, actor_id) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("handoff", [MAIN, OTHER])["id"]
    untouched = human.create_discussion("separate", [MAIN])["id"]
    for body in ("@You @Main first", "@You @Main second"):
        tools_for(world, OTHER).send_message(room, body)
    actor = tools_for(world, actor_id)
    actor.read_discussion(room)
    actor.ack(room, [1])
    actor.remove_members(room, [actor_id])
    assert world.store.message_count(room) == 2
    assert world.store.acknowledged(room, actor_id) == (1,)
    assert world.store.pending(actor_id) == ()
    with pytest.raises(DomainError, match="do not belong"):
        actor.read_discussion(room)
    actor.add_members(room, [actor_id, actor_id])
    assert actor.read_discussion(room)["awaiting_ack"] == [2]
    actor.archive_discussion(room)
    assert world.store.pending(actor_id) == ()
    assert room not in [item["id"] for item in actor.list_discussions()]
    assert len(actor.search_messages("first", sender_id=OTHER, discussion_id=room)) == 1
    assert actor.search_messages("first", sender_id=HUMAN, discussion_id=room) == []
    assert actor.search_messages("first", discussion_id=untouched) == []
    actor.archive_discussion(room, False)
    restored = actor.read_discussion(room)
    assert (restored["awaiting_ack"], restored["archived"]) == ([2], False)
    actor.delete_discussion(room)
    assert world.store.pending(actor_id) == ()
    assert world.store.messages(room) == ()
    assert world.store.acknowledged(room, actor_id) == ()
    assert world.store.get_discussion(untouched) is not None
    with pytest.raises(DomainError, match="does not exist"):
        actor.read_discussion(room)


@pytest.mark.parametrize(
    ("method", "params", "capability"),
    [
        ("add_members", {"member_ids": [OTHER]}, "discussion.add_members"),
        ("remove_members", {"member_ids": [MAIN]}, "discussion.remove_members"),
        ("set_discussion_members", {"member_ids": [HUMAN]}, "discussion.set_members"),
        ("archive_discussion", {}, "discussion.archive"),
        ("archive_discussion", {"archived": False}, "discussion.unarchive"),
        ("delete_discussion", {}, "discussion.delete"),
    ],
)
def test_discussion_management_is_authorized_before_mutation(
    world, method, params, capability
) -> None:
    room = tools_for(world, HUMAN).create_discussion("guarded", [MAIN])["id"]
    original = world.store.get_discussion(room)
    seen = []

    def deny(actor, name, target):
        seen.append((actor.member_id, name, target))
        return "deny"

    emitted = []
    tools = tools_for(
        world,
        MAIN,
        authorizer=Authorizer(deny),
        on_change=lambda name, payload: emitted.append(name),
    )
    with pytest.raises(DomainError) as error:
        getattr(tools, method)(room, **params)
    assert error.value.code == "not_permitted"
    assert seen == [(MAIN, capability, room)]
    assert emitted == []
    assert world.store.get_discussion(room) == original


@pytest.mark.parametrize("method", ["add_members", "set_discussion_members"])
def test_invalid_members_are_rejected_without_partial_changes(world, method) -> None:
    room = tools_for(world, HUMAN).create_discussion("guarded", [MAIN])["id"]
    original = world.store.get_discussion(room)
    actor = tools_for(world, MAIN)
    with pytest.raises(DomainError, match="Unknown Members"):
        getattr(actor, method)(room, [OTHER, 999])
    assert world.store.get_discussion(room) == original
    world.store.delete_member(OTHER)
    with pytest.raises(DomainError, match="Unknown Members"):
        getattr(actor, method)(room, [OTHER])
    assert world.store.get_discussion(room) == original


def test_concurrent_member_changes_preserve_independent_updates(world) -> None:
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    human = tools_for(world, HUMAN)
    room = human.create_discussion("concurrent", [MAIN])["id"]
    barrier = Barrier(2)

    def add():
        barrier.wait()
        tools_for(world, MAIN).add_members(room, [OTHER])

    def remove():
        barrier.wait()
        human.remove_members(room, [MAIN])

    with ThreadPoolExecutor(max_workers=2) as pool:
        workers = [pool.submit(add), pool.submit(remove)]
        for worker in workers:
            worker.result(timeout=5)
    assert world.store.get_discussion(room).member_ids == frozenset([HUMAN, OTHER])


def test_creating_a_discussion_always_includes_the_creator(world) -> None:
    tools = tools_for(world, HUMAN)
    room = tools.create_discussion("plan the rewrite", [MAIN])
    assert room["member_ids"] == [HUMAN, MAIN]


def test_a_discussion_needs_at_least_one_other_member(world) -> None:
    with pytest.raises(DomainError) as error:
        tools_for(world, HUMAN).create_discussion("alone", [HUMAN])
    assert error.value.code == "needs_members"


def test_non_members_cannot_read_or_send(world) -> None:
    room = tools_for(world, HUMAN).create_discussion("private", [MAIN])
    outsider = tools_for(world, OTHER)
    with pytest.raises(DomainError) as error:
        outsider.read_discussion(room["id"])
    assert error.value.code == "not_a_member"
    with pytest.raises(DomainError):
        outsider.send_message(room["id"], "hello")


def test_reading_a_mention_returns_surrounding_context(world) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("context", [MAIN])
    human.send_message(room["id"], "background one")
    human.send_message(room["id"], "background two")
    human.send_message(room["id"], "@Main please look")

    result = tools_for(world, MAIN).read_discussion(room["id"], message_id=3)
    assert [item["id"] for item in result["messages"]] == [1, 2, 3]
    assert result["total_messages"] == 3


@pytest.mark.parametrize(
    ("watermark", "expected"),
    [(0, [3, 4, 5]), (2, [1, 2, 3, 4, 5])],
)
def test_reading_a_mention_preserves_context_boundaries(
    world, watermark: int, expected: list[int]
) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("context", [MAIN, OTHER])
    for body in (
        "Earlier background",
        "@Other handle another item",
        "Background for this item",
        "@Main please look",
        "More details",
    ):
        human.send_message(room["id"], body)
    tools_for(world, OTHER).send_message(room["id"], "A different sender")
    world.store.set_watermark(room["id"], MAIN, watermark)

    result = tools_for(world, MAIN).read_discussion(room["id"], message_id=4)

    assert result["read_through"] == watermark
    assert [item["id"] for item in result["messages"]] == expected


def test_reading_advances_the_watermark_and_clears_unread(world) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("unread", [MAIN])
    human.send_message(room["id"], "@Main hello")

    agent = tools_for(world, MAIN)
    assert agent.list_discussions()[0]["unread"] == 1
    agent.read_discussion(room["id"], message_id=1)
    assert agent.list_discussions()[0]["unread"] == 0


def test_ack_requires_the_message_to_have_been_read(world) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("ack", [MAIN])
    human.send_message(room["id"], "@Main do this")

    agent = tools_for(world, MAIN)
    with pytest.raises(DomainError) as error:
        agent.ack(room["id"], [1])
    assert error.value.code == "not_read"

    agent.read_discussion(room["id"], message_id=1)
    assert agent.ack(room["id"], [1])["acked"] == 1
    assert world.store.pending(MAIN) == ()


@pytest.mark.parametrize("member_id", [HUMAN, MAIN])
def test_members_only_revoke_their_own_acknowledgements(world, member_id: int) -> None:
    room = tools_for(world, HUMAN).create_discussion("review", [MAIN, OTHER])
    tools_for(world, OTHER).send_message(room["id"], "@You @Main please review")
    for actor in (HUMAN, MAIN):
        tools = tools_for(world, actor)
        tools.read_discussion(room["id"])
        tools.ack(room["id"], [1])
    tools = tools_for(world, member_id)
    assert tools.read_discussion(room["id"])["acknowledged"] == [1]

    assert tools.revoke_ack(room["id"], [1])["revoked"] == 1

    own = tools.read_discussion(room["id"])
    assert own["acknowledged"] == []
    assert own["awaiting_ack"] == [1]
    other = MAIN if member_id == HUMAN else HUMAN
    assert world.store.acknowledged(room["id"], other) == (1,)
    assert tools.revoke_ack(room["id"], [1])["revoked"] == 0
    world.store.set_discussion_members(room["id"], [other, OTHER])
    with pytest.raises(DomainError, match="do not belong"):
        tools.revoke_ack(room["id"], [1])


def test_sending_marks_your_own_message_as_read(world) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("self", [MAIN])
    human.send_message(room["id"], "mine")
    assert human.list_discussions()[0]["unread"] == 0


def test_search_only_returns_discussions_you_belong_to(world) -> None:
    human = tools_for(world, HUMAN)
    mine = human.create_discussion("mine", [MAIN])
    human.send_message(mine["id"], "findme here")

    assert len(tools_for(world, MAIN).search_messages("findme")) == 1
    assert tools_for(world, OTHER).search_messages("findme") == []


def test_duplicate_agent_names_are_rejected(world) -> None:
    with pytest.raises(DomainError) as error:
        tools_for(world, HUMAN).create_agent("main")
    assert error.value.code == "duplicate_name"


def test_running_agents_cannot_be_deleted(world) -> None:
    world.store.set_agent_state(MAIN, "running")
    with pytest.raises(DomainError) as error:
        tools_for(world, HUMAN).delete_agent(MAIN)
    assert error.value.code == "agent_running"

    world.store.set_agent_state(MAIN, "paused")
    assert tools_for(world, HUMAN).delete_agent(MAIN)["deleted"] is True


def test_library_conflict_returns_the_current_content(world) -> None:
    author = tools_for(world, MAIN)
    author.write_library("shared.md", "first")
    result = author.write_library("shared.md", "second", expected_hash="0" * 16)
    assert result["conflict"] is True
    assert result["current_content"] == "first"


def test_agent_library_write_emits_one_update_and_conflicts_emit_none(world) -> None:
    emitted = []
    author = tools_for(
        world, MAIN, on_change=lambda name, payload: emitted.append((name, payload))
    )
    written = author.write_library("shared.md", "first")
    assert emitted == [("library.updated", written)]
    assert emitted[0][1]["path"] == "shared.md"

    conflict = author.write_library("shared.md", "second", expected_hash="0" * 16)
    assert conflict["conflict"] is True
    assert len(emitted) == 1


def test_memory_is_private_to_each_agent(world) -> None:
    tools_for(world, MAIN).write_memory("notes.md", "mine")
    assert [item["path"] for item in tools_for(world, OTHER).list_memory()] == [
        "MEMORY.md"
    ]
    assert len(tools_for(world, MAIN).list_memory()) == 2


def test_library_is_shared_across_members(world) -> None:
    tools_for(world, MAIN).write_library("shared.md", "for everyone")
    assert (
        tools_for(world, OTHER).read_library("shared.md")["content"] == "for everyone"
    )


def test_authorization_hook_can_deny_a_capability(world) -> None:
    def deny_sending(actor, capability, target):
        return "deny" if capability == "discussion.send" else "allow"

    tools = tools_for(world, HUMAN, authorizer=Authorizer(deny_sending))
    room = tools.create_discussion("guarded", [MAIN])
    with pytest.raises(DomainError) as error:
        tools.send_message(room["id"], "blocked")
    assert error.value.code == "not_permitted"


def test_todo_hard_constraint_surfaces_through_the_tool(world) -> None:
    tools = tools_for(world, MAIN)
    first = tools.add_todo("one", "detail one")
    second = tools.add_todo("two")
    tools.start_todo(first["id"])
    with pytest.raises(DomainError) as error:
        tools.start_todo(second["id"])
    assert error.value.code == "todo_already_in_progress"


def test_read_reports_what_is_waiting_for_you(world) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("waiting", [MAIN])
    human.send_message(room["id"], "background")
    world.store.append_message(room["id"], MAIN, "@You please confirm")

    result = human.read_discussion(room["id"])
    assert result["awaiting_ack"] == [2]

    human.ack(room["id"], [2])
    assert human.read_discussion(room["id"])["awaiting_ack"] == []


def test_read_reports_the_position_you_had_reached_before_reading(world) -> None:
    human = tools_for(world, HUMAN)
    room = human.create_discussion("watermark", [MAIN])
    world.store.append_message(room["id"], MAIN, "one")
    world.store.append_message(room["id"], MAIN, "two")

    first = human.read_discussion(room["id"])
    assert first["read_through"] == 0

    world.store.append_message(room["id"], MAIN, "three")
    second = human.read_discussion(room["id"])
    assert second["read_through"] == 2
    assert second["awaiting_ack"] == []


def test_awaiting_ack_only_covers_the_discussion_you_read(world) -> None:
    human = tools_for(world, HUMAN)
    first = human.create_discussion("first", [MAIN])
    second = human.create_discussion("second", [MAIN])
    world.store.append_message(first["id"], MAIN, "@You here")
    world.store.append_message(second["id"], MAIN, "@You and here")

    assert human.read_discussion(first["id"])["awaiting_ack"] == [1]
    assert human.read_discussion(second["id"])["awaiting_ack"] == [1]


def test_a_turn_records_what_it_produced(world) -> None:
    tools = tools_for(world, MAIN, turn=TurnBinding(MAIN, 1))
    discussion = tools.create_discussion("Work", [OTHER])["id"]
    sent = tools.send_message(discussion, "Starting now")["id"]
    tools.run(["echo", "hi"])
    tools.write_library("notes.md", "content")

    recorded = world.history.effects(MAIN, sequences=[1])
    assert [item.tool for item in recorded] == [
        "send",
        "run",
        "library.write",
    ]
    assert str(sent) in recorded[0].summary


def test_tools_outside_a_turn_record_nothing(world) -> None:
    tools = tools_for(world, MAIN)
    discussion = tools.create_discussion("Work", [OTHER])["id"]
    tools.send_message(discussion, "Starting now")
    assert world.history.effects(MAIN) == ()


def test_an_acknowledging_turn_is_not_counted_as_productive(world) -> None:
    from huddol.core.turn import is_productive

    author = tools_for(world, OTHER)
    discussion = author.create_discussion("Work", [MAIN])["id"]
    message = author.send_message(discussion, "@Main please look")["id"]

    tools = tools_for(world, MAIN, turn=TurnBinding(MAIN, 1))
    tools.read_discussion(discussion, message)
    tools.ack(discussion, [message])

    recorded = world.history.effects(MAIN, sequences=[1])
    assert [item.tool for item in recorded] == ["ack"]
    assert not is_productive([item.tool for item in recorded])


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")
def test_library_run_records_effects_and_emits_each_changed_file(world) -> None:
    emitted = []
    tools = tools_for(
        world,
        MAIN,
        turn=TurnBinding(MAIN, 1),
        on_change=lambda name, payload: emitted.append((name, payload)),
    )
    tools.write_library("changed.txt", "before")
    tools.write_library("removed.txt", "gone")
    tools.write_library("unchanged.txt", "same")
    emitted.clear()
    result = tools.run_library(
        ["sh", "-c", "echo new > added.txt; echo after > changed.txt; rm removed.txt"]
    )
    assert result == {"exit_code": 0, "stdout": "", "stderr": "", "truncated": False}
    assert emitted == [
        (
            "library.updated",
            {"path": "added.txt", "hash": tools.read_library("added.txt")["hash"]},
        ),
        (
            "library.updated",
            {"path": "changed.txt", "hash": tools.read_library("changed.txt")["hash"]},
        ),
        ("library.updated", {"path": "removed.txt", "deleted": True}),
    ]
    effect = world.history.effects(MAIN, sequences=[1])[-1]
    assert effect.tool == "library.run"
    assert "sh -c echo new" in effect.summary and "exited 0" in effect.summary
    assert world.execution.snapshot().write_directories == ()


def test_library_run_forwards_only_the_library_root_for_each_cwd(
    world, monkeypatch
) -> None:
    tools = tools_for(world, MAIN)
    root = world.library_tree.root
    tools.mkdir_library("nested")
    calls = []
    environment = world.execution.snapshot()

    def run(argv, **params):
        calls.append((argv, params))
        return RunResult(3, "output", "error", True)

    monkeypatch.setattr(environment, "run", run)
    monkeypatch.setattr(world.execution, "snapshot", lambda: environment)
    for cwd, directory in (
        (None, root),
        ("nested", root / "nested"),
        (str(root / "nested"), root / "nested"),
    ):
        assert tools.run_library(["command"], cwd=cwd, timeout=7) == {
            "exit_code": 3,
            "stdout": "output",
            "stderr": "error",
            "truncated": True,
        }
        assert calls[-1] == (
            ["command"],
            {"cwd": str(directory), "timeout": 7, "write_directories": [str(root)]},
        )
    for cwd in (str(root.parent), "..", "missing"):
        with pytest.raises(DomainError) as error:
            tools.run_library(["command"], cwd=cwd)
        assert error.value.code == "invalid_cwd"
    assert len(calls) == 3


def test_library_run_emits_partial_changes_on_execution_error(
    world, monkeypatch
) -> None:
    emitted = []
    tools = tools_for(
        world, MAIN, on_change=lambda name, payload: emitted.append((name, payload))
    )
    environment = world.execution.snapshot()

    def run(*args, **params):
        world.library_tree.write("partial.txt", "partial")
        raise DomainError("timeout", "Command timed out")

    monkeypatch.setattr(environment, "run", run)
    monkeypatch.setattr(world.execution, "snapshot", lambda: environment)
    with pytest.raises(DomainError, match="timed out"):
        tools.run_library(["command"])
    assert emitted == [
        (
            "library.updated",
            {"path": "partial.txt", "hash": tools.read_library("partial.txt")["hash"]},
        )
    ]


def test_library_mutations_emit_path_deltas_and_record_effects(world) -> None:
    emitted = []
    tools = tools_for(
        world,
        MAIN,
        turn=TurnBinding(MAIN, 1),
        on_change=lambda name, payload: emitted.append((name, payload)),
    )
    assert tools.mkdir_library("notes") == {"path": "notes", "hash": None}
    written = tools.write_library("notes/file.txt", "before")
    result = tools.edit_library("notes/file.txt", "before", "after")
    assert "+after" in result["diff"]
    tools.move_library("notes", "renamed")
    tools.delete_library("renamed")
    assert emitted == [
        ("library.updated", {"path": "notes", "hash": None}),
        ("library.updated", {"path": "notes/file.txt", "hash": written["hash"]}),
        ("library.updated", {"path": "notes/file.txt", "hash": result["hash"]}),
        ("library.updated", {"path": "notes", "deleted": True}),
        ("library.updated", {"path": "renamed", "hash": None}),
        ("library.updated", {"path": "renamed", "deleted": True}),
    ]
    assert [effect.tool for effect in world.history.effects(MAIN, sequences=[1])] == [
        "library.mkdir",
        "library.write",
        "library.edit",
        "library.move",
        "library.delete",
    ]


def test_humans_can_read_other_agents_memory_but_agents_cannot(world) -> None:
    tools = tools_for(world, MAIN)
    tools.mkdir_memory("topics")
    tools.write_memory("topics/note.md", "private")
    tools.edit_memory("topics/note.md", "private", "updated")
    tools.move_memory("topics", "notes")
    human = tools_for(world, HUMAN)
    assert [entry["path"] for entry in human.list_memory(agent_id=MAIN)] == [
        "MEMORY.md",
        "notes",
        "notes/note.md",
    ]
    assert human.read_memory("notes/note.md", agent_id=MAIN)["content"] == "updated"
    assert tools.read_memory("notes/note.md", agent_id=MAIN)["content"] == "updated"
    other = tools_for(world, OTHER)
    for operation in (
        lambda: other.list_memory(agent_id=MAIN),
        lambda: other.read_memory("notes/note.md", agent_id=MAIN),
    ):
        with pytest.raises(DomainError) as error:
            operation()
        assert (
            error.value.code == "not_allowed"
            and str(error.value) == "Memory is private"
        )
    tools.delete_memory("notes")
    assert [entry["path"] for entry in human.list_memory(agent_id=MAIN)] == [
        "MEMORY.md"
    ]


@pytest.mark.parametrize(
    "method,args,capability",
    [
        ("edit_library", ("doc.txt", "old", "new"), "library.edit"),
        ("mkdir_library", ("folder",), "library.mkdir"),
        ("run_library", (["echo"],), "library.run"),
        ("edit_memory", ("doc.md", "old", "new"), "memory.edit"),
        ("mkdir_memory", ("folder",), "memory.mkdir"),
        ("move_memory", ("old.md", "new.md"), "memory.move"),
    ],
)
def test_tree_capabilities_are_checked_before_changes(
    world, method, args, capability
) -> None:
    calls = []

    def deny(actor, name, target):
        calls.append(name)
        return "deny"

    tools = tools_for(world, MAIN, authorizer=Authorizer(deny))
    with pytest.raises(DomainError) as error:
        getattr(tools, method)(*args)
    assert error.value.code == "not_permitted"
    assert calls == [capability]
    assert world.library_tree.list() == ()
