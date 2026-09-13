import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Choices } from "@/components/ui/choices";
import { Button, Chip, Field, Textarea, toast } from "@/components/ui/index";
import { reportLoadFailure } from "@/features/settings/saver";
import { backend } from "@/lib/backend";

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
    try {
      const result = await onSave(executionUpdate(selected, draft));
      setInfo(result);
      setSelected(environmentKey(result.environment));
      setDrafts(directoryDrafts(result.directories));
      toast({ tone: "success", title: "Saved" });
    } catch (failure) {
      toast({
        tone: "danger",
        title: "Could not save",
        description:
          failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setBusy(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) input.current?.focus();
      });
    }
  };
  return (
    <form
      className="m-0 flex min-w-0 max-w-[560px] flex-col gap-4 border-0 p-0"
      aria-label="Execution settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {info.error ||
      info.probe_error ||
      info.unusable_write_directories.length ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {info.error ? (
            <li className="flex min-w-0 items-center gap-2">
              <Chip tone="danger">Unavailable</Chip>
              <span className="flex-1 min-w-0 text-fg-muted text-sm wrap-anywhere">
                {info.error}
              </span>
            </li>
          ) : null}
          {info.probe_error ? (
            <li className="flex min-w-0 items-center gap-2">
              <Chip tone="warning">Probe failed</Chip>
              <span className="flex-1 min-w-0 text-fg-muted text-sm wrap-anywhere">
                {info.probe_error}
              </span>
            </li>
          ) : null}
          {info.unusable_write_directories.map((item) => (
            <li key={item.path} className="flex min-w-0 items-center gap-2">
              <Chip tone="warning">{item.reason}</Chip>
              <span className="flex-1 min-w-0 truncate font-mono text-sm text-fg-muted wrap-anywhere">
                {item.path}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <fieldset
        className="m-0 flex min-w-0 max-w-[560px] flex-col gap-4 border-0 p-0"
        disabled={busy}
      >
        <legend className="p-0 pb-2 text-sm font-medium text-fg-muted">
          Environment
        </legend>
        <Choices
          label="Execution environment"
          value={selected}
          options={options}
          onChange={setSelected}
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
            }}
          />
        </Field>
        <div className="flex items-center gap-3 pt-1">
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
  const load = useCallback(async () => {
    try {
      setInfo((await backend.settings("execution")) as ExecutionSettings);
    } catch (failure) {
      reportLoadFailure("settings-execution", failure, () => void load());
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!info) return null;
  return (
    <ExecutionForm
      initial={info}
      onSave={async (values) =>
        (await backend.updateSettings("execution", values)) as ExecutionSettings
      }
    />
  );
}
