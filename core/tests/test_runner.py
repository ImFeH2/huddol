from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import replace
from typing import Any

import pytest
from pydantic_ai import ModelMessagesTypeAdapter, models
from pydantic_ai.capabilities import Hooks
from pydantic_ai.messages import (
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.function import FunctionModel

from huddol.adapters.model.config import ModelConfig
from huddol.adapters.model.observability import ObservabilityConfig
from huddol.adapters.model.runner import UNAVAILABLE, LiveModel, PydanticModelRunner
from huddol.runtime.reminder import Reminder, ReminderItem, TurnRequest


class FakeSettings:
    def __init__(self) -> None:
        self.values: dict[str, dict[str, object]] = {}

    def get_settings(self, section: str) -> dict[str, object] | None:
        return self.values.get(section)

    def set_settings(self, section: str, values: dict[str, object]) -> None:
        self.values[section] = values


class FakeObservability:
    def __init__(self, config: ObservabilityConfig) -> None:
        self.config = config
        self.stopped = False
        self.calls = 0

    def instrumentation(self) -> Any:
        self.calls += 1
        return Hooks()

    def shutdown(self) -> None:
        self.stopped = True


@pytest.fixture(autouse=True)
def no_network(monkeypatch) -> None:
    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)


def request() -> TurnRequest:
    return TurnRequest(
        reminder=Reminder(2, "Main", (ReminderItem(1, "work", 1, 1, "You", False),)),
        history_json="[]",
        resident="Your MEMORY.md is empty.\n\nTodos: none\n\nenvironment A",
        environment=lambda: "environment A",
        ephemeral=lambda: "",
    )


def model_values(model: str) -> dict[str, object]:
    return {
        "api_type": "openai",
        "base_url": "https://example.invalid/v1",
        "api_key": "unused",
        "model": model,
    }


@pytest.fixture
def settings() -> FakeSettings:
    settings = FakeSettings()
    settings.set_settings("model", model_values("first"))
    return settings


class Builder:
    def __init__(self, delay: threading.Event | None = None) -> None:
        self.calls: list[ModelConfig] = []
        self.entered = threading.Event()
        self._delay = delay

    def __call__(self, config: ModelConfig) -> FunctionModel:
        self.calls.append(config)
        self.entered.set()
        if self._delay is not None:
            assert self._delay.wait(timeout=5)
        return FunctionModel(
            lambda messages, info: ModelResponse(parts=[TextPart(config.model)])
        )


def test_runs_are_unavailable_until_a_model_is_configured() -> None:
    settings = FakeSettings()
    builder = Builder()
    runner = PydanticModelRunner(settings, build_model=builder)
    original = replace(request(), history_json='[{"kind":"response"}]')
    for values in ({}, {"compaction_threshold": 5}):
        settings.set_settings("model", values)
        outcome = runner.run(original, None)
        assert outcome.error == UNAVAILABLE
        assert outcome.messages_json == original.history_json
        assert builder.calls == []


def test_the_next_turn_picks_up_settings_and_reuses_unchanged_models(settings) -> None:
    builder = Builder()
    runner = PydanticModelRunner(settings, build_model=builder)
    agent = runner._agent
    for name in ("first", "first", "second"):
        settings.set_settings("model", model_values(name))
        outcome = runner.run(request(), None)
        assert outcome.error is None
        assert (
            ModelMessagesTypeAdapter.validate_json(outcome.messages_json)[-1]
            .parts[0]
            .content
            == name
        )
    assert [config.model for config in builder.calls] == ["first", "second"]
    assert runner._agent is agent
    settings.set_settings(
        "model", {**model_values("second"), "compaction_threshold": 9}
    )
    assert runner.run(request(), None).error is None
    assert builder.calls[-1].compaction_threshold == 9
    assert len(builder.calls) == 3
    settings.set_settings("model", {})
    assert runner.run(request(), None).error == UNAVAILABLE


@pytest.mark.parametrize("remove", [False, True])
def test_model_settings_are_resolved_after_a_tool_call_in_the_same_turn(
    settings, remove
) -> None:
    received = []
    built = []

    def build(config):
        built.append(config.model)

        def respond(messages, info):
            received.append(config.model)
            if config.model == "first":
                return ModelResponse(parts=[ToolCallPart("todo", {"action": "list"})])
            return ModelResponse(parts=[TextPart("Done")])

        return FunctionModel(respond)

    class Tools:
        def list_todos(self):
            settings.set_settings("model", {} if remove else model_values("second"))
            return []

    outcome = PydanticModelRunner(settings, build_model=build).run(request(), Tools())
    assert received == (["first"] if remove else ["first", "second"])
    assert built == received
    if remove:
        assert UNAVAILABLE in outcome.error
        assert "tool-return" in outcome.messages_json
    else:
        assert outcome.error is None
        assert json.loads(outcome.usage_json)["requests"] == 2
        assert json.loads(outcome.usage_json)["tool_calls"] == 1


