from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, cast

from anthropic import AsyncAnthropic
from pydantic_ai import Agent
from pydantic_ai.models import Model
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider

from huddol.adapters.model.config import API_TYPES, ApiType, ModelConfig
from huddol.adapters.model.runner import build_model
from huddol.core.errors import DomainError

LIST_TIMEOUT = 15.0
TEST_TIMEOUT = 60.0
TEST_PROMPT = "Reply with the single word OK."
TEST_MAX_TOKENS = 16

Lister = Callable[[ModelConfig], Awaitable[Iterable[str]]]
Builder = Callable[[ModelConfig], Model]


def api_type_of(value: Any) -> ApiType:
    if value not in API_TYPES:
        raise DomainError(
            "invalid_api_type", f"api_type must be one of {', '.join(API_TYPES)}"
        )
    return cast(ApiType, value)


def sanitize(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


def describe(failure: BaseException, timeout: float) -> str:
    if isinstance(failure, TimeoutError):
        return f"No response within {timeout:g} s"
    message = str(failure).strip()
    return f"{type(failure).__name__}: {message}" if message else type(failure).__name__


def resolve(
    values: dict[str, Any], stored: dict[str, Any] | None, *, model_required: bool
) -> ModelConfig:
    api_type = api_type_of(values.get("api_type"))
    base_url = str(values.get("base_url") or "").strip()
    if not base_url:
        raise ValueError("base_url is required")
    api_key = str(values.get("api_key") or "").strip()
    if not api_key:
        api_key = str((stored or {}).get("api_key") or "").strip()
    if not api_key:
        raise DomainError(
            "model_key_missing", "Enter an API key or save one in Settings first"
        )
    model = str(values.get("model") or "").strip()
    if model_required and not model:
        raise ValueError("model is required")
    return ModelConfig(
        api_type=api_type, base_url=base_url, api_key=api_key, model=model
    )


async def fetch_model_names(config: ModelConfig) -> list[str]:
    if config.api_type == "anthropic":
        anthropic = AsyncAnthropic(base_url=config.base_url, api_key=config.api_key)
        try:
            return [item.id async for item in anthropic.models.list()]
        finally:
            await anthropic.close()
    if config.api_type == "google":
        google = GoogleProvider(api_key=config.api_key, base_url=config.base_url).client
        try:
            return [item.name or "" async for item in await google.aio.models.list()]
        finally:
            await google.aio.aclose()
    openai = OpenAIProvider(base_url=config.base_url, api_key=config.api_key).client
    try:
        return [item.id async for item in openai.models.list()]
    finally:
        await openai.close()


def list_models(
    values: dict[str, Any],
    stored: dict[str, Any] | None,
    *,
    fetch: Lister = fetch_model_names,
) -> dict[str, Any]:
    config = resolve(values, stored, model_required=False)
    try:
        names = asyncio.run(asyncio.wait_for(fetch(config), LIST_TIMEOUT))
    except Exception as failure:  # noqa: BLE001
        raise DomainError(
            "model_list_failed",
            sanitize(describe(failure, LIST_TIMEOUT), config.api_key),
        ) from None
    return {"models": sorted({name.removeprefix("models/") for name in names if name})}


def try_model(
    values: dict[str, Any],
    stored: dict[str, Any] | None,
    *,
    build: Builder = build_model,
) -> dict[str, Any]:
    config = resolve(values, stored, model_required=True)

    async def probe() -> str:
        agent: Agent[None, str] = Agent(build(config), name="huddol_model_test")
        result = await agent.run(
            TEST_PROMPT, model_settings={"max_tokens": TEST_MAX_TOKENS}
        )
        return result.output

    started = time.perf_counter()
    try:
        reply = asyncio.run(asyncio.wait_for(probe(), TEST_TIMEOUT))
    except Exception as failure:  # noqa: BLE001
        raise DomainError(
            "model_test_failed",
            sanitize(describe(failure, TEST_TIMEOUT), config.api_key),
        ) from None
    latency_ms = int((time.perf_counter() - started) * 1000)
    return {"ok": True, "latency_ms": latency_ms, "reply": str(reply).strip()}
