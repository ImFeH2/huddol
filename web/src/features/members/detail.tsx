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
import { useOrganization } from "../../app/organization";
import { useNavigate } from "../../app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  Section,
  Table,
} from "../../components/layout/shell";
import { ConfirmDialog } from "../../components/ui/dialog";
import {
  Avatar,
  Banner,
  Button,
  Chip,
  Dot,
  EmptyState,
  Meter,
  StateDot,
  StatusText,
} from "../../components/ui/index";
import { OverflowMenu } from "../../components/ui/menu";
import {
  type AgentDetail,
  type AgentRun,
  backend,
  type Todo,
} from "../../lib/backend";
import { formatBytes, plural, relativeTime } from "../../lib/format";
import { formatTime } from "../mentions";
import "./members.css";

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
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [doomed, setDoomed] = useState(false);
  const member = members.find((item) => item.id === id);

  const load = useCallback(async () => {
    if (member?.type !== "agent") return;
    try {
      setDetail(await backend.agentDetail(id));
    } catch (failure) {
      backend.reportFailure(failure);
    }
  }, [id, member]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return backend.onEvent((event) => {
      if (event.type.startsWith("turn.")) void load();
    });
  }, [load]);

  if (!member) {
    return (
      <Page>
        <PageHeader
          title="Member not found"
          crumb={{
            label: "Members",
            onSelect: () => navigate({ name: "members" }),
          }}
        />
        <PageBody>
          <EmptyState
            title="Nothing to show"
            description="This Member is no longer in the organization."
          />
        </PageBody>
      </Page>
    );
  }

  if (member.type === "human") {
    return (
      <Page>
        <PageHeader
          title={member.name}
          lede="A Human Member. Humans and Agents share one identity model, so there is no separate machinery to show here."
          crumb={{
            label: "Members",
            onSelect: () => navigate({ name: "members" }),
          }}
          leading={<Avatar name={member.name} size="lg" />}
        />
        <PageBody>
          <EmptyState
            title="No Agent state"
            description="Todos, Memory and Turns belong to Agents. Humans work through the Discussions view."
            action={
              <Button onClick={() => navigate({ name: "discussions" })}>
                Go to Discussions
              </Button>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const usage = detail?.usage;
  const limit = detail?.token_limit ?? 0;
  const spent = usage?.total_tokens ?? member.tokens ?? 0;
  const openTodos = (detail?.todos ?? []).filter(
    (todo) => todo.status !== "done",
  ).length;

  return (
    <Page>
      <PageHeader
        title={member.name}
        lede={`Agent · ${plural(usage?.requests ?? 0, "model request")} · ${plural(detail?.runs.length ?? 0, "recorded Turn")}`}
        crumb={{
          label: "Members",
          onSelect: () => navigate({ name: "members" }),
        }}
        leading={<Avatar name={member.name} size="lg" />}
        actions={
          <>
            <Button
              variant={member.state === "paused" ? "primary" : "default"}
              onClick={async () => {
                await (member.state === "paused"
                  ? backend.resumeAgent(member.id)
                  : backend.pauseAgent(member.id));
                await refresh();
              }}
            >
              {member.state === "paused" ? (
                <Play size={16} />
              ) : (
                <Pause size={16} />
              )}
              {member.state === "paused" ? "Resume" : "Pause"}
            </Button>
            <OverflowMenu
              label={`Actions for ${member.name}`}
              actions={[
                {
                  id: "delete",
                  label: "Delete Agent",
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
        {detail?.over_token_limit ? (
          <Banner tone="danger" icon={<CircleAlert size={16} />}>
            <strong>{member.name} has reached its token ceiling.</strong> It is
            no longer scheduled, so mentions will pile up unhandled. Raise the
            limit under Settings, or hand the work to another Member.
          </Banner>
        ) : null}
        {detail && detail.idle_streak >= 3 ? (
          <Banner tone="warning" icon={<CircleAlert size={16} />}>
            <strong>
              The last {detail.idle_streak} Turns produced nothing.
            </strong>{" "}
            {member.name} acknowledged its mentions without sending, editing or
            running anything. It may be stuck in a loop of declaring work done.
          </Banner>
        ) : null}

        <div className="stat-grid">
          <Stat
            label="Token spend"
            value={spent.toLocaleString()}
            detail={
              limit > 0 ? (
                <>
                  <Meter
                    value={spent}
                    max={limit}
                    label={`Token spend for ${member.name}`}
                  />
                  <span className="muted">
                    of {limit.toLocaleString()} cumulative
                  </span>
                </>
              ) : (
                <span className="muted">No ceiling configured</span>
              )
            }
          />
          <Stat
            label="Model requests"
            value={(usage?.requests ?? 0).toLocaleString()}
            detail={
              <span className="muted">
                {(usage?.input_tokens ?? 0).toLocaleString()} in ·{" "}
                {(usage?.output_tokens ?? 0).toLocaleString()} out
              </span>
            }
          />
          <Stat
            label="State"
            value={
              <StatusText
                dot={
                  <StateDot
                    state={member.state}
                    ping={member.state === "running"}
                  />
                }
              >
                {member.state === "running"
                  ? "Running"
                  : member.state === "paused"
                    ? "Paused"
                    : "Idle"}
              </StatusText>
            }
            detail={
              <span className="muted">
                {member.state === "paused"
                  ? "No new Turns will start"
                  : "Wakes when mentioned"}
              </span>
            }
          />
          <Stat
            label="Open Todos"
            value={String(openTodos)}
            detail={
              <span className="muted">
                {plural(detail?.memory.length ?? 0, "Memory file")}
              </span>
            }
          />
        </div>

        <Section
          title="Todos"
          description="What this Agent believes it is working on across Turns."
        >
          {(detail?.todos ?? []).length === 0 ? (
            <p className="muted">No Todos recorded.</p>
          ) : (
            <Table columns={TODO_COLUMNS} label="Todos">
              {(detail?.todos ?? []).map((todo) => (
                <TodoRow key={todo.id} todo={todo} />
              ))}
            </Table>
          )}
        </Section>

        <Section
          title="Memory"
          description="Private notes this Agent keeps for itself. The Library is the shared one."
        >
          {(detail?.memory ?? []).length === 0 ? (
            <p className="muted">No Memory files yet.</p>
          ) : (
            <Table columns={MEMORY_COLUMNS} label="Memory files">
              {(detail?.memory ?? []).map((file) => (
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

        <Section
          title="Recent Turns"
          description="Every Turn records what it actually produced. A Turn with no effects changed nothing."
        >
          {(detail?.runs ?? []).length === 0 ? (
            <p className="muted">This Agent has not run yet.</p>
          ) : (
            <ul className="turn-list">
              {(detail?.runs ?? []).slice(0, 10).map((run) => (
                <TurnCard key={run.sequence} run={run} />
              ))}
            </ul>
          )}
        </Section>
      </PageBody>

      <ConfirmDialog
        open={doomed}
        onOpenChange={setDoomed}
        title={`Delete ${member.name}?`}
        description="Its messages stay in every Discussion and its name stays reserved. Its Memory, Todos and model history are removed."
        confirmLabel="Delete Agent"
        onConfirm={async () => {
          await backend.deleteAgent(member.id);
          await refresh();
          navigate({ name: "members" });
        }}
      />
    </Page>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-detail">{detail}</span>
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
        <time
          className="turn-time muted"
          dateTime={run.started_at}
          title={formatTime(run.started_at)}
        >
          {relativeTime(run.started_at)}
        </time>
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
            <p className="muted">
              This Turn read context and declared itself done without sending,
              editing or running anything.
            </p>
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
