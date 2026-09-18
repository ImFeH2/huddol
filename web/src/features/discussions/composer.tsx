import { clsx } from "clsx";
import {
  type CSSProperties,
  Fragment,
  useCallback,
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
const composerTheme = {
  "--composer-background": "oklch(14.5% 0 0)",
  "--composer-foreground": "oklch(98.5% 0 0)",
  "--composer-card": "oklch(20.5% 0 0)",
  "--composer-primary": "oklch(92.2% 0 0)",
  "--composer-primary-foreground": "oklch(20.5% 0 0)",
  "--composer-accent": "oklch(26.9% 0 0)",
  "--composer-muted-foreground": "oklch(70.8% 0 0)",
  "--composer-border": "rgb(255 255 255 / 0.1)",
  "--composer-ring": "oklch(55.6% 0 0)",
} as CSSProperties;

function ArrowUpIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 12V2M7 2L2.5 6.5M7 2L11.5 6.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="5"
        y="1"
        width="4"
        height="7"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M2.75 6.5V7a4.25 4.25 0 0 0 8.5 0v-.5M7 11.25V13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M7 2.5V11.5M2.5 7H11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EffortIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="1.5"
        y="8"
        width="2.5"
        height="4.5"
        rx="1"
        fill="currentColor"
        className="transition-opacity duration-300"
        opacity={1}
      />
      <rect
        x="5.75"
        y="5"
        width="2.5"
        height="7.5"
        rx="1"
        fill="currentColor"
        className="transition-opacity duration-300"
        opacity={1}
      />
      <rect
        x="10"
        y="2"
        width="2.5"
        height="10.5"
        rx="1"
        fill="currentColor"
        className="transition-opacity duration-300"
        opacity={0.3}
      />
    </svg>
  );
}

