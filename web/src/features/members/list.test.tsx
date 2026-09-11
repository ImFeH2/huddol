import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemberRow, memberActions } from "@/features/members/list";
import { agentStateLabel } from "@/features/members/state";
import type { Member } from "@/lib/backend";

const noop = { toggle: () => {}, rename: () => {}, remove: () => {} };

const human: Member = { id: 1, name: "You", type: "human", state: "idle" };

function agent(state: Member["state"]): Member {
  return { id: 2, name: "Helper", type: "agent", state, tokens: 1200 };
}

function render(member: Member, tokenLimit = 0) {
  return renderToStaticMarkup(
    <table>
      <tbody>
        <MemberRow
          member={member}
          tokenLimit={tokenLimit}
          onOpen={() => {}}
          onToggle={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
        />
      </tbody>
    </table>,
  );
}

describe("member actions", () => {
  it("gives an idle agent pause, rename and delete", () => {
    expect(
      memberActions(agent("idle"), noop).map((action) => [
        action.label,
        action.disabled ?? false,
      ]),
    ).toEqual([
      ["Pause", false],
      ["Rename", false],
      ["Delete", false],
    ]);
  });

  it("offers resume once paused", () => {
    expect(memberActions(agent("paused"), noop)[0].label).toBe("Resume");
  });

  it("disables delete while the agent runs", () => {
    const actions = memberActions(agent("running"), noop);
    expect(actions.find((action) => action.id === "delete")?.disabled).toBe(
      true,
    );
    expect(actions.find((action) => action.id === "toggle")?.label).toBe(
      "Pause",
    );
  });

  it("gives a human rename only", () => {
    expect(memberActions(human, noop).map((action) => action.label)).toEqual([
      "Rename",
    ]);
  });
});

describe("member row", () => {
  it("links an agent to its page by name alone", () => {
    const html = render(agent("idle"));
    expect(html).toContain('class="row-link"');
    expect(html).toContain('<span class="row-primary">Helper</span>');
    expect(html).not.toContain("row-secondary");
  });

  it("shows a human as plain text", () => {
    const html = render(human);
    expect(html).not.toContain("row-link");
    expect(html).toContain('<span class="member-name">You</span>');
  });

  it("reports the ceiling in the State column", () => {
    expect(render(agent("idle"), 1000)).toContain("At ceiling");
    expect(render(agent("idle"), 2000)).toContain("Idle");
  });
});

describe("agentStateLabel", () => {
  it("prefers the live state over the ceiling", () => {
    expect(agentStateLabel(agent("running"), 1000)).toBe("Running");
    expect(agentStateLabel(agent("paused"), 1000)).toBe("Paused");
  });

  it("reports the ceiling only when a limit is set and reached", () => {
    expect(agentStateLabel(agent("idle"), 1200)).toBe("At ceiling");
    expect(agentStateLabel(agent("idle"), 1201)).toBe("Idle");
    expect(agentStateLabel(agent("idle"), 0)).toBe("Idle");
  });
});
