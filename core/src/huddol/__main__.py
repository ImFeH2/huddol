from __future__ import annotations

import json
import logging
import os
import secrets
import sys
from io import TextIOWrapper
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import cast
from urllib.parse import quote

DATA_DIRECTORY_ENV = "HUDDOL_DATA_DIR"
PORT_ENV = "HUDDOL_PORT"
TOKEN_ENV = "HUDDOL_TOKEN"


def data_directory() -> Path:
    override = os.environ.get(DATA_DIRECTORY_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".huddol"


def configure_logging(directory: Path) -> list[logging.Handler]:
    logs = directory / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(
            logs / "huddol.log", maxBytes=1 << 20, backupCount=3, encoding="utf-8"
        ),
        logging.StreamHandler(sys.stderr),
    ]
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for handler in handlers:
        handler.setFormatter(formatter)
        root.addHandler(handler)
    return handlers


def write_run_file(path: Path, port: int, token: str) -> None:
    payload = json.dumps({"port": port, "token": token, "pid": os.getpid()})
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(payload)
    os.chmod(path, 0o600)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    if args:
        if args[0] == "--windows-write-sandbox" and os.name == "nt":
            from huddol.adapters.sandbox.windows import run_restricted_command

            separator = args.index("--")
            return run_restricted_command(args[1], args[separator + 1 :], os.getcwd())
        raise SystemExit("Unknown execution mode")

    cast(TextIOWrapper, sys.stdin).reconfigure(encoding="utf-8", errors="strict")
    cast(TextIOWrapper, sys.stdout).reconfigure(
        encoding="utf-8", errors="strict", newline="\n"
    )

    from huddol.adapters.execution.manager import ExecutionManager
    from huddol.adapters.files.tree import MarkdownTree
    from huddol.adapters.jsonl.api import HUMAN_ID, Api
    from huddol.adapters.jsonl.protocol import Dispatcher, wait_for_shutdown
    from huddol.adapters.model.config import ModelConfig
    from huddol.adapters.sqlite.agent import SqliteAgentStore
    from huddol.adapters.sqlite.store import SqliteStore
    from huddol.adapters.websocket.server import WebServer, web_directory
    from huddol.runtime.scheduler import Scheduler
    from huddol.tools import Dependencies

    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True)
    handlers = configure_logging(directory)
    log = logging.getLogger("huddol")
    workspace = directory / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    store = SqliteStore(directory / "huddol.sqlite3")
    agent_store = SqliteAgentStore(store._db)
    agent_store.mark_interrupted()

    if store.get_member(HUMAN_ID) is None:
        store.create_member("human", "You")
    for member in store.list_members():
        if member.is_agent and member.state == "running":
            store.set_agent_state(member.id, "idle")

    execution = ExecutionManager(
        workspace, settings=agent_store.get_settings("execution"), tolerant=True
    )
    deps = Dependencies(
        store=store,
        todos=agent_store,
        history=agent_store,
        settings=agent_store,
        execution=execution,
        library_tree=MarkdownTree(directory / "library"),
        memory_tree_for=lambda member_id: MarkdownTree(
            directory / "agents" / str(member_id) / "memory"
        ),
    )

    dispatcher = Dispatcher()

    from huddol.adapters.model.observability import ObservabilityConfig

    config = ModelConfig.restore(agent_store.get_settings("model"))
    runner: object
    if config is None:
        from huddol.adapters.model.unavailable import UnavailableRunner

        runner = UnavailableRunner(
            "Configure a model in Settings before running Agents"
        )
    else:
        from huddol.adapters.model.runner import PydanticModelRunner

        tracing = ObservabilityConfig.restore(agent_store.get_settings("observability"))
        observability = None
        if tracing is not None:
            from huddol.adapters.model.langfuse import LangfuseObservability

            observability = LangfuseObservability(tracing)
        runner = PydanticModelRunner(config, observability)

    scheduler = Scheduler(
        deps,
        runner,  # type: ignore[arg-type]
        on_event=lambda name, payload: dispatcher.emit(name, payload),
    )
    Api(scheduler, dispatcher)

    token = os.environ.get(TOKEN_ENV) or secrets.token_urlsafe(24)
    server = WebServer(
        dispatcher,
        token,
        web_directory(),
        port=int(os.environ.get(PORT_ENV) or 0),
    )
    run_file = directory / "run.json"

    scheduler.start()
    server.start()
    write_run_file(run_file, server.port, token)
    log.info(
        "Listening on http://127.0.0.1:%d with data directory %s",
        server.port,
        directory,
    )
    sys.stdout.write(
        json.dumps(
            {
                "type": "ready",
                "port": server.port,
                "token": token,
                "url": f"http://127.0.0.1:{server.port}/?token={quote(token, safe='')}",
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    sys.stdout.flush()

    try:
        reason = wait_for_shutdown()
        log.info("Shutting down (%s)", reason)
    finally:
        server.stop()
        scheduler.stop()
        store.close()
        run_file.unlink(missing_ok=True)
        for handler in handlers:
            logging.getLogger().removeHandler(handler)
            handler.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
