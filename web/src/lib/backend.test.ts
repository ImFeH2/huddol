import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Backend,
  BackendError,
  type Frame,
  selectTransport,
  type Transport,
} from "@/lib/backend";

const invoke = vi.fn();
const channels: { onmessage?: (frame: unknown) => void }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage?: (frame: unknown) => void;
    constructor() {
      channels.push(this);
    }
  },
}));

type Sent = { id: number; method: string; params: Record<string, unknown> };

function harness() {
  const sent: Sent[] = [];
  let receive: (frame: Frame) => void = () => {};
  const transport: Transport = {
    open: vi.fn(async (deliver: (frame: Frame) => void) => {
      receive = deliver;
    }),
    async send(request) {
      sent.push(request);
    },
  };
  return {
    transport,
    sent,
    reply: (frame: Frame) => receive(frame),
    backend: (overrides: Partial<Transport> = {}) =>
      new Backend(() => ({ ...transport, ...overrides })),
  };
}

function fakeHot() {
  const listeners = new Map<string, (payload: Frame) => void>();
  const sent: { event: string; data: unknown }[] = [];
  return {
    context: {
      on: vi.fn((event: string, listener: (payload: Frame) => void) => {
        listeners.set(event, listener);
      }),
      send: vi.fn((event: string, data?: unknown) => {
        sent.push({ event, data });
      }),
    },
    sent,
    emit: (event: string, payload: Frame) => listeners.get(event)?.(payload),
  };
}

