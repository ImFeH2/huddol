import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Page, PageBody, PageHeader } from "../../components/layout/shell";
import { Choices } from "../../components/ui/choices";
import {
  Banner,
  Button,
  Chip,
  Field,
  Textarea,
} from "../../components/ui/index";
import { backend } from "../../lib/backend";
import "./settings.css";

export type EnvironmentTarget =
  | { kind: "native" }
  | { kind: "wsl"; distribution: string };

export type ExecutionSettings = {
  environment: EnvironmentTarget;
  write_directories: string[];
  distributions: string[];
  error: string | null;
  probe_error: string | null;
  unusable_write_directories: { path: string; reason: string }[];
};

export function executionUpdate(value: string, directories: string) {
  let environment: EnvironmentTarget;
  if (value === "native") {
    environment = { kind: "native" };
  } else if (value.startsWith("wsl:") && value.slice(4).trim()) {
    environment = { kind: "wsl", distribution: value.slice(4) };
  } else {
    throw new Error("Choose an execution environment");
  }
  return {
    environment,
    write_directories: [
      ...new Set(
        directories
          .split("\n")
          .map((path) => path.trim())
          .filter(Boolean),
      ),
    ],
  };
}

function targetValue(target: EnvironmentTarget) {
  return target.kind === "native"
    ? "native"
    : target.kind === "wsl"
      ? `wsl:${target.distribution}`
      : "";
}

export function ExecutionForm({
  initial,
  onSave,
}: {
  initial: ExecutionSettings;
  onSave: (
    values: ReturnType<typeof executionUpdate>,
  ) => Promise<ExecutionSettings>;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [info, setInfo] = useState(initial);
  const [selected, setSelected] = useState(targetValue(initial.environment));
  const [directories, setDirectories] = useState(
    initial.write_directories.join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const changed =
    selected !== targetValue(info.environment) ||
    directories !== info.write_directories.join("\n") ||
    info.error !== null;
  const options = [
    { value: "native", label: "Native" },
    ...info.distributions.map((distribution) => ({
      value: `wsl:${distribution}`,
      label: `WSL · ${distribution}`,
    })),
  ];
  if (
    info.environment.kind === "wsl" &&
    !options.some((option) => option.value === targetValue(info.environment))
  ) {
    options.push({
      value: targetValue(info.environment),
      label: `WSL · ${info.environment.distribution}`,
    });
  }
  const save = async () => {
    if (busy || !changed || !selected) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await onSave(executionUpdate(selected, directories));
      setInfo(result);
      setSelected(targetValue(result.environment));
      setDirectories(result.write_directories.join("\n"));
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) input.current?.focus();
      });
    }
  };
  return (
    <form
      className="settings-form"
      aria-label="Execution settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {error || info.error ? (
        <Banner tone="danger">{error || info.error}</Banner>
      ) : null}
      {info.probe_error ? (
        <Banner tone="warning">{info.probe_error}</Banner>
      ) : null}
      {saved ? (
        <Banner tone="success">
          Saved. Environment changes apply to new Turns.
        </Banner>
      ) : null}
      {info.unusable_write_directories.length ? (
        <Banner tone="warning">
          Some configured directories are unavailable.
          <ul className="unusable-list">
            {info.unusable_write_directories.map((item) => (
              <li key={item.path}>
                <span className="directory-path">{item.path}</span>
                <Chip tone="warning">{item.reason}</Chip>
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <fieldset className="settings-form" disabled={busy}>
        <legend>Environment</legend>
        <Choices
          label="Execution environment"
          value={selected}
          options={options}
          onChange={(value) => {
            setSelected(value);
            setSaved(false);
          }}
        />
        <Field label="Writable directories" htmlFor={id}>
          <Textarea
            ref={input}
            id={id}
            rows={6}
            value={directories}
            onChange={(event) => {
              setDirectories(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
        <div className="settings-actions">
          <Button
            variant="primary"
            type="submit"
            disabled={!changed || !selected || busy}
          >
            Save
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function ExecutionPage() {
  const [info, setInfo] = useState<ExecutionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setInfo((await backend.settings("execution")) as ExecutionSettings);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <Page>
      <PageHeader title="Execution" />
      <PageBody>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {!info && error ? <Button onClick={load}>Retry</Button> : null}
        {info ? (
          <ExecutionForm
            initial={info}
            onSave={async (values) =>
              (await backend.updateSettings(
                "execution",
                values,
              )) as ExecutionSettings
            }
          />
        ) : null}
      </PageBody>
    </Page>
  );
}
