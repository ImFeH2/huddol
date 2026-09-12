from __future__ import annotations

import threading
from collections.abc import Callable

from huddol.adapters.model.config import ModelConfig
from huddol.adapters.model.observability import Observability, ObservabilityConfig
from huddol.adapters.model.unavailable import UnavailableRunner
from huddol.ports.agent import SettingsStore
from huddol.runtime.reminder import ModelRunner, TurnOutcome, TurnRequest
from huddol.tools import AgentTools

UNAVAILABLE = "Configure a model in Settings before running Agents"

RunnerBuilder = Callable[[ModelConfig, Observability | None], ModelRunner]
ObservabilityBuilder = Callable[[ObservabilityConfig], Observability]


def build_runner(
    config: ModelConfig, observability: Observability | None
) -> ModelRunner:
    from huddol.adapters.model.runner import PydanticModelRunner

    return PydanticModelRunner(config, observability)


def build_observability(config: ObservabilityConfig) -> Observability:
    from huddol.adapters.model.langfuse import LangfuseObservability

    return LangfuseObservability(config)


class LiveModelRunner:
    def __init__(
        self,
        settings: SettingsStore,
        *,
        build_runner: RunnerBuilder = build_runner,
        build_observability: ObservabilityBuilder = build_observability,
    ) -> None:
        self._settings = settings
        self._build_runner = build_runner
        self._build_observability = build_observability
        self._lock = threading.Lock()
        self._config: ModelConfig | None = None
        self._tracing: ObservabilityConfig | None = None
        self._observability: Observability | None = None
        self._runner: ModelRunner = UnavailableRunner(UNAVAILABLE)

    def current(self) -> ModelRunner:
        config = ModelConfig.restore(self._settings.get_settings("model"))
        tracing = ObservabilityConfig.restore(
            self._settings.get_settings("observability")
        )
        with self._lock:
            tracing_changed = tracing != self._tracing
            if tracing_changed:
                observability = (
                    self._build_observability(tracing) if tracing is not None else None
                )
                previous = self._observability
                self._observability = observability
                self._tracing = tracing
                if previous is not None:
                    previous.shutdown()
            if tracing_changed or config != self._config:
                self._runner = (
                    self._build_runner(config, self._observability)
                    if config is not None
                    else UnavailableRunner(UNAVAILABLE)
                )
                self._config = config
            return self._runner

    def run(self, request: TurnRequest, tools: AgentTools) -> TurnOutcome:
        return self.current().run(request, tools)
