from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, replace

from huddol.core.errors import DomainError
from huddol.core.parameters import AgentParameters, agent_parameters
from huddol.ports.agent import HistoryStore, SettingsStore, TodoStore
from huddol.ports.execution import ExecutionControl
from huddol.ports.store import OrganizationStore
from huddol.runtime.reminder import (
    PREPARATION_PROMPT,
    ModelRunner,
    Reminder,
    TurnRequest,
    build_reminder,
    exchange_nudge,
    render_resident,
    reset_notice,
)
from huddol.services.memory import Memory
from huddol.services.todo import Todos
from huddol.tools import AgentTools, Dependencies, TurnBinding
from huddol.tools.authorize import Actor, Authorizer

logger = logging.getLogger("huddol.runtime")


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
        on_event: Callable[[str, dict[str, object]], None] | None = None,
    ) -> None:
        self._deps = deps
        self._runner = runner
        self._authorizer = authorizer or Authorizer()
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
        return self.parameters().token_limit

    def over_token_limit(self, agent_id: int) -> bool:
        limit = self.token_limit()
        if limit <= 0:
            return False
        return self.history.usage_total(agent_id)["total_tokens"] >= limit

    def parameters(self) -> AgentParameters:
        return agent_parameters(self.settings.get_settings("agent"))

    def preparation_due(self, agent_id: int) -> bool:
        runs = self.history.runs(agent_id, limit=1)
        if not runs:
            return False
        run = runs[0]
        if run.sequence < self.history.window(
            agent_id
        ).since_sequence or run.status not in ("completed", "failed"):
            return False
        tokens = json.loads(run.usage_json or "{}").get("last_input_tokens")
        return type(tokens) is int and tokens >= self.parameters().context_window_tokens

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
            if self.over_token_limit(member.id):
                continue
            if self.preparation_due(member.id):
                found.append(member.id)
                continue
            keys = self.pending_keys(member.id)
            if keys and not self._failed_on(member.id, keys):
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
    ) -> AgentTools:
        return AgentTools(
            self._deps,
            actor,
            self._authorizer,
            turn,
            on_change=self._changed,
        )

    @property
    def execution(self) -> ExecutionControl:
        return self._deps.execution

    def resident_block(self, agent_id: int) -> str:
        return render_resident(
            Memory(self._deps.memory_tree_for(agent_id)).index(
                self.parameters().memory_index_bytes
            ),
            Todos(self._deps.todos, agent_id).snapshot(),
            self.environment_facts(),
            reset_notice(self.history.window(agent_id)),
        )

    def environment_facts(self) -> str | None:
        try:
            return self._deps.execution.snapshot().describe_environment()
        except DomainError:
            return None

    def run_turn(self, agent_id: int) -> TurnRecord | None:
        member = self.store.get_member(agent_id)
        if member is None or not member.is_agent or member.state != "idle":
            return None
        if self.over_token_limit(agent_id):
            return None
        if self.preparation_due(agent_id):
            return self._execute(agent_id, member.name, None, PREPARATION_PROMPT)
        reminder = build_reminder(self.store, self.history, agent_id, member.name)
        if reminder is None:
            return None
        return self._execute(agent_id, member.name, reminder, reminder.render())

    def _execute(
        self, agent_id: int, agent_name: str, reminder: Reminder | None, prompt: str
    ) -> TurnRecord:
        items = reminder.items if reminder is not None else ()
        self.store.set_agent_state(agent_id, "running")
        run = self.history.start_run(
            agent_id,
            reminded=[(item.discussion_id, item.message_id) for item in items],
        )
        self.emit(
            "turn.started",
            {
                "agent_id": agent_id,
                "sequence": run.sequence,
                "items": len(items),
                "kind": "reminder" if reminder is not None else "preparation",
            },
        )
        discussion_ids = tuple(item.discussion_id for item in items)
        request = TurnRequest(
            agent_id=agent_id,
            sequence=run.sequence,
            agent_name=agent_name,
            prompt=prompt,
            reminder=reminder,
            history_json=self.history.latest_messages(agent_id),
            resident="",
            environment=self.environment_facts,
            persist=lambda messages_json: self.history.save_progress(
                agent_id, run.sequence, messages_json
            ),
            ephemeral=lambda: exchange_nudge(
                self.store,
                agent_id,
                discussion_ids,
                after=self.parameters().exchange_nudge_after,
            ),
        )
        status = "completed"
        error: str | None = None
        context_exceeded = False
        try:
            request = replace(request, resident=self.resident_block(agent_id))
            outcome = self._runner.run(
                request,
                self.tools_for_actor(
                    Actor(agent_id, True),
                    TurnBinding(agent_id, run.sequence),
                ),
            )
            context_exceeded = outcome.context_exceeded
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
            reason = None
            if reminder is None:
                reason = "prepared"
            elif (
                context_exceeded
                and run.sequence != self.history.window(agent_id).since_sequence
            ):
                reason = "overflow"
            if reason is not None:
                window = self.history.reset_window(agent_id, reason)
                with self._lock:
                    self._failed.pop(agent_id, None)
                self.emit(
                    "window.reset",
                    {"agent_id": agent_id, "number": window.number, "reason": reason},
                )
                self.wake()
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
                running = sum(thread.is_alive() for thread in self._threads.values())
                if running >= self.parameters().max_concurrent_turns:
                    break

                def work(target: int = agent_id) -> None:
                    try:
                        self.run_turn(target)
                    finally:
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
