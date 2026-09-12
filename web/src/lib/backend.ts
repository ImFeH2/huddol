export type Member = {
  id: number;
  type: "human" | "agent";
  name: string;
  state: "idle" | "running" | "paused";
  tokens?: number;
};

export type DiscussionSummary = {
  id: number;
  topic: string;
  member_ids: number[];
  archived: boolean;
  unread: number;
};

export type Message = {
  id: number;
  sender_id: number;
  sender_name: string;
  body: string;
  created_at: string;
};

export type DiscussionDetail = {
  id: number;
  topic: string;
  members: { id: number; name: string }[];
  total_messages: number;
  archived: boolean;
  read_through: number;
  awaiting_ack: number[];
  acknowledged: number[];
  messages: Message[];
};

export type Todo = {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done";
  detail: string;
};

export type TurnEffect = { ordinal: number; tool: string; summary: string };

export type AgentRun = {
  sequence: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  usage: string | null;
  error: string | null;
  effects: TurnEffect[];
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  requests: number;
  total_tokens: number;
};

export type AgentDetail = {
  id: number;
  todos: Todo[];
  memory: { path: string; size: number; hash: string }[];
  runs: AgentRun[];
  usage: Usage;
  token_limit: number;
  over_token_limit: boolean;
  idle_streak: number;
};

export type FoundMessage = {
  discussion_id: number;
  id: number;
  sender_name: string;
  body: string;
};

export type LibraryEntry = { path: string; size: number; hash: string };

export type BackendEvent = { type: string } & Record<string, unknown>;

export class BackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transport = false,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export type Frame = {
  type: string;
  id?: number;
  result?: unknown;
  error?: { code: string; message: string };
} & Record<string, unknown>;

export type Connection = { url: string } | { error: string };

export type Socket = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(): void;
};

const REQUEST_TIMEOUT = 60_000;

export function connectionFrom(search: string, origin: string): Connection {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error !== null) return { error };
  const ws =
    params.get("ws") ??
    `${origin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/ws`;
  const url = new URL(ws);
  url.searchParams.set("token", params.get("token") ?? "");
  return { url: url.toString() };
}

function pageConnection(): Connection {
  return connectionFrom(location.search, location.origin);
}

function browserSocket(url: string): Socket {
  return new WebSocket(url);
}

export class Backend {
  #locate: () => Connection;
  #socket: (url: string) => Socket;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: BackendEvent) => void>();
  #ready: Promise<Socket> | null = null;
  #closed: BackendError | null = null;
  #rejectConnection: ((error: BackendError) => void) | null = null;
  #failures = new Set<(error: BackendError) => void>();

  constructor(
    locate: () => Connection = pageConnection,
    socket: (url: string) => Socket = browserSocket,
  ) {
    this.#locate = locate;
    this.#socket = socket;
  }

  async connect(): Promise<void> {
    await this.#open();
  }