describe("Backend", () => {
  afterEach(() => vi.useRealTimers());

  it("ends concurrent requests once on disconnect without waiting for send completion", async () => {
    vi.useFakeTimers();
    const { sent, reply, backend: connect } = harness();
    const backend = connect({
      send: (request) => {
        sent.push(request);
        return new Promise(() => {});
      },
    });
    const failures = vi.fn();
    const events = vi.fn();
    backend.onFailure(failures);
    backend.onEvent(events);
    const first = backend.organization().catch((error) => error);
    const second = backend.discussions().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    reply({ type: "bridge.disconnected" });
    reply({ type: "bridge.disconnected" });
    expect(await first).toMatchObject({ code: "disconnected" });
    expect(await second).toMatchObject({ code: "disconnected" });
    backend.reportFailure(new Error("late failure"));
    expect(failures).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(backend.organization()).rejects.toMatchObject({
      code: "disconnected",
    });
    expect(sent).toHaveLength(2);
  });

  it("ends a connection handshake when its transport disconnects", async () => {
    vi.useFakeTimers();
    const { transport, reply, backend: connect } = harness();
    const backend = connect({
      open: (deliver) => {
        void transport.open(deliver);
        return new Promise(() => {});
      },
    });
    const result = backend.organization().catch((error) => error);
    reply({ type: "bridge.disconnected" });
    expect(await result).toMatchObject({ code: "disconnected" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a silent handshake and ignores a late open completion", async () => {
    vi.useFakeTimers();
    let complete = () => {};
    const { backend: connect } = harness();
    const backend = connect({
      open: () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    });
    const failure = vi.fn();
    backend.onFailure(failure);
    const result = backend.organization().catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "connection_timeout" });
    complete();
    await expect(backend.connect()).rejects.toMatchObject({
      code: "connection_timeout",
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a failed open as a transport failure", async () => {
    vi.useFakeTimers();
    const { backend: connect } = harness();
    const backend = connect({ open: async () => Promise.reject("no bridge") });
    await expect(backend.connect()).rejects.toMatchObject({
      code: "connection_failed",
      message: "no bridge",
      transport: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a rejected send immediately", async () => {
    vi.useFakeTimers();
    const { backend: connect } = harness();
    const backend = connect({
      send: async () => Promise.reject(new Error("write failed")),
    });
    await backend.connect();
    await expect(backend.organization()).rejects.toMatchObject({
      code: "send_failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a request timeout without declaring the connection dead", async () => {
    vi.useFakeTimers();
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const failures = vi.fn();
    backend.onFailure(failures);
    const result = backend.organization().catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(failures).toHaveBeenCalledTimes(1);
    const next = backend.organization();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    reply({ type: "response", id: sent[0].id, result: "late" });
    reply({ type: "response", id: sent[1].id, result: { members: [] } });
    await expect(next).resolves.toEqual({ members: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens the transport once and reuses it", async () => {
    const { transport, backend: connect } = harness();
    const backend = connect();
    await backend.connect();
    await backend.connect();
    expect(transport.open).toHaveBeenCalledTimes(1);
  });

  it("correlates a response with its request id", async () => {
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const promise = backend.createAgent("Main");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].method).toBe("organization.create_agent");
    reply({
      type: "response",
      id: sent[0].id,
      result: { id: 2, name: "Main" },
    });
    await expect(promise).resolves.toMatchObject({ name: "Main" });
  });

  it("rejects with a typed error carrying the backend code", async () => {
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const promise = backend.createAgent("  ");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reply({
      type: "response",
      id: sent[0].id,
      error: { code: "invalid_name", message: "Member name must not be empty" },
    });
    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_name" });
  });

  it("keeps concurrent requests independent", async () => {
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const first = backend.discussions();
    const second = backend.organization();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0].id).not.toBe(sent[1].id);
    reply({ type: "response", id: sent[1].id, result: { members: [] } });
    reply({ type: "response", id: sent[0].id, result: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toMatchObject({ members: [] });
  });

  it("delivers non-response frames to event listeners", async () => {
    const { reply, backend: connect } = harness();
    const backend = connect();
    const seen: unknown[] = [];
    backend.onEvent((event) => seen.push(event));
    await backend.connect();
    reply({ type: "message.created", discussion_id: 1, id: 4 });
    reply({ type: "turn.started", agent_id: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      type: "message.created",
      discussion_id: 1,
    });
  });

  it("does not leak responses into the event stream", async () => {
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const seen: unknown[] = [];
    backend.onEvent((event) => seen.push(event));
    const promise = backend.discussions();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    reply({ type: "response", id: sent[0].id, result: [] });
    await promise;
    expect(seen).toHaveLength(0);
  });

  it("ignores a response for an unknown id", async () => {
    const { reply, backend: connect } = harness();
    const backend = connect();
    await backend.connect();
    expect(() =>
      reply({ type: "response", id: 999, result: null }),
    ).not.toThrow();
  });

  it("sends the search query under the method the core exposes", async () => {
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const promise = backend.searchMessages("deadline");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "discussion.search",
      params: { query: "deadline" },
    });
    reply({ type: "response", id: sent[0].id, result: [] });
    await expect(promise).resolves.toEqual([]);
  });

  it("moves a library document to its destination path", async () => {
    const { sent, reply, backend: connect } = harness();
    const backend = connect();
    const promise = backend.moveLibrary("old.md", "new.md");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      method: "library.move",
      params: { path: "old.md", destination: "new.md" },
    });
    reply({ type: "response", id: sent[0].id, result: { path: "new.md" } });
    await expect(promise).resolves.toMatchObject({ path: "new.md" });
  });

  it("unsubscribing stops delivery", async () => {
    const { reply, backend: connect } = harness();
    const backend = connect();
    const seen: unknown[] = [];
    const off = backend.onEvent((event) => seen.push(event));
    await backend.connect();
    off();
    reply({ type: "member.created", id: 3 });
    expect(seen).toHaveLength(0);
  });
});

describe("transport selection", () => {
  beforeEach(() => {
    invoke.mockReset();
    channels.length = 0;
  });

  it("prefers the Tauri bridge when it is present", async () => {
    invoke.mockResolvedValue(undefined);
    const hot = fakeHot();
    await selectTransport(true, hot.context).open(() => {});
    expect(invoke).toHaveBeenCalledWith("subscribe", expect.anything());
    expect(hot.context.on).not.toHaveBeenCalled();
  });

  it("uses the dev bridge outside Tauri when Vite HMR is present", async () => {
    const hot = fakeHot();
    await selectTransport(false, hot.context).open(() => {});
    expect(hot.context.on).toHaveBeenCalledWith(
      "huddol:frame",
      expect.any(Function),
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects connecting when neither bridge exists", async () => {
    vi.useFakeTimers();
    const backend = new Backend(() => selectTransport(false, undefined));
    const failure = vi.fn();
    backend.onFailure(failure);
    await expect(backend.connect()).rejects.toMatchObject({
      code: "no_transport",
      transport: true,
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(backend.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe("dev transport", () => {
  afterEach(() => vi.useRealTimers());

  it("round-trips a request over Vite HMR", async () => {
    const hot = fakeHot();
    const backend = new Backend(() => selectTransport(false, hot.context));
    const promise = backend.searchMessages("deadline");
    await vi.waitFor(() => expect(hot.sent).toHaveLength(1));
    const { event, data } = hot.sent[0];
    const request = data as Sent;
    expect(event).toBe("huddol:request");
    expect(request).toMatchObject({
      method: "discussion.search",
      params: { query: "deadline" },
    });
    hot.emit("huddol:frame", { type: "response", id: request.id, result: [] });
    await expect(promise).resolves.toEqual([]);
  });

  it("treats a bridge.disconnected frame as a lost connection", async () => {
    vi.useFakeTimers();
    const hot = fakeHot();
    const backend = new Backend(() => selectTransport(false, hot.context));
    const events = vi.fn();
    backend.onEvent(events);
    const promise = backend.organization().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    hot.emit("huddol:frame", { type: "bridge.disconnected" });
    expect(await promise).toMatchObject({ code: "disconnected" });
    expect(backend.disconnected).toBe(true);
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Tauri transport", () => {
  beforeEach(() => {
    invoke.mockReset();
    channels.length = 0;
  });

  it("subscribes through a channel and sends through invoke", async () => {
    invoke.mockResolvedValue(undefined);
    const backend = new Backend(() => selectTransport(true, undefined));
    const promise = backend.createAgent("Main");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([name]) => name === "send")).toBe(true),
    );
    expect(
      invoke.mock.calls.filter(([name]) => name === "subscribe"),
    ).toHaveLength(1);
    const sent = invoke.mock.calls.find(([name]) => name === "send");
    if (!sent) throw new Error("no send call");
    const { message } = sent[1] as { message: Sent };
    expect(message.method).toBe("organization.create_agent");
    for (const channel of channels)
      channel.onmessage?.({
        type: "response",
        id: message.id,
        result: { id: 2, name: "Main" },
      });
    await expect(promise).resolves.toMatchObject({ name: "Main" });
  });
});
