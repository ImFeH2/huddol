import { Channel, invoke } from "@tauri-apps/api/core";

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

export type Transport = {
  open(receive: (frame: Frame) => void): Promise<void>;
  send(request: {
    id: number;
    method: string;
    params: Record<string, unknown>;
  }): Promise<void>;
};

type Hot = {
  on(event: string, listener: (payload: Frame) => void): void;
  send(event: string, data?: unknown): void;
};

const REQUEST_TIMEOUT = 60_000;

function tauriTransport(): Transport {
  return {
    async open(receive) {
      const channel = new Channel<Frame>();
      channel.onmessage = receive;
      await invoke("subscribe", { channel });
    },
    async send(request) {
      await invoke("send", { message: request });
    },
  };
}

function devTransport(hot: Hot): Transport {
  return {
    async open(receive) {
      hot.on("huddol:frame", receive);
    },
    async send(request) {
      hot.send("huddol:request", request);
    },
  };
}

export function selectTransport(
  tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
  hot: Hot | undefined = import.meta.hot,
): Transport {
  if (tauri) return tauriTransport();
  if (hot) return devTransport(hot);
  throw new BackendError(
    "no_transport",
    "No Huddol backend is available. Open Huddol from the desktop app or the Vite dev server.",
    true,
  );
}

export class Backend {
  #select: () => Transport;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: BackendEvent) => void>();
  #ready: Promise<Transport> | null = null;
  #closed: BackendError | null = null;
  #rejectConnection: ((error: BackendError) => void) | null = null;
  #failures = new Set<(error: BackendError) => void>();

  constructor(select: () => Transport = selectTransport) {
    this.#select = select;
  }

  async connect(): Promise<void> {
    await this.#open();
  }

  async #attach(): Promise<Transport> {
    const transport = this.#select();
    await transport.open((frame) => this.#receive(frame));
    return transport;
  }

  async #open(): Promise<Transport> {
    if (this.#closed) throw this.#closed;
    if (this.#ready) return this.#ready;
    this.#ready = new Promise<Transport>((resolve, reject) => {
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
      this.#attach().then(
        (transport) => {
          clearTimeout(timer);
          this.#rejectConnection = null;
          resolve(transport);
        },
        (error: unknown) =>
          this.#disconnect(
            error instanceof BackendError
              ? error
              : new BackendError(
                  "connection_failed",
                  typeof error === "string"
                    ? error
                    : "Could not connect to Huddol. Restart Huddol.",
                  true,
                ),
          ),
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
    if (frame.type === "bridge.disconnected") {
      this.#disconnect(
        new BackendError(
          "disconnected",
          "Connection lost. Restart Huddol.",
          true,
        ),
      );
      return;
    }
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
    const transport = await this.#open();
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
      transport.send({ id, method, params }).catch(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        const error = new BackendError(
          "send_failed",
          "Could not send request. Check before retrying.",
          true,
        );
        pending.reject(error);
        this.#notify(error);
      });
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