  #attach(): Promise<Socket> {
    const connection = this.#locate();
    if ("error" in connection)
      throw new BackendError("startup_failed", connection.error, true);
    return new Promise<Socket>((resolve, reject) => {
      const socket = this.#socket(connection.url);
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve(socket);
      };
      socket.onmessage = (event) => {
        let frame: Frame;
        try {
          frame = JSON.parse(String(event.data));
        } catch {
          return;
        }
        this.#receive(frame);
      };
      socket.onerror = () => {};
      socket.onclose = () => {
        if (opened) {
          this.#disconnect(
            new BackendError(
              "disconnected",
              "Connection lost. Restart Huddol.",
              true,
            ),
          );
          return;
        }
        reject(
          new BackendError(
            "connection_failed",
            "Could not connect to Huddol. Restart Huddol.",
            true,
          ),
        );
      };
    });
  }

  async #open(): Promise<Socket> {
    if (this.#closed) throw this.#closed;
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#disconnect(
          new BackendError(
            "connection_timeout",
            "Connection timed out. Restart Huddol.",
            true,
          ),
        );
      }, REQUEST_TIMEOUT);
      this.#rejectConnection = (error) => {
        clearTimeout(timer);
        this.#rejectConnection = null;
        reject(error);
      };
      let attached: Promise<Socket>;
      try {
        attached = this.#attach();
      } catch (error) {
        this.#disconnect(error as BackendError);
        return;
      }
      attached.then(
        (socket) => {
          clearTimeout(timer);
          this.#rejectConnection = null;
          resolve(socket);
        },
        (error: BackendError) => this.#disconnect(error),
      );
    });
    return this.#ready;
  }

  get disconnected(): boolean {
    return this.#closed !== null;
  }

  onFailure(listener: (error: BackendError) => void): () => void {
    this.#failures.add(listener);
    if (this.#closed) listener(this.#closed);
    return () => this.#failures.delete(listener);
  }

  reportFailure = (error: unknown): void => {
    if (this.#closed || (error instanceof BackendError && error.transport))
      return;
    this.#notify(
      error instanceof BackendError
        ? error
        : new BackendError(
            "request_failed",
            error instanceof Error ? error.message : String(error),
          ),
    );
  };

  #notify(error: BackendError): void {
    for (const listener of this.#failures) listener(error);
  }

  #disconnect(error: BackendError): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#rejectConnection?.(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#notify(error);
  }

  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #receive(frame: Frame): void {
    if (this.#closed) return;
    if (frame.type === "response" && typeof frame.id === "number") {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      if (frame.error) {
        pending.reject(new BackendError(frame.error.code, frame.error.message));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    for (const listener of this.#listeners) listener(frame as BackendEvent);
  }

  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const socket = await this.#open();
    if (this.#closed) throw this.#closed;
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new BackendError(
          "timeout",
          "Request timed out. Check before retrying.",
          true,
        );
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.reject(error);
        this.#notify(error);
      }, REQUEST_TIMEOUT);
      const finish = () => {
        clearTimeout(timer);
        this.#pending.delete(id);
      };
      this.#pending.set(id, {
        resolve: (value) => {
          finish();
          resolve(value as T);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        const error = new BackendError(
          "send_failed",
          "Could not send request. Check before retrying.",
          true,
        );
        this.#pending.get(id)?.reject(error);
        this.#notify(error);
      }
    });
  }

  organization() {
    return this.call<{
      id: number;
      members: Member[];
      human_id: number;
      token_limit: number;
    }>("organization.get");
  }

  createAgent(name: string) {
    return this.call<Member>("organization.create_agent", { name });
  }

  renameMember(member_id: number, name: string) {
    return this.call<Member>("organization.rename_member", { member_id, name });
  }

  pauseAgent(agent_id: number) {
    return this.call<Member>("organization.pause_agent", { agent_id });
  }

  resumeAgent(agent_id: number) {
    return this.call<Member>("organization.resume_agent", { agent_id });
  }

  deleteAgent(agent_id: number) {
    return this.call<{ id: number }>("organization.delete_agent", { agent_id });
  }

  discussions(include_archived = false) {
    return this.call<DiscussionSummary[]>("discussion.list", {
      include_archived,
    });
  }

  createDiscussion(topic: string, member_ids: number[]) {
    return this.call<DiscussionSummary>("discussion.create", {
      topic,
      member_ids,
    });
  }

  readDiscussion(discussion_id: number, message_id?: number) {
    return this.call<DiscussionDetail>("discussion.read", {
      discussion_id,
      message_id,
    });
  }

  send(discussion_id: number, body: string) {
    return this.call<{ id: number }>("discussion.send", {
      discussion_id,
      body,
    });
  }

  ack(discussion_id: number, message_ids: number[]) {
    return this.call<{ acked: number }>("discussion.ack", {
      discussion_id,
      message_ids,
    });
  }

  revokeAck(discussion_id: number, message_ids: number[]) {
    return this.call<{ revoked: number }>("discussion.revoke_ack", {
      discussion_id,
      message_ids,
    });
  }

  setDiscussionMembers(discussion_id: number, member_ids: number[]) {
    return this.call<DiscussionSummary>("discussion.set_members", {
      discussion_id,
      member_ids,
    });
  }

  archiveDiscussion(discussion_id: number, archived: boolean) {
    return this.call<{ id: number }>("discussion.archive", {
      discussion_id,
      archived,
    });
  }

  deleteDiscussion(discussion_id: number) {
    return this.call<{ id: number }>("discussion.delete", { discussion_id });
  }

  searchMessages(query: string) {
    return this.call<FoundMessage[]>("discussion.search", { query });
  }

  agentDetail(agent_id: number) {
    return this.call<AgentDetail>("agent.detail", { agent_id });
  }

  library(path?: string) {
    return this.call<LibraryEntry[]>("library.list", { path });
  }

  readLibrary(path: string) {
    return this.call<{ path: string; content: string; hash: string }>(
      "library.read",
      { path },
    );
  }

  writeLibrary(path: string, content: string, expected_hash?: string) {
    return this.call<LibraryEntry & { conflict?: boolean }>("library.write", {
      path,
      content,
      expected_hash,
    });
  }

  deleteLibrary(path: string) {
    return this.call<{ path: string }>("library.delete", { path });
  }

  moveLibrary(path: string, destination: string) {
    return this.call<LibraryEntry>("library.move", { path, destination });
  }

  settings(section: string) {
    return this.call<Record<string, unknown>>("settings.get", { section });
  }

  updateSettings(section: string, values: Record<string, unknown>) {
    return this.call<Record<string, unknown>>("settings.update", {
      section,
      values,
    });
  }
}

export const backend = new Backend();
