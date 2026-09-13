from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from huddol.adapters.execution.manager import ExecutionManager
from huddol.adapters.files.tree import MarkdownTree
from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore
from huddol.runtime.reminder import (
    TurnOutcome,
    TurnRequest,
    build_reminder,
    render_resident,
)
from huddol.runtime.scheduler import Scheduler
from huddol.tools import AgentTools, Dependencies

HUMAN = 1
MAIN = 2
HELPER = 3


class RecordingRunner:
    def __init__(self, behaviour=None) -> None:
        self.requests: list[TurnRequest] = []
        self._behaviour = behaviour

    def run(self, request: TurnRequest, tools: AgentTools) -> TurnOutcome:
        self.requests.append(request)
        if self._behaviour is not None:
            return self._behaviour(request, tools)
        return TurnOutcome(messages_json=json.dumps([{"kind": "response"}]))


@pytest.fixture
def world(tmp_path: Path):
    store = SqliteStore(tmp_path / "huddol.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")
    store.create_member("agent", "Main")
    store.create_member("agent", "Helper")

    def agent_directory_for(member_id: int) -> Path:
        path = tmp_path / "agents" / str(member_id)
        path.mkdir(parents=True, exist_ok=True)
        return path

    deps = Dependencies(
        store=store,
        todos=agent_store,
        history=agent_store,
        settings=agent_store,
        agent_directory_for=agent_directory_for,
        execution=ExecutionManager(
            settings={"directories": {"native": [str(tmp_path)]}},
            enforce=False,
        ),
        library_tree=MarkdownTree(tmp_path / "library"),
        memory_tree_for=lambda member_id: MarkdownTree(
            tmp_path / "agents" / str(member_id) / "memory"
        ),
    )
    yield deps
    store.close()


def mention(deps: Dependencies, body: str = "@Main please help") -> int:
    room = deps.store.create_discussion("work", [HUMAN, MAIN])
    deps.store.append_message(room.id, HUMAN, body)
    return room.id


def test_unavailable_execution_does_not_disable_business_tools(
    world, tmp_path: Path
) -> None:
    from huddol.core.errors import DomainError

    room = mention(world)
    world.execution.close()
    world.execution = ExecutionManager(settings={"environment": {"kind": "invalid"}})

    def respond(request, tools):
        assert request.resident == "Your MEMORY.md is empty.\n\nTodos: none"
        assert request.environment() is None
        assert tools.list_members()
        tools.send_message(room, "Business tools still work")
        with pytest.raises(DomainError):
            tools.run(["must-not-run"])
        return TurnOutcome(messages_json="[]")

    scheduler = Scheduler(world, RecordingRunner(respond))
    try:
        result = scheduler.run_turn(MAIN)
        assert result is not None and result.status == "completed"
        assert world.store.messages(room)[-1].body == "Business tools still work"
    finally:
        scheduler.stop()


def test_reminder_never_contains_the_message_body(world) -> None:
    mention(world, "@Main the secret passphrase is hunter2")
    reminder = build_reminder(world.store, world.history, MAIN, "Main")
    assert reminder is not None
    rendered = reminder.render()
    assert "hunter2" not in rendered
    assert "secret passphrase" not in rendered
    assert "Discussion 1" in rendered
    assert "Message 1" in rendered
    assert "discussion action=read" in rendered


def test_reminder_names_the_topic_and_sender(world) -> None:
    mention(world)
    reminder = build_reminder(world.store, world.history, MAIN, "Main")
    assert reminder is not None
    assert reminder.items[0].topic == "work"
    assert reminder.items[0].sender_name == "You"