@pytest.mark.parametrize("fail", [False, True])
def test_ephemeral_is_loaded_each_call_and_never_persisted(settings, fail) -> None:
    received = []
    nudges = iter(["EPHEMERAL_ONE", "EPHEMERAL_TWO"])

    def respond(messages, info):
        received.append(ModelMessagesTypeAdapter.dump_json(messages).decode())
        if len(received) == 1:
            return ModelResponse(parts=[ToolCallPart("todo", {"action": "list"})])
        if fail:
            raise RuntimeError("local failure")
        return ModelResponse(parts=[TextPart("Done")])

    class Tools:
        def list_todos(self):
            return []

    outcome = PydanticModelRunner(
        settings, build_model=lambda config: FunctionModel(respond)
    ).run(replace(request(), ephemeral=lambda: next(nudges)), Tools())
    assert len(received) == 2
    assert "EPHEMERAL_ONE" in received[0]
    assert "EPHEMERAL_TWO" in received[1]
    assert "EPHEMERAL_ONE" not in received[1]
    assert "EPHEMERAL" not in outcome.messages_json
    assert "tool-return" in outcome.messages_json
    assert (outcome.error is not None) == fail


def test_resident_is_inserted_only_for_empty_history(settings) -> None:
    runner = PydanticModelRunner(settings, build_model=Builder())
    original = request()
    first = runner.run(original, None)
    messages = ModelMessagesTypeAdapter.validate_json(first.messages_json)
    assert len(messages) == 3
    assert messages[0].parts[0].content == original.resident
    assert messages[0].metadata == {
        "huddol": {"block": "resident", "environment": "environment A"}
    }
    assert messages[1].parts[0].content == original.reminder.render()
    second = runner.run(
        replace(original, history_json=first.messages_json, resident="changed"), None
    )
    saved = ModelMessagesTypeAdapter.validate_json(second.messages_json)
    assert len(saved) == 5
    assert saved[:3] == messages
    assert "changed" not in second.messages_json


@pytest.mark.parametrize("reset", [False, True])
def test_history_reset_uses_utf8_bytes_and_keeps_the_exact_threshold(
    settings, reset
) -> None:
    original = request()
    history = [
        ModelRequest(
            parts=[UserPromptPart("旧记忆😀" * 20)],
            metadata={"huddol": {"block": "resident", "environment": "environment A"}},
        ),
        ModelResponse(parts=[TextPart("Old response")]),
    ]
    raw = ModelMessagesTypeAdapter.dump_json(history).decode()
    threshold = len(raw) if reset else len(raw.encode("utf-8"))
    settings.set_settings(
        "model", {**model_values("first"), "compaction_threshold": threshold}
    )
    outcome = PydanticModelRunner(settings, build_model=Builder()).run(
        replace(original, history_json=raw), None
    )
    assert outcome.error is None
    saved = ModelMessagesTypeAdapter.validate_json(outcome.messages_json)
    if reset:
        assert len(saved) == 3
        assert saved[0].parts[0].content == original.resident
        assert saved[0].metadata == {
            "huddol": {"block": "resident", "environment": "environment A"}
        }
    else:
        assert saved[:2] == history
    assert saved[-2].parts[0].content == original.reminder.render()


@pytest.mark.parametrize("initial", [None, "environment A"])
@pytest.mark.parametrize("fail", [False, True])
def test_durable_changes_are_persisted_once_and_survive_runner_restarts(
    settings, initial, fail
) -> None:
    environment = initial
    received = []

    def respond(messages, info):
        received.append(
            ModelMessagesTypeAdapter.validate_json(
                ModelMessagesTypeAdapter.dump_json(messages)
            )
        )
        if len(received) < 3:
            return ModelResponse(parts=[ToolCallPart("todo", {"action": "list"})])
        if fail:
            raise RuntimeError("local failure after environment change")
        return ModelResponse(parts=[TextPart("Done")])

    class Tools:
        def list_todos(self):
            nonlocal environment
            environment = "environment B"
            return []

    original = replace(request(), environment=lambda: environment)
    runner = PydanticModelRunner(
        settings, build_model=lambda config: FunctionModel(respond)
    )
    outcome = runner.run(original, Tools())
    assert (outcome.error is not None) == fail
    saved = ModelMessagesTypeAdapter.validate_json(outcome.messages_json)
    assert saved[0].metadata == {
        "huddol": {"block": "resident", "environment": initial or ""}
    }
    durable = [
        message
        for message in saved
        if message.metadata
        and message.metadata.get("huddol", {}).get("block") == "durable"
    ]
    assert len(durable) == 1
    assert (
        durable[0].parts[0].content
        == "The execution environment changed.\nenvironment B"
    )
    assert durable[0].metadata == {
        "huddol": {"block": "durable", "environment": "environment B"}
    }
    assert [
        sum(
            isinstance(part, UserPromptPart)
            and part.content == durable[0].parts[0].content
            for message in messages
            for part in message.parts
        )
        for messages in received
    ] == [0, 1, 1]
    restarted = PydanticModelRunner(settings, build_model=Builder())
    continued = restarted.run(
        replace(original, history_json=outcome.messages_json), None
    )
    assert continued.error is None
    assert (
        ModelMessagesTypeAdapter.validate_json(continued.messages_json)[: len(saved)]
        == saved
    )
    environment = None
    unavailable = restarted.run(
        replace(original, history_json=continued.messages_json), None
    )
    assert unavailable.error is None
    assert unavailable.messages_json.count('"block":"durable"') == 1


