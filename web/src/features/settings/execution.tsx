import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Choices } from "@/components/ui/choices";
import { Banner, Button, Chip, Field, Textarea } from "@/components/ui/index";
import { backend } from "@/lib/backend";
import "@/features/settings/settings.css";

export type EnvironmentTarget =
  | { kind: "native" }
  | { kind: "wsl"; distribution: string };

export type ExecutionSettings = {
  environment: EnvironmentTarget;
  write_directories: string[];
  directories: Record<string, string[]>;
  distributions: string[];
  error: string | null;
  probe_error: string | null;
  unusable_write_directories: { path: string; reason: string }[];
};

export function environmentKey(target: EnvironmentTarget): string {
  return target.kind === "native"
    ? "native"
    : target.kind === "wsl"
      ? `wsl:${target.distribution}`
      : "";
}

export function directoryDrafts(
  directories: Record<string, string[]>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(directories).map(([key, paths]) => [key, paths.join("\n")]),
  );
}

export function executionChanged(
  saved: ExecutionSettings,
  selected: string,
  draft: string,
): boolean {
  return (
    selected !== environmentKey(saved.environment) ||
    draft !== (saved.directories[selected] ?? []).join("\n") ||
    saved.error !== null
  );
}

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
  const [selected, setSelected] = useState(environmentKey(initial.environment));
  const [drafts, setDrafts] = useState(() =>
    directoryDrafts(initial.directories),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const draft = drafts[selected] ?? "";
  const changed = executionChanged(info, selected, draft);
  const options = [
    { value: "native", label: "Native" },
    ...info.distributions.map((distribution) => ({
      value: `wsl:${distribution}`,
      label: `WSL · ${distribution}`,
    })),
  ];
  if (
    info.environment.kind === "wsl" &&
    !options.some((option) => option.value === environmentKey(info.environment))
  ) {
    options.push({
      value: environmentKey(info.environment),
      label: `WSL · ${info.environment.distribution}`,
    });
  }
  const selectedLabel =
    options.find((option) => option.value === selected)?.label ?? selected;
  const save = async () => {
    if (busy || !changed || !selected) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const result = await onSave(executionUpdate(selected, draft));
      setInfo(result);
      setSelected(environmentKey(result.environment));
      setDrafts(directoryDrafts(result.directories));
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
        <Banner tone="success">Saved. Applies to new Turns.</Banner>
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
        <Field
          label={
            <>
              Writable directories <Chip>{selectedLabel}</Chip>
            </>
          }
          htmlFor={id}
        >
          <Textarea
            ref={input}
            id={id}
            rows={6}
            value={draft}
            onChange={(event) => {
              const value = event.target.value;
              setDrafts((current) => ({ ...current, [selected]: value }));
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

export function ExecutionPanel() {
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
    <>
      {error ? (
        <Banner tone="danger">
          {error}
          <div className="settings-actions">
            <Button onClick={() => void load()}>Retry</Button>
          </div>
        </Banner>
      ) : null}
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
    </>
  );
}
