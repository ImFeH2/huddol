import pytest

from huddol.core.errors import DomainError
from huddol.core.parameters import (
    AgentParameters,
    agent_parameters,
    validate_parameters,
)


@pytest.mark.parametrize("values", [None, {}, {"unknown": 10}])
def test_parameters_fill_defaults_and_ignore_unknown_keys(values) -> None:
    assert agent_parameters(values) == AgentParameters(context_window_tokens=200_000)


def test_parameters_accept_positive_integers() -> None:
    values = {"context_window_tokens": 100}
    assert validate_parameters(values) == values
    assert agent_parameters(values).context_window_tokens == 100
    assert validate_parameters({}) == {}


@pytest.mark.parametrize("value", [0, -1, True, False, "100", 1.5, None])
def test_invalid_parameters_are_ignored_on_read_and_rejected_on_write(value) -> None:
    values = {"context_window_tokens": value}
    assert agent_parameters(values) == AgentParameters()
    with pytest.raises(DomainError) as error:
        validate_parameters(values)
    assert error.value.code == "invalid_parameter"
    assert str(error.value) == "context_window_tokens must be a positive integer"


def test_unknown_parameters_are_rejected_on_write() -> None:
    with pytest.raises(DomainError) as error:
        validate_parameters({"unknown": 100})
    assert error.value.code == "invalid_setting"
    assert str(error.value) == "Unknown Agent parameter: unknown"
