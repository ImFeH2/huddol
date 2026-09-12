import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Backend,
  BackendError,
  type Connection,
  connectionFrom,
  type Frame,
  type Socket,
} from "@/lib/backend";

type Sent = { id: number; method: string; params: Record<string, unknown> };

class FakeSocket implements Socket {
  static instances: FakeSocket[] = [];
  onopen: Socket["onopen"] = null;
  onmessage: Socket["onmessage"] = null;
  onclose: Socket["onclose"] = null;
  onerror: Socket["onerror"] = null;
  sent: Sent[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.closed) throw new Error("socket is closed");
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  reply(frame: Frame): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  fail(): void {
    this.onerror?.(new Event("error"));
    this.closed = true;
    this.onclose?.(new CloseEvent("close"));
  }
}

const URL = "ws://127.0.0.1:4321/ws?token=secret";

function harness(connection: Connection = { url: URL }) {
  FakeSocket.instances = [];
  const backend = new Backend(
    () => connection,
    (url) => new FakeSocket(url),
  );
  const socket = () => {
    const last = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!last) throw new Error("no socket");
    return last;
  };
  const connected = async () => {
    const pending = backend.connect();
    await vi.waitFor(() => socket());
    socket().open();
    await pending;
    return socket();
  };
  return { backend, socket, connected };
}

describe("connectionFrom", () => {
  it("derives the same-origin socket for the full-stack page", () => {
    expect(connectionFrom("?token=abc", "http://127.0.0.1:8000")).toEqual({
      url: "ws://127.0.0.1:8000/ws?token=abc",
    });
  });

  it("uses the ws parameter from the Vite dev page", () => {
    expect(
      connectionFrom(
        "?ws=ws://127.0.0.1:4321/ws&token=abc",
        "http://127.0.0.1:1420",
      ),
    ).toEqual({ url: "ws://127.0.0.1:4321/ws?token=abc" });
  });

  it("uses the ws parameter from the Tauri page", () => {
    expect(
      connectionFrom(
        "?ws=ws://127.0.0.1:4321/ws&token=abc",
        "tauri://localhost",
      ),
    ).toEqual({ url: "ws://127.0.0.1:4321/ws?token=abc" });
    expect(
      connectionFrom(
        "?ws=ws://127.0.0.1:4321/ws&token=abc",
        "http://tauri.localhost",
      ),
    ).toEqual({ url: "ws://127.0.0.1:4321/ws?token=abc" });
  });

  it("reports the error parameter instead of a url", () => {
    expect(
      connectionFrom("?error=kernel%20did%20not%20start", "tauri://localhost"),
    ).toEqual({ error: "kernel did not start" });
  });
});

