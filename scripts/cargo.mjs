import { resolve } from "node:path";
import { binary, root, run } from "./process.mjs";

const manifest = resolve(root, "Cargo.toml");
const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Expected a Cargo command");
}

const separator = args.indexOf("--");
const withManifest =
  separator === -1
    ? [...args, "--manifest-path", manifest]
    : [
        ...args.slice(0, separator),
        "--manifest-path",
        manifest,
        ...args.slice(separator),
      ];

// Clearing the bundled resources lets cargo check and clippy run before the
// core has been packaged.
await run(binary("cargo"), withManifest, {
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ bundle: { resources: [] } }),
  },
});
