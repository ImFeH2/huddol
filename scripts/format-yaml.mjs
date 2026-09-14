import { execFileSync } from "node:child_process";
import { root, run } from "./process.mjs";

const files = execFileSync(
  "git",
  [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "*.yml",
    "*.yaml",
    ":!:pnpm-lock.yaml",
  ],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);

run(process.execPath, [
  "node_modules/prettier/bin/prettier.cjs",
  ...process.argv.slice(2),
  ...files,
]);
