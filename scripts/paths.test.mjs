import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { root } from "./process.mjs";

test("core packaging targets the desktop resources", async (t) => {
  const config = JSON.parse(
    fs.readFileSync(resolve(root, "app/tauri.conf.json"), "utf8"),
  );
  const bundled = resolve(root, "app", config.bundle.resources[0]);
  const calls = [];
  const copies = [];
  const removed = [];
  const remove = fs.rmSync;
  const temporaryDirectory = fs.mkdtempSync;
  let temporary;
  t.mock.method(fs, "mkdtempSync", (...args) => {
    temporary = temporaryDirectory(...args);
    return temporary;
  });
  t.mock.method(fs, "cpSync", (...args) => copies.push(args));
  t.mock.method(fs, "rmSync", (path, options) => {
    removed.push(path);
    if (path === temporary) remove(path, options);
  });
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout:
        '{"type":"ready","methods":["ping"]}\n' +
        '{"id":1,"result":{"pong":"huddol-smoke 中文 😀"}}\n' +
        '{"id":2,"result":{"stopped":true}}\n',
    };
  });
  syncBuiltinESMExports();
  try {
    await import("./build-core.mjs");
    assert.deepEqual(copies, [
      [resolve(root, "core/dist/huddol"), bundled, { recursive: true }],
    ]);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].command, "uv");
    assert.equal(calls[0].args[2], resolve(root, "core"));
    assert.equal(calls[1].command, "uv");
    assert.equal(calls[1].options.cwd, resolve(root, "core"));
    assert.equal(calls[1].args.at(-1), resolve(root, "core/huddol.spec"));
    const smoke = calls[2];
    assert.equal(
      smoke.command,
      resolve(bundled, process.platform === "win32" ? "huddol.exe" : "huddol"),
    );
    assert.equal(smoke.options.cwd, root);
    const data = smoke.options.env.HUDDOL_DATA_DIR;
    assert.deepEqual(removed, [bundled, data]);
    assert.equal(fs.existsSync(data), false);
  } finally {
    if (temporary) remove(temporary, { recursive: true, force: true });
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
