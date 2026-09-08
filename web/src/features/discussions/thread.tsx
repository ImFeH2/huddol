import { Archive, ArchiveRestore, Check, Trash2, Users } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrganization } from "../../app/organization";
import { useNavigate } from "../../app/router";
import { Page, PageBody, PageHeader } from "../../components/layout/shell";
import { ConfirmDialog } from "../../components/ui/dialog";
import {
  Avatar,
  Banner,
  Button,
  Chip,
  EmptyState,
} from "../../components/ui/index";
import { OverflowMenu } from "../../components/ui/menu";
import {
  BackendError,
  backend,
  type DiscussionDetail,
  type Message,
} from "../../lib/backend";
import { plural, relativeTime } from "../../lib/format";
import { formatTime, highlightMentions } from "../mentions";
import { Composer } from "./composer";
import { DiscussionMembersDialog } from "./members";
import "./discussions.css";

export function ThreadPage({ id }: { id: number }) {
  const { members, humanId, refresh } = useOrganization();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DiscussionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doomed, setDoomed] = useState(false);
  const [editingMembers, setEditingMembers] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const bottom = useRef<HTMLDivElement>(null);
  const seen = useRef(0);

  const load = useCallback(async () => {
    try {
      setDetail(await backend.readDiscussion(id));
      setMissing(false);
      setLoadFailed(false);
    } catch (failure) {
      if (
        failure instanceof BackendError &&
        ["not_found", "not_a_member"].includes(failure.code)
      ) {
        setMissing(true);
      } else {
        setLoadFailed(true);
        backend.reportFailure(failure);
      }
    }
  }, [id]);

  useEffect(() => {
    seen.current = 0;
    setFresh(new Set());
    void load();
  }, [load]);

  useEffect(() => {
    return backend.onEvent((event) => {
      if (
        event.type === "message.created" ||
        event.type === "mention.acked" ||
        event.type === "mention.revoked" ||
        event.type === "discussion.updated" ||
        event.type === "discussion.deleted"
      ) {
        void load();
      }
    });
  }, [load]);

  useEffect(() => {
    if (!detail) return;
    const newest = detail.messages.reduce(
      (largest, message) => Math.max(largest, message.id),
      0,
    );
    if (seen.current > 0 && newest > seen.current) {
      const arrived = new Set(
        detail.messages
          .filter((message) => message.id > seen.current)
          .map((message) => message.id),
      );
      seen.current = newest;
      setFresh(arrived);
      const timer = setTimeout(() => setFresh(new Set()), 700);
      return () => clearTimeout(timer);
    }
    seen.current = newest;
  }, [detail]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the tail as messages arrive
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [detail]);

  const memberIds = useMemo(
    () => new Set((detail?.members ?? []).map((member) => member.id)),
    [detail],
  );
  const awaiting = useMemo(() => new Set(detail?.awaiting_ack ?? []), [detail]);
  const acknowledged = useMemo(
    () => new Set(detail?.acknowledged ?? []),
    [detail],
  );

  const send = async (body: string) => {
    setBusy(true);
    setError(null);
    try {
      await backend.send(id, body);
      await load();
      return true;
    } catch (failure) {
      if (!(failure instanceof BackendError && failure.transport)) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ack = async (messageIds: number[], revoke = false) => {
    if (ackBusy) return;
    setAckBusy(true);
    setError(null);
    try {
      if (revoke) await backend.revokeAck(id, messageIds);
      else await backend.ack(id, messageIds);
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setAckBusy(false);
    }
  };

  if (missing) {
    return (
      <Page>
        <PageHeader
          title="Discussion not found"
          lede="It may have been deleted, or you may no longer be a Member of it."
          crumb={{
            label: "Discussions",
            onSelect: () => navigate({ name: "discussions" }),
          }}
        />
        <PageBody>
          <EmptyState
            title="Nothing to show"
            description="Go back to the list and pick another Discussion."
            action={
              <Button onClick={() => navigate({ name: "discussions" })}>
                Back to Discussions
              </Button>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const people = detail?.members ?? [];
  const typeOf = (memberId: number) =>
    members.find((member) => member.id === memberId)?.type ?? "agent";

  return (
    <Page>
      <PageHeader
        title={detail?.topic ?? (loadFailed ? "Unavailable" : "Loading…")}
        lede={
          detail
            ? `${plural(people.length, "Member")} · ${plural(detail.total_messages, "message")}`
            : undefined
        }
        crumb={{
          label: "Discussions",
          onSelect: () => navigate({ name: "discussions" }),
        }}
        actions={
          detail ? (
            <>
              {awaiting.size > 0 ? (
                <Button
                  variant="primary"
                  disabled={ackBusy}
                  onClick={() => void ack([...awaiting])}
                >
                  <Check size={16} />
                  Mark all handled
                </Button>
              ) : null}
              <OverflowMenu
                label="Discussion actions"
                actions={[
                  {
                    id: "members",
                    label: "Members",
                    icon: <Users size={15} />,
                    onSelect: () => setEditingMembers(true),
                  },
                  {
                    id: "archive",
                    label: "Archive",
                    icon: <Archive size={15} />,
                    onSelect: async () => {
                      await backend.archiveDiscussion(id, true);
                      navigate({ name: "discussions" });
                    },
                  },
                  {
                    id: "unarchive",
                    label: "Unarchive",
                    icon: <ArchiveRestore size={15} />,
                    onSelect: async () => {
                      await backend.archiveDiscussion(id, false);
                      await load();
                    },
                  },
                  {
                    id: "delete",
                    label: "Delete Discussion",
                    icon: <Trash2 size={15} />,
                    tone: "danger",
                    onSelect: () => setDoomed(true),
                  },
                ]}
              />
            </>
          ) : undefined
        }
      />

      <div className="thread-strip">
        <span className="thread-strip-icon" aria-hidden="true">
          <Users size={14} />
        </span>
        <ul className="thread-people">
          {people.map((member) => (
            <li key={member.id}>
              <Chip tone={typeOf(member.id) === "agent" ? "blue" : "neutral"}>
                {member.name}
              </Chip>
            </li>
          ))}
        </ul>
        {awaiting.size > 0 ? (
          <span className="thread-pending">
            {plural(awaiting.size, "message")} waiting for you
          </span>
        ) : null}
      </div>

      <PageBody variant="flush">
        <div className="thread-scroll">
          {error ? (
            <div className="thread-banner">
              <Banner tone="danger" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            </div>
          ) : null}
          {detail && detail.messages.length === 0 ? (
            <EmptyState
              title="No messages yet"
              description="Write the first one. Use @Name to notify a Member — for an Agent that schedules a Turn."
            />
          ) : null}
          <ol className="messages">
            {(detail?.messages ?? []).map((message, index) => {
              const previous = detail?.messages[index - 1];
              const divider =
                detail !== undefined &&
                previous !== undefined &&
                detail !== null &&
                previous.id <= detail.read_through &&
                message.id > detail.read_through;
              const compact =
                !divider &&
                previous !== undefined &&
                previous.sender_id === message.sender_id;
              return (
                <Fragment key={message.id}>
                  {divider ? (
                    <li className="unread-divider">
                      <span>New</span>
                    </li>
                  ) : null}
                  <MessageRow
                    message={message}
                    compact={compact}
                    fresh={fresh.has(message.id)}
                    pending={awaiting.has(message.id)}
                    acknowledged={acknowledged.has(message.id)}
                    busy={ackBusy}
                    memberIds={memberIds}
                    onAck={() => void ack([message.id])}
                    onRevoke={() => void ack([message.id], true)}
                  />
                </Fragment>
              );
            })}
          </ol>
          <div ref={bottom} />
        </div>

        <Composer
          members={members}
          memberIds={memberIds}
          busy={busy}
          placeholder="Write a message. Use @Name to notify a Member."
          onSend={send}
        />
      </PageBody>

      {editingMembers && detail ? (
        <DiscussionMembersDialog
          discussionId={id}
          memberIds={detail.members.map((member) => member.id)}
          onClose={() => setEditingMembers(false)}
          onSaved={async (ids) => {
            await refresh();
            if (ids.includes(humanId)) await load();
            else navigate({ name: "discussions" });
          }}
        />
      ) : null}

      <ConfirmDialog
        open={doomed}
        onOpenChange={setDoomed}
        title={`Delete “${detail?.topic ?? ""}”?`}
        description="The Discussion and every message in it are removed for good. Archiving keeps the history instead."
        confirmLabel="Delete Discussion"
        onConfirm={async () => {
          await backend.deleteDiscussion(id);
          navigate({ name: "discussions" });
        }}
      />
    </Page>
  );
}

export function MessageRow({
  message,
  compact,
  fresh,
  pending,
  acknowledged,
  busy,
  memberIds,
  onAck,
  onRevoke,
}: {
  message: Message;
  compact: boolean;
  fresh: boolean;
  pending: boolean;
  acknowledged: boolean;
  busy: boolean;
  memberIds: ReadonlySet<number>;
  onAck: () => void;
  onRevoke: () => void;
}) {
  const { members } = useOrganization();
  return (
    <li
      className="message"
      data-pending={pending}
      data-compact={compact}
      data-fresh={fresh}
    >
      <div className="message-gutter">
        {compact ? null : <Avatar name={message.sender_name} />}
      </div>
      <div className="message-main">
        {compact ? null : (
          <div className="message-head">
            <span className="message-sender">{message.sender_name}</span>
            <time
              className="message-time"
              dateTime={message.created_at}
              title={formatTime(message.created_at)}
            >
              {relativeTime(message.created_at)}
            </time>
          </div>
        )}
        <div className="message-text">
          {highlightMentions(message.body, members, memberIds)}
        </div>
        {pending ? (
          <div className="message-actions">
            <Chip tone="warning">Mentions you</Chip>
            <Button size="sm" disabled={busy} onClick={onAck}>
              <Check size={13} />
              Mark handled
            </Button>
          </div>
        ) : acknowledged ? (
          <div className="message-actions">
            <Chip tone="success">Handled</Chip>
            <Button
              size="sm"
              disabled={busy}
              aria-label="Undo confirmation"
              onClick={onRevoke}
            >
              Undo
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}
