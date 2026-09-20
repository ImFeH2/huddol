import { cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { executableName, root, run } from "./process.mjs";

const core = resolve(root, "core");
const bundled = resolve(root, "app", "core");
const dist = resolve(core, "dist");
const work = resolve(core, "build");

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

const executable = resolve(bundled, executableName("huddol"));
process.stdout.write(`${executable}\n`);
