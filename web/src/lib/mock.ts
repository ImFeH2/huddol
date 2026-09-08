import type { Backend, BackendEvent, Member } from "./backend";

type MockMessage = {
  id: number;
  sender_id: number;
  sender_name: string;
  body: string;
  created_at: string;
};

type MockDiscussion = {
  id: number;
  topic: string;
  member_ids: number[];
  archived: boolean;
  messages: MockMessage[];
  read_through: number;
  acked: number[];
};

const NOW = Date.parse("2026-09-02T09:00:00Z");

function at(minutes: number): string {
  return new Date(NOW + minutes * 60_000).toISOString();
}

const members: Member[] = [
  { id: 1, type: "human", name: "You", state: "idle" },
  { id: 2, type: "agent", name: "Scout", state: "running", tokens: 184_320 },
  { id: 3, type: "agent", name: "Archivist", state: "idle", tokens: 41_002 },
  { id: 4, type: "agent", name: "Mainframe", state: "paused", tokens: 9_845 },
  { id: 5, type: "agent", name: "Ledger", state: "idle", tokens: 205_400 },
  { id: 6, type: "agent", name: "Nightshift", state: "idle", tokens: 0 },
  { id: 7, type: "human", name: "Robin Quill", state: "idle" },
];

const discussions: MockDiscussion[] = [
  {
    id: 1,
    topic: "Ship the release notes",
    member_ids: [1, 2, 3],
    archived: false,
    read_through: 3,
    acked: [],
    messages: [
      {
        id: 1,
        sender_id: 1,
        sender_name: "You",
        body: "@Scout can you draft the notes for 0.4? @Mainframe wrote the migration so pull the details from there.",
        created_at: at(0),
      },
      {
        id: 2,
        sender_id: 2,
        sender_name: "Scout",
        body: "Reading the migration now. I will put a draft in the library as release-0.4.md.",
        created_at: at(4),
      },
      {
        id: 3,
        sender_id: 3,
        sender_name: "Archivist",
        body: "I filed last quarter's notes under archive/. Same structure should work.",
        created_at: at(9),
      },
      {
        id: 4,
        sender_id: 2,
        sender_name: "Scout",
        body: "Draft is up. @You please look at the migration section, I am not sure the ordering is right.",
        created_at: at(21),
      },
    ],
  },
  {
    id: 2,
    topic: "Sandbox write directories",
    member_ids: [1, 4],
    archived: false,
    read_through: 2,
    acked: [],
    messages: [
      {
        id: 1,
        sender_id: 4,
        sender_name: "Mainframe",
        body: "I cannot write to the workspace root. Is that deliberate?",
        created_at: at(-90),
      },
      {
        id: 2,
        sender_id: 1,
        sender_name: "You",
        body: "Yes. Ask for a specific directory and I will add it.",
        created_at: at(-84),
      },
    ],
  },
  {
    id: 3,
    topic: "Model timeouts on long Turns",
    member_ids: [1, 2, 5],
    archived: false,
    read_through: 1,
    acked: [],
    messages: [
      {
        id: 1,
        sender_id: 5,
        sender_name: "Ledger",
        body: "Turn 10 failed with a timeout. I have retried twice and both attempts died at the same tool call.",
        created_at: at(-240),
      },
      {
        id: 2,
        sender_id: 2,
        sender_name: "Scout",
        body: "Same here. @Archivist saw it last week too, but they are not in this discussion so nobody was paged.",
        created_at: at(-233),
      },
      {
        id: 3,
        sender_id: 5,
        sender_name: "Ledger",
        body: "@You I am close to the token ceiling, so I will stop scheduling after this. Raise it or reassign the work.",
        created_at: at(-228),
      },
    ],
  },
  {
    id: 4,
    topic: "Weekly review",
    member_ids: [1, 2, 3, 4, 5, 6, 7],
    archived: false,
    read_through: 3,
    acked: [],
    messages: [
      {
        id: 1,
        sender_id: 7,
        sender_name: "Robin Quill",
        body: "Numbers for the week are in the library under glossary.md. Nothing alarming.",
        created_at: at(-1450),
      },
      {
        id: 2,
        sender_id: 3,
        sender_name: "Archivist",
        body: "Filed. I also pruned the old drafts folder.",
        created_at: at(-1440),
      },
      {
        id: 3,
        sender_id: 6,
        sender_name: "Nightshift",
        body: "Nothing from me. I have not been woken this week.",
        created_at: at(-1400),
      },
    ],
  },
  {
    id: 5,
    topic: "Vendor evaluation",
    member_ids: [1, 3],
    archived: true,
    read_through: 2,
    acked: [],
    messages: [
      {
        id: 1,
        sender_id: 1,
        sender_name: "You",
        body: "Closing this out, we picked the second option.",
        created_at: at(-8600),
      },
      {
        id: 2,
        sender_id: 3,
        sender_name: "Archivist",
        body: "Archived the comparison table for later.",
        created_at: at(-8590),
      },
    ],
  },
  {
    id: 6,
    topic: "Kickoff: night shift rotation",
    member_ids: [1, 6],
    archived: false,
    read_through: 0,
    acked: [],
    messages: [],
  },
];

