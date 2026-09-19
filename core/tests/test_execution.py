from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from huddol.adapters.execution.local import LocalExecution, entrypoint
from huddol.adapters.execution.manager import ExecutionManager
from huddol.core.errors import DomainError


@pytest.fixture(autouse=True)
def isolated_business_data(tmp_path: Path, monkeypatch):
    directory = tmp_path / "unexpected-business-startup"
    monkeypatch.setenv("HUDDOL_DATA_DIR", str(directory))
    yield
    assert not directory.exists()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_execution_session_keeps_the_existing_process_view(tmp_path: Path) -> None:
    import os

    environment = LocalExecution()
    try:
        code = f"import os; from pathlib import Path; assert os.getsid(0)!={os.getsid(0)}; assert Path('/proc/{os.getpid()}/cmdline').exists()"
        result = environment.run([sys.executable, "-c", code], cwd=str(tmp_path))
        assert result.exit_code == 0, result.stderr
    finally:
        environment.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_timeout_does_not_leave_a_linux_descendant_writing_later(
    tmp_path: Path,
) -> None:
    environment = LocalExecution([str(tmp_path)])
    marker = tmp_path / "late"
    try:
        with pytest.raises(DomainError) as error:
            environment.run(
                ["sh", "-c", '(sleep 2; printf late > "$1") & wait', "sh", str(marker)],
                cwd=str(tmp_path),
                timeout=1,
            )
        assert error.value.code == "timeout"
        time.sleep(1.3)
        assert not marker.exists()
    finally:
        environment.close()


def test_existing_snapshot_resolves_current_directories(tmp_path: Path) -> None:
    manager = ExecutionManager(
        settings={"directories": {"native": [str(tmp_path)]}}, enforce=False
    )
    first = manager.snapshot()
    second = manager.snapshot()
    allowed = tmp_path / "allowed"
    replacement = tmp_path / "replacement"
    allowed.mkdir()
    replacement.mkdir()
    try:
        manager.configure({"write_directories": [str(allowed)]}, lambda values: None)
        assert first.write_directories == (str(allowed),)
        manager.configure(
            {"write_directories": [str(replacement)]}, lambda values: None
        )
        assert first.write_directories == (str(replacement),)
        assert second.write_directories == (str(replacement),)
        assert manager.status()["write_directories"] == [str(replacement)]
    finally:
        manager.close()


def test_failed_persistence_does_not_switch_execution_or_directories(
    tmp_path: Path,
) -> None:
    manager = ExecutionManager(
        settings={"directories": {"native": [str(tmp_path)]}}, enforce=False
    )
    bound = manager.snapshot()

    def fail(values):
        raise OSError("storage failure")

    with pytest.raises(OSError, match="storage failure"):
        manager.configure({"write_directories": []}, fail)
    assert bound.write_directories == (str(tmp_path),)
    assert manager.status()["write_directories"] == [str(tmp_path)]
    manager.close()