def test_model_discussion_list_defaults_to_twenty(world, monkeypatch) -> None:
    from pydantic_ai import models
    from pydantic_ai.messages import (
        ModelResponse,
        RetryPromptPart,
        TextPart,
        ToolCallPart,
        ToolReturnPart,
    )
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.model.runner import PydanticModelRunner

    for day in range(1, 26):
        monkeypatch.setattr(
            "huddol.adapters.sqlite.store.now",
            lambda day=day: f"2026-01-{day:02}T00:00:00Z",
        )
        mention(world)
    actions = iter([{}, {"limit": 3}, {"limit": 30}, {"limit": 0}])
    returned = []
    retries = []

    def respond(messages, info):
        definition = next(
            tool for tool in info.function_tools if tool.name == "discussion"
        )
        assert "limit" in definition.parameters_json_schema["properties"]
        assert "defaults to 20" in definition.description
        for part in messages[-1].parts:
            if isinstance(part, ToolReturnPart):
                returned.append(part.content)
            elif isinstance(part, RetryPromptPart):
                retries.append(part.content)
        action = next(actions, None)
        return (
            ModelResponse(parts=[TextPart("Done")])
            if action is None
            else ModelResponse(
                parts=[ToolCallPart("discussion", {"action": "list", **action})]
            )
        )

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    world.settings.set_settings(
        "model",
        {"base_url": "https://example.invalid", "api_key": "unused", "model": "local"},
    )
    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    record = Scheduler(world, runner).run_turn(MAIN)
    assert record is not None and record.status == "completed", record
    assert [[item["id"] for item in page] for page in returned] == [
        list(range(25, 5, -1)),
        [25, 24, 23],
        list(range(25, 0, -1)),
    ]
    assert len(retries) == 1 and "invalid_pagination" in str(retries[0])


def test_model_can_manage_discussions_and_page_messages(world, monkeypatch) -> None:
    from pydantic_ai import models
    from pydantic_ai.messages import (
        ModelResponse,
        RetryPromptPart,
        TextPart,
        ToolCallPart,
        ToolReturnPart,
    )
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.model.runner import PydanticModelRunner

    room = mention(world, "@Main review this")
    world.store.append_message(room, HUMAN, "needle")
    world.store.append_message(room, HUMAN, "tail")
    actions = iter(
        [
            {"action": "add_members", "member_ids": [HELPER]},
            {"action": "read", "before": 3, "limit": 1},
            {"action": "read", "after": 0, "limit": 1},
            {"action": "read", "message_id": 2, "before": 3},
            {"action": "search", "query": "needle", "sender_id": HUMAN},
            {"action": "remove_members", "member_ids": [HELPER]},
            {"action": "archive"},
            {"action": "read", "message_id": 2, "limit": 1},
            {"action": "unarchive"},
            {"action": "delete"},
        ]
    )
    returned = []
    retries = []

    def respond(messages, info):
        definition = next(
            tool for tool in info.function_tools if tool.name == "discussion"
        )
        properties = definition.parameters_json_schema["properties"]
        assert set(properties["action"]["enum"]) == {
            "create",
            "list",
            "read",
            "send",
            "ack",
            "revoke_ack",
            "search",
            "add_members",
            "remove_members",
            "archive",
            "unarchive",
            "delete",
        }
        assert {"before", "after", "limit", "sender_id"} <= properties.keys()
        assert "permanently" in definition.description
        for part in messages[-1].parts:
            if isinstance(part, ToolReturnPart):
                returned.append(part.content)
            elif isinstance(part, RetryPromptPart):
                retries.append(part.content)
        action = next(actions, None)
        if action is None:
            return ModelResponse(parts=[TextPart("Done")])
        return ModelResponse(
            parts=[ToolCallPart("discussion", {"discussion_id": room, **action})]
        )

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    world.settings.set_settings(
        "model",
        {"base_url": "https://example.invalid", "api_key": "unused", "model": "local"},
    )
    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    emitted = []
    record = Scheduler(
        world, runner, on_event=lambda name, payload: emitted.append(name)
    ).run_turn(MAIN)
    assert record is not None
    assert record.status == "completed", record.error
    assert [name for name in emitted if name.startswith("discussion.")] == [
        "discussion.updated",
        "discussion.updated",
        "discussion.updated",
        "discussion.updated",
        "discussion.deleted",
    ]
    assert emitted[-1] == "turn.finished"
    assert len(retries) == 1 and "invalid_pagination" in str(retries[0])
    assert returned[0]["member_ids"] == [HUMAN, MAIN, HELPER]
    assert [item["id"] for item in returned[1]["messages"]] == [2]
    assert [item["id"] for item in returned[2]["messages"]] == [1]
    assert [item["id"] for item in returned[3]] == [2]
    assert returned[4]["member_ids"] == [HUMAN, MAIN]
    assert returned[5]["archived"] is True
    assert [item["id"] for item in returned[6]["messages"]] == [1, 2, 3]
    assert returned[7]["archived"] is False
    assert returned[8] == {"id": room, "deleted": True}
    assert world.store.get_discussion(room) is None
    assert world.history.latest_messages(MAIN) != "[]"


