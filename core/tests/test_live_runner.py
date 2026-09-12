from __future__ import annotations

import threading
from typing import Any

from huddol.adapters.model.config import ModelConfig
from huddol.adapters.model.live import UNAVAILABLE, LiveModelRunner
from huddol.adapters.model.observability import ObservabilityConfig
from huddol.runtime.reminder import Reminder, ReminderItem, TurnOutcome, TurnRequest


class FakeSettings:
    def __init__(self) -> None:
        self.values: dict[str, dict[str, object]] = {}

    def get_settings(self, section: str) -> dict[str, object] | None:
        return self.values.get(section)

    def set_settings(self, section: str, values: dict[str, object]) -> None:
        self.values[section] = values


class FakeRunner:
    def __init__(self, config: ModelConfig, observability: Any) -> None:
        self.config = config
        self.observability = observability

    def run(self, request: TurnRequest, tools: Any) -> TurnOutcome:
        return TurnOutcome(messages_json=f'["{self.config.model}"]')


class FakeObservability:
    def __init__(self, config: ObservabilityConfig) -> None:
        self.config = config
        self.stopped = False

    def instrumentation(self) -> Any:
        return None

    def shutdown(self) -> None:
        self.stopped = True


class Builder:
    def __init__(self, delay: threading.Event | None = None) -> None:
        self.calls: list[ModelConfig] = []
        self.entered = threading.Event()
        self._delay = delay

    def __call__(self, config: ModelConfig, observability: Any) -> FakeRunner:
        self.calls.append(config)
        self.entered.set()
        if self._delay is not None:
            self._delay.wait(timeout=5)
        return FakeRunner(config, observability)


def request() -> TurnRequest:
    return TurnRequest(
        reminder=Reminder(2, "Main", (ReminderItem(1, "work", 1, 1, "You", False),)),
        history_json="[]",
        runtime_context="",
    )


def model_values(model: str) -> dict[str, object]:
    return {
        "api_type": "openai",
        "base_url": "https://example.invalid/v1",
        "api_key": "unused",
        "model": model,
    }


def test_runs_are_unavailable_until_a_model_is_configured() -> None:
    settings = FakeSettings()
    builder = Builder()
    live = LiveModelRunner(settings, build_runner=builder)
    outcome = live.run(request(), None)
    assert outcome.error == UNAVAILABLE
    assert outcome.messages_json == "[]"
    assert builder.calls == []

    settings.set_settings("model", {"compaction_threshold": 5})
    assert live.run(request(), None).error == UNAVAILABLE
    assert builder.calls == []


def test_the_next_run_picks_up_saved_settings_without_a_restart() -> None:
    settings = FakeSettings()
    builder = Builder()
    live = LiveModelRunner(settings, build_runner=builder)
    assert live.run(request(), None).error == UNAVAILABLE

    settings.set_settings("model", model_values("first"))
    assert live.run(request(), None).messages_json == '["first"]'
    first = live.current()
    assert live.current() is first
    assert [config.model for config in builder.calls] == ["first"]

    settings.set_settings("model", {**model_values("first"), "compaction_threshold": 9})
    second = live.current()
    assert second is not first
    assert isinstance(second, FakeRunner)
    assert second.config.compaction_threshold == 9

    settings.set_settings("model", model_values("second"))
    assert live.run(request(), None).messages_json == '["second"]'
    assert [config.model for config in builder.calls] == ["first", "first", "second"]

    settings.set_settings("model", {"compaction_threshold": 9})
    assert live.run(request(), None).error == UNAVAILABLE
    assert len(builder.calls) == 3


def test_observability_changes_rebuild_the_runner_and_stop_the_old_exporter() -> None:
    settings = FakeSettings()
    settings.set_settings("model", model_values("m"))
    builder = Builder()
    live = LiveModelRunner(
        settings, build_runner=builder, build_observability=FakeObservability
    )
    plain = live.current()
    assert isinstance(plain, FakeRunner)
    assert plain.observability is None

    tracing = {
        "enabled": True,
        "base_url": "https://langfuse.invalid",
        "public_key": "pk",
        "secret_key": "sk",
    }
    settings.set_settings("observability", tracing)
    traced = live.current()
    assert traced is not plain
    assert isinstance(traced, FakeRunner)
    assert isinstance(traced.observability, FakeObservability)
    assert traced.observability.config.base_url == "https://langfuse.invalid"
    assert live.current() is traced
    exporter = traced.observability

    settings.set_settings("observability", {**tracing, "enabled": False})
    untraced = live.current()
    assert untraced is not traced
    assert isinstance(untraced, FakeRunner)
    assert untraced.observability is None
    assert exporter.stopped is True
    assert len(builder.calls) == 3


def test_concurrent_runs_build_the_runner_once() -> None:
    settings = FakeSettings()
    settings.set_settings("model", model_values("m"))
    release = threading.Event()
    builder = Builder(delay=release)
    live = LiveModelRunner(settings, build_runner=builder)
    seen: list[object] = []
    threads = [
        threading.Thread(target=lambda: seen.append(live.current())) for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    assert builder.entered.wait(timeout=5)
    release.set()
    for thread in threads:
        thread.join(timeout=5)
    assert len(builder.calls) == 1
    assert len(seen) == 4
    assert all(runner is seen[0] for runner in seen)


def test_a_failed_build_is_retried_on_the_next_run() -> None:
    settings = FakeSettings()
    settings.set_settings("model", model_values("m"))
    attempts: list[int] = []

    def flaky(config: ModelConfig, observability: Any) -> FakeRunner:
        attempts.append(len(attempts))
        if len(attempts) == 1:
            raise RuntimeError("provider rejected the configuration")
        return FakeRunner(config, observability)

    live = LiveModelRunner(settings, build_runner=flaky)
    try:
        live.current()
    except RuntimeError:
        pass
    assert isinstance(live.current(), FakeRunner)
    assert len(attempts) == 2
