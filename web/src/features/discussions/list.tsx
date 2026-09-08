import {
  Archive,
  ArchiveRestore,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { ConfirmDialog } from "../../components/ui/dialog";
import {
  Badge,
  Button,
  Chip,
  CountPill,
  Dot,
  EmptyState,
  IconButton,
  SearchField,
  StatusText,
} from "../../components/ui/index";
import { OverflowMenu } from "../../components/ui/menu";
import {
  backend,
  type DiscussionSummary,
  type FoundMessage,
  type Member,
} from "../../lib/backend";
import { plural } from "../../lib/format";
import { CreateDiscussionDialog } from "./create";
import "./discussions.css";

type Segment = { id: string; text: string; match: boolean };

function segments(text: string, query: string): Segment[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ id: "s0", text, match: false }];
  const found: Segment[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  let count = 0;
  let at = haystack.indexOf(needle, from);
  while (at >= 0) {
    if (at > from)
      found.push({
        id: `s${count++}`,
        text: text.slice(from, at),
        match: false,
      });
    found.push({
      id: `s${count++}`,
      text: text.slice(at, at + needle.length),
      match: true,
    });
    from = at + needle.length;
    at = haystack.indexOf(needle, from);
  }
  if (from < text.length)
    found.push({ id: `s${count++}`, text: text.slice(from), match: false });
  return found;
}

const LIST_COLUMNS: Column[] = [
  { key: "topic", label: "Discussion" },
  { key: "members", label: "Members", hideBelow: "md" },
  { key: "unread", label: "Unread", align: "end", width: "96px" },
  { key: "status", label: "Status", width: "168px" },
  { key: "actions", label: "", width: "56px" },
];

const RESULT_COLUMNS: Column[] = [
  { key: "message", label: "Message" },
  { key: "sender", label: "Sender", width: "180px", hideBelow: "sm" },
  { key: "discussion", label: "Discussion", width: "220px" },
];

export function DiscussionsPage() {
  const { members } = useOrganization();
  const navigate = useNavigate();
  const [list, setList] = useState<DiscussionSummary[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundMessage[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [doomed, setDoomed] = useState<DiscussionSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setList(await backend.discussions(archived));
    } catch (failure) {
      backend.reportFailure(failure);
    }
  }, [archived]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return backend.onEvent((event) => {
      if (
        event.type === "message.created" ||
        event.type === "mention.acked" ||
        event.type === "mention.revoked" ||
        event.type === "discussion.created" ||
        event.type === "discussion.updated" ||
        event.type === "discussion.deleted"
      ) {
        void load();
      }
    });
  }, [load]);

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void backend
        .searchMessages(text)
        .then((found) => {
          if (live) setResults(found);
        })
        .catch(backend.reportFailure);
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const byId = useMemo(
    () => new Map(members.map((member) => [member.id, member] as const)),
    [members],
  );

  const topicOf = (id: number) =>
    list.find((item) => item.id === id)?.topic ?? `Discussion ${id}`;

  const searching = results !== null;

  return (
    <Page>
      <PageHeader
        title="Discussions"
        lede={
          <>
            Members work through Discussions. Writing <code>@Name</code> in a
            message notifies that Member — for an{" "}
            <button
              type="button"
              className="inline-link"
              onClick={() => navigate({ name: "members" })}
            >
              Agent
            </button>{" "}
            it schedules a Turn.
          </>
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={16} />
            New discussion
          </Button>
        }
      />
      <Toolbar>
        <SearchField
          icon={<Search size={15} />}
          value={query}
          placeholder="Search messages across every Discussion"
          aria-label="Search messages"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          onClick={() => setArchived((current) => !current)}
          aria-pressed={archived}
        >
          <Archive size={15} />
          {archived ? "Hiding nothing" : "Show archived"}
        </Button>
        <ToolbarSpacer />
        <IconButton label="Refresh" onClick={() => void load()}>
          <RefreshCw size={15} />
        </IconButton>
      </Toolbar>
      <PageBody>
        <CountPill>
          {searching
            ? plural(results.length, "result")
            : plural(list.length, "discussion")}
        </CountPill>

        {searching ? (
          results.length === 0 ? (
            <EmptyState
              title="No messages match"
              description={`Nothing in this organization mentions “${query.trim()}”.`}
            />
          ) : (
            <Table columns={RESULT_COLUMNS} label="Search results">
              {results.map((result) => (
                <tr
                  className="table-row"
                  key={`${result.discussion_id}-${result.id}`}
                >
                  <td>
                    <RowLink
                      primary={
                        <span className="result-body">
                          {segments(result.body, query).map((part) =>
                            part.match ? (
                              <mark key={part.id}>{part.text}</mark>
                            ) : (
                              <span key={part.id}>{part.text}</span>
                            ),
                          )}
                        </span>
                      }
                      onSelect={() =>
                        navigate({
                          name: "discussion",
                          id: result.discussion_id,
                        })
                      }
                    />
                  </td>
                  <td data-hide-below="sm" className="muted">
                    {result.sender_name}
                  </td>
                  <td>
                    <Chip>{topicOf(result.discussion_id)}</Chip>
                  </td>
                </tr>
              ))}
            </Table>
          )
        ) : list.length === 0 ? (
          <EmptyState
            title="No Discussions yet"
            description="A Discussion is a message space around one topic. Create one and pick who belongs in it."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus size={16} />
                New discussion
              </Button>
            }
          />
        ) : (
          <Table columns={LIST_COLUMNS} label="Discussions">
            {list.map((item) => (
              <DiscussionRow
                key={item.id}
                item={item}
                byId={byId}
                onOpen={() => navigate({ name: "discussion", id: item.id })}
                onArchive={async () => {
                  await backend.archiveDiscussion(item.id, !item.archived);
                  await load();
                }}
                onDelete={() => setDoomed(item)}
              />
            ))}
          </Table>
        )}
      </PageBody>

      <CreateDiscussionDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (id) => {
          await load();
          navigate({ name: "discussion", id });
        }}
      />
      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(next) => !next && setDoomed(null)}
        title={`Delete “${doomed?.topic ?? ""}”?`}
        description="The Discussion and every message in it are removed for good. Archiving keeps the history instead."
        confirmLabel="Delete Discussion"
        onConfirm={async () => {
          if (doomed) await backend.deleteDiscussion(doomed.id);
          setDoomed(null);
          await load();
        }}
      />
    </Page>
  );
}

