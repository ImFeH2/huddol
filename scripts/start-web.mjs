import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { root, run, venvExecutable } from "./process.mjs";

const packages = resolve(root, "dist", "python");
const environment = resolve(root, "dist", "web-environment");

run("pnpm", ["build:python"]);

const wheels = readdirSync(packages)
  .filter((name) => name.endsWith(".whl"))
  .map((name) => resolve(packages, name));

run("uv", ["venv", "--allow-existing", "--python", "3.13", environment]);
run("uv", [
  "pip",
  "install",
  "--python",
  venvExecutable(environment, "python"),
  "--reinstall",
  ...wheels,
]);
run(venvExecutable(environment, "huddol-web"), process.argv.slice(2));
