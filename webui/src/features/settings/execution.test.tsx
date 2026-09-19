import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  directoryDrafts,
  ExecutionForm,
  type ExecutionSettings,
  environmentKey,
  executionChanged,
  executionUpdate,
} from "@/features/settings/execution";

const initial: ExecutionSettings = {
  environment: { kind: "native" },
  write_directories: ["/work"],
  directories: { native: ["/work"], "wsl:Debian": ["/home/you", "/srv"] },
  distributions: ["Debian"],
  error: null,
  probe_error: null,
  unusable_write_directories: [],
};

describe("Execution settings", () => {
  it("mirrors the kernel environment keys", () => {
    expect(environmentKey({ kind: "native" })).toBe("native");
    expect(environmentKey({ kind: "wsl", distribution: "Debian" })).toBe(
      "wsl:Debian",
    );
  });

  it("keeps one draft per environment key", () => {
    expect(directoryDrafts(initial.directories)).toEqual({
      native: "/work",
      "wsl:Debian": "/home/you\n/srv",
    });
    expect(directoryDrafts({})).toEqual({});
  });

  it("marks a change of environment, of the selected draft or a kernel error", () => {
    expect(executionChanged(initial, "native", "/work")).toBe(false);
    expect(executionChanged(initial, "native", "/work\n/tmp")).toBe(true);
    expect(executionChanged(initial, "wsl:Debian", "/home/you\n/srv")).toBe(
      true,
    );
    expect(
      executionChanged(
        { ...initial, error: "WSL is unavailable" },
        "native",
        "/work",
      ),
    ).toBe(true);
    expect(
      executionChanged(
        { ...initial, environment: { kind: "wsl", distribution: "Ubuntu" } },
        "wsl:Ubuntu",
        "",
      ),
    ).toBe(false);
  });

  it("saves environment and directories together without App startup fields", () => {
    expect(
      executionUpdate("wsl:Debian", "/work\n/work\n/home/you/中文\n"),
    ).toEqual({
      environment: { kind: "wsl", distribution: "Debian" },
      write_directories: ["/work", "/home/you/中文"],
    });
    expect(executionUpdate("native", "")).toEqual({
      environment: { kind: "native" },
      write_directories: [],
    });
    expect(() => executionUpdate("wsl:", "/work")).toThrow();
  });

  it("exposes named execution choices and the matching file policy", () => {
    const html = renderToStaticMarkup(
      <ExecutionForm initial={initial} onSave={async () => initial} />,
    );
    expect(html).toContain("Execution environment");
    expect(html).toContain("WSL · Debian");
    expect(html).toContain("Writable directories");
    expect(html).toMatch(/Writable directories <span[^>]*>Native<\/span>/);
    expect(html).toMatch(/<textarea[^>]*>\/work<\/textarea>/);
    expect(html).not.toContain("Next start");
  });

  it("labels the directories of the selected WSL environment", () => {
    const wsl: ExecutionSettings = {
      ...initial,
      environment: { kind: "wsl", distribution: "Debian" },
      write_directories: ["/home/you", "/srv"],
    };
    const html = renderToStaticMarkup(
      <ExecutionForm initial={wsl} onSave={async () => wsl} />,
    );
    expect(html).toMatch(
      /Writable directories <span[^>]*>WSL · Debian<\/span>/,
    );
    expect(html).toMatch(/<textarea[^>]*>\/home\/you\n\/srv<\/textarea>/);
    expect(html).not.toMatch(/<textarea[^>]*>\/work<\/textarea>/);
  });

  it("shows an unavailable selected environment without switching the draft to Native", () => {
    const failed: ExecutionSettings = {
      ...initial,
      environment: { kind: "wsl", distribution: "Missing" },
      write_directories: [],
      distributions: [],
      error: "WSL is unavailable",
      probe_error: "WSL command failed",
      unusable_write_directories: [
        { path: "/missing", reason: "invalid_directory" },
      ],
    };
    const html = renderToStaticMarkup(
      <ExecutionForm initial={failed} onSave={async () => failed} />,
    );
    expect(html).toContain("WSL · Missing");
    expect(html).toMatch(
      /Writable directories <span[^>]*>WSL · Missing<\/span>/,
    );
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).toContain("WSL is unavailable");
    expect(html).toContain("WSL command failed");
    expect(html).toContain("/missing");
    expect(html).toContain("invalid_directory");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
    expect(html).toContain(">Unavailable</span>");
    expect(html).toContain(">Probe failed</span>");
    expect(html).toContain(">invalid_directory</span>");
  });

  it("shows no fact list for a healthy environment", () => {
    const html = renderToStaticMarkup(
      <ExecutionForm initial={initial} onSave={async () => initial} />,
    );
    expect(html).not.toMatch(/<ul\b/);
    expect(html).not.toContain("Restart Huddol");
  });
});
