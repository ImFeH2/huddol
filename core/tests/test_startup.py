from __future__ import annotations

import json
import socket
import sqlite3
import time
from contextlib import closing
from pathlib import Path

import pytest
from test_sidecar_process import Client, Kernel, wait_for_persisted_turn
from test_sidecar_process import local_model as local_model  # noqa: PLC0414

from huddol.adapters.sqlite.agent import SqliteAgentStore
from huddol.adapters.sqlite.store import SqliteStore


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def frontend(directory: Path) -> Path:
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text("<!doctype html><title>Huddol</title>")
    return directory


def stored_setting(directory: Path, section: str, raw: str) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    store = SqliteStore(directory / "huddol.sqlite3")
    try:
        SqliteAgentStore(store._db)
        with store._db:
            store._db.execute(
                "INSERT INTO settings (section, values_json) VALUES (?, ?)"
                " ON CONFLICT (section) DO UPDATE SET values_json = excluded.values_json",
                (section, raw),
            )
    finally:
        store.close()


@pytest.mark.parametrize("raw", ['{"request_limit":-1}', "null", '{"private-value":'])
@pytest.mark.parametrize("transport", ["stdio", "websocket"])
def test_invalid_settings_fail_before_ready(tmp_path, raw, transport) -> None:
    directory = tmp_path / "data"
    stored_setting(directory, "agent", raw)
    kernel = Kernel(
        directory,
        env={name: str(tmp_path) for name in ("TMPDIR", "TEMP", "TMP")},
        arguments=["--transport", transport],
    )
    result = kernel.run_second_instance()
    assert result.returncode != 0
    assert result.stdout == b""
    assert b"DomainError" in result.stderr
    assert b"private-value" not in result.stderr
    assert not (directory / "run.json").exists()
    assert not (directory / "token").exists()
    with closing(sqlite3.connect(directory / "huddol.sqlite3")) as connection:
        assert connection.execute("SELECT COUNT(*) FROM agent_runs").fetchone()[0] == 0
        assert (
            connection.execute(
                "SELECT values_json FROM settings WHERE section = 'agent'"
            ).fetchone()[0]
            == raw
        )


@pytest.mark.parametrize(
    "section,raw",
    [("agent", '{"token_limit":-1}'), ("execution", "null"), ("model", "null")],
)
def test_startup_failure_releases_created_resources(
    tmp_path, monkeypatch, section, raw
) -> None:
    import logging

    import huddol.__main__ as entry
    from huddol.adapters.execution.manager import ExecutionManager
    from huddol.core.errors import DomainError

    directory = tmp_path / "data"
    stored_setting(directory, section, raw)
    before = list(logging.getLogger().handlers)
    closed_stores = []
    closed_execution = []
    handlers = []
    close_store = SqliteStore.close
    close_execution = ExecutionManager.close
    configure_logging = entry.configure_logging

    def record_store(store):
        close_store(store)
        closed_stores.append(store)

    def record_execution(execution):
        close_execution(execution)
        closed_execution.append(execution)

    def record_logging(path):
        created = configure_logging(path)
        handlers.extend(created)
        return created

    monkeypatch.setattr(SqliteStore, "close", record_store)
    monkeypatch.setattr(ExecutionManager, "close", record_execution)
    monkeypatch.setattr(entry, "configure_logging", record_logging)
    monkeypatch.setattr(entry, "configure_stdio", lambda: None)
    monkeypatch.setattr(entry, "install_signal_handlers", lambda callback: None)
    with pytest.raises(DomainError):
        entry.main(["--data-dir", str(directory), "--transport", "stdio"])
    assert len(closed_stores) == 1
    assert len(closed_execution) == (1 if section == "agent" else 0)
    assert logging.getLogger().handlers == before
    assert handlers and all(handler._closed for handler in handlers)
    assert not (directory / "run.json").exists()


@pytest.mark.parametrize("raw", ["null", '{"request_limit":'])
def test_backup_repair_and_restart_preserve_safety_state(
    tmp_path, raw, local_model
) -> None:
    directory = tmp_path / "data"
    stored_setting(directory, "agent", raw)
    store = SqliteStore(directory / "huddol.sqlite3")
    try:
        history = SqliteAgentStore(store._db)
        history.set_settings("model", local_model)
        human = store.create_member("human", "You")
        ready = store.create_member("agent", "Ready")
        paused = store.create_member("agent", "Paused")
        room = store.create_discussion("pending", [human.id, ready.id, paused.id])
        store.append_message(room.id, human.id, "@Ready @Paused work")
        history.pause_for_safety(paused.id, "runtime_error")
        store.set_agent_state(paused.id, "paused")
    finally:
        store.close()
    with closing(sqlite3.connect(directory / "huddol.sqlite3")) as source:
        with closing(sqlite3.connect(tmp_path / "backup.sqlite3")) as backup:
            source.backup(backup)
        with source:
            source.execute(
                "UPDATE settings SET values_json = ? WHERE section = 'agent'",
                (json.dumps({"request_limit": 1, "max_concurrent_turns": 1}),),
            )
    with Kernel(
        directory, env={name: str(tmp_path) for name in ("TMPDIR", "TEMP", "TMP")}
    ) as kernel:
        wait_for_persisted_turn(directory, ready.id, 1)
        with kernel.connect() as connection:
            client = Client(connection)
            result = client.call(
                {"id": 1, "method": "settings.get", "params": {"section": "agent"}}
            )
            assert result["result"]["request_limit"] == 1
            assert result["result"]["max_concurrent_turns"] == 1
        assert kernel.shutdown() == 0
    with closing(sqlite3.connect(tmp_path / "backup.sqlite3")) as backup:
        assert (
            backup.execute(
                "SELECT values_json FROM settings WHERE section = 'agent'"
            ).fetchone()[0]
            == raw
        )
    store = SqliteStore(directory / "huddol.sqlite3")
    try:
        history = SqliteAgentStore(store._db)
        assert len(history.runs(ready.id)) == 1
        assert history.runs(paused.id) == ()
        assert history.pause_reason(paused.id) == "runtime_error"
        assert store.get_member(paused.id).state == "paused"
    finally:
        store.close()


