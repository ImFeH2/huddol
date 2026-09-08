import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { Member } from "../lib/backend";
import {
  candidatesFor,
  completeMention,
  highlightMentions,
  matchMembers,
  mentionQuery,
} from "./mentions";

const members: Member[] = [
  { id: 1, type: "human", name: "You", state: "idle" },
  { id: 2, type: "agent", name: "Main", state: "idle" },
  { id: 3, type: "agent", name: "Mainframe", state: "idle" },
  { id: 4, type: "agent", name: "Data Team", state: "idle" },
];

describe("mentionQuery", () => {
  it("finds the mention the caret is sitting in", () => {
    expect(mentionQuery("hello @Ma", 9)).toEqual({ start: 6, query: "Ma" });
  });

  it("treats an empty mention as a query so the full list shows", () => {
    expect(mentionQuery("hello @", 7)).toEqual({ start: 6, query: "" });
  });

  it("ignores an at sign glued to the end of a word", () => {
    expect(mentionQuery("mail@Ma", 7)).toBeNull();
  });

  it("does not reach across a line break", () => {
    expect(mentionQuery("@Main\nlater", 11)).toBeNull();
  });

  it("does not reach past an earlier mention", () => {
    expect(mentionQuery("@Main @Da", 9)).toEqual({ start: 6, query: "Da" });
  });

  it("gives up once the query is longer than any name may be", () => {
    const long = `@${"x".repeat(80)}`;
    expect(mentionQuery(long, long.length)).toBeNull();
  });
});

describe("matchMembers", () => {
  it("matches case insensitively and puts the shortest name first", () => {
    expect(matchMembers(members, "ma").map((m) => m.name)).toEqual([
      "Main",
      "Mainframe",
    ]);
  });

  it("matches names containing a space", () => {
    expect(matchMembers(members, "data t").map((m) => m.name)).toEqual([
      "Data Team",
    ]);
  });

  it("returns everyone for an empty query", () => {
    expect(matchMembers(members, "")).toHaveLength(4);
  });

  it("returns nothing when no name starts with the query", () => {
    expect(matchMembers(members, "zzz")).toEqual([]);
  });
});

describe("completeMention", () => {
  it("replaces the partial mention and leaves the caret after it", () => {
    const text = "hello @Ma there";
    const mention = mentionQuery(text, 9);
    if (!mention) throw new Error("expected a mention");
    const result = completeMention(text, mention, 9, "Mainframe");
    expect(result.text).toBe("hello @Mainframe  there");
    expect(result.caret).toBe(17);
  });

  it("completes a name that contains a space", () => {
    const text = "@Data t";
    const mention = mentionQuery(text, 7);
    if (!mention) throw new Error("expected a mention");
    const result = completeMention(text, mention, 7, "Data Team");
    expect(result.text).toBe("@Data Team ");
  });
});

describe("mentionQuery boundaries", () => {
  it("returns nothing when the caret sits at the very start", () => {
    expect(mentionQuery("@Main", 0)).toBeNull();
  });

  it("does not fabricate a query from a clamped index", () => {
    expect(mentionQuery("@", 0)).toBeNull();
  });
});

describe("candidatesFor", () => {
  const here = new Set([1, 2]);

  it("a bare mention offers only the people who can be notified", () => {
    const groups = candidatesFor(members, here, "");
    expect(groups.inDiscussion.map((m) => m.name)).toEqual(["You", "Main"]);
    expect(groups.elsewhere).toEqual([]);
  });

  it("a keyword searches the whole organization", () => {
    const groups = candidatesFor(members, here, "ma");
    expect(groups.inDiscussion.map((m) => m.name)).toEqual(["Main"]);
    expect(groups.elsewhere.map((m) => m.name)).toEqual(["Mainframe"]);
  });

  it("keeps discussion members ahead of everyone else", () => {
    const groups = candidatesFor(members, here, "");
    expect(groups.inDiscussion.length).toBeGreaterThan(0);
    expect(groups.elsewhere.length).toBe(0);
  });

  it("finds nobody when the keyword matches no one", () => {
    const groups = candidatesFor(members, here, "zzz");
    expect(groups.inDiscussion).toEqual([]);
    expect(groups.elsewhere).toEqual([]);
  });
});

describe("highlightMentions", () => {
  function kinds(body: string, notifiable?: Set<number>) {
    return highlightMentions(body, members, notifiable)
      .filter((node) => isValidElement(node))
      .map((node) => {
        const element = node as ReactElement<{ className?: string }>;
        return element.props.className ?? String(element.type);
      });
  }

  it("marks a mention that reaches someone in the discussion", () => {
    expect(kinds("hi @Main", new Set([2]))).toEqual(["mark"]);
  });

  it("renders a mention of someone outside the discussion as a reference", () => {
    expect(kinds("about @Mainframe", new Set([2]))).toEqual([
      "mention-reference",
    ]);
  });

  it("distinguishes the two inside one message", () => {
    expect(kinds("@Main please review @Mainframe work", new Set([2]))).toEqual([
      "mark",
      "mention-reference",
    ]);
  });

  it("treats every match as reaching when no membership is given", () => {
    expect(kinds("@Main and @Mainframe")).toEqual(["mark", "mark"]);
  });
});
