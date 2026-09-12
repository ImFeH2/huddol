from __future__ import annotations

import asyncio
from typing import Any

import pytest

from huddol.adapters.model import probe
from huddol.adapters.model.config import ModelConfig
from huddol.core.errors import DomainError

STORED = {
    "api_type": "openai",
    "base_url": "https://stored.invalid/v1",
    "api_key": "STORED-KEY",
    "model": "stored-model",
}


async def names(config: ModelConfig) -> list[str]:
    del config
    return ["models/gemini-b", "gemini-a", "gemini-a", "", "models/gemini-a"]


def test_listing_sorts_deduplicates_and_strips_the_google_prefix() -> None:
    result = probe.list_models(
        {"api_type": "google", "base_url": "https://g.invalid", "api_key": "k"},
        None,
        fetch=names,
    )
    assert result == {"models": ["gemini-a", "gemini-b"]}


@pytest.mark.parametrize("supplied", [None, "", "   "])
def test_listing_falls_back_to_the_stored_key(supplied: str | None) -> None:
    seen: list[ModelConfig] = []

    async def record(config: ModelConfig) -> list[str]:
        seen.append(config)
        return ["m"]

    values: dict[str, Any] = {"api_type": "anthropic", "base_url": "https://a.invalid"}
    if supplied is not None:
        values["api_key"] = supplied
    assert probe.list_models(values, STORED, fetch=record) == {"models": ["m"]}
    assert seen[0].api_key == "STORED-KEY"
    assert seen[0].api_type == "anthropic"
    assert seen[0].base_url == "https://a.invalid"


def test_listing_without_any_key_names_the_problem() -> None:
    with pytest.raises(DomainError) as failed:
        probe.list_models(
            {"api_type": "openai", "base_url": "https://a.invalid"}, {}, fetch=names
        )
    assert failed.value.code == "model_key_missing"


@pytest.mark.parametrize("api_type", [None, "", "azure", "OpenAI"])
def test_listing_rejects_unknown_api_types(api_type: object) -> None:
    with pytest.raises(DomainError) as failed:
        probe.list_models(
            {"api_type": api_type, "base_url": "https://a.invalid", "api_key": "k"},
            None,
            fetch=names,
        )
    assert failed.value.code == "invalid_api_type"


def test_listing_requires_a_base_url() -> None:
    with pytest.raises(ValueError):
        probe.list_models({"api_type": "openai", "api_key": "k"}, None, fetch=names)


def test_listing_failures_never_echo_the_key() -> None:
    async def explode(config: ModelConfig) -> list[str]:
        raise RuntimeError(
            f"401 from https://a.invalid/models?key={config.api_key}"
            f" with header Bearer {config.api_key}"
        )

    with pytest.raises(DomainError) as failed:
        probe.list_models(
            {"api_type": "openai", "base_url": "https://a.invalid", "api_key": "TOP"},
            None,
            fetch=explode,
        )
    assert failed.value.code == "model_list_failed"
    message = str(failed.value)
    assert "TOP" not in message
    assert message == (
        "RuntimeError: 401 from https://a.invalid/models?key=*** with header Bearer ***"
    )


def test_listing_is_bounded_by_a_timeout(monkeypatch) -> None:
    monkeypatch.setattr(probe, "LIST_TIMEOUT", 0.05)

    async def slow(config: ModelConfig) -> list[str]:
        await asyncio.sleep(5)
        return []

    with pytest.raises(DomainError) as failed:
        probe.list_models(
            {"api_type": "openai", "base_url": "https://a.invalid", "api_key": "k"},
            None,
            fetch=slow,
        )
    assert failed.value.code == "model_list_failed"
    assert str(failed.value) == "No response within 0.05 s"


def test_the_default_lister_covers_every_api_type() -> None:
    source = probe.fetch_model_names.__code__.co_consts
    del source
    assert probe.api_type_of("openai-responses") == "openai-responses"
    for api_type in ("openai", "openai-responses", "anthropic", "google"):
        assert probe.api_type_of(api_type) == api_type


def function_model(reply: str | Exception):
    from pydantic_ai.messages import ModelResponse, TextPart
    from pydantic_ai.models.function import FunctionModel

    def respond(messages, info):
        if isinstance(reply, Exception):
            raise reply
        assert messages[-1].parts[-1].content == probe.TEST_PROMPT
        return ModelResponse(parts=[TextPart(reply)])

    return FunctionModel(respond)


def test_a_model_test_reports_success_latency_and_reply(monkeypatch) -> None:
    from pydantic_ai import models

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    built: list[ModelConfig] = []

    def build(config: ModelConfig):
        built.append(config)
        return function_model(" OK \n")

    result = probe.try_model(
        {
            "api_type": "openai-responses",
            "base_url": "https://a.invalid/v1",
            "api_key": "k",
            "model": "candidate",
        },
        STORED,
        build=build,
    )
    assert result["ok"] is True
    assert isinstance(result["latency_ms"], int)
    assert result["latency_ms"] >= 0
    assert result["reply"] == "OK"
    assert built[0] == ModelConfig(
        "openai-responses", "https://a.invalid/v1", "k", "candidate"
    )


def test_a_model_test_uses_the_stored_key_when_none_is_typed(monkeypatch) -> None:
    from pydantic_ai import models

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    built: list[ModelConfig] = []

    def build(config: ModelConfig):
        built.append(config)
        return function_model("OK")

    probe.try_model(
        {"api_type": "openai", "base_url": "https://a.invalid/v1", "model": "m"},
        STORED,
        build=build,
    )
    assert built[0].api_key == "STORED-KEY"


def test_a_model_test_requires_a_model_name() -> None:
    with pytest.raises(ValueError):
        probe.try_model(
            {"api_type": "openai", "base_url": "https://a.invalid", "api_key": "k"},
            None,
            build=lambda config: function_model("OK"),
        )


def test_a_failing_model_test_never_echoes_the_key(monkeypatch) -> None:
    from pydantic_ai import models

    monkeypatch.setattr(models, "ALLOW_MODEL_REQUESTS", False)
    with pytest.raises(DomainError) as failed:
        probe.try_model(
            {
                "api_type": "anthropic",
                "base_url": "https://a.invalid",
                "api_key": "TOP",
                "model": "m",
            },
            None,
            build=lambda config: function_model(
                RuntimeError(f"rejected key TOP for {config.model}")
            ),
        )
    assert failed.value.code == "model_test_failed"
    assert "TOP" not in str(failed.value)
    assert "rejected key *** for m" in str(failed.value)


def test_a_broken_provider_is_reported_as_a_failed_test() -> None:
    def build(config: ModelConfig):
        raise ValueError("bad base_url")

    with pytest.raises(DomainError) as failed:
        probe.try_model(
            {
                "api_type": "openai",
                "base_url": "https://a.invalid",
                "api_key": "k",
                "model": "m",
            },
            None,
            build=build,
        )
    assert failed.value.code == "model_test_failed"
    assert str(failed.value) == "ValueError: bad base_url"
