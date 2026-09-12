import {
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Gauge,
  Pause,
  PencilLine,
  Play,
  Send,
  Terminal,
  Trash2,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useOrganization } from "@/app/organization";
import { useNavigate } from "@/app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  Section,
  Table,
} from "@/components/layout/shell";
import { ConfirmDialog } from "@/components/ui/dialog";
import {
  Avatar,
  Button,
  Chip,
  Dot,
  Meter,
  StateDot,
  StatusText,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { agentStateLabel } from "@/features/members/state";
import {
  type AgentDetail,
  type AgentRun,
  backend,
  type Member,
  type Todo,
} from "@/lib/backend";
import { formatBytes, formatTime, plural, relativeTime } from "@/lib/format";
import "@/features/members/members.css";

const TODO_COLUMNS: Column[] = [
  { key: "todo", label: "Todo" },
  { key: "status", label: "Status", width: "160px" },
];

const MEMORY_COLUMNS: Column[] = [
  { key: "path", label: "File" },
  { key: "size", label: "Size", align: "end", width: "120px" },
];

const TOOL_ICONS: Record<string, ReactNode> = {
  send: <Send size={13} />,
  run: <Terminal size={13} />,
  edit: <PencilLine size={13} />,
  ack: <Check size={13} />,
};

function toolIcon(tool: string): ReactNode {
  if (TOOL_ICONS[tool]) return TOOL_ICONS[tool];
  if (tool.startsWith("library")) return <FileText size={13} />;
  return <Gauge size={13} />;
}

function runTone(status: string): "green" | "red" | "blue" | "yellow" | "grey" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "blue";
  if (status === "interrupted") return "yellow";
  return "grey";
}

export function MemberPage({ id }: { id: number }) {
  const { members, refresh } = useOrganization();
  const navigate = useNavigate();
  const member = members.find((item) => item.id === id);
  const agent = member?.type === "agent" ? member : null;

  useEffect(() => {
    if (!agent) navigate({ name: "members" });
  }, [agent, navigate]);

  if (!agent) return null;
  return <AgentPage member={agent} refresh={refresh} />;
}

