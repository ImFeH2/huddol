import { Save } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import {
  Button,
  Chip,
  Field,
  Input,
  Spinner,
  toast,
} from "@/components/ui/index";
import { Segmented } from "@/components/ui/segmented";
import { reportLoadFailure, useSaver } from "@/features/settings/saver";
import { backend } from "@/lib/backend";

const PROVIDERS = [
  { value: "openai-chat", label: "OpenAI Chat" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];

export function modelUpdate(
  values: Record<string, unknown>,
  apiKey: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    api_type: values.api_type,
    base_url: values.base_url,
    model: values.model,
  };
  if (apiKey.trim()) next.api_key = apiKey.trim();
  return next;
}

export function modelTestEnabled(
  values: Record<string, unknown>,
  testing: boolean,
): boolean {
  return (
    !testing &&
    PROVIDERS.some(({ value }) => value === values.api_type) &&
    typeof values.base_url === "string" &&
    !!values.base_url.trim() &&
    typeof values.model === "string" &&
    !!values.model.trim()
  );
}

export function modelTestDescription(latency: number, reply: string): string {
  return `${latency.toLocaleString("en-US")} ms · ${reply.trim().replace(/\s+/g, " ").slice(0, 80)}`;
}

export function ModelPanel() {
  const baseUrlId = useId();
  const modelId = useId();
  const keyId = useId();
  const first = useRef<HTMLInputElement>(null);
  const listRequest = useRef(0);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setValues(await backend.settings("model"));
      setLoaded(true);
      setLoadFailed(false);
    } catch (error) {
      setLoadFailed(true);
      reportLoadFailure("settings-model", error, () => void load());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      listRequest.current += 1;
    };
  }, [load]);

  const { saving, save } = useSaver(load, first);
  const configured = values.api_key_set === true;
  const update = modelUpdate(values, apiKey);
  const disabled = loading || saving || !loaded || loadFailed;

  const clearModels = () => {
    listRequest.current += 1;
    setModels([]);
    setListing(false);
  };

  const listModels = async () => {
    if (listing || disabled) return;
    const request = ++listRequest.current;
    setListing(true);
    try {
      const result = await backend.call<{ models: string[] }>(
        "settings.list_models",
        {
          api_type: values.api_type,
          base_url: values.base_url,
          api_key: apiKey.trim(),
        },
      );
      if (request === listRequest.current) setModels(result.models);
    } catch (error) {
      if (request === listRequest.current) {
        toast({
          tone: "danger",
          title: "Could not load models",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (request === listRequest.current) setListing(false);
    }
  };

  const testModel = async () => {
    if (disabled || !modelTestEnabled(values, testing)) return;
    first.current?.focus();
    setTesting(true);
    try {
      const result = await backend.call<{
        ok: true;
        latency_ms: number;
        reply: string;
      }>("settings.test_model", {
        ...update,
        api_key: apiKey.trim(),
      });
      toast({
        tone: "success",
        title: "Model responded",
        description: modelTestDescription(result.latency_ms, result.reply),
      });
    } catch (error) {
      toast({
        tone: "danger",
        title: "Model test failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled) return;
        clearModels();
        if (await save("model", update)) setApiKey("");
      }}
    >
      <fieldset
        className="m-0 flex min-w-0 max-w-[560px] flex-col gap-4 border-0 p-0"
        aria-label="Model settings"
        disabled={disabled}
      >
        <Field label="Provider">
          <Segmented
            label="Provider"
            value={String(values.api_type ?? "")}
            options={PROVIDERS}
            onChange={(api_type) => {
              clearModels();
              setValues({ ...values, api_type });
            }}
          />
        </Field>
        <Field label="Base URL" htmlFor={baseUrlId}>
          <Input
            ref={first}
            id={baseUrlId}
            value={String(values.base_url ?? "")}
            placeholder="https://api.example.com/v1"
            onChange={(event) => {
              clearModels();
              setValues({ ...values, base_url: event.target.value });
            }}
          />
        </Field>
        <Field label="Model" htmlFor={modelId}>
          <Combobox
            id={modelId}
            label="Model"
            value={String(values.model ?? "")}
            onChange={(model) => setValues({ ...values, model })}
            options={models}
            chooseLabel="Choose model"
            loadLabel="Load models"
            onLoad={() => void listModels()}
            loading={listing}
            disabled={disabled}
          />
        </Field>
        <Field
          label="API key"
          htmlFor={keyId}
          hint={configured ? "Leave blank to keep the stored key." : undefined}
        >
          <Input
            id={keyId}
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={configured ? "Unchanged" : "Required"}
            onChange={(event) => {
              clearModels();
              setApiKey(event.target.value);
            }}
          />
        </Field>
        <div className="flex items-center gap-3 pt-1">
          <Button variant="primary" type="submit" disabled={disabled}>
            <Save size={16} />
            Save
          </Button>
          <Button
            disabled={disabled || !modelTestEnabled(values, testing)}
            onClick={() => void testModel()}
          >
            {testing ? <Spinner label="Testing" /> : null}
            {testing ? "Testing" : "Test"}
          </Button>
          {configured ? <Chip tone="success">Key stored</Chip> : null}
        </div>
      </fieldset>
    </form>
  );
}