export function composerFades(top: number, height: number, viewport: number) {
  return {
    top: Math.min(top / 20, 1),
    bottom: Math.min(Math.max(height - viewport - top - 16, 0) / 10, 1),
  };
}

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
  return expanded ? Math.max(116, inputHeight + 48) : 48;
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
  const topFade = useRef<HTMLDivElement>(null);
  const bottomFade = useRef<HTMLDivElement>(null);
  const updateFades = useCallback(() => {
    const element = input.current;
    if (!element || !topFade.current || !bottomFade.current) return;
    const fades = composerFades(
      element.scrollTop,
      element.scrollHeight,
      element.clientHeight,
    );
    topFade.current.style.opacity = String(fades.top);
    bottomFade.current.style.opacity = String(fades.bottom);
    bottomFade.current.style.top = `${element.offsetHeight - 32}px`;
  }, []);
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
      const compactStyle = getComputedStyle(measureInput);
      const compactLine = Number.parseFloat(compactStyle.lineHeight);
      const compactPadding =
        Number.parseFloat(compactStyle.paddingTop) +
        Number.parseFloat(compactStyle.paddingBottom);
      measureInput.style.height = "auto";
      const expanded = composerMultiline(
        element.value,
        measureInput.scrollHeight,
        compactLine,
        compactPadding,
      );
      element.style.paddingBlock = expanded ? "14px" : "12px";
      const style = getComputedStyle(element);
      const line = Number.parseFloat(style.lineHeight);
      const padding =
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      const scrollTop = element.scrollTop;
      element.style.height = "auto";
      const height = expanded
        ? Math.max(
            68,
            autoGrowHeight(element.scrollHeight, line, padding, 0, 8),
          )
        : line + padding;
      element.style.height = `${height}px`;
      element.scrollTop = scrollTop;
      updateFades();
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
  }, [body, updateFades]);

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
    <div
      style={composerTheme}
      className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center"
    >
      <div
        className="invisible pointer-events-none absolute top-0 w-full @[601px]:w-3/4 border border-transparent"
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
        className={clsx(
          "pointer-events-auto relative w-full rounded-[24px] border border-(--composer-border) bg-(--composer-card) text-(--composer-foreground) shadow-[0_1px_3px_0_rgb(0_0_0/0.1),0_1px_2px_-1px_rgb(0_0_0/0.1)] focus-within:border-(--composer-ring)/40 focus-within:ring-1 focus-within:ring-(--composer-ring)/20 hover:border-(--composer-border)/80 transition-[width,height] motion-reduce:transition-none",
          layout.expanded ? "@[601px]:w-[90%]" : "@[601px]:w-3/4",
        )}
        style={{
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
            onScroll={updateFades}
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
        <div
          ref={topFade}
          aria-hidden="true"
          className="pointer-events-none absolute left-4 right-12 top-0 z-[2] h-8 bg-gradient-to-b from-(--composer-card) via-(--composer-card)/90 to-transparent"
          style={{ opacity: 0 }}
        />
        <div
          ref={bottomFade}
          aria-hidden="true"
          className="pointer-events-none absolute left-4 right-12 z-[2] h-8 bg-gradient-to-t from-(--composer-card) via-(--composer-card)/90 to-transparent"
          style={{ opacity: 0 }}
        />
        <div
          aria-hidden={!layout.expanded}
          className={clsx(
            "absolute bottom-2 left-3 right-12 z-10 flex min-w-0 items-center gap-0 transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] motion-reduce:transition-none",
            layout.expanded
              ? "opacity-100 blur-0 translate-y-0 pointer-events-auto"
              : "opacity-0 blur-sm translate-y-2 pointer-events-none",
          )}
        >
          <button
            type="button"
            disabled
            aria-label="Model selection · Coming soon"
            title="Model selection · Coming soon"
            className="group flex min-w-0 items-center gap-1 rounded-full px-2 py-1 text-(--composer-foreground)/50 outline-none cursor-default"
          >
            <span className="truncate px-1 text-xs font-semibold select-none">
              Model
            </span>
          </button>
          <button
            type="button"
            disabled
            aria-label="Thinking effort · Coming soon"
            title="Thinking effort · Coming soon"
            className="group flex min-w-0 items-center gap-1 rounded-full px-2 py-1 text-(--composer-foreground)/50 outline-none cursor-default"
          >
            <EffortIcon />
            <span className="truncate px-1 text-xs font-semibold select-none">
              Effort
            </span>
          </button>
          <button
            type="button"
            disabled
            aria-label="Attach files · Coming soon"
            title="Attach files · Coming soon"
            className="ml-auto flex size-7 flex-none items-center justify-center rounded-full text-(--composer-foreground)/50 outline-none cursor-default disabled:opacity-40"
          >
            <PlusIcon />
          </button>
        </div>
        <button
          type="button"
          className="absolute right-2 bottom-2 z-10 flex size-8 items-center justify-center rounded-full bg-(--composer-primary) text-(--composer-primary-foreground) transition-all duration-300 hover:enabled:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-(--composer-ring) cursor-default motion-reduce:transition-none"
          aria-label={
            body.trim() ? "Send · Enter" : "Voice input · Coming soon"
          }
          title={body.trim() ? "Send · Enter" : "Voice input · Coming soon"}
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
        >
          <span
            className="relative flex h-full w-full items-center justify-center"
            aria-hidden="true"
          >
            <span
              className={clsx(
                "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] motion-reduce:transition-none",
                body.trim()
                  ? "opacity-100 scale-100 rotate-0 blur-none"
                  : "opacity-0 scale-50 rotate-45 blur-[1px] pointer-events-none",
              )}
            >
              <ArrowUpIcon />
            </span>
            <span
              className={clsx(
                "absolute inset-0 flex items-center justify-center transition-all duration-300 ease-[cubic-bezier(0.175,0.885,0.32,1.275)] motion-reduce:transition-none",
                body.trim()
                  ? "opacity-0 scale-50 -rotate-45 blur-[1px] pointer-events-none"
                  : "opacity-100 scale-100 rotate-0 blur-none",
              )}
            >
              <MicIcon />
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
