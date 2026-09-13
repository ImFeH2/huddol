import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentForm, AgentPanel, agentUpdate } from "@/features/settings/agent";

const drafts = {
  context_window_tokens: "200000",
  memory_index_bytes: "16384",
  exchange_nudge_after: "6",
  idle_streak_after: "3",
  max_concurrent_turns: "4",
  token_limit: "0",
};

function renderForm(values = drafts) {
  return renderToStaticMarkup(
    <AgentForm drafts={values} onChange={() => {}} onSave={() => {}} />,
  );
}

describe("Agent settings", () => {
  it("sends all six values as integers", () => {
    expect(agentUpdate(drafts)).toEqual({
      context_window_tokens: 200000,
      memory_index_bytes: 16384,
      exchange_nudge_after: 6,
      idle_streak_after: 3,
      max_concurrent_turns: 4,
      token_limit: 0,
    });
    expect(
      agentUpdate({ ...drafts, token_limit: " 250000 " })?.token_limit,
    ).toBe(250000);
  });

  it.each(Object.keys(drafts).filter((key) => key !== "token_limit"))(
    "requires a positive %s",
    (key) => {
      expect(agentUpdate({ ...drafts, [key]: "0" })).toBeNull();
      expect(agentUpdate({ ...drafts, [key]: " 1 " })?.[key]).toBe(1);
    },
  );

  it.each(["", " ", "-1", "1.5", "1e3", "abc", "Infinity", "9007199254740992"])(
    "rejects invalid draft %s in every field",
    (draft) => {
      for (const key of Object.keys(drafts)) {
        expect(agentUpdate({ ...drafts, [key]: draft })).toBeNull();
      }
    },
  );

  it("rejects missing and unknown keys", () => {
    expect(agentUpdate({})).toBeNull();
    expect(agentUpdate({ ...drafts, extra: "1" })).toBeNull();
    const { token_limit, ...incomplete } = drafts;
    expect(
      agentUpdate({ ...incomplete, agent_token_limit: token_limit }),
    ).toBeNull();
  });

  it("renders the returned defaults, numeric bounds and one Save", () => {
    const html = renderForm();
    for (const label of [
      "Context window (tokens)",
      "MEMORY.md in context (bytes)",
      "Nudge after (messages)",
      "Idle after (Turns)",
      "Concurrent Turns",
      "Tokens per Agent",
    ])
      expect(html).toContain(label);
    for (const value of Object.values(drafts))
      expect(html).toContain(`value="${value}"`);
    expect(html.match(/type="number"/g)).toHaveLength(6);
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(6);
    expect(html.match(/min="1"/g)).toHaveLength(5);
    expect(html.match(/min="0"/g)).toHaveLength(1);
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain("0 means no ceiling.");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('aria-invalid="true"');
  });

  it("marks only the invalid field and disables Save", () => {
    const html = renderForm({ ...drafts, memory_index_bytes: "1.5" });
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      /<input[^>]*id="[^"]*-memory_index_bytes"[^>]*aria-invalid="true"/,
    );
    expect(html).toMatch(/<button(?=[^>]*type="submit")[^>]*disabled=""/);
    expect(html).not.toContain("Enter a");
  });

  it("does not invent defaults before loading", () => {
    const html = renderToStaticMarkup(<AgentPanel />);
    expect(html).toMatch(
      /<fieldset[^>]*aria-label="Agent settings"[^>]*disabled=""/,
    );
    expect(html.match(/value=""/g)).toHaveLength(6);
    expect(html).not.toContain('value="0"');
  });
});