function DiscussionRow({
  item,
  byId,
  onOpen,
  onArchive,
  onDelete,
}: {
  item: DiscussionSummary;
  byId: Map<number, Member>;
  onOpen: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const people = item.member_ids
    .map((id) => byId.get(id))
    .filter((member): member is Member => member !== undefined);
  const shown = people.slice(0, 3);
  const rest = people.length - shown.length;

  return (
    <tr className="table-row" data-highlight={item.unread > 0}>
      <td>
        <div className="cell-lead">
          <span className="topic-glyph" aria-hidden="true">
            <MessageSquare size={15} />
          </span>
          <RowLink
            primary={item.topic}
            secondary={plural(item.member_ids.length, "member")}
            onSelect={onOpen}
          />
        </div>
      </td>
      <td data-hide-below="md">
        <div className="cell-chips">
          {shown.map((member) => (
            <Chip
              key={member.id}
              tone={member.type === "agent" ? "blue" : "neutral"}
            >
              {member.name}
            </Chip>
          ))}
          {rest > 0 ? <Chip>+{rest}</Chip> : null}
        </div>
      </td>
      <td data-align="end" className="numeric">
        {item.unread > 0 ? (
          <Badge tone="unread">{item.unread}</Badge>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {item.archived ? (
          <StatusText dot={<Dot tone="grey" />}>
            <span className="muted">Archived</span>
          </StatusText>
        ) : item.unread > 0 ? (
          <StatusText dot={<Dot tone="blue" />}>
            {plural(item.unread, "new message")}
          </StatusText>
        ) : (
          <StatusText dot={<Dot tone="green" />}>
            <span className="muted">Up to date</span>
          </StatusText>
        )}
      </td>
      <td className="cell-actions">
        <OverflowMenu
          label={`Actions for ${item.topic}`}
          actions={[
            {
              id: "archive",
              label: item.archived ? "Unarchive" : "Archive",
              icon: item.archived ? (
                <ArchiveRestore size={15} />
              ) : (
                <Archive size={15} />
              ),
              onSelect: onArchive,
            },
            {
              id: "delete",
              label: "Delete",
              icon: <Trash2 size={15} />,
              tone: "danger",
              onSelect: onDelete,
            },
          ]}
        />
      </td>
    </tr>
  );
}