const library = new Map<string, string>([
  [
    "release-0.4.md",
    "# Release 0.4\n\n- Packaged the core as a directory\n- Agents now report what each Turn produced\n- Cumulative token spend is capped per Agent\n",
  ],
  ["archive/release-0.3.md", "# Release 0.3\n\nOlder notes.\n"],
  [
    "runbooks/on-call.md",
    "# On call\n\n1. Check the Members page for a paused Agent.\n2. Read the last Turn and what it produced.\n3. Raise the token limit only after reading the spend.\n",
  ],
  [
    "glossary.md",
    "# Glossary\n\n**Turn** — one run of an Agent.\n\n**Reminder** — the wake-up notice that lists what is waiting.\n",
  ],
]);

const settings: Record<string, Record<string, unknown>> = {
  model: {
    api_type: "openai",
    base_url: "https://example.invalid/v1",
    model: "a-model",
    compaction_threshold: 400_000,
    api_key_set: true,
  },
  execution: {
    environment: { kind: "native" },
    write_directories: ["/home/you/work", "/home/you/scratch"],
    distributions: [],
    error: null,
    probe_error: null,
    unusable_write_directories: [],
  },
  limits: { agent_token_limit: 200_000 },
};

const unusableWriteDirectories = [
  { path: "/home/you/archive-2024", reason: "does not exist" },
  { path: "/usr/local/share", reason: "not writable by this user" },
];

type MockAgent = {
  todos: { id: number; title: string; status: string; detail: string }[];
  memory: { path: string; size: number; hash: string }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    requests: number;
    total_tokens: number;
  };
  idle_streak: number;
  runs: {
    sequence: number;
    status: string;
    started_at: string;
    completed_at: string | null;
    usage: string | null;
    error: string | null;
    effects: { ordinal: number; tool: string; summary: string }[];
  }[];
};

function usage(total: number, requests: number) {
  return {
    input_tokens: Math.round(total * 0.9),
    output_tokens: Math.round(total * 0.07),
    cache_read_tokens: Math.round(total * 0.45),
    requests,
    total_tokens: total,
  };
}