def test_execution_helpers_ignore_other_business_modules_on_pythonpath(
    tmp_path: Path, monkeypatch
) -> None:
    package = tmp_path / "other" / "huddol"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    marker = tmp_path / "wrong-business-entry"
    (package / "__main__.py").write_text(
        "from pathlib import Path\nPath("
        + repr(str(marker))
        + ").write_text('wrong')\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("PYTHONPATH", str(package.parent))
    target = tmp_path / "file.txt"
    target.write_text("before", encoding="utf-8")
    environment = LocalExecution([str(tmp_path)])
    try:
        environment.edit(str(target), "before", "after")
        result = environment.run(
            [sys.executable, "-c", "print('command-ok')"], cwd=str(tmp_path)
        )
        assert result.exit_code == 0 and "command-ok" in result.stdout
        assert target.read_text() == "after"
    finally:
        environment.close()
    reentered = subprocess.run(
        [*entrypoint(), "--windows-write-sandbox", "S-1-5-21-1-2-3", "--", "true"],
        capture_output=True,
        timeout=60,
        check=False,
    )
    assert not marker.exists()
    if sys.platform != "win32":
        assert reentered.returncode != 0
        assert b"unrecognized arguments" in reentered.stderr


def test_reconfiguration_reuses_the_same_execution_instance(tmp_path: Path) -> None:
    manager = ExecutionManager(
        settings={"directories": {"native": [str(tmp_path)]}}, enforce=False
    )
    original = manager._environment
    try:
        for directories in ([], [str(tmp_path)], []):
            manager.configure({"write_directories": directories}, lambda values: None)
            assert manager._environment is original
            assert manager.snapshot().write_directories == tuple(directories)
    finally:
        manager.close()


def test_changing_the_current_directories_leaves_other_stored_keys_alone(
    tmp_path: Path,
) -> None:
    native_directory = tmp_path / "native"
    replacement = tmp_path / "replacement"
    native_directory.mkdir()
    replacement.mkdir()
    manager = ExecutionManager(
        settings={
            "environment": {"kind": "native"},
            "directories": {
                "native": [str(native_directory)],
                "legacy": ["/mnt/c/elsewhere"],
            },
        },
        enforce=False,
    )
    try:
        status = manager.configure(
            {"write_directories": [str(replacement)]}, lambda values: None
        )
        assert status["environment"] == {"kind": "native"}
        assert status["write_directories"] == [str(replacement)]
        assert status["directories"] == {
            "native": [str(replacement)],
            "legacy": ["/mnt/c/elsewhere"],
        }
    finally:
        manager.close()


def test_execution_status_reports_configuration_and_diagnostics(tmp_path: Path) -> None:
    manager = ExecutionManager(
        settings={"directories": {"native": [str(tmp_path), "relative/bad"]}},
        enforce=False,
        tolerant=True,
    )
    try:
        status = manager.status()
        assert set(status) == {
            "environment",
            "write_directories",
            "directories",
            "unusable_write_directories",
            "error",
        }
        assert status["environment"] == {"kind": "native"}
        assert "working_directory" not in status
        assert status["write_directories"] == [str(tmp_path), "relative/bad"]
        assert status["directories"] == {"native": [str(tmp_path), "relative/bad"]}
        assert status["unusable_write_directories"] == [
            {"path": "relative/bad", "reason": "invalid_directory"}
        ]
        assert status["error"] is None
    finally:
        manager.close()


def test_invalid_saved_environment_does_not_fall_back_to_native(tmp_path: Path) -> None:
    manager = ExecutionManager(settings={"environment": {"kind": "invalid"}})
    assert manager.status()["error"]
    with pytest.raises(DomainError):
        manager.snapshot().run(["echo", "should not run"], cwd=str(tmp_path))
    manager.configure({"environment": {"kind": "native"}}, lambda values: None)
    assert manager.status()["error"] is None
    manager.close()


@pytest.mark.skipif(
    not sys.platform.startswith("linux")
    or not Path("/mnt/c/Windows/System32/cmd.exe").exists(),
    reason="Windows host interop",
)
def test_linux_execution_preserves_windows_host_interop(tmp_path: Path) -> None:
    environment = LocalExecution()
    try:
        result = environment.run(
            ["/mnt/c/Windows/System32/cmd.exe", "/d", "/c", "echo", "interop-ok"],
            cwd=str(tmp_path),
        )
        assert result.exit_code == 0, result.stderr
        assert "interop-ok" in result.stdout
    finally:
        environment.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_local_run_override_replaces_roots_without_changing_configuration(
    tmp_path, monkeypatch
) -> None:
    configured = tmp_path / "configured"
    library = tmp_path / "library"
    configured.mkdir()
    library.mkdir()
    environment = LocalExecution([str(configured)])
    commands = []
    original = environment._wrap

    def wrap(argv, cwd, roots):
        command = original(argv, cwd, roots)
        commands.append(command)
        return command

    monkeypatch.setattr(environment, "_wrap", wrap)
    try:
        for override, expected in (
            ([str(library), str(library) + "/"], [str(library)]),
            ([], []),
            (None, [str(configured)]),
        ):
            result = environment.run(
                ["/bin/true"], cwd=str(tmp_path), write_directories=override
            )
            assert result.exit_code == 0, result.stderr
            command = commands[-1]
            assert [
                command[index + 1 : index + 3]
                for index, value in enumerate(command)
                if value == "--bind"
            ] == [[root, root] for root in expected]
            assert environment.write_directories == (str(configured),)
        denied = environment.run(
            ["sh", "-c", 'echo denied > "$1"', "sh", str(configured / "denied")],
            cwd=str(library),
            write_directories=[str(library)],
        )
        assert denied.exit_code != 0 and not (configured / "denied").exists()
    finally:
        environment.close()


@pytest.mark.parametrize("override", [None, [], "other"])
def test_local_edit_override_does_not_change_configuration(tmp_path, override) -> None:
    configured = tmp_path / "configured"
    other = tmp_path / "other"
    configured.mkdir()
    other.mkdir()
    for root in (configured, other):
        (root / "file.txt").write_text("before", encoding="utf-8")
    environment = LocalExecution([str(configured)])
    roots = [str(other)] if override == "other" else override
    try:
        for root in (configured, other):
            if (root == configured and override is None) or (
                root == other and override == "other"
            ):
                assert (
                    environment.edit(
                        str(root / "file.txt"),
                        "before",
                        "after",
                        write_directories=roots,
                    ).replacements
                    == 1
                )
            else:
                with pytest.raises(DomainError, match="outside"):
                    environment.edit(
                        str(root / "file.txt"),
                        "before",
                        "after",
                        write_directories=roots,
                    )
        assert environment.write_directories == (str(configured),)
    finally:
        environment.close()


def test_windows_write_access_is_cached_separately_for_each_root_set(
    tmp_path, monkeypatch
) -> None:
    from huddol.adapters.execution import local

    accesses = []

    class Access:
        def __init__(self, roots):
            self.roots = roots
            self.sid = f"sid-{len(accesses)}"
            self.closed = False
            accesses.append(self)

        def close(self):
            self.closed = True

    monkeypatch.setitem(
        sys.modules,
        "huddol.adapters.sandbox.windows",
        SimpleNamespace(WindowsWriteAccess=Access),
    )
    monkeypatch.setattr(
        local, "sys", SimpleNamespace(platform="win32", executable=sys.executable)
    )
    monkeypatch.setattr(local, "os", SimpleNamespace(name="nt"))
    library = tmp_path / "library"
    library.mkdir()
    environment = LocalExecution([str(tmp_path)])
    for roots, sid in (
        ((tmp_path,), "sid-0"),
        ((library,), "sid-1"),
        ((tmp_path,), "sid-0"),
    ):
        command = environment._wrap(["command"], tmp_path, roots)
        assert command[command.index("--windows-write-sandbox") + 1] == sid
    assert [access.roots for access in accesses] == [(tmp_path,), (library,)]
    assert not any(access.closed for access in accesses)
    environment.close()
    assert all(access.closed for access in accesses)
    assert environment._windows == {}