@pytest.mark.parametrize("actor_id", [HUMAN, MAIN])
def test_discussion_notifications_do_not_depend_on_the_caller_type(
    world, actor_id
) -> None:
    emitted = []
    scheduler = Scheduler(
        world, RecordingRunner(), on_event=lambda name, payload: emitted.append(name)
    )
    actor = scheduler.tools_for(actor_id)
    room = actor.create_discussion("Notifications", [HELPER])["id"]
    name = world.store.get_member(actor_id).name
    scheduler.tools_for(HELPER).send_message(room, f"@{name} please review")
    actor.read_discussion(room)
    actor.ack(room, [1])
    actor.revoke_ack(room, [1])
    assert emitted == [
        "discussion.created",
        "message.created",
        "mention.acked",
        "mention.revoked",
    ]


def test_lowering_compaction_threshold_resets_history_on_the_next_turn(
    world, monkeypatch
) -> None:

    from pydantic_ai import ModelMessagesTypeAdapter, models
    from pydantic_ai.messages import (
        ModelResponse,
        TextPart,
    )
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.jsonl.api import Api
    from huddol.adapters.jsonl.protocol import Dispatcher, parse
    from huddol.adapters.model.runner import PydanticModelRunner

    mention(world)
    world.settings.set_settings(
        "model",
        {
            "base_url": "https://example.invalid",
            "api_key": "unused",
            "model": "local",
            "compaction_threshold": 400000,
        },
    )
    received = []

    def respond(messages, info):
        received.append(len(messages))
        return ModelResponse(parts=[TextPart("Done")])

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    running = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    scheduler = Scheduler(world, running)
    first = scheduler.run_turn(MAIN)
    assert first is not None and first.status == "completed"
    second = scheduler.run_turn(MAIN)
    assert second is not None and second.status == "completed"
    assert received == [1, 3]
    output: list[dict] = []
    dispatcher = Dispatcher()
    Api(scheduler, dispatcher)
    update = parse(
        json.dumps(
            {
                "id": 1,
                "method": "settings.update",
                "params": {"section": "model", "values": {"compaction_threshold": 1}},
            }
        )
    )
    assert update is not None
    dispatcher.handle(update, output.append)
    assert output[-1]["result"]["compaction_threshold"] == 1
    reminder = build_reminder(world.store, world.history, MAIN, "Main")
    assert reminder is not None
    third = scheduler.run_turn(MAIN)
    assert third is not None and third.status == "completed"
    assert received == [1, 3, 1]
    saved = ModelMessagesTypeAdapter.validate_json(world.history.latest_messages(MAIN))
    assert len(saved) == 3
    assert saved[0].parts[0].content == scheduler.resident_block(MAIN)
    assert saved[0].metadata["huddol"]["block"] == "resident"
    assert saved[1].parts[0].content == reminder.render()
    assert saved[2].parts[0].content == "Done"


