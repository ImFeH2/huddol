from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, get_args

ApiType = Literal["openai", "openai-responses", "anthropic", "google"]

API_TYPES: tuple[ApiType, ...] = get_args(ApiType)


@dataclass(frozen=True)
class ModelConfig:
    api_type: ApiType
    base_url: str
    api_key: str
    model: str

    @classmethod
    def restore(cls, values: dict[str, Any] | None) -> ModelConfig | None:
        if not values:
            return None
        model = values.get("model")
        api_key = values.get("api_key")
        base_url = values.get("base_url")
        if not model or not api_key or not base_url:
            return None
        api_type = str(values.get("api_type") or "openai")
        if api_type not in API_TYPES:
            api_type = "openai"
        return cls(
            api_type=api_type,  # type: ignore[arg-type]
            base_url=str(base_url),
            api_key=str(api_key),
            model=str(model),
        )

    def redacted(self) -> dict[str, Any]:
        return {
            "api_type": self.api_type,
            "base_url": self.base_url,
            "model": self.model,
            "api_key_set": bool(self.api_key),
        }
