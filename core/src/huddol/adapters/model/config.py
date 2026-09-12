from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, get_args

ApiType = Literal["openai", "openai-responses", "anthropic", "google"]

API_TYPES: tuple[ApiType, ...] = get_args(ApiType)

DEFAULT_COMPACTION = 400_000


def compaction_threshold(values: dict[str, Any]) -> int:
    threshold = values.get("compaction_threshold")
    return int(threshold) if threshold else DEFAULT_COMPACTION


@dataclass(frozen=True)
class ModelConfig:
    api_type: ApiType
    base_url: str
    api_key: str
    model: str
    compaction_threshold: int = DEFAULT_COMPACTION

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
            compaction_threshold=compaction_threshold(values),
        )

    def redacted(self) -> dict[str, Any]:
        return {
            "api_type": self.api_type,
            "base_url": self.base_url,
            "model": self.model,
            "compaction_threshold": self.compaction_threshold,
            "api_key_set": bool(self.api_key),
        }