def test_no_reminder_without_pending_mentions(world) -> None:
    assert build_reminder(world.store, world.history, MAIN, "Main") is None


def test_turn_records_history_and_returns_to_idle(world) -> None:
    mention(world)
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    record = scheduler.run_turn(MAIN)
    assert record is not None
    assert record.status == "completed"
    assert world.store.get_member(MAIN).state == "idle"
    assert world.history.latest_messages(MAIN) == json.dumps([{"kind": "response"}])


@pytest.mark.parametrize("fail", [False, True])
def test_resident_is_persisted_and_stays_unchanged_until_a_reset(
    world, monkeypatch, fail
) -> None:
    from pydantic_ai import ModelMessagesTypeAdapter, models
    from pydantic_ai.messages import (
        ModelResponse,
        TextPart,
        ToolCallPart,
        ToolReturnPart,
        UserPromptPart,
    )
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.model.runner import PydanticModelRunner

    room = mention(world, "@Main keep the discussion text")
    received = []

    def respond(messages, info):
        received.append(ModelMessagesTypeAdapter.dump_json(messages).decode())
        if isinstance(messages[-1].parts[-1], ToolReturnPart):
            if fail:
                raise RuntimeError("local model failure")
            return ModelResponse(parts=[TextPart("Keep the model response")])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "discussion",
                    {"action": "read", "discussion_id": room, "message_id": 1},
                    tool_call_id=f"read-{len(received)}",
                )
            ]
        )

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    world.settings.set_settings(
        "model",
        {"base_url": "https://example.invalid", "api_key": "unused", "model": "local"},
    )
    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    scheduler = Scheduler(world, runner)
    tools = scheduler.tools_for(MAIN)
    memory = tools.write_memory("MEMORY.md", "MEMORY_STATE_OLD")
    old_todo = tools.add_todo("TASK_STATE_OLD")

    for turn, state in enumerate(("OLD", "NEW"), start=1):
        if state == "NEW":
            tools.write_memory(
                "MEMORY.md", "MEMORY_STATE_NEW", expected_hash=memory["hash"]
            )
            tools.complete_todo(old_todo["id"])
            tools.add_todo("TASK_STATE_NEW")
        reminder = build_reminder(world.store, world.history, MAIN, "Main")
        assert reminder is not None
        start = len(received)

        record = scheduler.run_turn(MAIN)

        assert record is not None
        assert record.status == ("failed" if fail else "completed")
        assert len(received) == start + 2
        for request in received[start:]:
            assert "MEMORY_STATE_OLD" in request
            assert "TASK_STATE_OLD" in request
            assert "MEMORY_STATE_NEW" not in request
            assert "TASK_STATE_NEW" not in request
        saved = world.history.latest_messages(MAIN)
        assert "MEMORY_STATE_OLD" in saved
        assert "TASK_STATE_OLD" in saved
        messages = ModelMessagesTypeAdapter.validate_json(saved)
        prompts = [
            part.content
            for message in messages
            for part in message.parts
            if isinstance(part, UserPromptPart)
        ]
        assert len(prompts) == turn + 1
        assert prompts[-1] == reminder.render()
        assert "@Main keep the discussion text" in saved
        assert (
            sum(
                isinstance(part, ToolCallPart)
                for message in messages
                for part in message.parts
            )
            == turn
        )
        assert (
            sum(
                isinstance(part, ToolReturnPart)
                for message in messages
                for part in message.parts
            )
            == turn
        )
        if not fail:
            assert "Keep the model response" in saved

    world.settings.set_settings(
        "model", {**world.settings.get_settings("model"), "compaction_threshold": 1}
    )
    record = scheduler.run_turn(MAIN)
    assert record is not None and record.status == ("failed" if fail else "completed")
    saved = world.history.latest_messages(MAIN)
    assert "MEMORY_STATE_NEW" in saved and "TASK_STATE_NEW" in saved
    assert "MEMORY_STATE_OLD" not in saved and "TASK_STATE_OLD" not in saved
    assert saved.count('"block":"resident"') == 1


