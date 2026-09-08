import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Backend } from "../../lib/backend";
import { createMockBackend } from "../../lib/mock";
import { LangfusePage, langfuseUpdate } from "./langfuse";

const stored = {
  enabled: true,
  base_url: " https://example.invalid/ ",
  keys_set: true,
  environment: "development",
};

describe("Langfuse settings", () => {
  it("omits blank credentials and response-only fields", () => {
    expect(langfuseUpdate(stored, "  ", "")).toEqual({
      enabled: true,
      base_url: "https://example.invalid/",
    });
  });

  it("only replaces credentials that were entered", () => {
    expect(langfuseUpdate(stored, " test-public ", " test-secret ")).toEqual({
      enabled: true,
      base_url: "https://example.invalid/",
      public_key: "test-public",
      secret_key: "test-secret",
    });
    expect(langfuseUpdate(stored, "", "replacement")).not.toHaveProperty(
      "public_key",
    );
  });

  it("renders labelled password fields and disables saving before load", () => {
    const html = renderToStaticMarkup(<LangfusePage />);
    expect(html).toContain("Public key");
    expect(html).toContain("Secret key");
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html).toContain('<fieldset class="settings-form" disabled="">');
    expect(html).toContain('type="submit"');
  });

  it("keeps mock responses redacted across updates without credentials", async () => {
    const backend = createMockBackend(Backend);
    const result = await backend.updateSettings(
      "observability",
      langfuseUpdate(stored, "test-public", "test-secret"),
    );
    expect(result.keys_set).toBe(true);
    expect(result).not.toHaveProperty("public_key");
    expect(result).not.toHaveProperty("secret_key");
    await backend.updateSettings("observability", { enabled: false });
    const reloaded = await backend.settings("observability");
    expect(reloaded.keys_set).toBe(true);
    expect(reloaded.enabled).toBe(false);
    expect(reloaded).not.toHaveProperty("public_key");
    expect(reloaded).not.toHaveProperty("secret_key");
  });
});
