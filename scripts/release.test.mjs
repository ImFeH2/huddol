import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { binary, root } from "./process.mjs";

test("cargo-release synchronizes versions and stops before commit on failed checks", () => {
  const temporary = mkdtempSync(join(tmpdir(), "huddol-release-"));
  const repository = join(temporary, "repository");
  const remote = join(temporary, "remote.git");
  const key = join(temporary, "signing-key");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(temporary, "gitconfig"),
    CARGO_NET_OFFLINE: "true",
    UV_OFFLINE: "true",
    UV_PYTHON_DOWNLOADS: "never",
    LEFTHOOK: "0",
  };
  const read = (path) => readFileSync(join(repository, path), "utf8");
  const write = (path, value) => {
    const target = join(repository, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  };
  const invoke = (command, args, options = {}) =>
    spawnSync(command, args, {
      cwd: repository,
      env,
      encoding: "utf8",
      timeout: 20_000,
      ...options,
    });
  const run = (command, args, options) => {
    const result = invoke(command, args, options);
    assert.equal(
      result.status,
      0,
      `${command} ${args.join(" ")}\n${result.error ?? ""}${result.stdout}${result.stderr}`,
    );
    return result.stdout.trim();
  };
  const git = (...args) => run("git", args);
  const release = (version, ...args) =>
    run(binary("pnpm"), ["release", version, "--no-confirm", ...args]);
  try {
    writeFileSync(env.GIT_CONFIG_GLOBAL, "");
    write(".gitignore", "/target/\n/core/.venv/\n/node_modules/\n");
    for (const path of [
      "Cargo.toml",
      "release.toml",
      "scripts/process.mjs",
      "scripts/release-hook.mjs",
      "app/package.json",
      "app/tauri.conf.json",
      "web/package.json",
    ]) {
      write(path, readFileSync(join(root, path), "utf8"));
    }
    const manifest = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    );
    write(
      "package.json",
      `${JSON.stringify(
        {
          version: manifest.version,
          private: true,
          type: "module",
          packageManager: manifest.packageManager,
          scripts: {
            release: manifest.scripts.release,
            check: "node checks.mjs check",
            test: "node checks.mjs test",
          },
        },
        null,
        2,
      )}\n`,
    );
    for (const crate of ["app", "cli"]) {
      const metadata = readFileSync(
        join(root, crate, "Cargo.toml"),
        "utf8",
      ).match(/\[package\.metadata\.release\]\n[\s\S]*?(?=\n\[|$)/)[0];
      write(
        `${crate}/Cargo.toml`,
        `[package]\nname = "huddol-${crate}"\nversion.workspace = true\nedition = "2024"\n${metadata}\n`,
      );
      write(`${crate}/src/lib.rs`, "");
    }
    write(
      "core/pyproject.toml",
      `[project]\nname = "huddol"\nversion = "${manifest.version}"\nrequires-python = ">=3.13"\n`,
    );
    write(
      "checks.mjs",
      'import assert from "node:assert/strict";\n' +
        'import { appendFileSync } from "node:fs";\n' +
        'import { fileURLToPath } from "node:url";\n' +
        'assert.equal(process.cwd(), fileURLToPath(new URL(".", import.meta.url)).replace(/[\\\\/]$/, ""));\n' +
        'appendFileSync(".git/checks", process.argv[2] + "\\n");\n' +
        "if (process.env.RELEASE_TEST_FAIL === process.argv[2]) process.exit(1);\n",
    );
    run("git", ["init", "-b", "main"]);
    git("config", "user.name", "Release test");
    git("config", "user.email", "release@example.invalid");
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    git("config", "gpg.format", "ssh");
    git("config", "user.signingkey", key);
    const signers = join(temporary, "allowed-signers");
    writeFileSync(
      signers,
      `release@example.invalid ${readFileSync(`${key}.pub`, "utf8")}`,
    );
    git("config", "gpg.ssh.allowedSignersFile", signers);
    run(binary("cargo"), ["generate-lockfile", "--offline"]);
    run(binary("uv"), ["lock", "--project", "core"]);
    run(binary("pnpm"), ["install", "--offline"]);
    git("add", ".");
    git("commit", "-m", "chore: fixture");
    run("git", ["init", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "main");
    const major = Number(manifest.version.split(".")[0]) + 1;
    const files = git("ls-files").split("\n");
    const snapshot = () => files.map((path) => [path, read(path)]);
    for (const version of [`${major}.0.0`, `${major}.1.0`]) {
      const previous = git("rev-parse", "HEAD");
      const before = snapshot();
      const tags = git("tag");
      release(version);
      assert.deepEqual(snapshot(), before);
      assert.equal(git("rev-parse", "HEAD"), previous);
      assert.equal(git("tag"), tags);
      assert.equal(git("status", "--porcelain"), "");
      release(version, "--execute");
      assert.equal(git("rev-list", "--count", `${previous}..HEAD`), "1");
      assert.equal(
        git("log", "-1", "--format=%s"),
        `chore: release ${version}`,
      );
      git("verify-commit", "HEAD");
      assert.equal(
        git("rev-parse", `v${version}^{}`),
        git("rev-parse", "HEAD"),
      );
      git("verify-tag", `v${version}`);
      assert.equal(
        git(
          "for-each-ref",
          "--format=%(contents:subject)",
          `refs/tags/v${version}`,
        ),
        `chore: release ${version}`,
      );
      for (const path of [
        "package.json",
        "app/package.json",
        "web/package.json",
      ]) {
        assert.equal(JSON.parse(read(path)).version, version);
      }
      assert.ok(read("Cargo.toml").includes(`version = "${version}"`));
      assert.ok(read("core/pyproject.toml").includes(`version = "${version}"`));
      assert.ok(read("core/uv.lock").includes(`version = "${version}"`));
      for (const crate of ["app", "cli"]) {
        assert.ok(
          read("Cargo.lock").includes(
            `name = "huddol-${crate}"\nversion = "${version}"`,
          ),
        );
      }
      assert.equal(
        JSON.parse(read("app/tauri.conf.json")).version,
        "package.json",
      );
      assert.equal(git("status", "--porcelain"), "");
      assert.equal(
        run("git", ["--git-dir", remote, "rev-parse", `v${version}^{}`]),
        git("rev-parse", "HEAD"),
      );
      assert.equal(
        run("git", ["--git-dir", remote, "rev-parse", `v${version}`]),
        git("rev-parse", `v${version}`),
      );
    }
    assert.equal(read(".git/checks"), "check\ntest\n".repeat(2));
    for (const check of ["check", "test"]) {
      const head = git("rev-parse", "HEAD");
      const tags = git("tag");
      const result = invoke(
        binary("pnpm"),
        ["release", `${major}.2.0`, "--execute", "--no-confirm"],
        {
          env: { ...env, RELEASE_TEST_FAIL: check },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Version changes remain uncommitted/);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("tag"), tags);
      assert.ok(git("diff", "--name-only").includes("Cargo.toml"));
      git("restore", ".");
      assert.equal(git("status", "--porcelain"), "");
    }
    git("checkout", "-b", "not-main");
    const result = invoke(binary("pnpm"), [
      "release",
      `${major}.2.0`,
      "--execute",
      "--no-confirm",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /branch/);
    assert.equal(git("status", "--porcelain"), "");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