@pytest.mark.parametrize("threshold", [1, 400_000])
def test_history_is_preserved_or_reset_without_rewriting_old_prompts(
    world, monkeypatch, threshold: int
) -> None:
    from pydantic_ai import ModelMessagesTypeAdapter, models
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.model.runner import PydanticModelRunner

    mention(world)
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    world.settings.set_settings(
        "model",
        {
            "base_url": "https://example.invalid",
            "api_key": "unused",
            "model": "local",
            "compaction_threshold": threshold,
        },
    )
    runner = PydanticModelRunner(
        world.settings,
        build_model=lambda config: FunctionModel(
            lambda messages, info: ModelResponse(parts=[TextPart("New response")])
        ),
    )
    scheduler = Scheduler(world, runner)
    reminder = build_reminder(world.store, world.history, MAIN, "Main")
    assert reminder is not None
    prompt = f"{reminder.render()}\n\n{scheduler.resident_block(MAIN)}"
    prior = []
    for index in range(6):
        prior.extend(
            [
                ModelRequest(parts=[UserPromptPart(prompt)], metadata={"index": index}),
                ModelResponse(parts=[TextPart(f"Saved response {index}")]),
            ]
        )
    original = ModelMessagesTypeAdapter.dump_json(prior).decode()
    old_run = world.history.start_run(MAIN)
    world.history.finish_run(
        MAIN, old_run.sequence, status="completed", messages_json=original
    )

    record = scheduler.run_turn(MAIN)

    assert record is not None and record.status == "completed"
    saved = ModelMessagesTypeAdapter.validate_json(world.history.latest_messages(MAIN))
    if threshold == 1:
        assert len(saved) == 3
        assert saved[0].parts[0].content == scheduler.resident_block(MAIN)
    else:
        assert saved[: len(prior)] == prior
        assert saved[-2].metadata == {
            "huddol": {"block": "durable", "environment": scheduler.environment_facts()}
        }
    assert (
        saved[1 if threshold == 1 else len(prior)].parts[0].content == reminder.render()
    )
    assert saved[-1].parts[0].content == "New response"
    assert world.history.runs(MAIN)[1].messages_json == original


def test_resident_carries_memory_todo_details_and_environment(
    world, tmp_path: Path
) -> None:
    mention(world)
    MarkdownTree(world.memory_tree_for(MAIN).root).write(
        "MEMORY.md", "- prior knowledge"
    )
    world.todos.add_todo(MAIN, "unfinished work", "detail")
    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    context = runner.requests[0].resident
    assert context == (
        "Your MEMORY.md:\n- prior knowledge\n\n"
        "Todos:\n- [ ] 1. unfinished work\n  detail\n\n"
        f"Execution environment: native ({sys.platform})\n"
        f"Writable directories:\n- {tmp_path}"
    )


@pytest.mark.parametrize("environment", [None, "environment facts"])
@pytest.mark.parametrize("memory", ["", "remember this"])
def test_render_resident_orders_only_the_requested_blocks(memory, environment) -> None:
    expected = (
        "Your MEMORY.md:\nremember this" if memory else "Your MEMORY.md is empty."
    )
    expected += "\n\nTodos: none"
    if environment is not None:
        expected += "\n\nenvironment facts"
    assert render_resident(memory, "Todos: none", environment) == expected


def test_resident_loading_failure_preserves_history_and_returns_to_idle(
    world, monkeypatch
) -> None:
    mention(world)
    scheduler = Scheduler(world, RecordingRunner())
    scheduler.run_turn(MAIN)
    previous = world.history.latest_messages(MAIN)

    def fail(agent_id):
        raise OSError("memory is unreadable")

    monkeypatch.setattr(scheduler, "resident_block", fail)
    record = scheduler.run_turn(MAIN)
    assert record is not None and record.status == "failed"
    assert "memory is unreadable" in record.error
    assert world.history.latest_messages(MAIN) == previous
    assert world.store.get_member(MAIN).state == "idle"


