import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  directoryDraft,
  ExecutionForm,
  type ExecutionSettings,
  executionChanged,
  executionUpdate,
} from "@/features/settings/execution";

const initial: ExecutionSettings = {
  write_directories: ["/work"],
  unusable_write_directories: [],
  error: null,
};

describe("Execution settings", () => {
  it("reads the draft of the writable directories", () => {
    expect(directoryDraft(initial)).toBe("/work");
    expect(directoryDraft({ ...initial, write_directories: [] })).toBe("");
  });

  it("marks a change of the draft or a kernel error", () => {
    expect(executionChanged(initial, "/work")).toBe(false);
    expect(executionChanged(initial, "/work\n/tmp")).toBe(true);
    expect(
      executionChanged(
        { ...initial, error: "Execution environment is unavailable" },
        "/work",
      ),
    ).toBe(true);
  });

  it("saves the directories without App startup fields", () => {
    expect(executionUpdate("/work\n/work\n/home/you/中文\n")).toEqual({
      write_directories: ["/work", "/home/you/中文"],
    });
    expect(executionUpdate("")).toEqual({ write_directories: [] });
  });

  it("edits the file policy without an environment choice", () => {
    const html = renderToStaticMarkup(
      <ExecutionForm initial={initial} onSave={async () => initial} />,
    );
    expect(html).toContain("Writable directories");
    expect(html).toMatch(/<textarea[^>]*>\/work<\/textarea>/);
    expect(html).not.toContain("Execution environment");
    expect(html).not.toContain("Next start");
  });

  it("shows an unavailable execution with its diagnostics", () => {
    const failed: ExecutionSettings = {
      ...initial,
      write_directories: [],
      error: "Execution environment is unavailable",
      unusable_write_directories: [
        { path: "/missing", reason: "invalid_directory" },
      ],
    };
    const html = renderToStaticMarkup(
      <ExecutionForm initial={failed} onSave={async () => failed} />,
    );
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).toContain("Execution environment is unavailable");
    expect(html).toContain("/missing");
    expect(html).toContain("invalid_directory");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(html).toContain(">Unavailable</span>");
    expect(html).toContain(">invalid_directory</span>");
  });

  it("shows no fact list for a healthy execution", () => {
    const html = renderToStaticMarkup(
      <ExecutionForm initial={initial} onSave={async () => initial} />,
    );
    expect(html).not.toMatch(/<ul\b/);
    expect(html).not.toContain("Restart Huddol");
  });
});
