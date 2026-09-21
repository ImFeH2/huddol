import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts } from "@/components/ui/toast";
import {
  AgentCreateDialog,
  AgentModelPanel,
  ModelPanel,
} from "@/features/settings/model";
import { type BackendEvent, backend, type ModelCatalog } from "@/lib/backend";

const lifecycle = vi.hoisted(() => ({
  effects: [] as (() => undefined | (() => void))[],
  setters: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const setter = vi.fn();
    lifecycle.setters.push(setter);
    return [initial, setter];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => "model-test",
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => undefined | (() => void)) => {
    lifecycle.effects.push(effect);
  },
}));

const catalog: ModelCatalog = {
  version: 1,
  providers: [],
  models: [],
  default_model_id: null,
  default_thinking: "default",
  agent_configs: { "2": { model_id: null, thinking: "high" } },
};
let event: (value: BackendEvent) => void;
let cleanups: (() => void)[];
const off = vi.fn();

beforeEach(() => {
  lifecycle.effects = [];
  lifecycle.setters = [];
  cleanups = [];
  off.mockClear();
  clearToasts();
  vi.spyOn(backend, "onEvent").mockImplementation((listener) => {
    event = listener;
    return off;
  });
  vi.spyOn(backend, "modelCatalog").mockResolvedValue(catalog);
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  clearToasts();
  vi.restoreAllMocks();
});
async function mountEffects() {
  for (const effect of lifecycle.effects.splice(0)) {
    const cleanup = effect();
    if (cleanup) cleanups.push(cleanup);
  }
  await Promise.resolve();
}

describe("model configuration connection recovery", () => {
  it("reloads settings after a failed initial load and releases the listener", async () => {
    vi.mocked(backend.modelCatalog).mockRejectedValueOnce(new Error("offline"));
    ModelPanel();
    await mountEffects();
    expect(lifecycle.setters[2]).toHaveBeenLastCalledWith(true);
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(backend.modelCatalog).toHaveBeenCalledTimes(2);
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(catalog);
    expect(lifecycle.setters[2]).toHaveBeenLastCalledWith(false);
    cleanups.pop()?.();
    expect(off).toHaveBeenCalledOnce();
  });

  it("refreshes saved Agent choices after reconnect", async () => {
    AgentModelPanel({ agentId: 2 });
    await mountEffects();
    const next = {
      ...catalog,
      agent_configs: { "2": { model_id: null, thinking: null } },
    };
    vi.mocked(backend.modelCatalog).mockResolvedValueOnce(next);
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenLastCalledWith(next);
    expect(lifecycle.setters[1]).toHaveBeenLastCalledWith(
      next.agent_configs["2"],
    );
  });

  it("preserves an edited Agent choice while refreshing model availability", async () => {
    const panel = AgentModelPanel({ agentId: 2 });
    await mountEffects();
    panel.props.onChangeCapture();
    lifecycle.setters[1].mockClear();
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenCalledTimes(2);
    expect(lifecycle.setters[1]).not.toHaveBeenCalled();
  });

  it("refreshes models in Agent creation without changing the draft", async () => {
    AgentCreateDialog({ onClose: vi.fn(), onCreated: vi.fn() });
    await mountEffects();
    event({ type: "connection.restored" });
    await Promise.resolve();
    expect(lifecycle.setters[0]).toHaveBeenCalledTimes(2);
    expect(lifecycle.setters[1]).not.toHaveBeenCalled();
    expect(lifecycle.setters[2]).not.toHaveBeenCalled();
  });
});
