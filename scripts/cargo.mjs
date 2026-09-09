import { binary, run } from "./process.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Expected a Cargo command");
}

// Clearing the bundled resources lets cargo check and clippy run before the
// core has been packaged.
await run(binary("cargo"), args, {
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ bundle: { resources: [] } }),
  },
});
