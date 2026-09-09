import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { root } from "./process.mjs";

test("desktop scripts run Tauri from app", () => {
  const { scripts } = JSON.parse(
    fs.readFileSync(resolve(root, "package.json"), "utf8"),
  );
  for (const [entry, args] of [
    ["dev", "dev"],
    ["dev:release", "dev --release"],
    ["build:app", "build"],
  ]) {
    assert.equal(scripts[entry], `pnpm --dir app exec tauri ${args}`);
  }
});

test("cargo forwards arguments from the workspace root", async (t) => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const cwd = process.cwd();
  const calls = [];
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    calls.push({ command, args, options });
    return {
      once(event, listener) {
        if (event === "close") {
          queueMicrotask(() => listener(args[0] === "check" ? 0 : 23));
        }
      },
    };
  });
  syncBuiltinESMExports();
  try {
    process.chdir(resolve(root, "app"));
    for (const args of [
      ["check"],
      ["clippy", "--all-targets", "--", "-D", "warnings"],
      ["test", "--", "test name"],
    ]) {
      process.argv = [...argv.slice(0, 2), ...args];
      await import(`./cargo.mjs?command=${args[0]}`);
      const call = calls.at(-1);
      assert.equal(
        call.command,
        process.platform === "win32" ? "cargo.exe" : "cargo",
      );
      assert.deepEqual(call.args, args);
      assert.equal(call.options.cwd, root);
      assert.deepEqual(call.options.env, {
        ...process.env,
        TAURI_CONFIG: '{"bundle":{"resources":[]}}',
      });
      assert.equal(process.exitCode, args[0] === "check" ? exitCode : 23);
    }
    process.argv = argv.slice(0, 2);
    await assert.rejects(
      import("./cargo.mjs?empty"),
      /Expected a Cargo command/,
    );
    assert.equal(calls.length, 3);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    process.chdir(cwd);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

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