def test_a_failing_turn_is_recorded_and_the_agent_recovers(world) -> None:
    mention(world)

    def explode(request, tools):
        raise RuntimeError("model exploded")

    scheduler = Scheduler(world, RecordingRunner(explode))
    record = scheduler.run_turn(MAIN)
    assert record is not None
    assert record.status == "failed"
    assert "model exploded" in (record.error or "")
    assert world.store.get_member(MAIN).state == "idle"


def test_a_failed_turn_is_not_restarted_on_the_same_pending(world) -> None:
    room = mention(world)
    failing = RecordingRunner(
        lambda request, tools: TurnOutcome(messages_json="[]", error="no model")
    )
    scheduler = Scheduler(world, failing)
    try:
        assert scheduler.tick() == (MAIN,)
        scheduler._threads[MAIN].join(timeout=5)
        runs = world.history.runs(MAIN)
        assert [run.status for run in runs] == ["failed"]
        assert world.store.get_member(MAIN).state == "idle"
        assert world.store.pending(MAIN)

        assert scheduler.runnable_agents() == ()
        assert scheduler.tick() == ()
        assert len(world.history.runs(MAIN)) == 1

        world.store.append_message(room, HUMAN, "@Main are you there?")
        assert scheduler.runnable_agents() == (MAIN,)
        record = scheduler.run_turn(MAIN)
        assert record is not None and record.status == "failed"
        assert len(world.history.runs(MAIN)) == 2
        assert scheduler.runnable_agents() == ()

        scheduler._runner = RecordingRunner()
        assert scheduler.runnable_agents() == ()
        world.store.append_message(room, HUMAN, "@Main once more")
        assert scheduler.runnable_agents() == (MAIN,)
        record = scheduler.run_turn(MAIN)
        assert record is not None and record.status == "completed"
        assert scheduler._failed == {}
        assert scheduler.runnable_agents() == (MAIN,)
    finally:
        scheduler.stop()


def test_paused_agents_are_not_runnable(world) -> None:
    mention(world)
    world.store.set_agent_state(MAIN, "paused")
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.runnable_agents() == ()
    assert scheduler.run_turn(MAIN) is None


def test_only_agents_with_pending_work_are_runnable(world) -> None:
    mention(world)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.runnable_agents() == (MAIN,)


def test_acking_inside_the_turn_stops_the_next_one(world) -> None:
    room = mention(world)

    def handle(request, tools):
        tools.read_discussion(room, message_id=1)
        tools.ack(room, [1])
        return TurnOutcome(messages_json="[]")

    scheduler = Scheduler(world, RecordingRunner(handle))
    scheduler.run_turn(MAIN)
    assert scheduler.runnable_agents() == ()


def test_an_agent_can_reopen_its_own_acknowledgement(world, monkeypatch) -> None:
    from pydantic_ai import models
    from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.model.runner import PydanticModelRunner

    room = mention(world)
    actions = iter(("read", "ack", "revoke_ack"))
    results = []

    def respond(messages, info):
        action = next(actions, None)
        if action is None:
            results.append(messages[-1].parts[0].content)
            return ModelResponse(parts=[TextPart("Reopened")])
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "discussion",
                    {"action": action, "discussion_id": room, "message_id": 1},
                    tool_call_id=action,
                )
            ]
        )

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    world.settings.set_settings(
        "model",
        {"base_url": "https://example.invalid", "api_key": "unused", "model": "local"},
    )
    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )

    record = Scheduler(world, runner).run_turn(MAIN)

    assert record is not None and record.status == "completed"
    assert results == [{"discussion_id": room, "revoked": 1}]
    assert world.store.acknowledged(room, MAIN) == ()
    assert [item.message_id for item in world.store.pending(MAIN)] == [1]


