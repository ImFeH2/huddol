import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
const smokeData = mkdtempSync(join(tmpdir(), "huddol-smoke-"));
let smoke;
try {
  smoke = spawnSync(executable, [], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HUDDOL_DATA_DIR: smokeData },
    input:
      '{"id":1,"method":"ping","params":{"token":"huddol-smoke 中文 😀"}}\n' +
      '{"id":2,"method":"system.shutdown","params":{}}\n',
    timeout: 15_000,
  });
} finally {
  rmSync(smokeData, { force: true, recursive: true });
}
if (smoke.error || smoke.status !== 0) {
  throw (
    smoke.error ?? new Error(`Huddol smoke exited with status ${smoke.status}`)
  );
}
const frames = smoke.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const ready = frames.find((frame) => frame.type === "ready");
const pong = frames.find((frame) => frame.id === 1);
const stopped = frames.find((frame) => frame.id === 2);

// The packaged binary only has to prove three things: it finished starting up,
// it answers over the pipe, and it stops cleanly. Domain behaviour is covered by
// the process level tests, so this stays independent of the business API.
if (
  !ready ||
  !Array.isArray(ready.methods) ||
  ready.methods.length === 0 ||
  pong?.result?.pong !== "huddol-smoke 中文 😀" ||
  stopped?.result?.stopped !== true
) {
  throw new Error("Huddol smoke returned an invalid response");
}

process.stdout.write(`${executable}\n`);