const agentDetails: Record<number, MockAgent> = {
  2: {
    todos: [
      {
        id: 1,
        title: "Draft the 0.4 notes",
        status: "in_progress",
        detail: "",
      },
      {
        id: 2,
        title: "Check migration ordering",
        status: "pending",
        detail: "",
      },
      {
        id: 3,
        title: "Read the 0.3 notes for structure",
        status: "done",
        detail: "",
      },
    ],
    memory: [
      { path: "MEMORY.md", size: 412, hash: "a" },
      { path: "release-process.md", size: 1204, hash: "b" },
    ],
    usage: usage(184_320, 46),
    idle_streak: 0,
    runs: [
      {
        sequence: 12,
        status: "running",
        started_at: at(24),
        completed_at: null,
        usage: null,
        error: null,
        effects: [
          { ordinal: 1, tool: "library.read", summary: "release-0.4.md" },
        ],
      },
      {
        sequence: 11,
        status: "completed",
        started_at: at(20),
        completed_at: at(21),
        usage: null,
        error: null,
        effects: [
          { ordinal: 1, tool: "run", summary: "git log --oneline exited 0" },
          { ordinal: 2, tool: "library.write", summary: "release-0.4.md" },
          {
            ordinal: 3,
            tool: "send",
            summary: "Ship the release notes: message 4 (96 characters)",
          },
          {
            ordinal: 4,
            tool: "ack",
            summary: "Ship the release notes: 1 acknowledged",
          },
        ],
      },
      {
        sequence: 10,
        status: "completed",
        started_at: at(10),
        completed_at: at(11),
        usage: null,
        error: null,
        effects: [
          { ordinal: 1, tool: "edit", summary: "/home/you/work/notes/0.4.md" },
        ],
      },
      {
        sequence: 9,
        status: "failed",
        started_at: at(2),
        completed_at: at(3),
        usage: null,
        error: "TimeoutError: model did not respond within 120s",
        effects: [],
      },
    ],
  },
  3: {
    todos: [
      { id: 1, title: "Prune the drafts folder", status: "done", detail: "" },
    ],
    memory: [{ path: "MEMORY.md", size: 980, hash: "c" }],
    usage: usage(41_002, 18),
    idle_streak: 4,
    runs: [
      {
        sequence: 8,
        status: "completed",
        started_at: at(-30),
        completed_at: at(-29),
        usage: null,
        error: null,
        effects: [],
      },
      {
        sequence: 7,
        status: "completed",
        started_at: at(-120),
        completed_at: at(-119),
        usage: null,
        error: null,
        effects: [],
      },
      {
        sequence: 6,
        status: "completed",
        started_at: at(-300),
        completed_at: at(-299),
        usage: null,
        error: null,
        effects: [],
      },
      {
        sequence: 5,
        status: "completed",
        started_at: at(-1400),
        completed_at: at(-1399),
        usage: null,
        error: null,
        effects: [
          {
            ordinal: 1,
            tool: "library.write",
            summary: "archive/release-0.3.md",
          },
        ],
      },
    ],
  },
  4: {
    todos: [],
    memory: [{ path: "MEMORY.md", size: 120, hash: "d" }],
    usage: usage(9_845, 4),
    idle_streak: 0,
    runs: [
      {
        sequence: 3,
        status: "interrupted",
        started_at: at(-2000),
        completed_at: null,
        usage: null,
        error: "Huddol exited while this Turn was running",
        effects: [{ ordinal: 1, tool: "run", summary: "cargo build exited 0" }],
      },
    ],
  },
  5: {
    todos: [
      {
        id: 1,
        title: "Reconcile the timeout report",
        status: "in_progress",
        detail: "",
      },
    ],
    memory: [
      { path: "MEMORY.md", size: 2410, hash: "e" },
      { path: "incidents/timeouts.md", size: 6_140, hash: "f" },
    ],
    usage: usage(205_400, 88),
    idle_streak: 1,
    runs: [
      {
        sequence: 21,
        status: "completed",
        started_at: at(-220),
        completed_at: at(-219),
        usage: null,
        error: null,
        effects: [
          {
            ordinal: 1,
            tool: "send",
            summary: "Model timeouts on long Turns: message 3 (108 characters)",
          },
        ],
      },
      {
        sequence: 20,
        status: "failed",
        started_at: at(-260),
        completed_at: at(-258),
        usage: null,
        error: "TimeoutError: model did not respond within 120s",
        effects: [],
      },
    ],
  },
  6: { todos: [], memory: [], usage: usage(0, 0), idle_streak: 0, runs: [] },
};

function detailFor(id: number): MockAgent {
  return (
    agentDetails[id] ?? {
      todos: [],
      memory: [],
      usage: usage(0, 0),
      idle_streak: 0,
      runs: [],
    }
  );
}

function summary(item: MockDiscussion) {
  const unread = item.messages.filter((m) => m.id > item.read_through).length;
  return {
    id: item.id,
    topic: item.topic,
    member_ids: item.member_ids,
    archived: item.archived,
    unread,
  };
}

function mentionsOf(item: MockDiscussion, memberId: number): number[] {
  const me = members.find((m) => m.id === memberId);
  if (!me) return [];
  return item.messages
    .filter(
      (message) =>
        message.sender_id !== memberId &&
        message.body.toLowerCase().includes(`@${me.name.toLowerCase()}`) &&
        !item.acked.includes(message.id),
    )
    .map((message) => message.id);
}

