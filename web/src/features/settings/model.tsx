import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Banner, Button, Chip, Field, Input } from "@/components/ui/index";
import { useSaver } from "@/features/settings/saver";
import { backend } from "@/lib/backend";
import "@/features/settings/settings.css";

export function modelUpdate(
  values: Record<string, unknown>,
  apiKey: string,
): Record<string, unknown> | null {
  const raw = values.compaction_threshold;
  const threshold =
    typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isSafeInteger(threshold) || threshold <= 0) return null;
  const next: Record<string, unknown> = {
    api_type: values.api_type,
    base_url: values.base_url,
    model: values.model,
    compaction_threshold: threshold,
  };
  if (apiKey.trim()) next.api_key = apiKey.trim();
  return next;
}

export function ModelPanel() {
  const providerId = useId();
  const baseUrlId = useId();
  const modelId = useId();
  const keyId = useId();
  const thresholdId = useId();
  const first = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setValues(await backend.settings("model"));
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { status, failed, saving, save, dismiss } = useSaver(load, first);
  const configured = values.api_key_set === true;
  const update = modelUpdate(values, apiKey);

  return (
    <>
      {loadError ? (
        <Banner tone="danger">
          {loadError}
          <div className="settings-actions">
            <Button disabled={loading} onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Banner>
      ) : status ? (
        <Banner
          tone={failed ? "danger" : "success"}
          icon={failed ? <AlertTriangle size={16} /> : undefined}
          onDismiss={dismiss}
        >
          {failed ? status : "Saved. Restart Huddol to apply."}
        </Banner>
      ) : null}
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (!update || saving || loading || !loaded || loadError) return;
          if (await save("model", update)) setApiKey("");
        }}
      >
        <fieldset
          className="settings-form"
          aria-label="Model settings"
          disabled={loading || saving || !loaded || !!loadError}
        >
          <Field label="Provider" htmlFor={providerId}>
            <Input
              ref={first}
              id={providerId}
              value={String(values.api_type ?? "")}
              placeholder="openai"
              onChange={(event) =>
                setValues({ ...values, api_type: event.target.value })
              }
            />
          </Field>
          <Field label="Base URL" htmlFor={baseUrlId}>
            <Input
              id={baseUrlId}
              value={String(values.base_url ?? "")}
              placeholder="https://api.example.com/v1"
              onChange={(event) =>
                setValues({ ...values, base_url: event.target.value })
              }
            />
          </Field>
          <Field label="Model" htmlFor={modelId}>
            <Input
              id={modelId}
              value={String(values.model ?? "")}
              onChange={(event) =>
                setValues({ ...values, model: event.target.value })
              }
            />
          </Field>
          <Field
            label="API key"
            htmlFor={keyId}
            hint={
              configured ? "Leave blank to keep the stored key." : undefined
            }
          >
            <Input
              id={keyId}
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={configured ? "Unchanged" : "Required"}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
          <Field
            label="Compaction threshold (bytes)"
            htmlFor={thresholdId}
            hint={
              loaded && !update ? "Enter a positive whole number." : undefined
            }
          >
            <Input
              id={thresholdId}
              type="number"
              min={1}
              step={1}
              max={Number.MAX_SAFE_INTEGER}
              required
              aria-invalid={loaded && !update}
              value={String(values.compaction_threshold ?? "")}
              onChange={(event) =>
                setValues({
                  ...values,
                  compaction_threshold: event.target.value,
                })
              }
            />
          </Field>
          <div className="settings-actions">
            <Button
              variant="primary"
              type="submit"
              disabled={!update || saving}
            >
              Save
            </Button>
            {configured ? <Chip tone="success">Key stored</Chip> : null}
          </div>
        </fieldset>
      </form>
    </>
  );
}
