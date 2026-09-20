import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

export function executableName(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

export function venvExecutable(environment, name) {
  const scripts = process.platform === "win32" ? "Scripts" : "bin";
  return resolve(environment, scripts, executableName(name));
}

export function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
}