export function createMockBackend(Base: typeof Backend): Backend {
  class MockBackend extends Base {
    override async connect(): Promise<void> {}

    override onEvent(listener: (event: BackendEvent) => void): () => void {
      const timer = setTimeout(
        () =>
          listener({
            type: "ready",
            unusable_write_directories: unusableWriteDirectories,
          }),
        0,
      );
      return () => clearTimeout(timer);
    }

    override async call<T>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      return this.#handle(method, params) as T;
    }

    #handle(method: string, params: Record<string, unknown>): unknown {
      const find = (id: unknown) =>
        discussions.find((item) => item.id === Number(id));

      switch (method) {
        case "organization.get":
          return { id: 1, members, human_id: 1, token_limit: 200_000 };

        case "organization.create_agent": {
          const created: Member = {
            id: Math.max(...members.map((m) => m.id)) + 1,
            type: "agent",
            name: String(params.name),
            state: "idle",
            tokens: 0,
          };
          members.push(created);
          return created;
        }

        case "organization.rename_member": {
          const member = members.find((m) => m.id === Number(params.member_id));
          if (member) member.name = String(params.name);
          return member;
        }

        case "organization.pause_agent":
        case "organization.resume_agent": {
          const member = members.find((m) => m.id === Number(params.agent_id));
          if (member)
            member.state =
              method === "organization.pause_agent" ? "paused" : "idle";
          return member;
        }

        case "organization.delete_agent": {
          const id = Number(params.agent_id);
          const index = members.findIndex((m) => m.id === id);
          if (index >= 0) members.splice(index, 1);
          return { id };
        }

        case "discussion.list": {
          const limit = params.limit;
          if (
            limit != null &&
            (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
          ) {
            throw new Error("limit must be an integer >= 1");
          }
          return discussions
            .filter(
              (item) =>
                item.member_ids.includes(1) &&
                (params.include_archived || !item.archived),
            )
            .sort((a, b) => {
              const lastA = a.messages[a.messages.length - 1];
              const lastB = b.messages[b.messages.length - 1];
              const timeA = lastA ? Date.parse(lastA.created_at) : -Infinity;
              const timeB = lastB ? Date.parse(lastB.created_at) : -Infinity;
              return timeB - timeA || a.id - b.id;
            })
            .slice(0, limit ?? undefined)
            .map(summary);
        }

        case "discussion.create": {
          const created: MockDiscussion = {
            id: Math.max(...discussions.map((d) => d.id)) + 1,
            topic: String(params.topic),
            member_ids: [
              1,
              ...((params.member_ids as number[]) ?? []).filter(
                (id) => id !== 1,
              ),
            ],
            archived: false,
            messages: [],
            read_through: 0,
            acked: [],
          };
          discussions.unshift(created);
          return summary(created);
        }

        case "discussion.read": {
          const item = find(params.discussion_id);
          if (!item) throw new Error("no such discussion");
          if (!item.member_ids.includes(1))
            throw new Error("You do not belong to this Discussion");
          return {
            id: item.id,
            topic: item.topic,
            members: item.member_ids.map((id) => ({
              id,
              name: members.find((m) => m.id === id)?.name ?? String(id),
            })),
            total_messages: item.messages.length,
            read_through: item.read_through,
            awaiting_ack: mentionsOf(item, 1),
            acknowledged: [...item.acked],
            messages: item.messages,
          };
        }

        case "discussion.send": {
          const item = find(params.discussion_id);
          if (!item) throw new Error("no such discussion");
          const id = item.messages.length + 1;
          item.messages.push({
            id,
            sender_id: 1,
            sender_name: "You",
            body: String(params.body),
            created_at: new Date().toISOString(),
          });
          item.read_through = id;
          return { id };
        }

        case "discussion.ack": {
          const item = find(params.discussion_id);
          const ids = (params.message_ids as number[]) ?? [];
          if (item) item.acked.push(...ids);
          return { acked: ids.length };
        }

        case "discussion.revoke_ack": {
          const item = find(params.discussion_id);
          const ids = (params.message_ids as number[]) ?? [];
          if (item) item.acked = item.acked.filter((id) => !ids.includes(id));
          return { revoked: ids.length };
        }

        case "discussion.set_members": {
          const item = find(params.discussion_id);
          if (item) item.member_ids = (params.member_ids as number[]) ?? [];
          return item ? summary(item) : null;
        }

        case "discussion.archive": {
          const item = find(params.discussion_id);
          if (item) item.archived = Boolean(params.archived);
          return { id: item?.id ?? 0 };
        }

        case "discussion.delete": {
          const id = Number(params.discussion_id);
          const index = discussions.findIndex((item) => item.id === id);
          if (index >= 0) discussions.splice(index, 1);
          return { id };
        }

        case "discussion.search": {
          const needle = String(params.query).toLowerCase();
          return discussions.flatMap((item) =>
            item.messages
              .filter((message) => message.body.toLowerCase().includes(needle))
              .map((message) => ({
                discussion_id: item.id,
                id: message.id,
                sender_name: message.sender_name,
                body: message.body,
              })),
          );
        }

        case "agent.detail": {
          const id = Number(params.agent_id);
          const detail = detailFor(id);
          const limit = Number(settings.limits.agent_token_limit) || 0;
          return {
            id,
            todos: detail.todos,
            memory: detail.memory,
            usage: detail.usage,
            token_limit: limit,
            over_token_limit: limit > 0 && detail.usage.total_tokens >= limit,
            idle_streak: detail.idle_streak,
            runs: detail.runs,
          };
        }

        case "library.list":
          return [...library.entries()].map(([path, content]) => ({
            path,
            size: content.length,
            hash: `h${content.length}`,
          }));

        case "library.read": {
          const path = String(params.path);
          const content = library.get(path) ?? "";
          return { path, content, hash: `h${content.length}` };
        }

        case "library.write": {
          const path = String(params.path);
          const existing = library.get(path);
          const expected = params.expected_hash as string | undefined;
          if (
            existing !== undefined &&
            expected !== undefined &&
            expected !== `h${existing.length}`
          ) {
            return {
              path,
              size: existing.length,
              hash: `h${existing.length}`,
              conflict: true,
            };
          }
          const content = String(params.content ?? "");
          library.set(path, content);
          return { path, size: content.length, hash: `h${content.length}` };
        }

        case "library.delete": {
          const path = String(params.path);
          library.delete(path);
          return { path };
        }

        case "library.move": {
          const from = String(params.path);
          const to = String(params.destination);
          const content = library.get(from) ?? "";
          library.delete(from);
          library.set(to, content);
          return { path: to, size: content.length, hash: `h${content.length}` };
        }

        case "settings.get":
          return settings[String(params.section)] ?? {};

        case "settings.update": {
          const section = String(params.section);
          const values = params.values as Record<string, unknown>;
          if (
            section === "execution" &&
            Object.keys(values).some(
              (key) => !["environment", "write_directories"].includes(key),
            )
          ) {
            throw new Error("Unknown execution setting");
          }
          if (
            section === "model" &&
            "compaction_threshold" in values &&
            (typeof values.compaction_threshold !== "number" ||
              !Number.isInteger(values.compaction_threshold) ||
              values.compaction_threshold <= 0)
          ) {
            throw new Error(
              "Compaction threshold must be a positive integer in bytes",
            );
          }
          if (section === "model" && typeof values.api_key === "string") {
            const { api_key, ...rest } = values;
            settings.model = {
              ...settings.model,
              ...rest,
              api_key_set: api_key.length > 0,
            };
            return settings.model;
          }
          if (section === "observability") {
            const redacted = { ...values };
            delete redacted.public_key;
            delete redacted.secret_key;
            settings[section] = {
              ...settings[section],
              ...redacted,
              keys_set:
                typeof values.secret_key === "string"
                  ? values.secret_key.length > 0
                  : settings[section]?.keys_set === true,
            };
            return settings[section];
          }
          settings[section] = { ...settings[section], ...values };
          return settings[section];
        }

        default:
          throw new Error(`mock backend does not implement ${method}`);
      }
    }
  }

  return new MockBackend();
}
