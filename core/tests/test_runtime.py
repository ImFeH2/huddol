from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from huddol.adapters.execution.manager import ExecutionManager
from huddol.adapters.files.tree import DirectoryTree
from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore
from huddol.ports.agent import WindowState
from huddol.runtime.reminder import (
    PREPARATION_PROMPT,
    TurnOutcome,
    TurnRequest,
    build_reminder,
    render_resident,
    reset_notice,
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
        history=agent_store,
        settings=agent_store,
        agent_directory_for=agent_directory_for,
        execution=ExecutionManager(
            settings={"write_directories": [str(tmp_path)]},
            enforce=False,
        ),
        library_tree=DirectoryTree(tmp_path / "library"),
        workspace_tree_for=lambda member_id: DirectoryTree(
            tmp_path / "agents" / str(member_id) / "workspace"
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
    world.execution = ExecutionManager(settings={"legacy": "invalid"})

    def respond(request, tools):
        assert request.resident == "Your MEMORY.md is empty."
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
        }
        assert {"before", "after", "limit", "sender_id"} <= properties.keys()
        assert (
            "Archive is reversible and is the only way to put a Discussion away."
            in definition.description
        )
        assert (
            "Each message lists its mentions; an @Name that is not listed there notified nobody."
            in definition.description
        )
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
    assert len(returned) == 8
    assert world.store.get_discussion(room) is not None
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


def test_lowering_the_window_budget_schedules_preparation(world, monkeypatch) -> None:
    from pydantic_ai import ModelMessagesTypeAdapter, models
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel
    from pydantic_ai.usage import RequestUsage

    from huddol.adapters.model.runner import PydanticModelRunner

    mention(world)
    world.settings.set_settings(
        "model",
        {"base_url": "https://example.invalid", "api_key": "unused", "model": "local"},
    )
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    runner = PydanticModelRunner(
        world.settings,
        build_model=lambda config: FunctionModel(
            lambda messages, info: ModelResponse(
                parts=[TextPart("Done")], usage=RequestUsage(input_tokens=100)
            )
        ),
    )
    scheduler = Scheduler(world, runner)
    assert scheduler.run_turn(MAIN).status == "completed"
    assert not scheduler.preparation_due(MAIN)
    world.settings.set_settings("agent", {"context_window_tokens": 100})
    assert scheduler.preparation_due(MAIN)
    assert scheduler.run_turn(MAIN).status == "completed"
    runs = world.history.runs(MAIN)
    saved = ModelMessagesTypeAdapter.validate_json(runs[0].messages_json)
    assert saved[-2].parts[0].content == PREPARATION_PROMPT
    assert world.history.latest_messages(MAIN) == "[]"
    assert scheduler.run_turn(MAIN) is None
    mention(world)
    assert scheduler.run_turn(MAIN).status == "completed"
    saved = ModelMessagesTypeAdapter.validate_json(world.history.latest_messages(MAIN))
    assert len(saved) == 3
    assert saved[0].parts[0].content == scheduler.resident_block(MAIN)
    assert saved[0].metadata["huddol"]["block"] == "resident"
    assert saved[0].parts[0].content.endswith(reset_notice(world.history.window(MAIN)))


@pytest.mark.parametrize("first_status", ["completed", "failed"])
@pytest.mark.parametrize(
    "preparation_status", ["completed", "failed", "exception", "overflow"]
)
def test_preparation_runs_without_pending_and_resets_after_any_outcome(
    world, first_status, preparation_status
) -> None:
    room = mention(world)
    world.settings.set_settings("agent", {"context_window_tokens": 100})
    events = []

    def respond(request, tools):
        if request.reminder is not None:
            tools.read_discussion(room)
            tools.ack(room, [1])
            return TurnOutcome(
                messages_json='[{"text":"saved"}]',
                usage_json='{"input_tokens":100,"last_input_tokens":100}',
                input_tokens=100,
                error="failure" if first_status == "failed" else None,
            )
        assert request.prompt == PREPARATION_PROMPT
        assert request.ephemeral() == ""
        if preparation_status == "exception":
            raise RuntimeError("preparation failed")
        return TurnOutcome(
            messages_json='[{"text":"notes saved"}]',
            error="preparation failed" if preparation_status != "completed" else None,
            context_exceeded=preparation_status == "overflow",
        )

    runner = RecordingRunner(respond)
    scheduler = Scheduler(
        world, runner, on_event=lambda name, payload: events.append((name, payload))
    )
    assert scheduler.run_turn(MAIN).status == first_status
    assert world.store.pending(MAIN) == ()
    assert scheduler.preparation_due(MAIN)
    assert scheduler.runnable_agents() == (MAIN,)
    restarted = Scheduler(world, runner)
    assert restarted.preparation_due(MAIN)
    assert restarted.runnable_agents() == (MAIN,)
    record = scheduler.run_turn(MAIN)
    assert record.status == (
        "completed" if preparation_status == "completed" else "failed"
    )
    assert runner.requests[-1].reminder is None
    assert runner.requests[-1].history_json == '[{"text":"saved"}]'
    state = world.history.window(MAIN)
    assert state.number == 2 and state.since_sequence == 3
    assert state.reason == "prepared" and state.reset_at is not None
    assert world.history.latest_messages(MAIN) == "[]"
    assert not scheduler.preparation_due(MAIN)
    assert not restarted.preparation_due(MAIN)
    assert scheduler.runnable_agents() == ()
    assert events == [
        (
            "turn.started",
            {"agent_id": MAIN, "sequence": 1, "items": 1, "kind": "reminder"},
        ),
        ("mention.acked", {"discussion_id": room, "acked": 1}),
        ("turn.finished", {"agent_id": MAIN, "sequence": 1, "status": first_status}),
        (
            "turn.started",
            {"agent_id": MAIN, "sequence": 2, "items": 0, "kind": "preparation"},
        ),
        *(
            [("organization.changed", {"id": MAIN, "state": "paused"})]
            if preparation_status == "exception"
            else []
        ),
        ("window.reset", {"agent_id": MAIN, "number": 2, "reason": "prepared"}),
        ("turn.finished", {"agent_id": MAIN, "sequence": 2, "status": record.status}),
    ]
    world.store.append_message(room, HUMAN, "@Main next task")
    if preparation_status == "exception":
        assert scheduler.run_turn(MAIN) is None
        scheduler.tools_for(HUMAN).resume_agent(MAIN)
    assert scheduler.run_turn(MAIN).status == first_status
    following = runner.requests[-1]
    assert following.agent_id == MAIN and following.agent_name == "Main"
    assert following.reminder is not None
    assert following.prompt == following.reminder.render()
    assert following.history_json == "[]"
    assert following.resident.endswith(reset_notice(state))


@pytest.mark.parametrize("fresh", [False, True])
def test_overflow_resets_only_after_an_earlier_run_and_waits_for_changed_mentions(
    world, fresh
) -> None:
    mention(world)
    if fresh:
        world.history.reset_window(MAIN, "prepared")
    events = []
    runner = RecordingRunner()
    scheduler = Scheduler(
        world, runner, on_event=lambda name, payload: events.append((name, payload))
    )
    assert scheduler.run_turn(MAIN).status == "completed"
    prior = world.history.latest_messages(MAIN)
    runner._behaviour = lambda request, tools: TurnOutcome(
        messages_json=prior, error="too long", context_exceeded=True
    )
    previous = world.history.window(MAIN)
    mention(world)
    scheduler._wake.clear()
    assert scheduler.run_turn(MAIN).status == "failed"
    state = world.history.window(MAIN)
    assert state.number == previous.number + 1
    assert state.reason == "overflow" and state.since_sequence == 3
    assert world.history.latest_messages(MAIN) == "[]"
    assert scheduler.run_turn(MAIN) is None
    assert scheduler.tick() == ()
    assert scheduler._wake.is_set()
    assert (
        "window.reset",
        {"agent_id": MAIN, "number": state.number, "reason": "overflow"},
    ) in events
    try:
        mention(world)
        assert scheduler.tick() == (MAIN,)
        scheduler._threads[MAIN].join(timeout=5)
        assert not scheduler._threads[MAIN].is_alive()
        following = runner.requests[-1]
        assert following.history_json == "[]"
        assert following.reminder is not None
        assert following.resident.endswith(reset_notice(state))
        assert world.history.window(MAIN) == state
        assert world.history.last_reminder(MAIN) == scheduler.pending_keys(MAIN)
        assert scheduler.tick() == ()
    finally:
        scheduler.stop()


@pytest.mark.parametrize("fresh", [False, True])
def test_first_turn_overflow_is_an_ordinary_failure(world, fresh) -> None:
    mention(world)
    if fresh:
        spend(world, MAIN, 1)
        world.history.reset_window(MAIN, "prepared")
    state = world.history.window(MAIN)
    events = []
    runner = RecordingRunner(
        lambda request, tools: TurnOutcome(
            messages_json='[{"text":"partial"}]',
            error="too long",
            context_exceeded=True,
        )
    )
    scheduler = Scheduler(
        world, runner, on_event=lambda name, payload: events.append(name)
    )
    assert scheduler.run_turn(MAIN).status == "failed"
    assert world.history.window(MAIN) == state
    assert world.history.last_reminder(MAIN) == scheduler.pending_keys(MAIN)
    assert scheduler.tick() == ()
    assert world.history.latest_messages(MAIN) == '[{"text":"partial"}]'
    assert "window.reset" not in events


@pytest.mark.parametrize("status", ["completed", "failed", "interrupted", "running"])
@pytest.mark.parametrize("tokens", [None, 99, 100, 101])
def test_preparation_uses_the_latest_finished_run_in_the_current_window(
    world, status, tokens
) -> None:
    world.settings.set_settings("agent", {"context_window_tokens": 100})
    scheduler = Scheduler(world, RecordingRunner())
    assert not scheduler.preparation_due(MAIN)
    for run_status, count in [("completed", 200), (status, tokens)]:
        run = world.history.start_run(MAIN)
        world.history.finish_run(
            MAIN,
            run.sequence,
            status=run_status,
            messages_json="[]",
            usage_json=json.dumps({"last_input_tokens": count}),
        )
    assert scheduler.preparation_due(MAIN) == (
        status in ("completed", "failed") and tokens is not None and tokens >= 100
    )
    world.history.reset_window(MAIN, "prepared")
    assert not scheduler.preparation_due(MAIN)


def test_token_limit_and_member_state_still_block_preparation(world) -> None:
    world.settings.set_settings("agent", {"context_window_tokens": 100})
    run = world.history.start_run(MAIN)
    world.history.finish_run(
        MAIN,
        run.sequence,
        status="completed",
        messages_json="[]",
        usage_json='{"input_tokens":100,"last_input_tokens":100}',
    )
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    assert scheduler.preparation_due(MAIN)
    world.settings.set_settings(
        "agent", {"context_window_tokens": 100, "token_limit": 100}
    )
    assert scheduler.runnable_agents() == ()
    assert scheduler.run_turn(MAIN) is None
    world.settings.set_settings(
        "agent", {"context_window_tokens": 100, "token_limit": 101}
    )
    world.store.set_agent_state(MAIN, "paused")
    assert scheduler.runnable_agents() == ()
    assert scheduler.run_turn(MAIN) is None
    world.store.set_agent_state(MAIN, "idle")
    assert scheduler.runnable_agents() == (MAIN,)
    assert scheduler.run_turn(MAIN).status == "completed"
    assert runner.requests[-1].prompt == PREPARATION_PROMPT


def test_preparation_does_not_record_pending_mentions_as_reminded(world) -> None:
    room = mention(world)
    run = world.history.start_run(MAIN)
    world.history.finish_run(
        MAIN,
        run.sequence,
        status="completed",
        messages_json="[]",
        usage_json='{"last_input_tokens":200000}',
    )
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    assert scheduler.run_turn(MAIN).status == "completed"
    assert runner.requests[-1].reminder is None
    assert world.history.previously_reminded(MAIN, [(room, 1)]) == frozenset()
    assert scheduler.run_turn(MAIN).status == "completed"
    assert not runner.requests[-1].reminder.items[0].previously_reminded


def test_reset_notices_use_the_exact_window_timestamp() -> None:
    assert reset_notice(WindowState(1, 1, None, None)) is None
    assert reset_notice(WindowState(2, 3, "STAMP", "prepared")) == (
        "Your context window was reset at STAMP after you saved your notes. "
        "Use the history tool for anything older."
    )
    assert reset_notice(WindowState(2, 3, "STAMP", "overflow")) == (
        "Your context window was reset at STAMP in the middle of a Turn because it "
        "overflowed, so you could not save notes first. Use the history tool to see "
        "what you were doing."
    )


def test_no_reminder_without_pending_mentions(world) -> None:
    assert build_reminder(world.store, world.history, MAIN, "Main") is None


@pytest.mark.parametrize("fail", [False, True])
def test_unchanged_mentions_wait_across_restart_and_resume(world, fail) -> None:
    mention(world)
    runner = RecordingRunner(
        lambda request, tools: TurnOutcome(
            messages_json="[]", error="failure" if fail else None
        )
    )
    scheduler = Scheduler(world, runner)
    assert scheduler.run_turn(MAIN) is not None
    world.store.set_agent_state(MAIN, "paused")
    assert scheduler.run_turn(MAIN) is None
    world.store.set_agent_state(MAIN, "idle")
    restarted = Scheduler(world, runner)
    for current in (scheduler, restarted):
        assert current.runnable_agents() == ()
        assert current.run_turn(MAIN) is None
    assert len(runner.requests) == 1


@pytest.mark.parametrize("change", ["partial_ack", "all_ack", "new_mention"])
@pytest.mark.parametrize("fail", [False, True])
def test_next_turn_compares_mentions_with_the_start_of_the_previous_turn(
    world, change, fail
) -> None:
    room = mention(world)
    world.store.append_message(room, HUMAN, "@Main another task")

    def respond(request, tools):
        if request.sequence == 1:
            tools.read_discussion(room)
            if change == "partial_ack":
                tools.ack(room, [1])
            elif change == "all_ack":
                tools.ack(room, [1, 2])
            else:
                world.store.append_message(room, HUMAN, "@Main arrived during the turn")
        return TurnOutcome(messages_json="[]", error="failure" if fail else None)

    scheduler = Scheduler(world, RecordingRunner(respond))
    assert scheduler.run_turn(MAIN) is not None
    restarted = Scheduler(world, RecordingRunner())
    assert restarted.runnable_agents() == (() if change == "all_ack" else (MAIN,))
    assert (restarted.run_turn(MAIN) is not None) == (change != "all_ack")
    assert restarted.run_turn(MAIN) is None


def test_turn_records_history_and_returns_to_idle(world) -> None:
    mention(world)
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    record = scheduler.run_turn(MAIN)
    assert record is not None
    assert record.status == "completed"
    assert runner.requests[0].sequence == record.sequence
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
    world.workspace_tree_for(MAIN).write("MEMORY.md", "WORKSPACE_STATE_OLD")

    for turn, state in enumerate(("OLD", "NEW"), start=1):
        if state == "NEW":
            tools.edit(
                "workspace/MEMORY.md", "WORKSPACE_STATE_OLD", "WORKSPACE_STATE_NEW"
            )
            world.store.append_message(room, HUMAN, "@Main continue")
        reminder = build_reminder(world.store, world.history, MAIN, "Main")
        assert reminder is not None
        start = len(received)

        record = scheduler.run_turn(MAIN)

        assert record is not None
        assert record.status == ("failed" if fail else "completed")
        assert len(received) == start + 2
        for request in received[start:]:
            assert "WORKSPACE_STATE_OLD" in request
            assert "WORKSPACE_STATE_NEW" not in request
        saved = world.history.latest_messages(MAIN)
        assert "WORKSPACE_STATE_OLD" in saved
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

    world.history.reset_window(MAIN, "prepared")
    assert scheduler.run_turn(MAIN) is None
    world.store.append_message(room, HUMAN, "@Main continue after reset")
    record = scheduler.run_turn(MAIN)
    assert record is not None and record.status == ("failed" if fail else "completed")
    saved = world.history.latest_messages(MAIN)
    assert "WORKSPACE_STATE_NEW" in saved
    assert "WORKSPACE_STATE_OLD" not in saved
    assert saved.count('"block":"resident"') == 1


@pytest.mark.parametrize("reset", [False, True])
def test_history_is_preserved_or_reset_without_rewriting_old_prompts(
    world, monkeypatch, reset: bool
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
    if reset:
        world.history.reset_window(MAIN, "prepared")

    record = scheduler.run_turn(MAIN)

    assert record is not None and record.status == "completed"
    saved = ModelMessagesTypeAdapter.validate_json(world.history.latest_messages(MAIN))
    if reset:
        assert len(saved) == 3
        assert saved[0].parts[0].content == scheduler.resident_block(MAIN)
    else:
        key = saved[0].metadata.pop("huddol")["cache_key"]
        assert len(key) == 32
        assert saved[: len(prior)] == prior
        assert saved[-2].metadata == {
            "huddol": {
                "block": "durable",
                "environment": scheduler.environment_facts(MAIN),
            }
        }
    assert saved[1 if reset else len(prior)].parts[0].content == reminder.render()
    assert saved[-1].parts[0].content == "New response"
    assert world.history.runs(MAIN)[1].messages_json == original


def test_resident_carries_workspace_and_environment(world, tmp_path: Path) -> None:
    mention(world)
    DirectoryTree(world.workspace_tree_for(MAIN).root).write(
        "MEMORY.md", "- prior knowledge"
    )
    runner = RecordingRunner()
    Scheduler(world, runner).run_turn(MAIN)
    context = runner.requests[0].resident
    assert context == (
        "Your MEMORY.md:\n- prior knowledge\n\n"
        f"Commands run on {sys.platform}\n"
        "Writable directories:\n"
        f"- {world.workspace_tree_for(MAIN).root} (your workspace, private)\n"
        f"- {world.library_tree.root} (Library, shared with the whole organization)\n"
        f"- {tmp_path}"
    )


@pytest.mark.parametrize("error_kind", ["os", "domain"])
def test_resident_renders_when_workspace_index_creation_fails(
    world, monkeypatch, error_kind
) -> None:
    from huddol.core.errors import DomainError

    tree = world.workspace_tree_for(MAIN)

    def fail(*args, **kwargs):
        if error_kind == "os":
            raise OSError("Read-only filesystem")
        raise DomainError("invalid_path", "Cannot create index")

    monkeypatch.setattr(tree, "write", fail)
    monkeypatch.setattr(world, "workspace_tree_for", lambda agent_id: tree)
    mention(world)
    runner = RecordingRunner()
    record = Scheduler(world, runner).run_turn(MAIN)
    assert record.status == "completed"
    assert runner.requests[0].resident.startswith("Your MEMORY.md is empty.")
    assert "(your workspace, private)" in runner.requests[0].resident
    assert not (tree.root / "MEMORY.md").exists()


@pytest.mark.parametrize("environment", [None, "environment facts"])
@pytest.mark.parametrize("workspace", ["", "remember this"])
@pytest.mark.parametrize("reset", [None, "Window reset notice"])
def test_render_resident_orders_only_the_requested_blocks(
    workspace, environment, reset
) -> None:
    expected = (
        "Your MEMORY.md:\nremember this" if workspace else "Your MEMORY.md is empty."
    )
    if environment is not None:
        expected += "\n\nenvironment facts"
    if reset is not None:
        expected += "\n\n" + reset
    assert render_resident(workspace, environment, reset) == expected


def test_workspace_index_truncation_follows_the_current_parameter(world) -> None:
    world.workspace_tree_for(MAIN).write("MEMORY.md", "abc😀def")
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    for limit, prefix, truncated in [(5, "abc", True), (10, "abc😀def", False)]:
        mention(world)
        world.settings.set_settings("agent", {"memory_index_bytes": limit})
        assert scheduler.run_turn(MAIN).status == "completed"
        resident = runner.requests[-1].resident
        assert resident.startswith(f"Your MEMORY.md:\n{prefix}\n")
        assert ("was cut here" in resident) is truncated
        if truncated:
            assert f"longer than {limit} bytes" in resident
            assert "😀" not in resident


def test_resident_loading_failure_preserves_history_and_hard_pauses(
    world, monkeypatch
) -> None:
    mention(world)
    scheduler = Scheduler(world, RecordingRunner())
    scheduler.run_turn(MAIN)
    previous = world.history.latest_messages(MAIN)

    def fail(agent_id):
        raise OSError("workspace is unreadable")

    monkeypatch.setattr(scheduler, "resident_block", fail)
    mention(world)
    record = scheduler.run_turn(MAIN)
    assert record is not None and record.status == "failed"
    assert "workspace is unreadable" in record.error
    assert world.history.latest_messages(MAIN) == previous
    assert world.store.get_member(MAIN).state == "paused"
    assert world.history.pause_reason(MAIN) == "runtime_error"


def test_second_model_call_failure_keeps_saved_response_and_completed_tool_return(
    world, monkeypatch
) -> None:
    from pydantic_ai import ModelMessagesTypeAdapter, models
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        ToolCallPart,
        ToolReturnPart,
    )
    from pydantic_ai.models.function import FunctionModel

    from huddol.adapters.model.runner import PydanticModelRunner

    room = mention(world)
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    world.settings.set_settings(
        "model",
        {"base_url": "https://example.invalid", "api_key": "unused", "model": "local"},
    )
    persisted = []
    save = world.history.save_progress
    calls = 0

    def save_progress(agent_id, sequence, raw):
        persisted.append(raw)
        save(agent_id, sequence, raw)
        run = world.history.runs(agent_id)[0]
        assert run.sequence == sequence
        assert run.status == "running" and run.completed_at is None
        assert run.messages_json == raw

    def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(
                parts=[
                    ToolCallPart(
                        "discussion",
                        {"action": "read", "discussion_id": room},
                        tool_call_id="read",
                    )
                ]
            )
        assert len(persisted) == 1
        assert world.history.latest_messages(MAIN) == persisted[0]
        raise RuntimeError("second call failed")

    monkeypatch.setattr(world.history, "save_progress", save_progress)
    runner = PydanticModelRunner(
        world.settings, build_model=lambda config: FunctionModel(respond)
    )
    scheduler = Scheduler(world, runner)
    record = scheduler.run_turn(MAIN)
    assert record is not None and record.status == "failed"
    assert record.error == "RuntimeError: second call failed"
    assert calls == 2 and len(persisted) == 1
    saved = ModelMessagesTypeAdapter.validate_json(persisted[0])
    run = world.history.runs(MAIN)[0]
    captured = ModelMessagesTypeAdapter.validate_json(run.messages_json)
    assert captured[:-1] == saved[:-1]
    assert isinstance(saved[-1], ModelRequest)
    assert isinstance(saved[-1].parts[0], ToolReturnPart)
    assert saved[-1].parts[0].tool_call_id == "read"
    assert saved[-1].parts[0].content == (
        "The Turn ended without a confirmed result for this call. "
        "It may have executed; check the outcome before retrying."
    )
    assert isinstance(captured[-1], ModelRequest)
    assert len(captured[-1].parts) == 1
    returned = captured[-1].parts[0]
    assert isinstance(returned, ToolReturnPart)
    assert returned.tool_call_id == "read"
    assert returned.content["messages"][0]["body"] == "@Main please help"
    assert world.history.latest_messages(MAIN) == run.messages_json


def test_scheduler_resumes_interrupted_progress_on_changed_mentions(world) -> None:
    room = mention(world)
    run = world.history.start_run(MAIN, reminded=[(room, 1)])
    partial = '[{"text":"partial"}]'
    world.history.save_progress(MAIN, run.sequence, partial)
    assert world.history.mark_interrupted() == 1
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    assert scheduler.runnable_agents() == ()
    assert scheduler.run_turn(MAIN) is None
    world.store.append_message(room, HUMAN, "@Main continue")
    record = scheduler.run_turn(MAIN)
    assert record is not None and record.status == "completed"
    assert runner.requests[0].history_json == partial
    assert runner.requests[0].sequence == run.sequence + 1
    assert world.history.runs(MAIN)[1].messages_json == partial


def test_a_failing_turn_is_recorded_and_the_agent_recovers(world) -> None:
    mention(world)

    def explode(request, tools):
        return TurnOutcome(messages_json="[]", error="RuntimeError: model exploded")

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
        assert scheduler.runnable_agents() == ()
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


def test_prior_window_content_stays_retrievable_through_history(world) -> None:
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

    world.history.reset_window(MAIN, "prepared")
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


def test_nudge_threshold_is_read_again_for_each_model_call(world) -> None:
    room = world.store.create_discussion("exchange", [MAIN, HELPER])
    for sender, body in [(HELPER, "one"), (MAIN, "two"), (HELPER, "three @Main")]:
        world.store.append_message(room.id, sender, body)
    runner = RecordingRunner()
    scheduler = Scheduler(world, runner)
    world.settings.set_settings("agent", {"exchange_nudge_after": 3})
    assert scheduler.run_turn(MAIN).status == "completed"
    request = runner.requests[0]
    assert "exchanged 3 messages" in request.ephemeral()
    world.settings.set_settings("agent", {"exchange_nudge_after": 6})
    assert request.ephemeral() == ""


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


@pytest.mark.parametrize("fail", [False, True])
def test_concurrency_follows_the_current_parameter(world, fail) -> None:
    import threading

    entered = {agent_id: threading.Event() for agent_id in (MAIN, HELPER)}
    release = {agent_id: threading.Event() for agent_id in (MAIN, HELPER)}

    def slow(request, tools):
        entered[request.agent_id].set()
        assert release[request.agent_id].wait(timeout=5)
        if fail:
            return TurnOutcome(messages_json="[]", error="RuntimeError: model failed")
        return TurnOutcome(messages_json="[]")

    room = world.store.create_discussion("parallel", [HUMAN, MAIN, HELPER])
    world.store.append_message(room.id, HUMAN, "@Main @Helper go")
    world.settings.set_settings("agent", {"max_concurrent_turns": 1})
    scheduler = Scheduler(world, RecordingRunner(slow))
    try:
        assert scheduler.tick() == (MAIN,)
        assert entered[MAIN].wait(timeout=5)
        assert not entered[HELPER].is_set()
        assert scheduler.tick() == ()

        world.settings.set_settings("agent", {"max_concurrent_turns": 2})
        assert scheduler.tick() == (HELPER,)
        assert entered[HELPER].wait(timeout=5)
        assert scheduler.tick() == ()

        world.settings.set_settings("agent", {"max_concurrent_turns": 1})
        assert scheduler.tick() == ()
        assert all(thread.is_alive() for thread in scheduler._threads.values())
        release[MAIN].set()
        scheduler._threads[MAIN].join(timeout=5)
        assert not scheduler._threads[MAIN].is_alive()
        world.store.append_message(room.id, HUMAN, "@Main next")
        assert scheduler.runnable_agents() == (MAIN,)
        assert scheduler.tick() == ()

        release[HELPER].set()
        scheduler._threads[HELPER].join(timeout=5)
        assert not scheduler._threads[HELPER].is_alive()
        release[MAIN].clear()
        assert scheduler.tick() == (MAIN,)
    finally:
        for event in release.values():
            event.set()
        scheduler.stop()


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
    world.settings.set_settings("agent", {"token_limit": 500})
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.runnable_agents() == (MAIN,)

    spend(world, MAIN, 499)
    assert not scheduler.over_token_limit(MAIN)
    assert scheduler.runnable_agents() == (MAIN,)
    spend(world, MAIN, 1)
    assert scheduler.over_token_limit(MAIN)
    assert scheduler.runnable_agents() == ()
    assert scheduler.run_turn(MAIN) is None
    assert world.store.get_member(MAIN).state == "idle"
    assert scheduler.tick() == ()


def test_raising_the_limit_lets_the_agent_run_again(world) -> None:
    mention(world)
    world.settings.set_settings("agent", {"token_limit": 100})
    spend(world, MAIN, 400)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.runnable_agents() == ()

    world.settings.set_settings("agent", {"token_limit": 1000})
    assert scheduler.runnable_agents() == (MAIN,)


@pytest.mark.parametrize("values", [{}, {"token_limit": 0}])
def test_no_limit_configured_means_no_ceiling(world, values) -> None:
    mention(world)
    world.settings.set_settings("agent", values)
    spend(world, MAIN, 10_000_000)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.token_limit() == 0
    assert not scheduler.over_token_limit(MAIN)
    assert scheduler.runnable_agents() == (MAIN,)


def test_a_malformed_limit_is_treated_as_no_limit(world) -> None:
    mention(world)
    world.settings.set_settings("agent", {"token_limit": "not a number"})
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.token_limit() == 0
    assert scheduler.runnable_agents() == (MAIN,)


def test_legacy_limits_do_not_control_scheduling(world) -> None:
    mention(world)
    world.settings.set_settings("limits", {"agent_token_limit": 1})
    spend(world, MAIN, 10_000_000)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.token_limit() == 0
    assert scheduler.runnable_agents() == (MAIN,)


def test_the_limit_is_per_agent_not_shared(world) -> None:
    mention(world)
    world.settings.set_settings("agent", {"token_limit": 500})
    spend(world, HELPER, 900)
    scheduler = Scheduler(world, RecordingRunner())
    assert scheduler.over_token_limit(HELPER)
    assert scheduler.runnable_agents() == (MAIN,)
