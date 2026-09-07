import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ExecutionForm,
  type ExecutionSettings,
  executionUpdate,
} from "./execution";

const initial: ExecutionSettings = {
  environment: { kind: "native" },
  write_directories: ["/work"],
  distributions: ["Debian"],
  error: null,
  probe_error: null,
  unusable_write_directories: [],
};

describe("Execution settings", () => {
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
    expect(html).toContain("/work");
    expect(html).not.toContain("Next start");
  });

  it("shows an unavailable selected environment without switching the draft to Native", () => {
    const failed: ExecutionSettings = {
      ...initial,
      environment: { kind: "wsl", distribution: "Missing" },
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
    expect(html).toContain("WSL is unavailable");
    expect(html).toContain("WSL command failed");
    expect(html).toContain("/missing");
    expect(html).toContain("invalid_directory");
  });
});
