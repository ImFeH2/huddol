import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { Backend, BackendError } = await import("./backend");

function connected() {
  const backend = new Backend();
  invoke.mockResolvedValue(undefined);
  return backend;
}

function reply(frame: Record<string, unknown>) {
  for (const channel of channels) channel.onmessage?.(frame);
}

describe("Backend", () => {
  afterEach(() => vi.useRealTimers());

  it("ends concurrent requests once on disconnect without waiting for send completion", async () => {
    vi.useFakeTimers();
    const backend = connected();
    await backend.connect();
    invoke.mockImplementation(() => new Promise(() => {}));
    const failures = vi.fn();
    const events = vi.fn();
    backend.onFailure(failures);
    backend.onEvent(events);
    const first = backend.organization().catch((error) => error);
    const second = backend.discussions().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.filter(([name]) => name === "send")).toHaveLength(
      2,
    );
    reply({ type: "bridge.disconnected" });
    reply({ type: "bridge.disconnected" });
    expect(await first).toMatchObject({ code: "disconnected" });
    expect(await second).toMatchObject({ code: "disconnected" });
    backend.reportFailure(new Error("late failure"));
    expect(failures).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const count = invoke.mock.calls.length;
    await expect(backend.organization()).rejects.toMatchObject({
      code: "disconnected",
    });
    expect(invoke).toHaveBeenCalledTimes(count);
  });

  it("ends a connection handshake when its channel disconnects", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(() => new Promise(() => {}));
    const backend = new Backend();
    const result = backend.organization().catch((error) => error);
    reply({ type: "bridge.disconnected" });
    expect(await result).toMatchObject({ code: "disconnected" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a silent handshake and ignores a late subscription completion", async () => {
    vi.useFakeTimers();
    let complete = () => {};
    invoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const backend = new Backend();
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

  it("cleans up a rejected send immediately", async () => {
    vi.useFakeTimers();
    const backend = connected();
    await backend.connect();
    invoke.mockRejectedValue(new Error("write failed"));
    await expect(backend.organization()).rejects.toMatchObject({
      code: "send_failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a request timeout without declaring the connection dead", async () => {
    vi.useFakeTimers();
    const backend = connected();
    const failures = vi.fn();
    backend.onFailure(failures);
    const result = backend.organization().catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(failures).toHaveBeenCalledTimes(1);
    const next = backend.organization();
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.filter(([name]) => name === "send")).toHaveLength(
      2,
    );
    reply({ type: "response", id: 1, result: "late" });
    reply({ type: "response", id: 2, result: { members: [] } });
    await expect(next).resolves.toEqual({ members: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  beforeEach(() => {
    invoke.mockReset();
    channels.length = 0;
  });

  it("subscribes once and reuses the same channel", async () => {
    const backend = connected();
    await backend.connect();
    await backend.connect();
    expect(
      invoke.mock.calls.filter(([name]) => name === "subscribe"),
    ).toHaveLength(1);
  });

  it("correlates a response with its request id", async () => {
    const backend = connected();
    const promise = backend.createAgent("Main");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([name]) => name === "send")).toBe(true),
    );
    const sent = invoke.mock.calls.find(([name]) => name === "send");
    if (!sent) throw new Error("no send call");
    const [, payload] = sent;
    const message = (payload as { message: { id: number; method: string } })
      .message;
    expect(message.method).toBe("organization.create_agent");

    reply({
      type: "response",
      id: message.id,
      result: { id: 2, name: "Main" },
    });
    await expect(promise).resolves.toMatchObject({ name: "Main" });
  });

  it("rejects with a typed error carrying the backend code", async () => {
    const backend = connected();
    const promise = backend.createAgent("  ");
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([name]) => name === "send")).toBe(true),
    );
    const sent = invoke.mock.calls.find(([name]) => name === "send");
    if (!sent) throw new Error("no send call");
    const [, payload] = sent;
    const { id } = (payload as { message: { id: number } }).message;

    reply({
      type: "response",
      id,
      error: { code: "invalid_name", message: "Member name must not be empty" },
    });
    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_name" });
  });

  it("keeps concurrent requests independent", async () => {
    const backend = connected();
    const first = backend.discussions();
    const second = backend.organization();
    await vi.waitFor(() =>
      expect(
        invoke.mock.calls.filter(([name]) => name === "send"),
      ).toHaveLength(2),
    );
    const ids = invoke.mock.calls
      .filter(([name]) => name === "send")
      .map(
        ([, payload]) => (payload as { message: { id: number } }).message.id,
      );
    expect(new Set(ids).size).toBe(2);

    reply({ type: "response", id: ids[1], result: { members: [] } });
    reply({ type: "response", id: ids[0], result: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toMatchObject({ members: [] });
  });

  it("delivers non-response frames to event listeners", async () => {
    const backend = connected();
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
    const backend = connected();
    const seen: unknown[] = [];
    backend.onEvent((event) => seen.push(event));
    const promise = backend.discussions();
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([name]) => name === "send")).toBe(true),
    );
    const sent = invoke.mock.calls.find(([name]) => name === "send");
    if (!sent) throw new Error("no send call");
    const [, payload] = sent;
    const { id } = (payload as { message: { id: number } }).message;

    reply({ type: "response", id, result: [] });
    await promise;
    expect(seen).toHaveLength(0);
  });

  it("ignores a response for an unknown id", async () => {
    const backend = connected();
    await backend.connect();
    expect(() =>
      reply({ type: "response", id: 999, result: null }),
    ).not.toThrow();
  });

  async function lastSent() {
    await vi.waitFor(() =>
      expect(invoke.mock.calls.some(([name]) => name === "send")).toBe(true),
    );
    const sent = [...invoke.mock.calls]
      .reverse()
      .find(([name]) => name === "send");
    if (!sent) throw new Error("no send call");
    return (
      sent[1] as {
        message: {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
      }
    ).message;
  }

  it("sends the search query under the method the core exposes", async () => {
    const backend = connected();
    await backend.connect();
    const promise = backend.searchMessages("deadline");
    const { id, method, params } = await lastSent();
    expect(method).toBe("discussion.search");
    expect(params).toEqual({ query: "deadline" });
    reply({ type: "response", id, result: [] });
    await expect(promise).resolves.toEqual([]);
  });

  it("moves a library document to its destination path", async () => {
    const backend = connected();
    await backend.connect();
    const promise = backend.moveLibrary("old.md", "new.md");
    const { id, method, params } = await lastSent();
    expect(method).toBe("library.move");
    expect(params).toEqual({ path: "old.md", destination: "new.md" });
    reply({ type: "response", id, result: { path: "new.md" } });
    await expect(promise).resolves.toMatchObject({ path: "new.md" });
  });

  it("unsubscribing stops delivery", async () => {
    const backend = connected();
    const seen: unknown[] = [];
    const off = backend.onEvent((event) => seen.push(event));
    await backend.connect();
    off();
    reply({ type: "member.created", id: 3 });
    expect(seen).toHaveLength(0);
  });
});
