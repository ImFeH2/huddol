from dataclasses import asdict, fields

import pytest

from huddol.core.errors import DomainError
from huddol.core.parameters import (
    AgentParameters,
    agent_parameters,
    validate_parameters,
)


@pytest.mark.parametrize("values", [None, {}, {"unknown": 10}])
def test_parameters_fill_defaults_and_ignore_unknown_keys(values) -> None:
    assert asdict(agent_parameters(values)) == {
        "context_window_tokens": 200_000,
        "exchange_nudge_after": 6,
        "max_concurrent_turns": 4,
        "idle_streak_after": 3,
        "no_tool_turns_before_pause": 3,
        "memory_index_bytes": 16_384,
        "token_limit": 0,
    }


def test_parameters_accept_positive_integers() -> None:
    values = {field.name: 100 for field in fields(AgentParameters)}
    assert validate_parameters(values) == values
    assert asdict(agent_parameters(values)) == values
    assert validate_parameters({}) == {}


@pytest.mark.parametrize("key", [field.name for field in fields(AgentParameters)])
@pytest.mark.parametrize("value", [-1, True, False, "100", 1.5, None])
def test_invalid_parameters_are_ignored_on_read_and_rejected_on_write(
    key, value
) -> None:
    values = {key: value}
    assert agent_parameters(values) == AgentParameters()
    with pytest.raises(DomainError) as error:
        validate_parameters(values)
    assert error.value.code == "invalid_parameter"
    kind = "non-negative" if key == "token_limit" else "positive"
    assert str(error.value) == f"{key} must be a {kind} integer"


@pytest.mark.parametrize("key", [field.name for field in fields(AgentParameters)])
def test_only_token_limit_accepts_zero(key) -> None:
    values = {key: 0}
    assert agent_parameters(values) == AgentParameters()
    if key == "token_limit":
        assert validate_parameters(values) == values
    else:
        with pytest.raises(DomainError) as error:
            validate_parameters(values)
        assert error.value.code == "invalid_parameter"


def test_unknown_parameters_are_rejected_on_write() -> None:
    with pytest.raises(DomainError) as error:
        validate_parameters({"unknown": 100})
    assert error.value.code == "invalid_setting"
    assert str(error.value) == "Unknown Agent parameter: unknown"
