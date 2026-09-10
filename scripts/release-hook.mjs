import { run } from "./process.mjs";

if (process.env.DRY_RUN === "false") {
  run("uv", ["lock", "--project", "core"]);
} else if (process.env.DRY_RUN !== "true") {
  throw new Error("This hook must be run by cargo release.");
}