describe("Backend", () => {
  afterEach(() => vi.useRealTimers());

  it("does not connect when the page carries an error", async () => {
    vi.useFakeTimers();
    const { backend } = harness({ error: "kernel did not start" });
    const failure = vi.fn();
    backend.onFailure(failure);
    await expect(backend.connect()).rejects.toMatchObject({
      code: "startup_failed",
      message: "kernel did not start",
      transport: true,
    });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(backend.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens a socket at the resolved url", async () => {
    const { connected } = harness();
    const socket = await connected();
    expect(socket.url).toBe(URL);
  });

  it("reports a socket refused before opening, as with a wrong token, as a connection failure", async () => {
    vi.useFakeTimers();
    const { backend, socket } = harness();
    const failure = vi.fn();
    backend.onFailure(failure);
    const pending = backend.connect().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    socket().fail();
    expect(await pending).toMatchObject({
      code: "connection_failed",
      transport: true,
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(backend.disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends concurrent requests once when the socket closes", async () => {
    vi.useFakeTimers();
    const { backend, connected } = harness();
    const socket = await connected();
    const failures = vi.fn();
    const events = vi.fn();
    backend.onFailure(failures);
    backend.onEvent(events);
    const first = backend.organization().catch((error) => error);
    const second = backend.discussions().catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toHaveLength(2);
    socket.fail();
    socket.onclose?.(new CloseEvent("close"));
    expect(await first).toMatchObject({ code: "disconnected" });
    expect(await second).toMatchObject({ code: "disconnected" });
    backend.reportFailure(new Error("late failure"));
    expect(failures).toHaveBeenCalledTimes(1);
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(backend.organization()).rejects.toMatchObject({
      code: "disconnected",
    });
    expect(socket.sent).toHaveLength(2);
  });

  it("bounds a silent handshake and ignores a late open", async () => {
    vi.useFakeTimers();
    const { backend, socket } = harness();
    const failure = vi.fn();
    backend.onFailure(failure);
    const result = backend.organization().catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "connection_timeout" });
    socket().open();
    await expect(backend.connect()).rejects.toMatchObject({
      code: "connection_timeout",
    });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up a rejected send immediately", async () => {
    vi.useFakeTimers();
    const { backend, connected } = harness();
    const socket = await connected();
    socket.closed = true;
    await expect(backend.organization()).rejects.toMatchObject({
      code: "send_failed",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a request timeout without declaring the connection dead", async () => {
    vi.useFakeTimers();
    const { backend, connected } = harness();
    const socket = await connected();
    const failures = vi.fn();
    backend.onFailure(failures);
    const result = backend.organization().catch((error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(failures).toHaveBeenCalledTimes(1);
    const next = backend.organization();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toHaveLength(2);
    socket.reply({ type: "response", id: socket.sent[0].id, result: "late" });
    socket.reply({
      type: "response",
      id: socket.sent[1].id,
      result: { members: [] },
    });
    await expect(next).resolves.toEqual({ members: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("opens one socket and reuses it", async () => {
    const { backend, connected } = harness();
    await connected();
    await backend.connect();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("correlates a response with its request id", async () => {
    const { backend, connected } = harness();
    const socket = await connected();
    const promise = backend.createAgent("Main");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0].method).toBe("organization.create_agent");
    socket.reply({
      type: "response",
      id: socket.sent[0].id,
      result: { id: 2, name: "Main" },
    });
    await expect(promise).resolves.toMatchObject({ name: "Main" });
  });

  it("rejects with a typed error carrying the backend code", async () => {
    const { backend, connected } = harness();
    const socket = await connected();
    const promise = backend.createAgent("  ");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply({
      type: "response",
      id: socket.sent[0].id,
      error: { code: "invalid_name", message: "Member name must not be empty" },
    });
    await expect(promise).rejects.toBeInstanceOf(BackendError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_name" });
  });

  it("matches responses by id regardless of order", async () => {
    const { backend, connected } = harness();
    const socket = await connected();
    const first = backend.discussions();
    const second = backend.organization();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
    expect(socket.sent[0].id).not.toBe(socket.sent[1].id);
    socket.reply({
      type: "response",
      id: socket.sent[1].id,
      result: { members: [] },
    });
    socket.reply({ type: "response", id: socket.sent[0].id, result: [] });
    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toMatchObject({ members: [] });
  });

  it("delivers non-response frames to event listeners", async () => {
    const { backend, connected } = harness();
    const seen: unknown[] = [];
    backend.onEvent((event) => seen.push(event));
    const socket = await connected();
    socket.reply({ type: "message.created", discussion_id: 1, id: 4 });
    socket.reply({ type: "turn.started", agent_id: 2 });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      type: "message.created",
      discussion_id: 1,
    });
  });

  it("does not leak responses into the event stream", async () => {
    const { backend, connected } = harness();
    const seen: unknown[] = [];
    backend.onEvent((event) => seen.push(event));
    const socket = await connected();
    const promise = backend.discussions();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reply({ type: "response", id: socket.sent[0].id, result: [] });
    await promise;
    expect(seen).toHaveLength(0);
  });

  it("ignores a response for an unknown id and unreadable frames", async () => {
    const { connected } = harness();
    const socket = await connected();
    expect(() =>
      socket.reply({ type: "response", id: 999, result: null }),
    ).not.toThrow();
    expect(() =>
      socket.onmessage?.(new MessageEvent("message", { data: "{" })),
    ).not.toThrow();
  });

  it("sends the search query under the method the core exposes", async () => {
    const { backend, connected } = harness();
    const socket = await connected();
    const promise = backend.searchMessages("deadline");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({
      method: "discussion.search",
      params: { query: "deadline" },
    });
    socket.reply({ type: "response", id: socket.sent[0].id, result: [] });
    await expect(promise).resolves.toEqual([]);
  });

  it("moves a library document to its destination path", async () => {
    const { backend, connected } = harness();
    const socket = await connected();
    const promise = backend.moveLibrary("old.md", "new.md");
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    expect(socket.sent[0]).toMatchObject({
      method: "library.move",
      params: { path: "old.md", destination: "new.md" },
    });
    socket.reply({
      type: "response",
      id: socket.sent[0].id,
      result: { path: "new.md" },
    });
    await expect(promise).resolves.toMatchObject({ path: "new.md" });
  });

  it("unsubscribing stops delivery", async () => {
    const { backend, connected } = harness();
    const seen: unknown[] = [];
    const off = backend.onEvent((event) => seen.push(event));
    const socket = await connected();
    off();
    socket.reply({ type: "member.created", id: 3 });
    expect(seen).toHaveLength(0);
  });
});
