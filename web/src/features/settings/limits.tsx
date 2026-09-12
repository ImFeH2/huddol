import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Chip, Field, Input } from "@/components/ui/index";
import { reportLoadFailure, useSaver } from "@/features/settings/saver";
import { backend } from "@/lib/backend";
import "@/features/settings/settings.css";

export function limitsUpdate(
  limit: string,
): { agent_token_limit: number } | null {
  const trimmed = limit.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;
  return { agent_token_limit: parsed };
}

export function LimitsPanel() {
  const limitId = useId();
  const first = useRef<HTMLInputElement>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const values = await backend.settings("limits");
      setLimit(String(values.agent_token_limit ?? 0));
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      reportLoadFailure("settings-limits", error, () => void load());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { saving, save } = useSaver(load, first);
  const loaded = limit !== null;
  const update = loaded ? limitsUpdate(limit) : null;

  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (!update || saving || loading || !loaded || loadFailed) return;
        await save("limits", update);
      }}
    >
      <fieldset
        className="settings-form"
        aria-label="Limits settings"
        disabled={loading || saving || !loaded || loadFailed}
      >
        <Field
          label="Tokens per Agent"
          htmlFor={limitId}
          hint={
            loaded && !update ? "Enter a whole number." : "0 means no ceiling."
          }
        >
          <Input
            ref={first}
            id={limitId}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            max={Number.MAX_SAFE_INTEGER}
            required
            aria-invalid={loaded && !update}
            value={limit ?? ""}
            onChange={(event) => setLimit(event.target.value)}
          />
        </Field>
        <div className="settings-actions">
          <Button variant="primary" type="submit" disabled={!update || saving}>
            Save
          </Button>
          {update ? (
            <Chip tone={update.agent_token_limit > 0 ? "neutral" : "warning"}>
              {update.agent_token_limit > 0
                ? `${update.agent_token_limit.toLocaleString()} tokens`
                : "No ceiling"}
            </Chip>
          ) : null}
        </div>
      </fieldset>
    </form>
  );
}
