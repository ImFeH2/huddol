from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from huddol.adapters.execution.manager import ExecutionManager
from huddol.adapters.files.tree import MarkdownTree
from huddol.adapters.jsonl.api import HUMAN_ID, Api
from huddol.adapters.jsonl.protocol import Dispatcher, parse, wait_for_shutdown
from huddol.adapters.model.runner import PydanticModelRunner
from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore
from huddol.runtime.scheduler import Scheduler
from huddol.tools import Dependencies


class Capture:
    def __init__(self) -> None:
        self._frames: list[dict[str, Any]] = []

    def __call__(self, payload: dict[str, Any]) -> None:
        self._frames.append(json.loads(json.dumps(payload)))

    def frames(self) -> list[dict[str, Any]]:
        return list(self._frames)


class Probe:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], dict[str, Any] | None]] = []

    def list_models(
        self, values: dict[str, Any], stored: dict[str, Any] | None
    ) -> dict[str, Any]:
        self.calls.append(("list", values, stored))
        return {"models": ["b", "a"]}

    def test_model(
        self, values: dict[str, Any], stored: dict[str, Any] | None
    ) -> dict[str, Any]:
        self.calls.append(("test", values, stored))
        return {"ok": True, "latency_ms": 12, "reply": "OK"}


@pytest.fixture
def server(tmp_path: Path):
    store = SqliteStore(tmp_path / "huddol.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    store.create_member("human", "You")

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
    output = Capture()
    dispatcher = Dispatcher()
    dispatcher.attach(output)
    scheduler = Scheduler(
        deps, PydanticModelRunner(agent_store), on_event=dispatcher.emit
    )
    probe = Probe()
    Api(
        scheduler,
        dispatcher,
        list_models=probe.list_models,
        test_model=probe.test_model,
    )
    deps.probe = probe  # type: ignore[attr-defined]
    yield dispatcher, output, deps
    store.close()


def call(dispatcher: Dispatcher, output: Capture, method: str, **params: Any) -> Any:
    before = len(output.frames())
    request = parse(json.dumps({"id": 99, "method": method, "params": params}))
    assert request is not None
    dispatcher.handle(request, output)
    frames = output.frames()[before:]
    responses = [item for item in frames if item.get("type") == "response"]
    assert responses, f"no response for {method}"
    return responses[-1]


def test_bad_json_produces_an_error_event_not_a_crash(server) -> None:
    dispatcher, output, _ = server
    dispatcher.receive("{not json}", output)
    assert output.frames()[-1]["code"] == "invalid_frame"


def test_internal_methods_are_refused_from_outside(server) -> None:
    dispatcher, output, _ = server
    dispatcher.receive(json.dumps({"id": 1, "method": "system.secret"}), output)
    assert output.frames()[-1]["error"]["code"] == "internal_method"


def test_shutdown_is_refused_over_a_connection(server) -> None:
    dispatcher, output, _ = server
    dispatcher.receive(json.dumps({"id": 1, "method": "system.shutdown"}), output)
    assert output.frames()[-1]["error"]["code"] == "internal_method"


def test_shutdown_on_stdin_stops_the_loop() -> None:
    assert (
        wait_for_shutdown(io.StringIO(json.dumps({"method": "system.shutdown"}) + "\n"))
        == "shutdown"
    )


def test_other_stdin_input_is_ignored_until_eof() -> None:
    assert (
        wait_for_shutdown(io.StringIO('garbage\n{"id":1,"method":"ping"}\n')) == "eof"
    )


def test_responses_go_to_the_requesting_connection_only(server) -> None:
    dispatcher, output, _ = server
    other = Capture()
    dispatcher.attach(other)
    dispatcher.receive(json.dumps({"id": 1, "method": "ping"}), other)
    assert [frame["type"] for frame in other.frames()] == ["response"]
    assert output.frames() == []


def test_events_reach_every_connection(server) -> None:
    dispatcher, output, _ = server
    other = Capture()
    dispatcher.attach(other)
    call(dispatcher, output, "organization.create_agent", name="Main")
    assert [frame["type"] for frame in other.frames()] == ["member.created"]
    assert [frame["type"] for frame in output.frames()] == [
        "member.created",
        "response",
    ]
    dispatcher.detach(other)
    dispatcher.emit("noop")
    assert len(other.frames()) == 1


def test_unknown_methods_return_a_named_error(server) -> None:
    dispatcher, output, _ = server
    assert call(dispatcher, output, "nope.at.all")["error"]["code"] == "unknown_method"


def test_domain_errors_become_structured_responses(server) -> None:
    dispatcher, output, _ = server
    response = call(dispatcher, output, "organization.create_agent", name="   ")
    assert response["error"]["code"] == "invalid_name"


def test_notifications_without_an_id_emit_an_error_event(server) -> None:
    dispatcher, output, _ = server
    request = parse(json.dumps({"method": "organization.create_agent", "params": {}}))
    assert request is not None
    dispatcher.handle(request, output)
    last = output.frames()[-1]
    assert last["type"] == "error"
    assert last["code"] == "invalid_name"


def test_creating_an_agent_emits_an_incremental_event(server) -> None:
    dispatcher, output, _ = server
    call(dispatcher, output, "organization.create_agent", name="Main")
    events = [item for item in output.frames() if item.get("type") == "member.created"]
    assert events and events[0]["name"] == "Main"


def test_events_are_deltas_not_whole_organization_snapshots(server) -> None:
    dispatcher, output, _ = server
    call(dispatcher, output, "organization.create_agent", name="Main")
    event = next(item for item in output.frames() if item["type"] == "member.created")
    assert set(event) == {"type", "id", "name", "state"}
    assert "members" not in event
    assert "discussions" not in event


def test_full_human_flow_over_the_protocol(server) -> None:
    dispatcher, output, deps = server
    agent = call(dispatcher, output, "organization.create_agent", name="Main")["result"]
    room = call(
        dispatcher,
        output,
        "discussion.create",
        topic="ship it",
        member_ids=[agent["id"]],
    )["result"]
    call(
        dispatcher, output, "discussion.send", discussion_id=room["id"], body="@Main go"
    )

    assert [item.message_id for item in deps.store.pending(agent["id"])] == [1]
    listed = call(dispatcher, output, "discussion.list")["result"]
    assert listed[0]["topic"] == "ship it"

    read = call(dispatcher, output, "discussion.read", discussion_id=room["id"])[
        "result"
    ]
    assert read["messages"][0]["body"] == "@Main go"


def test_human_ack_and_revoke_round_trip(server) -> None:
    dispatcher, output, deps = server
    agent = call(dispatcher, output, "organization.create_agent", name="Main")["result"]
    room = call(
        dispatcher, output, "discussion.create", topic="t", member_ids=[agent["id"]]
    )["result"]
    call(
        dispatcher, output, "discussion.send", discussion_id=room["id"], body="@You hi"
    )
    deps.store.append_message(room["id"], agent["id"], "@You please review")

    call(dispatcher, output, "discussion.read", discussion_id=room["id"])
    assert len(deps.store.pending(HUMAN_ID)) == 1
    call(
        dispatcher, output, "discussion.ack", discussion_id=room["id"], message_ids=[2]
    )
    assert deps.store.pending(HUMAN_ID) == ()

    call(
        dispatcher,
        output,
        "discussion.revoke_ack",
        discussion_id=room["id"],
        message_ids=[2],
    )
    assert len(deps.store.pending(HUMAN_ID)) == 1


def test_archiving_stops_pending_and_unarchiving_restores_it(server) -> None:
    dispatcher, output, deps = server
    agent = call(dispatcher, output, "organization.create_agent", name="Main")["result"]
    room = call(
        dispatcher, output, "discussion.create", topic="t", member_ids=[agent["id"]]
    )["result"]
    call(
        dispatcher, output, "discussion.send", discussion_id=room["id"], body="@Main go"
    )

    call(
        dispatcher,
        output,
        "discussion.archive",
        discussion_id=room["id"],
        archived=True,
    )
    assert deps.store.pending(agent["id"]) == ()
    call(
        dispatcher,
        output,
        "discussion.archive",
        discussion_id=room["id"],
        archived=False,
    )
    assert len(deps.store.pending(agent["id"])) == 1


def test_settings_never_return_the_api_key(server) -> None:
    dispatcher, output, _ = server
    call(
        dispatcher,
        output,
        "settings.update",
        section="model",
        values={
            "api_type": "openai",
            "base_url": "https://example.test/v1",
            "api_key": "super-secret-value",
            "model": "some-model",
        },
    )
    result = call(dispatcher, output, "settings.get", section="model")["result"]
    assert "super-secret-value" not in json.dumps(result)
    assert result["api_key_set"] is True
    assert result["model"] == "some-model"


def test_model_settings_reject_unknown_api_types_and_keep_the_stored_ones(
    server,
) -> None:
    dispatcher, output, deps = server
    call(
        dispatcher,
        output,
        "settings.update",
        section="model",
        values={"api_type": "google", "base_url": "https://g.invalid", "model": "g"},
    )
    rejected = call(
        dispatcher,
        output,
        "settings.update",
        section="model",
        values={"api_type": "azure", "model": "other"},
    )
    assert rejected["error"]["code"] == "invalid_api_type"
    result = call(dispatcher, output, "settings.get", section="model")["result"]
    assert result["api_type"] == "google"
    assert result["model"] == "g"
    assert deps.settings.get_settings("model")["api_type"] == "google"
    assert [
        frame for frame in output.frames() if frame.get("type") == "settings.updated"
    ] == [{"type": "settings.updated", "section": "model"}]


def test_agent_settings_fill_defaults_merge_and_emit_events(server) -> None:
    dispatcher, output, deps = server
    assert call(dispatcher, output, "settings.get", section="agent")["result"] == {
        "context_window_tokens": 200_000
    }
    deps.settings.set_settings("agent", {"legacy": 10, "context_window_tokens": False})
    assert call(dispatcher, output, "settings.get", section="agent")["result"] == {
        "context_window_tokens": 200_000
    }
    updated = call(
        dispatcher,
        output,
        "settings.update",
        section="agent",
        values={"context_window_tokens": 12345},
    )["result"]
    assert updated == {"context_window_tokens": 12345}
    assert (
        call(dispatcher, output, "settings.get", section="agent")["result"] == updated
    )
    assert deps.settings.get_settings("agent") == {"legacy": 10, **updated}
    assert [
        frame for frame in output.frames() if frame["type"] == "settings.updated"
    ] == [{"type": "settings.updated", "section": "agent"}]
    assert (
        call(dispatcher, output, "settings.update", section="agent", values={})[
            "result"
        ]
        == updated
    )


@pytest.mark.parametrize(
    ("values", "code"),
    [
        *[
            ({"context_window_tokens": value}, "invalid_parameter")
            for value in (0, -1, True, False, "100", None, 1.5)
        ],
        ({"context_window_tokens": 100, "unknown": 1}, "invalid_setting"),
    ],
)
def test_agent_settings_validation_is_atomic(server, values, code) -> None:
    dispatcher, output, deps = server
    original = {"context_window_tokens": 12345}
    deps.settings.set_settings("agent", original)
    rejected = call(
        dispatcher, output, "settings.update", section="agent", values=values
    )
    assert rejected["error"]["code"] == code
    assert deps.settings.get_settings("agent") == original
    assert not any(frame["type"] == "settings.updated" for frame in output.frames())


@pytest.mark.parametrize("configured", [False, True])
def test_model_settings_ignore_the_obsolete_byte_threshold(server, configured) -> None:
    dispatcher, output, deps = server
    if configured:
        deps.settings.set_settings(
            "model",
            {"model": "m", "api_key": "unused", "base_url": "https://example.invalid"},
        )
    initial = call(dispatcher, output, "settings.get", section="model")["result"]
    assert "compaction_threshold" not in initial
    result = call(
        dispatcher,
        output,
        "settings.update",
        section="model",
        values={"compaction_threshold": "obsolete"},
    )["result"]
    assert result == initial


def test_model_listing_and_testing_reach_the_injected_probe(server) -> None:
    dispatcher, output, deps = server
    stored = {
        "api_type": "openai",
        "base_url": "https://stored.invalid/v1",
        "api_key": "stored-key",
        "model": "m",
    }
    call(dispatcher, output, "settings.update", section="model", values=stored)
    listed = call(
        dispatcher,
        output,
        "settings.list_models",
        api_type="anthropic",
        base_url="https://a.invalid",
    )
    assert listed["result"] == {"models": ["b", "a"]}
    tested = call(
        dispatcher,
        output,
        "settings.test_model",
        api_type="anthropic",
        base_url="https://a.invalid",
        api_key="typed-key",
        model="candidate",
    )
    assert tested["result"] == {"ok": True, "latency_ms": 12, "reply": "OK"}
    assert deps.probe.calls == [
        ("list", {"api_type": "anthropic", "base_url": "https://a.invalid"}, stored),
        (
            "test",
            {
                "api_type": "anthropic",
                "base_url": "https://a.invalid",
                "api_key": "typed-key",
                "model": "candidate",
            },
            stored,
        ),
    ]
    updated = [f for f in output.frames() if f.get("type") == "settings.updated"]
    assert len(updated) == 1
    assert deps.settings.get_settings("model") == stored


def test_observability_keys_are_never_returned(server) -> None:
    dispatcher, output, _ = server
    call(
        dispatcher,
        output,
        "settings.update",
        section="observability",
        values={
            "enabled": True,
            "base_url": "u",
            "public_key": "pk",
            "secret_key": "sk",
        },
    )
    result = call(dispatcher, output, "settings.get", section="observability")["result"]
    assert "sk" not in json.dumps(result)
    assert "pk" not in json.dumps(result)
    assert result["keys_set"] is True


def test_execution_settings_update_the_live_sandbox(server, tmp_path: Path) -> None:
    dispatcher, output, deps = server
    target = tmp_path / "workspace"
    target.mkdir()
    call(
        dispatcher,
        output,
        "settings.update",
        section="execution",
        values={"write_directories": [str(target)]},
    )
    assert deps.execution.snapshot().write_directories == (str(target.resolve()),)
    assert deps.settings.get_settings("execution") == {
        "environment": {"kind": "native"},
        "directories": {"native": [str(target.resolve())]},
    }


def test_agent_detail_reports_todos_and_runs(server) -> None:
    dispatcher, output, deps = server
    agent = call(dispatcher, output, "organization.create_agent", name="Main")["result"]
    deps.todos.add_todo(agent["id"], "some work", "detail")
    run = deps.history.start_run(agent["id"])
    deps.history.finish_run(
        agent["id"], run.sequence, status="completed", messages_json="[]"
    )

    detail = call(dispatcher, output, "agent.detail", agent_id=agent["id"])["result"]
    assert detail["todos"][0]["title"] == "some work"
    assert detail["runs"][0]["status"] == "completed"
    assert detail["window"] == {
        "number": 1,
        "since_sequence": 1,
        "reset_at": None,
        "reason": None,
    }
    state = deps.history.reset_window(agent["id"], "overflow")
    detail = call(dispatcher, output, "agent.detail", agent_id=agent["id"])["result"]
    assert detail["window"] == {
        "number": 2,
        "since_sequence": 2,
        "reset_at": state.reset_at,
        "reason": "overflow",
    }
    assert detail["runs"][0]["sequence"] == run.sequence


def test_agent_detail_reports_each_turn_output_and_the_idle_streak(server) -> None:
    dispatcher, output, deps = server
    agent = call(dispatcher, output, "organization.create_agent", name="Main")["result"]
    agent_id = agent["id"]

    productive = deps.history.start_run(agent_id)
    deps.history.record_effect(agent_id, productive.sequence, "send", "message 4")
    deps.history.finish_run(
        agent_id, productive.sequence, status="completed", messages_json="[]"
    )
    for _ in range(2):
        spinning = deps.history.start_run(agent_id)
        deps.history.record_effect(agent_id, spinning.sequence, "ack", "1 acknowledged")
        deps.history.finish_run(
            agent_id, spinning.sequence, status="completed", messages_json="[]"
        )

    detail = call(dispatcher, output, "agent.detail", agent_id=agent_id)["result"]
    assert detail["idle_streak"] == 2
    assert detail["runs"][0]["effects"] == [
        {"ordinal": 1, "tool": "ack", "summary": "1 acknowledged"}
    ]
    assert detail["runs"][2]["effects"] == [
        {"ordinal": 1, "tool": "send", "summary": "message 4"}
    ]


def test_library_round_trips_over_the_protocol(server) -> None:
    dispatcher, output, _ = server
    written = call(
        dispatcher, output, "library.write", path="notes.md", content="shared"
    )["result"]
    read = call(dispatcher, output, "library.read", path="notes.md")["result"]
    assert read["content"] == "shared"
    assert read["hash"] == written["hash"]


def test_rejected_write_directories_are_not_persisted(server, tmp_path: Path) -> None:
    dispatcher, output, deps = server
    good = tmp_path / "good"
    good.mkdir()
    call(
        dispatcher,
        output,
        "settings.update",
        section="execution",
        values={"write_directories": [str(good)]},
    )

    failed = call(
        dispatcher,
        output,
        "settings.update",
        section="execution",
        values={"write_directories": [str(good), "relative/bad"]},
    )
    assert failed["error"]["code"] == "invalid_directory"

    result = call(dispatcher, output, "settings.get", section="execution")["result"]
    assert result["write_directories"] == [str(good.resolve())]
    assert deps.execution.snapshot().write_directories == (str(good.resolve()),)


def test_accepted_write_directories_are_stored_canonically(
    server, tmp_path: Path
) -> None:
    dispatcher, output, _ = server
    target = tmp_path / "workspace"
    target.mkdir()
    call(
        dispatcher,
        output,
        "settings.update",
        section="execution",
        values={"write_directories": [f"{target}/", str(target)]},
    )
    result = call(dispatcher, output, "settings.get", section="execution")["result"]
    assert result["write_directories"] == [str(target.resolve())]
