from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore
from huddol.core.errors import DomainError
from huddol.ports.agent import WindowState
from huddol.services.history import History
from huddol.services.todo import Todos

AGENT = 13


@pytest.fixture
def agent_store(tmp_path: Path) -> SqliteAgentStore:
    base = SqliteStore(tmp_path / "huddol.sqlite3")
    yield SqliteAgentStore(base._db)
    base.close()


@pytest.fixture
def todos(agent_store: SqliteAgentStore) -> Todos:
    return Todos(agent_store, AGENT)


def test_at_most_one_todo_may_be_in_progress(todos: Todos) -> None:
    first = todos.add("write the store")
    second = todos.add("write the runtime")
    todos.start(first.id)

    with pytest.raises(DomainError) as error:
        todos.start(second.id)
    assert error.value.code == "todo_already_in_progress"

    todos.complete(first.id)
    assert todos.start(second.id).status == "in_progress"


def test_starting_the_same_todo_twice_is_allowed(todos: Todos) -> None:
    item = todos.add("keep going")
    todos.start(item.id)
    assert todos.start(item.id).status == "in_progress"


def test_titles_are_normalized_and_validated(todos: Todos) -> None:
    assert todos.add("  spaced   out  ").title == "spaced out"
    with pytest.raises(DomainError):
        todos.add("   ")


def test_snapshot_lists_open_items_with_details(todos: Todos) -> None:
    first = todos.add("alpha", "first line\nsecond line")
    todos.add("beta")
    done = todos.add("finished", "hidden")
    todos.complete(done.id)
    todos.start(first.id)
    assert todos.snapshot() == (
        "Todos:\n- [>] 1. alpha\n  first line\n  second line\n- [ ] 2. beta"
    )


def test_snapshot_has_no_items_when_empty_or_everything_is_done(todos: Todos) -> None:
    assert todos.snapshot() == "Todos: none"
    item = todos.add("only")
    todos.complete(item.id)
    assert todos.snapshot() == "Todos: none"


def test_todos_are_private_to_each_agent(agent_store: SqliteAgentStore) -> None:
    Todos(agent_store, 13).add("mine")
    assert Todos(agent_store, 36).list() == ()


def test_runs_append_and_report_the_latest_history(
    agent_store: SqliteAgentStore,
) -> None:
    first = agent_store.start_run(AGENT)
    agent_store.finish_run(
        AGENT, first.sequence, status="completed", messages_json='[{"kind":"request"}]'
    )
    second = agent_store.start_run(AGENT)
    assert second.sequence == 2
    assert agent_store.latest_messages(AGENT) == '[{"kind":"request"}]'


def test_windows_default_and_reset_without_any_runs(agent_store) -> None:
    assert agent_store.window(AGENT) == WindowState(1, 1, None, None)
    assert agent_store.latest_messages(AGENT) == "[]"
    state = agent_store.reset_window(AGENT, "prepared")
    assert state == WindowState(2, 1, state.reset_at, "prepared")
    assert state.reset_at is not None
    assert agent_store.window(AGENT) == state
    assert agent_store.window(AGENT + 1) == WindowState(1, 1, None, None)
    state = agent_store.reset_window(AGENT, "overflow")
    assert state == WindowState(3, 1, state.reset_at, "overflow")


def test_windows_scope_messages_but_keep_history_usage_and_effects(agent_store) -> None:
    first = agent_store.start_run(AGENT)
    agent_store.finish_run(
        AGENT,
        first.sequence,
        status="completed",
        messages_json='[{"text":"old"}]',
        usage_json='{"input_tokens":100,"output_tokens":20}',
    )
    agent_store.record_effect(AGENT, first.sequence, "send", "old message")
    agent_store.start_run(AGENT)
    for _ in range(5):
        agent_store.start_run(AGENT + 1)
    state = agent_store.reset_window(AGENT, "prepared")
    assert state.number == 2
    assert state.since_sequence == 3
    assert agent_store.latest_messages(AGENT) == "[]"
    assert len(agent_store.runs(AGENT)) == 2
    assert agent_store.search_runs(AGENT, "old")[0].sequence == first.sequence
    assert agent_store.usage_total(AGENT)["total_tokens"] == 120
    assert agent_store.effects(AGENT)[0].summary == "old message"
    run = agent_store.start_run(AGENT)
    assert run.sequence == state.since_sequence
    assert agent_store.latest_messages(AGENT) == "[]"
    agent_store.finish_run(
        AGENT, run.sequence, status="completed", messages_json='[{"text":"new"}]'
    )
    agent_store.start_run(AGENT)
    assert agent_store.latest_messages(AGENT) == '[{"text":"new"}]'
    state = agent_store.reset_window(AGENT, "overflow")
    assert state.number == 3 and state.since_sequence == 5
    assert agent_store.latest_messages(AGENT) == "[]"
    reopened = SqliteAgentStore(agent_store._db)
    assert reopened.window(AGENT) == state
    assert reopened.latest_messages(AGENT) == "[]"
    assert len(reopened.runs(AGENT)) == 4
    assert reopened.search_runs(AGENT, "old")[0].sequence == first.sequence


