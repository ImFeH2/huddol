import {
  Bot,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useOrganization } from "../../app/organization";
import { useNavigate } from "../../app/router";
import {
  type Column,
  Page,
  PageBody,
  PageHeader,
  RowLink,
  Table,
  Toolbar,
  ToolbarSpacer,
} from "../../components/layout/shell";
import { ConfirmDialog, PromptDialog } from "../../components/ui/dialog";
import {
  Avatar,
  Button,
  Chip,
  CountPill,
  EmptyState,
  IconButton,
  Meter,
  SearchField,
  StateDot,
  StatusText,
} from "../../components/ui/index";
import { OverflowMenu } from "../../components/ui/menu";
import { backend, type Member } from "../../lib/backend";
import { plural } from "../../lib/format";
import "./members.css";

const COLUMNS: Column[] = [
  { key: "member", label: "Member" },
  { key: "kind", label: "Kind", width: "120px", hideBelow: "md" },
  { key: "spend", label: "Token spend", align: "end", width: "180px" },
  { key: "state", label: "State", width: "150px" },
  { key: "actions", label: "", width: "56px" },
];

type Filter = "all" | "agents" | "humans";

export function MembersPage({ tokenLimit }: { tokenLimit: number }) {
  const { members, refresh, humanId } = useOrganization();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<Member | null>(null);
  const [doomed, setDoomed] = useState<Member | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return members.filter((member) => {
      if (filter === "agents" && member.type !== "agent") return false;
      if (filter === "humans" && member.type !== "human") return false;
      return !needle || member.name.toLowerCase().includes(needle);
    });
  }, [members, query, filter]);

  const agents = members.filter((member) => member.type === "agent").length;

  return (
    <Page>
      <PageHeader
        title="Members"
        lede={
          <>
            Humans and Agents are equal Members: same identity, same messages,
            same mentions. An Agent wakes when it is mentioned in a{" "}
            <button
              type="button"
              className="inline-link"
              onClick={() => navigate({ name: "discussions" })}
            >
              Discussion
            </button>
            , then decides for itself what to do.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            New Agent
          </Button>
        }
      />
      <Toolbar>
        <SearchField
          icon={<Search size={15} />}
          value={query}
          placeholder="Search Members by name"
          aria-label="Search Members"
          onChange={(event) => setQuery(event.target.value)}
        />
        <fieldset className="segmented">
          <legend className="visually-hidden">Filter by kind</legend>
          {(["all", "agents", "humans"] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              className="segment"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option === "all"
                ? "All"
                : option === "agents"
                  ? "Agents"
                  : "Humans"}
            </button>
          ))}
        </fieldset>
        <ToolbarSpacer />
        <IconButton
          label="Refresh"
          onClick={() => void refresh().catch(backend.reportFailure)}
        >
          <RefreshCw size={15} />
        </IconButton>
      </Toolbar>
      <PageBody>
        <CountPill>
          {plural(shown.length, "Member")} · {plural(agents, "Agent")}
        </CountPill>
        {shown.length === 0 ? (
          <EmptyState
            title="No Members match"
            description="Clear the search or change the filter."
          />
        ) : (
          <Table columns={COLUMNS} label="Members">
            {shown.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                tokenLimit={tokenLimit}
                isYou={member.id === humanId}
                onOpen={() => navigate({ name: "member", id: member.id })}
                onToggle={async () => {
                  await (member.state === "paused"
                    ? backend.resumeAgent(member.id)
                    : backend.pauseAgent(member.id));
                  await refresh();
                }}
                onRename={() => setRenaming(member)}
                onDelete={() => setDoomed(member)}
              />
            ))}
          </Table>
        )}
      </PageBody>

      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title="New Agent"
        description="An Agent is a Member with its own continuous history, Todos and Memory. Names are unique across the organization and are how everyone mentions each other."
        label="Name"
        placeholder="Scout"
        hint="Members write @Name to reach it."
        submitLabel="Create Agent"
        onSubmit={async (name) => {
          await backend.createAgent(name);
          await refresh();
        }}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(next) => !next && setRenaming(null)}
        title="Rename Member"
        description="Older messages keep the text they were written with, so a rename does not rewrite past mentions."
        label="Name"
        initial={renaming?.name ?? ""}
        submitLabel="Rename"
        onSubmit={async (name) => {
          if (renaming) await backend.renameMember(renaming.id, name);
          setRenaming(null);
          await refresh();
        }}
      />
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title={`Delete ${doomed?.name ?? ""}?`}
        description="Its messages stay in every Discussion, and its name stays reserved so old mentions keep pointing at the same individual. Its Memory, Todos and history are removed."
        confirmLabel="Delete Agent"
        onConfirm={async () => {
          if (doomed) await backend.deleteAgent(doomed.id);
          setDoomed(null);
          await refresh();
        }}
      />
    </Page>
  );
}

function MemberRow({
  member,
  tokenLimit,
  isYou,
  onOpen,
  onToggle,
  onRename,
  onDelete,
}: {
  member: Member;
  tokenLimit: number;
  isYou: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const agent = member.type === "agent";
  const tokens = member.tokens ?? 0;
  const capped = agent && tokenLimit > 0 && tokens >= tokenLimit;

  return (
    <tr className="table-row">
      <td>
        <div className="cell-lead">
          <Avatar name={member.name} />
          <RowLink
            primary={member.name}
            secondary={
              agent
                ? capped
                  ? "Token ceiling reached — no longer scheduled"
                  : "Wakes on mention, decides for itself"
                : isYou
                  ? "This is you"
                  : "Human"
            }
            onSelect={onOpen}
          />
        </div>
      </td>
      <td data-hide-below="md">
        <Chip tone={agent ? "blue" : "neutral"}>
          {agent ? <Bot size={12} /> : <User size={12} />}
          {agent ? "Agent" : "Human"}
        </Chip>
      </td>
      <td data-align="end">
        {agent ? (
          <div className="spend-cell">
            <span className="numeric">
              {tokens.toLocaleString()}
              {tokenLimit > 0 ? (
                <span className="muted"> / {tokenLimit.toLocaleString()}</span>
              ) : null}
            </span>
            {tokenLimit > 0 ? (
              <Meter
                value={tokens}
                max={tokenLimit}
                label={`Token spend for ${member.name}`}
              />
            ) : null}
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {agent ? (
          <StatusText
            dot={
              <StateDot
                state={member.state}
                ping={member.state === "running"}
              />
            }
          >
            {member.state === "running"
              ? "Running a Turn"
              : member.state === "paused"
                ? "Paused"
                : capped
                  ? "At ceiling"
                  : "Idle"}
          </StatusText>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="cell-actions">
        <OverflowMenu
          label={`Actions for ${member.name}`}
          actions={[
            {
              id: "toggle",
              label: member.state === "paused" ? "Resume" : "Pause",
              icon:
                member.state === "paused" ? (
                  <Play size={15} />
                ) : (
                  <Pause size={15} />
                ),
              disabled: !agent,
              onSelect: onToggle,
            },
            {
              id: "rename",
              label: "Rename",
              icon: <User size={15} />,
              onSelect: onRename,
            },
            {
              id: "delete",
              label: "Delete",
              icon: <Trash2 size={15} />,
              tone: "danger",
              disabled: !agent || member.state === "running",
              onSelect: onDelete,
            },
          ]}
        />
      </td>
    </tr>
  );
}
