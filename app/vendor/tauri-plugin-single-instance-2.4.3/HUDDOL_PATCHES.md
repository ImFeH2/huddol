# Huddol single-instance vendor fork

## Provenance

- Upstream crate: `tauri-plugin-single-instance 2.4.3`
- Official tag: `single-instance-v2.4.3`
- Source commit: `cad301fcc1f3ebad1eaef552c886b0bc8580c3fe`
- Published archive size: `92467` bytes
- SHA-256: `b3214becf9ef5783c0ae99a3bb25adf5353a7a16ebf53e74b909e29205735c6c`
- Upstream declared MSRV: Rust `1.77.2`
- Huddol fork `rust-version`: Rust `1.85`
- License: Apache-2.0 OR MIT

`upstream/tauri-plugin-single-instance-2.4.3.crate` and `upstream/source/` are unmodified release inputs. `crate/` is the only build input. `patches/` can reproduce every Huddol change from `upstream/source/`.

## Patches

- `windows.patch`: adds a named receiver-ready event, bounded receiver and notification waits, fail-closed ownership and IPC errors, complete secondary handle cleanup, JSON argv/cwd transport, and `AllowSetForegroundWindow(primary_pid)` before `WM_COPYDATA`.
- `linux.patch`: removes ownership-path unwrap and silent fallthrough, propagates D-Bus ownership and serve failures, and requires successful notification before secondary exit.
- `macos.patch`: raises the fork rust-version to 1.85, separates OS-released advisory ownership from socket IPC, binds the receiver synchronously, permits stale socket cleanup only after ownership, and makes bind and notification failures fail closed.

The application ignores secondary argv and cwd. They remain in the plugin callback API only for compatibility.

## Verification

Recalculate the archive with `sha256sum -c upstream/SHA256SUMS`. To reproduce `crate/`, copy `upstream/source/` and apply the three patch files with `patch -p1` in order. The build must resolve the plugin only through the local Cargo path and must not contain a registry or git source for this package.

Windows verification must cover cold-start concurrency, bounded secondary exit, exact process counts, graceful and forced stale release, foreground recovery, and absence of `SendInput` or `keybd_event` in the fork. Linux verification must cover D-Bus ownership, notification, stale release, and process counts. macOS build and runtime verification remains required before a macOS release.

## Removal condition

Delete this vendor directory and replace the path dependency with an exact stable upstream release only after that release independently proves race-safe ownership, fail-closed IPC on all desktop platforms, and Windows foreground permission handoff without synthetic input.
