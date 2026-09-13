import { clsx } from "clsx";
import { Archive, ArchiveRestore, Check, Users } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrganization } from "@/app/organization";
import { useNavigate } from "@/app/router";
import { Page, PageBody, PageHeader } from "@/components/layout/shell";
import {
  Avatar,
  AvatarStack,
  Button,
  Chip,
  EmptyState,
  toast,
} from "@/components/ui/index";
import { OverflowMenu } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { Composer } from "@/features/discussions/composer";
import { DiscussionMembersDialog } from "@/features/discussions/members";
import { renderMentions } from "@/features/mentions";
import {
  BackendError,
  backend,
  type DiscussionDetail,
  type Message,
} from "@/lib/backend";
import { formatTime, relativeTime } from "@/lib/format";

export function ThreadPage({ id }: { id: number }) {
  const { members, humanId, discussions, refresh } = useOrganization();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<DiscussionDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [editingMembers, setEditingMembers] = useState(false);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const bottom = useRef<HTMLDivElement>(null);
  const seen = useRef(0);
  const first = useRef(true);

  const load = useCallback(async () => {
    try {
      setDetail(await backend.readDiscussion(id));
      setMissing(false);
      setLoadFailed(false);
      void refresh().catch(backend.reportFailure);
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
  }, [id, refresh]);

  useEffect(() => {
    seen.current = 0;
    first.current = true;
    setFresh(new Set());
    void load();
  }, [load]);

  useEffect(() => {
    return backend.onEvent((event) => {
      if (
        event.type === "message.created" ||
        event.type === "mention.acked" ||
        event.type === "mention.revoked" ||
        event.type === "discussion.updated"
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
    if (first.current || newest > seen.current) {
      first.current = false;
      bottom.current?.scrollIntoView({ block: "end" });
    }
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
    try {
      await backend.send(id, body);
      await load();
      return true;
    } catch (failure) {
      if (!(failure instanceof BackendError && failure.transport)) {
        toast({
          tone: "danger",
          title: "Could not send",
          description:
            failure instanceof Error ? failure.message : String(failure),
        });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const ack = async (messageIds: number[], revoke = false) => {
    if (ackBusy) return;
    setAckBusy(true);
    try {
      if (revoke) await backend.revokeAck(id, messageIds);
      else await backend.ack(id, messageIds);
      await load();
    } catch (failure) {
      toast({
        tone: "danger",
        title: revoke ? "Could not undo" : "Could not mark handled",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setAckBusy(false);
    }
  };

  const archive = async (archived: boolean) => {
    try {
      await backend.archiveDiscussion(id, archived);
      if (archived) navigate({ name: "discussions" });
      else await load();
    } catch (failure) {
      backend.reportFailure(failure);
    }
  };

  if (missing) {
    return (
      <Page>
        <PageHeader
          title="Discussion not found"
          actions={
            <Button onClick={() => navigate({ name: "discussions" })}>
              Back to Discussions
            </Button>
          }
        />
      </Page>
    );
  }

  const names = (detail?.members ?? []).map((member) => member.name);
  const topic =
    discussions.find((item) => item.id === id)?.topic ?? detail?.topic ?? "";

  return (
    <Page>
      <PageHeader
        title={topic || (loadFailed ? "Unavailable" : "")}
        status={detail?.archived ? <Chip>Archived</Chip> : undefined}
        actions={
          detail ? (
            <>
              <Tooltip label={names.join("\n")}>
                <Button
                  variant="ghost"
                  aria-label="Members"
                  onClick={() => setEditingMembers(true)}
                >
                  <AvatarStack names={names} />
                </Button>
              </Tooltip>
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
                  detail.archived
                    ? {
                        id: "unarchive",
                        label: "Unarchive",
                        icon: <ArchiveRestore size={15} />,
                        onSelect: () => void archive(false),
                      }
                    : {
                        id: "archive",
                        label: "Archive",
                        icon: <Archive size={15} />,
                        onSelect: () => void archive(true),
                      },
                ]}
              />
            </>
          ) : undefined
        }
      />

      <PageBody variant="flush">
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-line px-8 pt-4 pb-6 max-[940px]:px-6">
          {detail && detail.messages.length === 0 ? (
            <EmptyState title="No messages yet" />
          ) : null}
          <ol className="flex flex-col gap-4">
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
                    <li className="flex items-center gap-3 text-xs font-medium uppercase tracking-caps text-primary before:content-[''] before:h-px before:flex-1 before:bg-blue-500/40 after:content-[''] after:h-px after:flex-1 after:bg-blue-500/40">
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
          placeholder={topic ? `Message ${topic}` : "Message"}
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
  onAck,
  onRevoke,
}: {
  message: Message;
  compact: boolean;
  fresh: boolean;
  pending: boolean;
  acknowledged: boolean;
  busy: boolean;
  onAck: () => void;
  onRevoke: () => void;
}) {
  const { members } = useOrganization();
  return (
    <li
      className={clsx(
        "flex scroll-m-6 items-start gap-3",
        compact && "-mt-3",
        fresh && "animate-rise-in [animation-duration:var(--duration-slow)]",
      )}
    >
      <div className="w-[26px] flex-none">
        {compact ? null : <Avatar name={message.sender_name} />}
      </div>
      <div
        className={clsx(
          "-ml-3 min-w-0 flex-1 border-l-2 pl-3",
          pending ? "border-l-yellow-300" : "border-l-transparent",
        )}
      >
        {compact ? null : (
          <div className="mb-0.5 flex items-baseline gap-2">
            <span className="font-semibold">{message.sender_name}</span>
            <Tooltip label={formatTime(message.created_at)}>
              <time
                className="text-xs text-fg-muted"
                dateTime={message.created_at}
              >
                {relativeTime(message.created_at)}
              </time>
            </Tooltip>
          </div>
        )}
        <div className="whitespace-pre-wrap wrap-anywhere [&_mark]:bg-blue-500/25 [&_mark]:text-blue-100 [&_mark]:rounded-xs [&_mark]:px-[3px] [&_mark]:font-medium">
          {renderMentions(message.body, message.mentions, members)}
        </div>
        {pending ? (
          <div className="mt-2 flex items-center gap-2">
            <Chip tone="warning">Mentions you</Chip>
            <Button size="sm" disabled={busy} onClick={onAck}>
              <Check size={13} />
              Mark handled
            </Button>
          </div>
        ) : acknowledged ? (
          <div className="mt-2 flex items-center gap-2">
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