def test_an_agent_can_wake_another_by_mentioning_it(world) -> None:
    room = mention(world)
    world.store.set_discussion_members(room, [HUMAN, MAIN, HELPER])

    def handle(request, tools):
        tools.read_discussion(room, message_id=1)
        tools.send_message(room, "@Helper your turn")
        tools.ack(room, [1])
        return TurnOutcome(messages_json="[]")

    scheduler = Scheduler(world, RecordingRunner(handle))
    scheduler.run_turn(MAIN)
    assert scheduler.runnable_agents() == (HELPER,)


def test_events_are_emitted_around_a_turn(world) -> None:
    mention(world)
    seen: list[str] = []
    scheduler = Scheduler(
        world, RecordingRunner(), on_event=lambda name, payload: seen.append(name)
    )
    scheduler.run_turn(MAIN)
    assert seen == ["turn.started", "turn.finished"]


def test_previously_reminded_is_flagged_on_the_second_turn(world) -> None:
    mention(world)
    scheduler = Scheduler(world, RecordingRunner())
    first = build_reminder(world.store, world.history, MAIN, "Main")
    assert first is not None
    assert first.items[0].previously_reminded is False

    scheduler.run_turn(MAIN)
    second = build_reminder(world.store, world.history, MAIN, "Main")
    assert second is not None
    assert second.items[0].previously_reminded is True
    assert "still waiting" in second.render()


def test_compacted_content_stays_retrievable_through_history(world) -> None:
    mention(world)
    from huddol.services.history import History

    early = json.dumps(
        [
            {
                "kind": "request",
                "parts": [{"part_kind": "user-prompt", "content": "bubblewrap notes"}],
            },
            {"kind": "response", "parts": [{"part_kind": "text", "content": "noted"}]},
        ]
    )
    first = world.history.start_run(MAIN)
    world.history.finish_run(
        MAIN, first.sequence, status="completed", messages_json=early
    )

    later = json.dumps([{"kind": "response", "parts": []}])
    second = world.history.start_run(MAIN)
    world.history.finish_run(
        MAIN, second.sequence, status="completed", messages_json=later
    )

    assert "bubblewrap" not in world.history.latest_messages(MAIN)
    found = History(world.history, MAIN).search("bubblewrap")
    assert [item.sequence for item in found] == [first.sequence]


def test_a_long_back_and_forth_produces_a_nudge(world) -> None:
    room = world.store.create_discussion("ping pong", [HUMAN, MAIN, HELPER])
    for index in range(6):
        sender = MAIN if index % 2 == 0 else HELPER
        world.store.append_message(room.id, sender, f"turn {index}")
    world.store.append_message(room.id, HELPER, "@Main again")

    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    context = runner.requests[0].ephemeral()
    assert "exchanged" in context
    assert "Helper" in context
    assert "acknowledge instead of mentioning them again" in context


def test_no_nudge_when_a_third_member_is_involved(world) -> None:
    room = world.store.create_discussion("group", [HUMAN, MAIN, HELPER])
    for index in range(6):
        sender = [MAIN, HELPER, HUMAN][index % 3]
        world.store.append_message(room.id, sender, f"turn {index} @Main")

    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    assert runner.requests[0].ephemeral() == ""


def test_no_nudge_for_a_short_exchange(world) -> None:
    room = world.store.create_discussion("brief", [HUMAN, MAIN])
    world.store.append_message(room.id, MAIN, "one")
    world.store.append_message(room.id, HUMAN, "two @Main")

    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    assert runner.requests[0].ephemeral() == ""


def test_no_nudge_for_an_exchange_you_are_not_part_of(world) -> None:
    room = world.store.create_discussion("others", [HUMAN, MAIN, HELPER])
    for index in range(6):
        sender = HUMAN if index % 2 == 0 else HELPER
        world.store.append_message(room.id, sender, f"turn {index} @Main")

    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    assert runner.requests[0].ephemeral() == ""


