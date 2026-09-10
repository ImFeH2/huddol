import { run } from "./process.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error("Expected a Cargo command");
}

run("cargo", args, {
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ bundle: { resources: [] } }),
  },
});