@pytest.mark.parametrize("raw", ['{"token_limit":-1}', "null", '{"private-value":'])
def test_scheduler_failure_keeps_http_and_settings_diagnostics(tmp_path, raw) -> None:
    directory = tmp_path / "data"
    with Kernel(
        directory,
        env={name: str(tmp_path) for name in ("TMPDIR", "TEMP", "TMP")},
        webui_directory=frontend(tmp_path / "webui"),
    ) as kernel:
        with (
            closing(sqlite3.connect(directory / "huddol.sqlite3")) as connection,
            connection,
        ):
            connection.execute(
                "INSERT INTO settings (section, values_json) VALUES ('agent', ?)",
                (raw,),
            )
        log_path = directory / "logs" / "huddol.log"
        deadline = time.monotonic() + 10
        while "Scheduler stopped after a runtime failure" not in log_path.read_text():
            assert time.monotonic() < deadline
            time.sleep(0.01)
        assert "private-value" not in log_path.read_text()
        assert kernel.http("/")[0] == 200
        with kernel.connect() as connection:
            client = Client(connection)
            result = client.call(
                {"id": 1, "method": "settings.get", "params": {"section": "agent"}}
            )
            assert result["error"]["code"] in ("invalid_setting", "invalid_parameter")
            assert "agent" in result["error"]["message"].lower()
            assert client.call({"id": 2, "method": "ping"})["result"] == {"pong": None}
        assert kernel.shutdown() == 0


def test_explicit_options_override_the_environment(tmp_path: Path) -> None:
    from_environment = tmp_path / "from-environment"
    explicit = tmp_path / "explicit"
    port = free_port()
    with Kernel(
        from_environment,
        env={
            "HUDDOL_PORT": "0",
            "HUDDOL_TOKEN": "from-environment",
            "HUDDOL_WEBUI_DIR": str(tmp_path / "environment-webui"),
        },
        arguments=[
            "--data-dir",
            str(explicit),
            "--port",
            str(port),
            "--token",
            "explicit",
        ],
    ) as kernel:
        assert kernel.ready["port"] == port
        assert kernel.ready["token"] == "explicit"
        assert (explicit / "huddol.sqlite3").is_file()
        assert not from_environment.exists()
        assert kernel.shutdown() == 0, kernel.stderr


def test_the_webui_directory_option_replaces_the_environment(tmp_path: Path) -> None:
    served = frontend(tmp_path / "served")
    with Kernel(
        tmp_path / "data",
        env={"HUDDOL_WEBUI_DIR": str(tmp_path / "ignored")},
        arguments=["--webui-dir", str(served)],
    ) as kernel:
        status, content_type, body = kernel.http("/")
        assert status == 200
        assert content_type == "text/html; charset=utf-8"
        assert b"Huddol" in body
        assert kernel.shutdown() == 0, kernel.stderr


def test_core_without_a_frontend_serves_only_the_websocket_endpoint(
    tmp_path: Path,
) -> None:
    with Kernel(tmp_path / "data", env={"HUDDOL_WEBUI_DIR": ""}) as kernel:
        assert kernel.http("/")[0] == 404
        assert kernel.http("/assets/app.js")[0] == 404
        assert kernel.http("/ws")[0] == 401
        status, _content_type, body = kernel.http(f"/ws?token={kernel.token}")
        assert status == 204
        assert body == b""
        with kernel.connect() as connection:
            client = Client(connection)
            assert client.call({"id": 1, "method": "ping"})["result"] == {"pong": None}
        assert kernel.shutdown() == 0, kernel.stderr


def test_stdio_serves_responses_and_events_on_stdout(tmp_path: Path) -> None:
    with Kernel(tmp_path / "data", arguments=["--transport", "stdio"]) as kernel:
        assert kernel.ready == {"type": "ready", "transport": "stdio"}
        kernel.send_stdin(
            json.dumps(
                {
                    "id": 1,
                    "method": "organization.rename_member",
                    "params": {"member_id": 1, "name": "Renamed"},
                }
            )
            + "\n"
        )
        frames = [kernel.read_frame(), kernel.read_frame()]
        assert {"type": "member.updated", "id": 1, "name": "Renamed"} in frames
        assert {
            "type": "response",
            "id": 1,
            "result": {"id": 1, "name": "Renamed"},
        } in frames
        assert kernel.shutdown() == 0, kernel.stderr
    assert "Shutting down (shutdown)" in kernel.stderr


def test_stdio_stops_when_stdin_ends(tmp_path: Path) -> None:
    with Kernel(tmp_path / "data", arguments=["--transport", "stdio"]) as kernel:
        assert kernel.shutdown(close_only=True) == 0
    assert "Shutting down (eof)" in kernel.stderr
    assert not (tmp_path / "data" / "run.json").exists()


@pytest.mark.parametrize("arguments", [[], ["--transport", "websocket"]])
def test_the_default_transport_is_websocket(
    tmp_path: Path, arguments: list[str]
) -> None:
    with Kernel(
        tmp_path / "data", env={"HUDDOL_WEBUI_DIR": ""}, arguments=arguments
    ) as kernel:
        assert kernel.ready["type"] == "ready"
        assert "port" in kernel.ready
        assert kernel.shutdown() == 0, kernel.stderr
