import { binary, run } from "./process.mjs";

if (process.env.DRY_RUN === "true") {
  console.log("Dry run: skipping lock updates and release checks.");
} else if (process.env.DRY_RUN === "false") {
  for (const [command, args] of [
    [binary("uv"), ["lock", "--project", "core"]],
    [binary("pnpm"), ["check"]],
    [binary("pnpm"), ["test"]],
  ]) {
    if ((await run(command, args)) !== 0) {
      console.error(
        "Release checks failed. Version changes remain uncommitted; inspect git diff before retrying.",
      );
      break;
    }
  }
} else {
  throw new Error("This hook must be run by cargo release.");
}
