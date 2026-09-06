from __future__ import annotations

import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest

from huddol.adapters.execution.bundle import build
from huddol.adapters.execution.local import LocalExecution
from huddol.adapters.execution.manager import ExecutionManager
from huddol.adapters.execution.wsl import WslConnection
from huddol.core.errors import DomainError


@pytest.fixture(autouse=True)
def isolated_business_data(tmp_path: Path, monkeypatch):
    directory = tmp_path / "unexpected-business-startup"
    monkeypatch.setenv("HUDDOL_DATA_DIR", str(directory))
    yield
    assert not directory.exists()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_worker_reuses_linux_run_edit_and_sandbox_without_business_services(
    tmp_path: Path, monkeypatch
) -> None:
    archive = build(tmp_path / "component 中文 space.pyz")
    with zipfile.ZipFile(archive) as contents:
        names = contents.namelist()
    assert not any(
        "sqlite" in name or "model" in name or "scheduler" in name for name in names
    )
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    connection = WslConnection("test", tmp_path, [str(allowed)])
    monkeypatch.setattr(
        connection, "_command", lambda: [sys.executable, "-I", str(archive)]
    )
    try:
        connection.inspect()
        assert connection.root == str(tmp_path)
        path = allowed / "中文 😀.txt"
        result = connection.run(
            [
                "/usr/bin/python3",
                "-c",
                "import sys; from pathlib import Path; Path(sys.argv[1]).write_text('before😀', encoding='utf-8')",
                str(path),
            ]
        )
        assert result.exit_code == 0, result.stderr
        edited = connection.edit(str(path), "before", "after")
        assert edited.replacements == 1
        assert path.read_text(encoding="utf-8") == "after😀"
        assert "after😀" in connection.run(["cat", str(path)]).stdout
        with pytest.raises(DomainError, match="outside"):
            connection.edit(str(outside), "private", "changed")
        denied = connection.run(
            ["sh", "-c", 'printf changed > "$1"', "sh", str(outside)]
        )
        assert denied.exit_code != 0
        assert outside.read_text() == "private"
        candidate = WslConnection("test", tmp_path, [])
        monkeypatch.setattr(
            candidate, "_command", lambda: [sys.executable, "-I", str(archive)]
        )
        candidate.inspect()
        connection.apply_configuration(candidate)
        candidate.close()
        with pytest.raises(DomainError):
            connection.edit(str(path), "after", "denied")
    finally:
        connection.close()
    assert not connection._processes


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_execution_session_keeps_the_existing_process_view(tmp_path: Path) -> None:
    import os

    environment = LocalExecution(tmp_path)
    try:
        code = f"import os; from pathlib import Path; assert os.getsid(0)!={os.getsid(0)}; assert Path('/proc/{os.getpid()}/cmdline').exists()"
        result = environment.run([sys.executable, "-c", code])
        assert result.exit_code == 0, result.stderr
    finally:
        environment.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_timeout_does_not_leave_a_linux_descendant_writing_later(
    tmp_path: Path,
) -> None:
    environment = LocalExecution(tmp_path, [str(tmp_path)])
    marker = tmp_path / "late"
    try:
        with pytest.raises(DomainError) as error:
            environment.run(
                ["sh", "-c", '(sleep 2; printf late > "$1") & wait', "sh", str(marker)],
                timeout=1,
            )
        assert error.value.code == "timeout"
        time.sleep(1.3)
        assert not marker.exists()
    finally:
        environment.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_worker_pipe_closure_ends_the_linux_command(tmp_path: Path) -> None:
    import json

    archive = build(tmp_path / "execution.pyz")
    marker = tmp_path / "late"
    started = tmp_path / "started"
    request = {
        "operation": "run",
        "root": str(tmp_path),
        "directories": [str(tmp_path)],
        "params": {
            "argv": [
                "sh",
                "-c",
                'printf started > "$1"; sleep 2; printf late > "$2"',
                "sh",
                str(started),
                str(marker),
            ]
        },
    }
    process = subprocess.Popen(
        [sys.executable, "-I", str(archive)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert process.stdin is not None
    try:
        process.stdin.write(json.dumps(request).encode() + b"\n")
        process.stdin.flush()
        deadline = time.monotonic() + 5
        while not started.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert started.exists()
        process.stdin.close()
        process.stdin = None
        process.communicate(timeout=5)
        time.sleep(2.1)
        assert not marker.exists()
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux execution")
def test_wsl_reinspection_keeps_unusable_directory_diagnostics(
    tmp_path: Path, monkeypatch
) -> None:
    archive = build(tmp_path / "execution.pyz")
    connection = WslConnection(
        "test", tmp_path, [str(tmp_path), "relative/bad"], tolerant=True
    )
    monkeypatch.setattr(
        connection, "_command", lambda: [sys.executable, "-I", str(archive)]
    )
    try:
        connection.inspect()
        expected = (("relative/bad", "invalid_directory"),)
        assert connection.skipped == expected
        connection.describe_environment()
        assert connection.skipped == expected
        assert connection.run(["/bin/true"]).exit_code == 0
        candidate = WslConnection("test", tmp_path, [str(tmp_path)])
        monkeypatch.setattr(
            candidate, "_command", lambda: [sys.executable, "-I", str(archive)]
        )
        candidate.inspect()
        connection.apply_configuration(candidate)
        candidate.close()
        connection.describe_environment()
        assert connection.skipped == ()
    finally:
        connection.close()


def test_environment_identity_is_bound_but_its_directory_policy_updates(
    tmp_path: Path, monkeypatch
) -> None:
    manager = ExecutionManager(tmp_path, [str(tmp_path)], enforce=False)
    first = manager.snapshot()
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    saved = []
    manager.configure({"write_directories": [str(allowed)]}, saved.append)
    assert first.write_directories == (str(allowed),)
    original = manager._create

    def create(target, directories, *, tolerant=False):
        if target["kind"] == "wsl":
            environment = LocalExecution(tmp_path, directories, enforce=False)
            return environment
        return original(target, directories, tolerant=tolerant)

    monkeypatch.setattr(manager, "_create", create)
    manager.configure(
        {
            "environment": {"kind": "wsl", "distribution": "test"},
            "write_directories": [],
        },
        saved.append,
    )
    second = manager.snapshot()
    assert first.write_directories == (str(allowed),)
    assert second.write_directories == ()
    manager.close()


def test_failed_persistence_does_not_switch_execution_or_directories(
    tmp_path: Path,
) -> None:
    manager = ExecutionManager(tmp_path, [str(tmp_path)], enforce=False)
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
    environment = LocalExecution(tmp_path, [str(tmp_path)])
    try:
        environment.edit(str(target), "before", "after")
        result = environment.run([sys.executable, "-c", "print('command-ok')"])
        assert result.exit_code == 0 and "command-ok" in result.stdout
        assert target.read_text() == "after"
        assert not marker.exists()
    finally:
        environment.close()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows component permissions")
def test_native_component_is_not_writable_by_the_restricted_command(
    tmp_path: Path,
) -> None:
    from huddol.adapters.execution.local import entrypoint

    environment = LocalExecution(tmp_path, [str(tmp_path)])
    try:
        component = Path(entrypoint()[-1])
        original = component.read_bytes()
        result = environment.run(
            [
                sys.executable,
                "-c",
                "from pathlib import Path; import sys; Path(sys.argv[1]).write_bytes(b'changed')",
                str(component),
            ]
        )
        assert result.exit_code != 0
        assert component.read_bytes() == original
    finally:
        environment.close()


def test_execution_component_is_shared_and_needs_no_per_instance_cleanup(
    tmp_path: Path,
) -> None:
    import gc

    from huddol.adapters.execution.local import entrypoint

    allowed = tmp_path / "allowed"
    allowed.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("private", encoding="utf-8")
    environment = LocalExecution(tmp_path, [str(allowed)])
    with pytest.raises(DomainError) as error:
        environment.edit(str(outside), "private", "changed")
    assert error.value.code == "not_writable"
    component = Path(entrypoint()[-1])
    assert component.is_file()
    del environment
    gc.collect()
    assert component.is_file()
    assert Path(entrypoint()[-1]) == component


def test_reconfiguration_reuses_the_same_execution_instance(tmp_path: Path) -> None:
    manager = ExecutionManager(tmp_path, [str(tmp_path)], enforce=False)
    original = manager._environments[("native", "")]
    try:
        for directories in ([], [str(tmp_path)], []):
            manager.configure({"write_directories": directories}, lambda values: None)
            assert manager._environments[("native", "")] is original
            assert manager.snapshot().write_directories == tuple(directories)
        assert len(manager._environments) == 1
    finally:
        manager.close()


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="Linux environment")
def test_native_wsl_reports_the_same_interop_limitation(
    tmp_path: Path, monkeypatch
) -> None:
    from huddol.adapters.execution.local import WSL_WARNING

    monkeypatch.setattr("platform.release", lambda: "6.18-microsoft-standard-WSL2")
    manager = ExecutionManager(tmp_path, enforce=False)
    try:
        assert manager.status()["warning"] == WSL_WARNING
        assert WSL_WARNING in manager.snapshot().describe_environment()
    finally:
        manager.close()


def test_closing_a_connection_unblocks_a_large_unsent_request(
    tmp_path: Path, monkeypatch
) -> None:
    import threading

    started = tmp_path / "started"
    connection = WslConnection("test", tmp_path, [])
    script = (
        "from pathlib import Path; import time; Path("
        + repr(str(started))
        + ").write_text('ready'); time.sleep(5)"
    )
    monkeypatch.setattr(
        connection, "_command", lambda: [sys.executable, "-I", "-c", script]
    )
    errors = []

    def request():
        try:
            connection.edit("ignored", "old", "x" * 2_000_000)
        except DomainError as error:
            errors.append(error.code)

    thread = threading.Thread(target=request, daemon=True)
    thread.start()
    deadline = time.monotonic() + 3
    try:
        while not started.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert started.exists()
        beginning = time.monotonic()
        connection.close()
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert time.monotonic() - beginning < 3
        assert errors
        assert not connection._processes
    finally:
        connection.close()
        thread.join(timeout=6)


def test_invalid_saved_environment_does_not_fall_back_to_native(tmp_path: Path) -> None:
    manager = ExecutionManager(tmp_path, environment={"kind": "invalid"})
    assert manager.status()["error"]
    with pytest.raises(DomainError):
        manager.snapshot().run(["echo", "should not run"])
    manager.configure({"environment": {"kind": "native"}}, lambda values: None)
    assert manager.status()["error"] is None
    manager.close()


@pytest.mark.skipif(
    not sys.platform.startswith("linux")
    or not Path("/proc/sys/fs/binfmt_misc/WSLInterop").exists(),
    reason="WSL interop",
)
def test_linux_execution_preserves_native_wsl_windows_interop(tmp_path: Path) -> None:
    environment = LocalExecution(tmp_path)
    try:
        result = environment.run(
            ["/mnt/c/Windows/System32/cmd.exe", "/d", "/c", "echo", "interop-ok"]
        )
        assert result.exit_code == 0, result.stderr
        assert "interop-ok" in result.stdout
    finally:
        environment.close()
