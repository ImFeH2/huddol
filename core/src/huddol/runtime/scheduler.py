from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, replace

from huddol.core.errors import DomainError
from huddol.ports.agent import HistoryStore, SettingsStore, TodoStore
from huddol.ports.execution import ExecutionControl, ExecutionEnvironment
from huddol.ports.store import OrganizationStore
from huddol.runtime.reminder import (
    ModelRunner,
    Reminder,
    TurnRequest,
    build_reminder,
    exchange_nudge,
)
from huddol.services.memory import Memory
from huddol.services.todo import Todos
from huddol.tools import AgentTools, Dependencies, TurnBinding
from huddol.tools.authorize import Actor, Authorizer

logger = logging.getLogger("huddol.runtime")

MAX_CONCURRENT = 4


@dataclass
class TurnRecord:
    agent_id: int
    sequence: int
    status: str
    error: str | None = None


class Scheduler:
    def __init__(
        self,
        deps: Dependencies,
        runner: ModelRunner,
        *,
        authorizer: Authorizer | None = None,
        max_concurrent: int = MAX_CONCURRENT,
        on_event: Callable[[str, dict[str, object]], None] | None = None,
    ) -> None:
        self._deps = deps
        self._runner = runner
        self._authorizer = authorizer or Authorizer()
        self._semaphore = threading.Semaphore(max_concurrent)
        self._threads: dict[int, threading.Thread] = {}
        self._failed: dict[int, frozenset[tuple[int, int]]] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._loop: threading.Thread | None = None
        self._on_event = on_event or (lambda name, payload: None)

    @property
    def store(self) -> OrganizationStore:
        return self._deps.store

    @property
    def todos(self) -> TodoStore:
        return self._deps.todos

    @property
    def history(self) -> HistoryStore:
        return self._deps.history

    @property
    def settings(self) -> SettingsStore:
        return self._deps.settings

    def emit(self, name: str, payload: dict[str, object]) -> None:
        try:
            self._on_event(name, payload)
        except Exception:
            logger.exception("event listener failed for %s", name)

    def _changed(self, name: str, payload: dict[str, object]) -> None:
        self.emit(name, payload)
        self.wake()

    def wake(self) -> None:
        self._wake.set()

    def start(self, poll_seconds: float = 0.2) -> None:
        if self._loop is not None:
            return
        self._loop = threading.Thread(
            target=self.serve,
            args=(poll_seconds,),
            name="huddol-loop",
            daemon=True,
        )
        self._loop.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        loop = self._loop
        self._loop = None
        if loop is not None and loop.ident is not None:
            loop.join(timeout=5)
        with self._lock:
            running = list(self._threads.values())
        self._deps.execution.close()
        for thread in running:
            if thread.ident is None:
                continue
            thread.join(timeout=5)

    def token_limit(self) -> int:
        limits = self.settings.get_settings("limits") or {}
        value = limits.get("agent_token_limit", 0)
        if not isinstance(value, int | float | str):
            return 0
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0

    def over_token_limit(self, agent_id: int) -> bool:
        limit = self.token_limit()
        if limit <= 0:
            return False
        return self.history.usage_total(agent_id)["total_tokens"] >= limit

    def pending_keys(self, agent_id: int) -> frozenset[tuple[int, int]]:
        return frozenset(
            (item.discussion_id, item.message_id)
            for item in self.store.pending(agent_id)
        )

    def _record_outcome(self, agent_id: int, status: str) -> None:
        keys = self.pending_keys(agent_id) if status == "failed" else None
        with self._lock:
            if keys is None:
                self._failed.pop(agent_id, None)
            else:
                self._failed[agent_id] = keys

    def _failed_on(self, agent_id: int, keys: frozenset[tuple[int, int]]) -> bool:
        with self._lock:
            return self._failed.get(agent_id) == keys

    def runnable_agents(self) -> tuple[int, ...]:
        found: list[int] = []
        for member in self.store.list_members():
            if not member.is_agent or member.state != "idle":
                continue
            keys = self.pending_keys(member.id)
            if not keys:
                continue
            if self._failed_on(member.id, keys):
                continue
            if self.over_token_limit(member.id):
                continue
            found.append(member.id)
        return tuple(found)

    def tools_for(self, agent_id: int) -> AgentTools:
        member = self.store.get_member(agent_id)
        if member is None:
            raise DomainError("not_found", f"Member {agent_id} does not exist")
        return self.tools_for_actor(Actor(agent_id, member.is_agent))

    def tools_for_actor(
        self,
        actor: Actor,
        turn: TurnBinding | None = None,
        *,
        environment: ExecutionEnvironment | None = None,
    ) -> AgentTools:
        return AgentTools(
            self._deps,
            actor,
            self._authorizer,
            turn,
            on_change=self._changed,
            environment=environment,
        )

    @property
    def execution(self) -> ExecutionControl:
        return self._deps.execution

    def runtime_context(
        self,
        agent_id: int,
        discussion_ids: tuple[int, ...] = (),
        *,
        environment: ExecutionEnvironment | None = None,
    ) -> str:
        selected = (
            environment if environment is not None else self._deps.execution.snapshot()
        )
        try:
            description = selected.describe_environment()
        except DomainError as error:
            description = f"Commands and file editing are unavailable: {error}. Business tools remain available."
        parts = [description]
        nudge = exchange_nudge(self.store, agent_id, discussion_ids)
        if nudge:
            parts.append(nudge)
        memory = Memory(self._deps.memory_tree_for(agent_id)).index_context()
        if memory:
            parts.append(memory)
        todo = Todos(self._deps.todos, agent_id).reminder()
        if todo:
            parts.append(todo)
        return "\n\n".join(parts)

    def run_turn(self, agent_id: int) -> TurnRecord | None:
        member = self.store.get_member(agent_id)
        if member is None or not member.is_agent or member.state != "idle":
            return None
        reminder = build_reminder(self.store, self.history, agent_id, member.name)
        if reminder is None:
            return None
        return self._execute(reminder)

    def _execute(self, reminder: Reminder) -> TurnRecord:
        environment = self._deps.execution.snapshot()
        agent_id = reminder.agent_id
        self.store.set_agent_state(agent_id, "running")
        run = self.history.start_run(
            agent_id,
            reminded=[(item.discussion_id, item.message_id) for item in reminder.items],
        )
        self.emit(
            "turn.started",
            {
                "agent_id": agent_id,
                "sequence": run.sequence,
                "items": len(reminder.items),
            },
        )
        request = TurnRequest(
            reminder=reminder,
            history_json=self.history.latest_messages(agent_id),
            runtime_context="",
        )
        status = "completed"
        error: str | None = None
        try:
            request = replace(
                request,
                runtime_context=self.runtime_context(
                    agent_id,
                    tuple(item.discussion_id for item in reminder.items),
                    environment=environment,
                ),
            )
            outcome = self._runner.run(
                request,
                self.tools_for_actor(
                    Actor(agent_id, True),
                    TurnBinding(agent_id, run.sequence),
                    environment=environment,
                ),
            )
            if outcome.error:
                status = "failed"
                error = outcome.error
            self.history.finish_run(
                agent_id,
                run.sequence,
                status=status,
                messages_json=outcome.messages_json,
                usage_json=outcome.usage_json,
                error=error,
            )
        except Exception as failure:
            status = "failed"
            error = f"{type(failure).__name__}: {failure}"
            logger.exception("turn failed for agent %s", agent_id)
            self.history.finish_run(
                agent_id,
                run.sequence,
                status=status,
                messages_json=request.history_json,
                error=error,
            )
        finally:
            self._record_outcome(agent_id, status)
            current = self.store.get_member(agent_id)
            if current is not None and current.state == "running":
                self.store.set_agent_state(agent_id, "idle")
            self.emit(
                "turn.finished",
                {"agent_id": agent_id, "sequence": run.sequence, "status": status},
            )
        return TurnRecord(agent_id, run.sequence, status, error)

    def tick(self) -> tuple[int, ...]:
        started: list[int] = []
        for agent_id in self.runnable_agents():
            with self._lock:
                existing = self._threads.get(agent_id)
                if existing is not None and existing.is_alive():
                    continue
                if not self._semaphore.acquire(blocking=False):
                    break

                def work(target: int = agent_id) -> None:
                    try:
                        self.run_turn(target)
                    finally:
                        self._semaphore.release()
                        self.wake()

                thread = threading.Thread(
                    target=work, name=f"huddol-agent-{agent_id}", daemon=True
                )
                thread.start()
                self._threads[agent_id] = thread
            started.append(agent_id)
        return tuple(started)

    def serve(self, poll_seconds: float = 0.2) -> None:
        while not self._stop.is_set():
            self.tick()
            self._wake.wait(timeout=poll_seconds)
            self._wake.clear()
