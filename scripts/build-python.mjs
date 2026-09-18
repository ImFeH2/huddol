import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { root, run } from "./process.mjs";

const packages = resolve(root, "dist", "python");
const frontend = resolve(root, "web", "dist");
const static_ = resolve(root, "web", "huddol_web", "static");

run("pnpm", ["build:web"]);

rmSync(static_, { force: true, recursive: true });
mkdirSync(static_, { recursive: true });
cpSync(frontend, static_, { recursive: true });

run("uv", ["build", "--project", "core", "--out-dir", packages]);
run("uv", ["build", "--project", "web", "--out-dir", packages]);
