import { clsx } from "clsx";
import { Send } from "lucide-react";
import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Avatar, IconButton, Textarea } from "@/components/ui/index";
import {
  candidatesFor,
  completeMention,
  mentionQuery,
} from "@/features/mentions";
import type { Member } from "@/lib/backend";

const MENU_LIMIT = 8;

export type ComposerKey = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
};

export type ComposerAction =
  | "send"
  | "newline"
  | "accept"
  | "dismiss"
  | "up"
  | "down";

export function composerKey(
  event: ComposerKey,
  suggesting: boolean,
): ComposerAction | null {
  if (event.isComposing) return null;
  if (suggesting) {
    if (event.key === "ArrowDown") return "down";
    if (event.key === "ArrowUp") return "up";
    if (event.key === "Escape") return "dismiss";
    if (event.key === "Tab") return "accept";
  }
  if (event.key !== "Enter") return null;
  if (event.ctrlKey || event.metaKey) return "send";
  if (event.shiftKey) return "newline";
  return suggesting ? "accept" : "send";
}

export function Composer({
  members,
  memberIds,
  busy,
  placeholder,
  onSend,
}: {
  members: Member[];
  memberIds: ReadonlySet<number>;
  busy: boolean;
  placeholder: string;
  onSend: (body: string) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();

  const mention = mentionQuery(body, caret);
  const grouped = useMemo(
    () =>
      mention
        ? candidatesFor(members, memberIds, mention.query)
        : { inDiscussion: [], elsewhere: [] },
    [mention, members, memberIds],
  );

  const candidates = [...grouped.inDiscussion, ...grouped.elsewhere].slice(
    0,
    MENU_LIMIT,
  );
  const suggesting = mention !== null && candidates.length > 0 && !dismissed;
  const active = candidates.length > 0 ? highlighted % candidates.length : 0;
  const elsewhereFrom = Math.min(
    grouped.inDiscussion.length,
    candidates.length,
  );

  const accept = (member: Member) => {
    if (!mention) return;
    const next = completeMention(body, mention, caret, member.name);
    setBody(next.text);
    setCaret(next.caret);
    setHighlighted(0);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    if (!(await onSend(text)) || input.current?.value !== body) return;
    setBody("");
    setCaret(0);
  };

  return (
    <div className="relative flex flex-none items-end gap-2 border-t border-line bg-app px-8 pt-3 pb-4 max-[940px]:px-6">
      {suggesting ? (
        <div
          className="absolute bottom-[calc(100%-var(--spacing)*2)] left-8 right-8 z-(--layer-popover) max-h-66 overflow-y-auto rounded-sm bg-surface-raised p-1 shadow-popover origin-bottom animate-pop-in max-[940px]:left-6 max-[940px]:right-6"
          id={menuId}
          role="listbox"
          aria-label="Members"
        >
          {candidates.map((member, index) => {
            const inside = memberIds.has(member.id);
            return (
              <Fragment key={member.id}>
                {index === elsewhereFrom && index > 0 ? (
                  <div
                    className="mt-1 border-t border-line px-2 pt-3 pb-1 text-xs text-fg-muted"
                    role="presentation"
                  >
                    Not in this Discussion
                  </div>
                ) : null}
                <button
                  type="button"
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-xs border-0 px-2 py-1 text-left text-inherit cursor-pointer transition-[background-color] duration-(--duration-fast) ease-linear hover:bg-surface-hover",
                    index === active
                      ? "bg-surface-hover shadow-[inset_2px_0_0_var(--color-blue-300)]"
                      : "bg-transparent",
                  )}
                  role="option"
                  id={`${menuId}-${member.id}`}
                  aria-selected={index === active}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    accept(member);
                  }}
                >
                  <Avatar name={member.name} size="sm" />
                  <span
                    className={clsx(
                      "min-w-0 flex-1 truncate",
                      inside ? "font-medium" : "font-normal text-fg-muted",
                    )}
                  >
                    {member.name}
                  </span>
                  {inside ? (
                    <span className="flex-none text-xs text-fg-muted">
                      {member.type === "human" ? "Human" : member.state}
                    </span>
                  ) : null}
                </button>
              </Fragment>
            );
          })}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1">
        <Textarea
          ref={input}
          value={body}
          rows={1}
          autoGrow
          maxRows={8}
          placeholder={placeholder}
          aria-label="Message"
          role="combobox"
          aria-expanded={suggesting}
          aria-controls={suggesting ? menuId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            suggesting ? `${menuId}-${candidates[active].id}` : undefined
          }
          onChange={(event) => {
            setBody(event.target.value);
            setCaret(event.target.selectionStart ?? 0);
            setHighlighted(0);
            setDismissed(false);
          }}
          onSelect={(event) =>
            setCaret(event.currentTarget.selectionStart ?? 0)
          }
          onKeyDown={(event) => {
            const action = composerKey(
              {
                key: event.key,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                isComposing: event.nativeEvent.isComposing,
              },
              suggesting,
            );
            if (action === null || action === "newline") return;
            event.preventDefault();
            const size = candidates.length;
            switch (action) {
              case "down":
                setHighlighted((current) => (current + 1) % size);
                break;
              case "up":
                setHighlighted((current) => (current - 1 + size) % size);
                break;
              case "accept":
                accept(candidates[active]);
                break;
              case "dismiss":
                setDismissed(true);
                break;
              case "send":
                void submit();
                break;
            }
          }}
        />
      </div>
      <span className="flex h-[calc(var(--leading-body)+var(--spacing)*4+2px)] flex-none items-center">
        <IconButton
          label="Send · Enter"
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
        >
          <Send size={15} />
        </IconButton>
      </span>
    </div>
  );
}
