import { Save } from "lucide-react";
import {
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button, Field, Input } from "@/components/ui/index";
import { reportLoadFailure, useSaver } from "@/features/settings/saver";
import { backend } from "@/lib/backend";

const FIELDS = [
  { key: "context_window_tokens", label: "Context window (tokens)" },
  { key: "memory_index_bytes", label: "MEMORY.md in context (bytes)" },
  { key: "exchange_nudge_after", label: "Nudge after (messages)" },
  { key: "idle_streak_after", label: "Idle after (Turns)" },
  { key: "no_tool_turns_before_pause", label: "Pause after tool-free Turns" },
  { key: "max_concurrent_turns", label: "Concurrent Turns" },
  { key: "token_limit", label: "Tokens per Agent" },
];

function agentInteger(key: string, draft: string): number | null {
  const value = draft.trim();
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) &&
    number >= (key === "token_limit" ? 0 : 1)
    ? number
    : null;
}

export function agentUpdate(
  drafts: Record<string, string>,
): Record<string, number> | null {
  if (Object.keys(drafts).length !== FIELDS.length) return null;
  const update: Record<string, number> = {};
  for (const { key } of FIELDS) {
    const value = agentInteger(key, drafts[key] ?? "");
    if (value === null) return null;
    update[key] = value;
  }
  return update;
}

export function AgentForm({
  drafts,
  disabled = false,
  first,
  onChange,
  onSave,
}: {
  drafts: Record<string, string>;
  disabled?: boolean;
  first?: Ref<HTMLInputElement>;
  onChange: (drafts: Record<string, string>) => void;
  onSave: (values: Record<string, number>) => void;
}) {
  const id = useId();
  const update = agentUpdate(drafts);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (update && !disabled) onSave(update);
      }}
    >
      <fieldset
        className="m-0 flex min-w-0 max-w-[560px] flex-col gap-4 border-0 p-0"
        aria-label="Agent settings"
        disabled={disabled}
      >
        {FIELDS.map(({ key, label }, index) => (
          <Field
            key={key}
            label={label}
            htmlFor={`${id}-${key}`}
            hint={key === "token_limit" ? "0 means no ceiling." : undefined}
          >
            <Input
              ref={index === 0 ? first : undefined}
              id={`${id}-${key}`}
              type="number"
              inputMode="numeric"
              min={key === "token_limit" ? 0 : 1}
              step={1}
              max={Number.MAX_SAFE_INTEGER}
              required
              aria-invalid={
                key in drafts && agentInteger(key, drafts[key]) === null
              }
              value={drafts[key] ?? ""}
              onChange={(event) =>
                onChange({ ...drafts, [key]: event.target.value })
              }
            />
          </Field>
        ))}
        <div className="flex items-center gap-3 pt-1">
          <Button
            variant="primary"
            type="submit"
            disabled={disabled || !update}
          >
            <Save size={16} />
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function AgentPanel() {
  const first = useRef<HTMLInputElement>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const values = await backend.settings("agent");
      setDrafts(
        Object.fromEntries(
          FIELDS.map(({ key }) => [key, String(values[key] ?? "")]),
        ),
      );
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      reportLoadFailure("settings-agent", error, () => void load());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { saving, save } = useSaver(load, first);
  return (
    <AgentForm
      drafts={drafts}
      disabled={loading || saving || loadFailed}
      first={first}
      onChange={setDrafts}
      onSave={(values) => void save("agent", values)}
    />
  );
}
