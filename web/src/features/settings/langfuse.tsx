import { useCallback, useEffect, useId, useState } from "react";
import { Page, PageBody, PageHeader } from "../../components/layout/shell";
import { Banner, Button, Chip, Field, Input } from "../../components/ui/index";
import { backend } from "../../lib/backend";
import "./settings.css";

export function langfuseUpdate(
  values: Record<string, unknown>,
  publicKey: string,
  secretKey: string,
) {
  const next: Record<string, unknown> = {
    enabled: values.enabled === true,
    base_url: String(values.base_url ?? "").trim(),
  };
  if (publicKey.trim()) next.public_key = publicKey.trim();
  if (secretKey.trim()) next.secret_key = secretKey.trim();
  return next;
}

export function LangfusePage() {
  const id = useId();
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setValues(await backend.settings("observability"));
    } catch {
      setError("Could not load settings");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!values || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await backend.updateSettings(
        "observability",
        langfuseUpdate(values, publicKey, secretKey),
      );
      setValues(updated);
      setPublicKey("");
      setSecretKey("");
      setSaved(true);
    } catch {
      setError("Could not save settings");
    } finally {
      setBusy(false);
    }
  };

  const enabled = values?.enabled === true;
  const configured = values?.keys_set === true;

  return (
    <Page>
      <PageHeader title="Langfuse" />
      <PageBody>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {saved ? (
          <Banner tone="success">Saved. Restart Huddol to apply.</Banner>
        ) : null}
        {!values && error ? (
          <Button disabled={busy} onClick={load}>
            Retry
          </Button>
        ) : null}
        <form
          onChange={() => setSaved(false)}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="settings-form" disabled={busy || !values}>
            <label className="settings-toggle">
              <Input
                type="checkbox"
                checked={enabled}
                onChange={(event) =>
                  setValues({ ...values, enabled: event.target.checked })
                }
              />
              Enabled
            </label>
            <Field label="Base URL" htmlFor={`${id}-url`}>
              <Input
                id={`${id}-url`}
                type="url"
                pattern="https?://.+"
                required={enabled}
                placeholder="https://cloud.langfuse.com"
                value={String(values?.base_url ?? "")}
                onChange={(event) =>
                  setValues({ ...values, base_url: event.target.value })
                }
              />
            </Field>
            <Field label="Public key" htmlFor={`${id}-public`}>
              <Input
                id={`${id}-public`}
                type="password"
                autoComplete="off"
                required={enabled && !configured}
                placeholder={configured ? "Unchanged" : ""}
                pattern=".*\S.*"
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
              />
            </Field>
            <Field
              label="Secret key"
              htmlFor={`${id}-secret`}
              hint={configured ? "Leave keys blank to keep them." : undefined}
            >
              <Input
                id={`${id}-secret`}
                type="password"
                autoComplete="off"
                required={enabled && !configured}
                placeholder={configured ? "Unchanged" : ""}
                pattern=".*\S.*"
                value={secretKey}
                onChange={(event) => setSecretKey(event.target.value)}
              />
            </Field>
            <div className="settings-actions">
              <Button type="submit" variant="primary">
                Save
              </Button>
              {configured ? <Chip tone="success">Keys stored</Chip> : null}
            </div>
          </fieldset>
        </form>
      </PageBody>
    </Page>
  );
}
