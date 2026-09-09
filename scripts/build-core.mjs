import { spawnSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./process.mjs";

const core = resolve(root, "core");
const bundled = resolve(root, "app", "core");
const dist = resolve(core, "dist");
const work = resolve(core, "build");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

const extension = process.platform === "win32" ? ".exe" : "";

run("uv", [
  "run",
  "--project",
  core,
  "python",
  "-m",
  "huddol.adapters.execution.bundle",
  resolve(root, "artifacts", "execution.pyz"),
]);

run(
  "uv",
  [
    "run",
    "--project",
    core,
    "python",
    "-m",
    "PyInstaller",
    "--noconfirm",
    "--clean",
    "--distpath",
    dist,
    "--workpath",
    work,
    resolve(core, "huddol.spec"),
  ],
  { cwd: core },
);

rmSync(bundled, { force: true, recursive: true });
cpSync(resolve(dist, "huddol"), bundled, { recursive: true });

const executable = resolve(bundled, `huddol${extension}`);
process.stdout.write(`${executable}\n`);
