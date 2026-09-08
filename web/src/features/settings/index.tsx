import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import {
  Page,
  PageBody,
  PageHeader,
  Section,
} from "../../components/layout/shell";
import { Banner, Button, Chip, Field, Input } from "../../components/ui/index";
import { backend } from "../../lib/backend";
import "./settings.css";

function useSaver(load: () => Promise<void>) {
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (section: string, values: Record<string, unknown>) => {
    setStatus(null);
    setSaving(true);
    try {
      await backend.updateSettings(section, values);
      setFailed(false);
      setStatus("Saved.");
      await load();
      return true;
    } catch (error) {
      setFailed(true);
      setStatus(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { status, failed, saving, save, dismiss: () => setStatus(null) };
}

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

export function ModelPage() {
  const providerId = useId();
  const baseUrlId = useId();
  const modelId = useId();
  const keyId = useId();
  const thresholdId = useId();
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

  const { status, failed, saving, save, dismiss } = useSaver(load);
  const configured = values.api_key_set === true;
  const update = modelUpdate(values, apiKey);

  return (
    <Page>
      <PageHeader
        title="Model"
        lede="Every Agent in the organization runs on this model. Changing it takes effect the next time Huddol starts."
      />
      <PageBody>
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
        <Section
          title="Provider"
          description="The endpoint and credentials Agents use to reach the model."
        >
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
                  configured
                    ? "A key is stored. Leave this blank to keep it."
                    : "Required before any Agent can run."
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
                  loaded && !update
                    ? "Enter a positive whole number."
                    : undefined
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
        </Section>
      </PageBody>
    </Page>
  );
}

export function LimitsPage() {
  const limitId = useId();
  const [limit, setLimit] = useState("0");

  const load = useCallback(async () => {
    const values = await backend.settings("limits");
    setLimit(String(values.agent_token_limit ?? 0));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const { status, failed, save, dismiss } = useSaver(load);
  const parsed = Number(limit) || 0;

  return (
    <Page>
      <PageHeader
        title="Limits"
        lede="A ceiling on what a single Agent may spend in total. It is per Agent, not shared across the organization."
      />
      <PageBody>
        {status ? (
          <Banner
            tone={failed ? "danger" : "success"}
            icon={failed ? <AlertTriangle size={16} /> : undefined}
            onDismiss={dismiss}
          >
            {status}
          </Banner>
        ) : null}
        <Section
          title="Cumulative token limit"
          description="An Agent that reaches its ceiling stops being scheduled. Its state does not change and nothing is reported as an error, because a spent budget is not a fault. Raise the limit and it becomes schedulable again immediately."
        >
          <div className="settings-form">
            <Field
              label="Tokens per Agent"
              htmlFor={limitId}
              hint="0 means no ceiling."
            >
              <Input
                id={limitId}
                inputMode="numeric"
                value={limit}
                onChange={(event) => setLimit(event.target.value)}
              />
            </Field>
            <div className="settings-actions">
              <Button
                variant="primary"
                onClick={() => save("limits", { agent_token_limit: parsed })}
              >
                Save limit
              </Button>
              <Chip tone={parsed > 0 ? "neutral" : "warning"}>
                {parsed > 0
                  ? `${parsed.toLocaleString()} tokens`
                  : "No ceiling"}
              </Chip>
            </div>
          </div>
        </Section>
      </PageBody>
    </Page>
  );
}