def test_the_nudge_reaches_the_model_but_not_the_history(world) -> None:
    room = mention(world)
    world.store.set_discussion_members(room, [HUMAN, MAIN, HELPER])
    for index in range(6):
        sender = MAIN if index % 2 == 0 else HELPER
        world.store.append_message(room, sender, f"turn {index}")
    world.store.append_message(room, HELPER, "@Main once more")

    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    assert "exchanged" in runner.requests[0].ephemeral()
    world.store.append_message(room, HUMAN, "A third participant")
    assert runner.requests[0].ephemeral() == ""
    assert "exchanged" not in world.history.latest_messages(MAIN)


def test_stop_is_safe_while_a_turn_is_being_started(world) -> None:
    import threading

    scheduler = Scheduler(world, RecordingRunner())
    never_started = threading.Thread(target=lambda: None)
    scheduler._threads[MAIN] = never_started
    scheduler.stop()


def test_stop_waits_for_a_running_turn(world) -> None:
    import threading

    release = threading.Event()

    def slow(request, tools):
        release.wait(timeout=5)
        return TurnOutcome(messages_json="[]")

    mention(world)
    scheduler = Scheduler(world, RecordingRunner(slow))
    assert scheduler.tick() == (MAIN,)
    release.set()
    scheduler.stop()
    assert world.store.get_member(MAIN).state == "idle"


def test_the_scheduler_loop_is_joined_on_stop(world) -> None:
    scheduler = Scheduler(world, RecordingRunner())
    scheduler.start(poll_seconds=0.01)
    assert scheduler._loop is not None
    loop = scheduler._loop
    scheduler.stop()
    assert loop.is_alive() is False


def test_starting_twice_keeps_a_single_loop(world) -> None:
    scheduler = Scheduler(world, RecordingRunner())
    scheduler.start(poll_seconds=0.01)
    first = scheduler._loop
    scheduler.start(poll_seconds=0.01)
    assert scheduler._loop is first
    scheduler.stop()


def spend(world, agent_id: int, tokens: int) -> None:
    run = world.history.start_run(agent_id)
    world.history.finish_run(
        agent_id,
        run.sequence,
        status="completed",
        messages_json="[]",
        usage_json=json.dumps({"input_tokens": tokens, "output_tokens": 0}),
    )


def test_an_agent_over_its_token_limit_is_not_scheduled(world) -> None:
    mention(world)
    world.settings.set_settings("limits", {"agent_token_limit": 500})
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.runnable_agents() == (MAIN,)

    spend(world, MAIN, 500)
    assert scheduler.over_token_limit(MAIN)
    assert scheduler.runnable_agents() == ()


def test_raising_the_limit_lets_the_agent_run_again(world) -> None:
    mention(world)
    world.settings.set_settings("limits", {"agent_token_limit": 100})
    spend(world, MAIN, 400)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.runnable_agents() == ()

    world.settings.set_settings("limits", {"agent_token_limit": 1000})
    assert scheduler.runnable_agents() == (MAIN,)


def test_no_limit_configured_means_no_ceiling(world) -> None:
    mention(world)
    spend(world, MAIN, 10_000_000)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.token_limit() == 0
    assert not scheduler.over_token_limit(MAIN)
    assert scheduler.runnable_agents() == (MAIN,)


def test_a_malformed_limit_is_treated_as_no_limit(world) -> None:
    mention(world)
    world.settings.set_settings("limits", {"agent_token_limit": "not a number"})
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.token_limit() == 0
    assert scheduler.runnable_agents() == (MAIN,)


def test_the_limit_is_per_agent_not_shared(world) -> None:
    mention(world)
    world.settings.set_settings("limits", {"agent_token_limit": 500})
    spend(world, HELPER, 900)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.over_token_limit(HELPER)
    assert scheduler.runnable_agents() == (MAIN,)
