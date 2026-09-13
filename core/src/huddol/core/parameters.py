from collections.abc import Mapping
from dataclasses import asdict, dataclass

from huddol.core.errors import DomainError


@dataclass(frozen=True)
class AgentParameters:
    context_window_tokens: int = 200_000


def agent_parameters(values: Mapping[str, object] | None) -> AgentParameters:
    defaults = asdict(AgentParameters())
    return AgentParameters(
        **{
            key: value
            for key, value in (values or {}).items()
            if key in defaults and type(value) is int and value > 0
        }
    )


def validate_parameters(values: Mapping[str, object]) -> dict[str, int]:
    defaults = asdict(AgentParameters())
    validated: dict[str, int] = {}
    for key, value in values.items():
        if key not in defaults:
            raise DomainError("invalid_setting", f"Unknown Agent parameter: {key}")
        if type(value) is not int or value <= 0:
            raise DomainError("invalid_parameter", f"{key} must be a positive integer")
        validated[key] = value
    return validated