def test_observability_is_reused_replaced_and_shutdown_per_turn(settings) -> None:
    builder = Builder()
    exporters = []

    def build(config):
        exporter = FakeObservability(config)
        exporters.append(exporter)
        return exporter

    runner = PydanticModelRunner(
        settings, build_model=builder, build_observability=build
    )
    assert runner.run(request(), None).error is None
    assert exporters == []
    tracing = {
        "enabled": True,
        "base_url": "https://langfuse.invalid",
        "public_key": "pk",
        "secret_key": "sk",
    }
    settings.set_settings("observability", tracing)
    for _ in range(2):
        assert runner.run(request(), None).error is None
    assert len(exporters) == 1 and exporters[0].calls == 2
    assert not exporters[0].stopped
    settings.set_settings("observability", {**tracing, "environment": "test"})
    assert runner.run(request(), None).error is None
    assert len(exporters) == 2 and exporters[0].stopped
    assert not exporters[1].stopped
    settings.set_settings("observability", {**tracing, "enabled": False})
    assert runner.run(request(), None).error is None
    assert exporters[1].stopped
    assert len(builder.calls) == 1


def test_observability_changes_during_a_turn_apply_to_the_next_turn(settings) -> None:
    exporters = []
    calls = 0

    def build(config):
        exporter = FakeObservability(config)
        exporters.append(exporter)
        return exporter

    def respond(messages, info):
        nonlocal calls
        calls += 1
        if calls == 1:
            return ModelResponse(parts=[ToolCallPart("todo", {"action": "list"})])
        assert len(exporters) == 1
        assert not exporters[0].stopped
        return ModelResponse(parts=[TextPart("Done")])

    class Tools:
        def list_todos(self):
            settings.set_settings("observability", {"enabled": False})
            return []

    settings.set_settings(
        "observability",
        {
            "enabled": True,
            "base_url": "https://langfuse.invalid",
            "public_key": "pk",
            "secret_key": "sk",
        },
    )
    runner = PydanticModelRunner(
        settings,
        build_model=lambda config: FunctionModel(respond),
        build_observability=build,
    )
    assert runner.run(request(), Tools()).error is None
    assert exporters[0].calls == 1
    runner._build_model = Builder()
    settings.set_settings("model", model_values("second"))
    assert runner.run(request(), None).error is None
    assert exporters[0].stopped


def test_concurrent_turns_build_the_model_once(settings) -> None:
    release = threading.Event()
    builder = Builder(delay=release)
    runner = PydanticModelRunner(settings, build_model=builder)
    seen = []
    threads = [
        threading.Thread(target=lambda: seen.append(runner.run(request(), None)))
        for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    assert builder.entered.wait(timeout=5)
    release.set()
    for thread in threads:
        thread.join(timeout=5)
        assert not thread.is_alive()
    assert len(builder.calls) == 1
    assert len(seen) == 4
    assert all(outcome.error is None for outcome in seen)


def test_a_failed_model_build_is_retried_on_the_next_turn(settings) -> None:
    attempts = []

    def flaky(config):
        attempts.append(config)
        if len(attempts) == 1:
            raise RuntimeError("provider rejected the configuration")
        return Builder()(config)

    runner = PydanticModelRunner(settings, build_model=flaky)
    assert "provider rejected" in runner.run(request(), None).error
    assert runner.run(request(), None).error is None
    assert len(attempts) == 2


def test_streaming_appends_ephemeral_only_to_the_outgoing_copy() -> None:
    received = []

    async def stream(messages, info):
        received.append(ModelMessagesTypeAdapter.dump_json(messages).decode())
        yield "Done"

    original = [ModelRequest(parts=[UserPromptPart("Reminder")])]
    model = LiveModel(
        lambda: FunctionModel(stream_function=stream), lambda: "EPHEMERAL"
    )

    async def run():
        async with model.request_stream(
            original, None, ModelRequestParameters()
        ) as response:
            async for _ in response:
                pass
            assert response.get().parts[0].content == "Done"

    asyncio.run(run())
    assert "EPHEMERAL" in received[0]
    assert len(original[0].parts) == 1
