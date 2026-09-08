import { CornerDownLeft, Send } from "lucide-react";
import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Avatar, Button, Textarea } from "../../components/ui/index";
import type { Member } from "../../lib/backend";
import { candidatesFor, completeMention, mentionQuery } from "../mentions";

const MENU_LIMIT = 8;

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
    <div className="composer">
      {suggesting ? (
        <ul className="mention-menu" id={menuId} aria-label="Members">
          {candidates.map((member, index) => {
            const inside = memberIds.has(member.id);
            return (
              <Fragment key={member.id}>
                {index === elsewhereFrom && index > 0 ? (
                  <li className="mention-group" role="presentation">
                    Elsewhere in the organization — inserts a reference,
                    notifies nobody
                  </li>
                ) : null}
                <li role="presentation">
                  <button
                    type="button"
                    className="mention-option"
                    role="option"
                    id={`${menuId}-${member.id}`}
                    aria-selected={index === active}
                    data-active={index === active}
                    data-reference={!inside}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      accept(member);
                    }}
                  >
                    <Avatar name={member.name} size="sm" />
                    <span className="mention-name">{member.name}</span>
                    <span className="mention-meta">
                      {inside
                        ? member.type === "human"
                          ? "Human"
                          : member.state
                        : "reference only"}
                    </span>
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      ) : null}
      <Textarea
        ref={input}
        value={body}
        rows={3}
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
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (suggesting) {
            const size = candidates.length;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((current) => (current + 1) % size);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((current) => (current - 1 + size) % size);
              return;
            }
            if (event.key === "Tab" || event.key === "Enter") {
              if (
                !(event.key === "Enter" && (event.metaKey || event.ctrlKey))
              ) {
                event.preventDefault();
                accept(candidates[active]);
                return;
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
              return;
            }
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">
          <kbd>
            <CornerDownLeft size={11} />
            &#8984;/Ctrl + Enter
          </kbd>
          to send
        </span>
        <Button
          variant="primary"
          disabled={busy || !body.trim()}
          onClick={submit}
        >
          <Send size={15} />
          Send
        </Button>
      </div>
    </div>
  );
}
