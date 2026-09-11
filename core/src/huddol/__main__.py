from __future__ import annotations

import os
import sys
from io import TextIOWrapper
from pathlib import Path
from typing import cast

DATA_DIRECTORY_ENV = "HUDDOL_DATA_DIR"


def data_directory() -> Path:
    override = os.environ.get(DATA_DIRECTORY_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / ".huddol"


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
    from huddol.adapters.jsonl.protocol import Dispatcher, JsonLineWriter, serve
    from huddol.adapters.model.config import ModelConfig
    from huddol.adapters.sqlite.agent import SqliteAgentStore
    from huddol.adapters.sqlite.store import SqliteStore
    from huddol.runtime.scheduler import Scheduler
    from huddol.tools import Dependencies

    directory = data_directory()
    directory.mkdir(parents=True, exist_ok=True)
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

    writer = JsonLineWriter(sys.stdout)
    dispatcher = Dispatcher(writer)

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

    scheduler.start()

    execution_status = execution.status()
    dispatcher.emit(
        "ready",
        {
            "working_directory": execution_status["working_directory"],
            "data_directory": str(directory),
            "human_id": HUMAN_ID,
            "model_configured": config is not None,
            "tracing_enabled": bool(
                ObservabilityConfig.restore(agent_store.get_settings("observability"))
            ),
            "write_directories": list(execution.snapshot().write_directories)
            if execution_status["error"] is None
            else [],
            "unusable_write_directories": execution_status[
                "unusable_write_directories"
            ],
            "methods": list(dispatcher.methods()),
        },
    )

    try:
        serve(dispatcher)
    finally:
        scheduler.stop()
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
