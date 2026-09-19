import { useVirtualizer } from "@tanstack/react-virtual";
import { clsx } from "clsx";
import { Archive, ArchiveRestore, Check, Users } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useThreadData } from "@/features/discussions/thread-data";
import { renderMentions } from "@/features/mentions";
import { BackendError, backend, type Message } from "@/lib/backend";
import { formatTime, relativeTime } from "@/lib/format";

export function ThreadPage({ id }: { id: number }) {
  return <ThreadSession key={id} id={id} />;
}

function ThreadSession({ id }: { id: number }) {
  const { members, humanId, discussions, refresh } = useOrganization();
  const navigate = useNavigate();
  const thread = useThreadData(id, humanId);
  const { data: detail, missing, failed: loadFailed } = thread;
  const [busy, setBusy] = useState(false);
  const [ackBusy, setAckBusy] = useState(false);
  const [editingMembers, setEditingMembers] = useState(false);
  const [composerSize, setComposerSize] = useState(48);
  const [lastVisible, setLastVisible] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const preserveBottom = useRef(false);
  const frame = useRef(0);
  const messages = detail?.messages ?? [];
  const virtual = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 96,
    getItemKey: useCallback((index: number) => messages[index].id, [messages]),
    overscan: 5,
    anchorTo: "end",
    followOnAppend: detail !== null && !detail.hasAfter,
    paddingStart: 16,
    paddingEnd: composerSize + 40,
    scrollEndThreshold: 1,
  });
  const resizeComposer = useCallback(
    (height: number) => {
      preserveBottom.current = ready.current && virtual.isAtEnd();
      setComposerSize(height);
    },
    [virtual],
  );
  const items = virtual.getVirtualItems();
  const memberIds = useMemo(
    () => new Set((detail?.members ?? []).map((member) => member.id)),
    [detail?.members],
  );

  const sample = useCallback(
    (paginate = false) => {
      const root = scroll.current;
      const current = thread.current.current;
      if (!root || !ready.current || !current) return;
      const bounds = root.getBoundingClientRect();
      const end = bounds.bottom - composerSize - 16;
      const visible: number[] = [];
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-message-id]",
      )) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom > bounds.top && rect.top < end)
          visible.push(Number(element.dataset.messageId));
      }
      setLastVisible(visible.length ? Math.max(...visible) : 0);
      thread.view(visible, virtual.isAtEnd());
      if (document.visibilityState === "visible" && visible.length)
        void thread.markRead(Math.max(...visible)).catch(() => {});
      if (paginate && !thread.failed) {
        if (root.scrollTop < root.clientHeight && current.hasBefore)
          void thread.request("before");
        else if (
          root.scrollHeight - root.scrollTop - root.clientHeight <
            root.clientHeight &&
          current.hasAfter
        )
          void thread.request("after");
      }
    },
    [composerSize, thread, virtual],
  );

  useLayoutEffect(() => {
    if (!thread.position || !detail || !scroll.current) return;
    ready.current = false;
    if (thread.position === "latest" || detail.divider === null)
      virtual.scrollToEnd();
    else
      virtual.scrollToIndex(
        Math.max(
          0,
          messages.findIndex((message) => message.id === detail.divider),
        ),
        { align: "start" },
      );
    frame.current = requestAnimationFrame(() => {
      ready.current = true;
      thread.positioned();
    });
    return () => cancelAnimationFrame(frame.current);
  }, [thread.position, detail, messages, virtual, thread.positioned]);

  useEffect(() => {
    const tick = requestAnimationFrame(() => sample());
    const changed = () => sample();
    document.addEventListener("visibilitychange", changed);
    return () => {
      cancelAnimationFrame(tick);
      document.removeEventListener("visibilitychange", changed);
    };
  }, [sample, items]);

  useLayoutEffect(() => {
    if (ready.current && preserveBottom.current) virtual.scrollToEnd();
  }, [composerSize, virtual]);

  const load = thread.invalidate;

  const send = async (body: string) => {
    setBusy(true);
    try {
      await backend.sendVisible(id, body);
      if (!thread.live.current) return true;
      await thread.request("after");
      return true;
    } catch (failure) {
      if (
        thread.live.current &&
        !(failure instanceof BackendError && failure.transport)
      ) {
        toast({
          tone: "danger",
          title: "Could not send",
          description:
            failure instanceof Error ? failure.message : String(failure),
        });
      }
      return false;
    } finally {
      if (thread.live.current) setBusy(false);
    }
  };

  const ack = async (messageIds: number[], revoke = false) => {
    if (ackBusy) return;
    setAckBusy(true);
    try {
      if (revoke) await backend.revokeAck(id, messageIds);
      else {
        await thread.markRead(Math.max(...messageIds));
        if (!thread.live.current) return;
        await backend.ack(id, messageIds);
      }
      if (thread.live.current) await load();
    } catch (failure) {
      if (!thread.live.current) return;
      toast({
        tone: "danger",
        title: revoke ? "Could not undo" : "Could not mark handled",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      if (thread.live.current) setAckBusy(false);
    }
  };

  const ackAll = async () => {
    if (ackBusy || !detail) return;
    setAckBusy(true);
    try {
      await backend.ackPending(id, detail.latest);
      if (thread.live.current) await load();
    } catch (failure) {
      if (thread.live.current) backend.reportFailure(failure);
    } finally {
      if (thread.live.current) setAckBusy(false);
    }
  };

  const archive = async (archived: boolean) => {
    try {
      await backend.archiveDiscussion(id, archived);
      if (!thread.live.current) return;
      if (archived) navigate({ name: "discussions" });
      else await load();
    } catch (failure) {
      if (thread.live.current) backend.reportFailure(failure);
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
                  <AvatarStack members={detail.members} />
                </Button>
              </Tooltip>
              {detail.pendingCount > 0 ? (
                <Button
                  variant="primary"
                  disabled={ackBusy}
                  onClick={() => void ackAll()}
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
        <div className="@container relative flex min-h-0 flex-1 flex-col">
          <div
            ref={scroll}
            className="min-h-0 flex-1 overflow-y-auto border-t border-line px-8 max-[940px]:px-6 [overflow-anchor:none]"
            onScroll={() => sample(true)}
            aria-busy={thread.loading}
          >
            {detail && messages.length === 0 ? (
              <EmptyState title="No messages yet" />
            ) : null}
            <ol className="relative" style={{ height: virtual.getTotalSize() }}>
              {items.map((item) => {
                const message = messages[item.index];
                const previousSender =
                  item.index === 0
                    ? detail?.previousSender
                    : messages[item.index - 1].sender_id;
                const divider = message.id === detail?.divider;
                const compact =
                  !divider && previousSender === message.sender_id;
                return (
                  <li
                    key={item.key}
                    ref={virtual.measureElement}
                    data-index={item.index}
                    className="absolute top-0 left-0 w-full"
                    style={{
                      transform: `translateY(${item.start}px)`,
                      paddingTop: compact ? 4 : 16,
                    }}
                  >
                    {divider ? (
                      <div className="mb-4 flex items-center gap-3 text-xs font-medium uppercase tracking-caps text-primary before:content-[''] before:h-px before:flex-1 before:bg-blue-500/40 after:content-[''] after:h-px after:flex-1 after:bg-blue-500/40">
                        <span>New</span>
                      </div>
                    ) : null}
                    <MessageRow
                      message={message}
                      compact={compact}
                      fresh={false}
                      pending={message.pending}
                      acknowledged={message.acknowledged}
                      busy={ackBusy}
                      onAck={() => void ack([message.id])}
                      onRevoke={() => void ack([message.id], true)}
                    />
                  </li>
                );
              })}
            </ol>
          </div>
          {detail && detail.latest > lastVisible ? (
            <div
              className="absolute right-8"
              style={{ bottom: composerSize + 24 }}
            >
              <Button
                disabled={thread.loading}
                onClick={() => {
                  void thread.request("latest");
                }}
              >
                New messages
              </Button>
            </div>
          ) : null}

          <Composer
            members={members}
            memberIds={memberIds}
            busy={busy}
            placeholder={topic ? `Message ${topic}` : "Message"}
            onSend={send}
            onHeightChange={resizeComposer}
          />
        </div>
      </PageBody>

      {editingMembers && detail ? (
        <DiscussionMembersDialog
          discussionId={id}
          memberIds={detail.members.map((member) => member.id)}
          onClose={() => setEditingMembers(false)}
          onSaved={async (ids) => {
            await refresh();
            if (!thread.live.current) return;
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
    <div
      data-message-id={message.id}
      className={clsx(
        "flex scroll-m-6 items-start gap-3",
        fresh && "animate-rise-in [animation-duration:var(--duration-slow)]",
      )}
    >
      <div className="w-[26px] flex-none">
        {compact ? null : <Avatar memberId={message.sender_id} />}
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
    </div>
  );
}