function AgentPage({
  member,
  refresh,
}: {
  member: Member;
  refresh: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [doomed, setDoomed] = useState(false);
  const paused = member.state === "paused";

  const load = useCallback(async () => {
    try {
      setDetail(await backend.agentDetail(member.id));
    } catch (failure) {
      backend.reportFailure(failure);
    }
  }, [member.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return backend.onEvent((event) => {
      if (event.type.startsWith("turn.")) void load();
    });
  }, [load]);

  const openTodos = detail
    ? detail.todos.filter((todo) => todo.status !== "done").length
    : 0;
  const tokenLimit = detail?.token_limit ?? 0;

  return (
    <Page>
      <PageHeader
        title={member.name}
        status={
          <>
            <AgentState member={member} tokenLimit={tokenLimit} />
            {detail?.over_token_limit ? (
              <Chip tone="danger">
                <CircleAlert size={12} />
                Token ceiling
              </Chip>
            ) : null}
            {detail && detail.idle_streak >= 3 ? (
              <Chip tone="warning">
                {plural(detail.idle_streak, "idle Turn")}
              </Chip>
            ) : null}
          </>
        }
        crumb={{
          label: "Members",
          onSelect: () => navigate({ name: "members" }),
        }}
        leading={<Avatar name={member.name} size="lg" />}
        actions={
          <>
            <Button
              variant={paused ? "primary" : "default"}
              onClick={async () => {
                await (paused
                  ? backend.resumeAgent(member.id)
                  : backend.pauseAgent(member.id));
                await refresh();
              }}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <OverflowMenu
              label={`Actions for ${member.name}`}
              actions={[
                {
                  id: "delete",
                  label: "Delete",
                  icon: <Trash2 size={15} />,
                  tone: "danger",
                  disabled: member.state === "running",
                  onSelect: () => setDoomed(true),
                },
              ]}
            />
          </>
        }
      />
      <PageBody>
        {detail ? (
          <>
            <div className="stat-grid">
              <Stat
                label="Token spend"
                value={detail.usage.total_tokens.toLocaleString()}
                detail={
                  detail.token_limit > 0 ? (
                    <>
                      <Meter
                        value={detail.usage.total_tokens}
                        max={detail.token_limit}
                        label={`Token spend for ${member.name}`}
                      />
                      <span className="muted">
                        of {detail.token_limit.toLocaleString()}
                      </span>
                    </>
                  ) : (
                    <span className="muted">No ceiling</span>
                  )
                }
              />
              <Stat
                label="Model requests"
                value={detail.usage.requests.toLocaleString()}
                detail={
                  <span className="muted">
                    {detail.usage.input_tokens.toLocaleString()} in ·{" "}
                    {detail.usage.output_tokens.toLocaleString()} out
                  </span>
                }
              />
              <Stat
                label="State"
                value={<AgentState member={member} tokenLimit={tokenLimit} />}
              />
              <Stat
                label="Open Todos"
                value={String(openTodos)}
                detail={
                  <span className="muted">
                    {plural(detail.memory.length, "Memory file")}
                  </span>
                }
              />
            </div>

            <Section title="Todos">
              {detail.todos.length === 0 ? (
                <p className="muted">No Todos</p>
              ) : (
                <Table columns={TODO_COLUMNS} label="Todos">
                  {detail.todos.map((todo) => (
                    <TodoRow key={todo.id} todo={todo} />
                  ))}
                </Table>
              )}
            </Section>

            <Section title="Memory">
              {detail.memory.length === 0 ? (
                <p className="muted">No Memory files</p>
              ) : (
                <Table columns={MEMORY_COLUMNS} label="Memory files">
                  {detail.memory.map((file) => (
                    <tr className="table-row" key={file.path}>
                      <td>
                        <span className="mono">{file.path}</span>
                      </td>
                      <td data-align="end" className="numeric muted">
                        {formatBytes(file.size)}
                      </td>
                    </tr>
                  ))}
                </Table>
              )}
            </Section>

            <Section title="Recent Turns">
              {detail.runs.length === 0 ? (
                <p className="muted">No Turns yet</p>
              ) : (
                <ul className="turn-list">
                  {detail.runs.slice(0, 10).map((run) => (
                    <TurnCard key={run.sequence} run={run} />
                  ))}
                </ul>
              )}
            </Section>
          </>
        ) : null}
      </PageBody>

      <ConfirmDialog
        open={doomed}
        onOpenChange={setDoomed}
        title={`Delete ${member.name}?`}
        description="Its Memory, Todos and history are removed."
        confirmLabel="Delete Agent"
        onConfirm={async () => {
          await backend.deleteAgent(member.id);
          await refresh();
        }}
      />
    </Page>
  );
}

function AgentState({
  member,
  tokenLimit,
}: {
  member: Member;
  tokenLimit: number;
}) {
  return (
    <StatusText
      dot={<StateDot state={member.state} ping={member.state === "running"} />}
    >
      {agentStateLabel(member, tokenLimit)}
    </StatusText>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {detail ? <span className="stat-detail">{detail}</span> : null}
    </div>
  );
}

function TodoRow({ todo }: { todo: Todo }) {
  return (
    <tr className="table-row">
      <td>
        <span className={todo.status === "done" ? "muted" : undefined}>
          {todo.title}
        </span>
        {todo.detail ? <p className="muted">{todo.detail}</p> : null}
      </td>
      <td>
        <Chip
          tone={
            todo.status === "in_progress"
              ? "blue"
              : todo.status === "done"
                ? "success"
                : "neutral"
          }
        >
          {todo.status === "in_progress"
            ? "In progress"
            : todo.status === "done"
              ? "Done"
              : "Pending"}
        </Chip>
      </td>
    </tr>
  );
}

function TurnCard({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(run.status === "failed");
  const tools = [...new Set(run.effects.map((effect) => effect.tool))];

  return (
    <li className="turn">
      <button
        type="button"
        className="turn-head"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown className="turn-chevron" size={14} aria-hidden="true" />
        <span className="turn-sequence mono">#{run.sequence}</span>
        <StatusText dot={<Dot tone={runTone(run.status)} />}>
          <span className="turn-status">{run.status}</span>
        </StatusText>
        <span className="turn-summary">
          {run.effects.length === 0 ? (
            <span className="turn-nothing">Produced nothing</span>
          ) : (
            `${plural(run.effects.length, "effect")} · ${tools.join(", ")}`
          )}
        </span>
        <Tooltip label={formatTime(run.started_at)}>
          <time className="turn-time muted" dateTime={run.started_at}>
            {relativeTime(run.started_at)}
          </time>
        </Tooltip>
      </button>
      {open ? (
        <div className="turn-body">
          {run.error ? (
            <p className="turn-error">
              <CircleAlert size={14} aria-hidden="true" />
              {run.error}
            </p>
          ) : null}
          {run.effects.length === 0 ? (
            <p className="muted">Nothing produced.</p>
          ) : (
            <ul className="effects">
              {run.effects.map((effect) => (
                <li key={`${run.sequence}-${effect.ordinal}`}>
                  <span className="effect-tool">
                    {toolIcon(effect.tool)}
                    {effect.tool}
                  </span>
                  <span className="effect-summary muted">{effect.summary}</span>
                </li>
              ))}
            </ul>
          )}
          {run.completed_at ? (
            <p className="muted turn-finished">
              Finished {formatTime(run.completed_at)}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