@pytest.mark.parametrize("finished", [False, True])
def test_save_progress_updates_only_the_target_runs_messages(
    agent_store, finished
) -> None:
    first = agent_store.start_run(AGENT)
    other = agent_store.start_run(AGENT + 1)
    if finished:
        agent_store.finish_run(
            AGENT,
            first.sequence,
            status="failed",
            messages_json="[]",
            usage_json='{"requests":1}',
            error="failure",
        )
    original = agent_store.runs(AGENT)[0]
    second = agent_store.start_run(AGENT)
    for messages in ('[{"text":"first"}]', '[{"text":"second"}]'):
        agent_store.save_progress(AGENT, first.sequence, messages)
        assert agent_store.runs(AGENT) == (
            second,
            replace(original, messages_json=messages),
        )
        assert agent_store.runs(AGENT + 1) == (other,)


def test_unfinished_runs_are_marked_interrupted(agent_store: SqliteAgentStore) -> None:
    prior = agent_store.start_run(AGENT)
    agent_store.finish_run(
        AGENT, prior.sequence, status="completed", messages_json='[{"text":"old"}]'
    )
    run = agent_store.start_run(AGENT)
    partial = '[{"text":"partial"}]'
    agent_store.save_progress(AGENT, run.sequence, partial)
    assert agent_store.mark_interrupted() == 1
    assert agent_store.runs(AGENT)[0].status == "interrupted"
    assert agent_store.runs(AGENT)[0].messages_json == partial
    agent_store.start_run(AGENT)
    assert agent_store.latest_messages(AGENT) == partial


def test_history_search_finds_runs_by_content(agent_store: SqliteAgentStore) -> None:
    run = agent_store.start_run(AGENT)
    agent_store.finish_run(
        AGENT, run.sequence, status="completed", messages_json='[{"text":"bubblewrap"}]'
    )
    history = History(agent_store, AGENT)
    assert len(history.search("bubblewrap")) == 1
    assert history.search("nothing") == ()


def test_settings_round_trip_without_a_directory_table(
    agent_store: SqliteAgentStore,
) -> None:
    agent_store.set_settings("model", {"model": "claude-opus-5", "compaction": 200})
    assert agent_store.get_settings("model") == {
        "model": "claude-opus-5",
        "compaction": 200,
    }
    assert agent_store.get_settings("missing") is None

    tables = {
        str(row["name"])
        for row in agent_store._db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    assert "write_directories" not in tables


def test_effects_are_numbered_per_turn_and_read_back_in_order(
    agent_store: SqliteAgentStore,
) -> None:
    agent_store.start_run(AGENT)
    agent_store.record_effect(AGENT, 1, "run", "pytest exited 0")
    agent_store.record_effect(AGENT, 1, "send", "Discussion 2: message 9")
    agent_store.start_run(AGENT)
    agent_store.record_effect(AGENT, 2, "ack", "Discussion 2: 1 acknowledged")

    everything = agent_store.effects(AGENT)
    assert [(item.sequence, item.ordinal, item.tool) for item in everything] == [
        (2, 1, "ack"),
        (1, 1, "run"),
        (1, 2, "send"),
    ]

    only_first = agent_store.effects(AGENT, sequences=[1])
    assert [item.tool for item in only_first] == ["run", "send"]


def test_effects_are_scoped_to_one_agent(agent_store: SqliteAgentStore) -> None:
    agent_store.record_effect(AGENT, 1, "send", "mine")
    agent_store.record_effect(AGENT + 1, 1, "send", "theirs")
    assert [item.summary for item in agent_store.effects(AGENT)] == ["mine"]


def test_usage_totals_add_up_across_turns(agent_store: SqliteAgentStore) -> None:
    import json as _json

    for inbound, outbound in ((100, 20), (300, 50)):
        run = agent_store.start_run(AGENT)
        agent_store.finish_run(
            AGENT,
            run.sequence,
            status="completed",
            messages_json="[]",
            usage_json=_json.dumps(
                {
                    "input_tokens": inbound,
                    "output_tokens": outbound,
                    "cache_read_tokens": 5,
                    "requests": 1,
                }
            ),
        )

    total = agent_store.usage_total(AGENT)
    assert total["input_tokens"] == 400
    assert total["output_tokens"] == 70
    assert total["total_tokens"] == 470
    assert total["requests"] == 2


def test_turns_without_usage_do_not_break_the_total(
    agent_store: SqliteAgentStore,
) -> None:
    run = agent_store.start_run(AGENT)
    agent_store.finish_run(AGENT, run.sequence, status="failed", messages_json="[]")
    assert agent_store.usage_total(AGENT)["total_tokens"] == 0
