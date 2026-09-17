import { clsx } from "clsx";
import { ArrowUp } from "lucide-react";
import {
  Fragment,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Avatar, autoGrowHeight, Textarea } from "@/components/ui/index";
import {
  candidatesFor,
  completeMention,
  mentionQuery,
} from "@/features/mentions";
import type { Member } from "@/lib/backend";

const MENU_LIMIT = 8;

export function composerMultiline(
  value: string,
  height: number,
  line: number,
  padding: number,
) {
  return (
    value.includes("\n") ||
    (value.length > 0 && height > Math.ceil(line + padding) + 1)
  );
}

export function composerHeight(expanded: boolean, inputHeight: number) {
  return expanded ? Math.max(116, inputHeight + 42) : 48;
}

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
  onHeightChange,
}: {
  members: Member[];
  memberIds: ReadonlySet<number>;
  busy: boolean;
  placeholder: string;
  onSend: (body: string) => Promise<boolean>;
  onHeightChange: (height: number) => void;
}) {
  const [body, setBody] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const card = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLTextAreaElement>(null);
  const [layout, setLayout] = useState({
    expanded: false,
    height: 48,
    smooth: false,
  });

  useLayoutEffect(() => {
    const element = input.current;
    const measureInput = probe.current;
    if (!element || !measureInput) return;
    const measure = (typing = false) => {
      const style = getComputedStyle(element);
      const line = Number.parseFloat(style.lineHeight);
      const padding =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      measureInput.style.height = "auto";
      const expanded = composerMultiline(
        element.value,
        measureInput.scrollHeight,
        line,
        padding,
      );
      const scrollTop = element.scrollTop;
      element.style.height = "auto";
      const height = expanded
        ? autoGrowHeight(element.scrollHeight, line, padding, 0, 8)
        : line + padding;
      element.style.height = `${height}px`;
      element.scrollTop = scrollTop;
      setLayout((previous) => {
        const nextHeight = composerHeight(expanded, height);
        const smooth =
          previous.expanded !== expanded
            ? false
            : typing
              ? true
              : previous.smooth;
        return previous.expanded === expanded &&
          previous.height === nextHeight &&
          previous.smooth === smooth
          ? previous
          : { expanded, height: nextHeight, smooth };
      });
    };
    measure(true);
    let width = element.getBoundingClientRect().width;
    let compactWidth = measureInput.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      const nextCompactWidth = measureInput.getBoundingClientRect().width;
      if (nextWidth === width && nextCompactWidth === compactWidth) return;
      width = nextWidth;
      compactWidth = nextCompactWidth;
      measure();
    });
    observer.observe(element);
    observer.observe(measureInput);
    let mounted = true;
    void document.fonts.ready.then(() => {
      if (mounted) measure();
    });
    return () => {
      mounted = false;
      observer.disconnect();
    };
  }, [body]);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    let height = -1;
    const update = () => {
      const next = element.getBoundingClientRect().height;
      if (height === next) return;
      height = next;
      onHeightChange(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);

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
    <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center">
      <div
        className="invisible pointer-events-none absolute top-0 w-full max-w-[320px] border border-transparent"
        aria-hidden="true"
      >
        <Textarea
          ref={probe}
          variant="composer"
          value={body}
          readOnly
          rows={1}
          tabIndex={-1}
        />
      </div>
      <div
        ref={card}
        data-expanded={layout.expanded}
        className="pointer-events-auto relative w-full rounded-[24px] border border-line-interactive bg-surface-raised shadow-button focus-within:border-line-focus focus-within:ring-1 focus-within:ring-ring/20 transition-[max-width,height] motion-reduce:transition-none"
        style={{
          maxWidth: layout.expanded ? 480 : 320,
          height: layout.height,
          transitionDuration: layout.smooth ? "0.4s, 0.15s" : "0.4s, 0.4s",
          transitionTimingFunction: layout.smooth
            ? "cubic-bezier(0.175,0.885,0.32,1.275), ease-out"
            : "cubic-bezier(0.175,0.885,0.32,1.275)",
        }}
      >
        {suggesting ? (
          <div
            className="absolute bottom-full mb-2 left-0 right-0 z-(--layer-popover) max-h-66 overflow-y-auto rounded-sm bg-surface-raised p-1 shadow-popover origin-bottom animate-pop-in"
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
                    <Avatar memberId={member.id} size="sm" />
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
            variant="composer"
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
        <button
          type="button"
          className="absolute right-2 bottom-2 flex size-8 items-center justify-center rounded-full bg-blue-500 text-gray-0 cursor-pointer hover:enabled:bg-blue-300 disabled:bg-blue-700/45 disabled:text-gray-0/55 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-focus"
          aria-label="Send · Enter"
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
        >
          <ArrowUp size={15} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
