from __future__ import annotations

import json
import socket
from pathlib import Path

import pytest
from test_sidecar_process import Client, Kernel


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def frontend(directory: Path) -> Path:
    (directory / "assets").mkdir(parents=True)
    (directory / "index.html").write_text("<!doctype html><title>Huddol</title>")
    return directory


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
        assert kernel.http(f"/ws?token={kernel.token}")[0] == 426
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
