from __future__ import annotations

import argparse
import atexit
import os
import sys
import tempfile
import threading
import zipfile
from pathlib import Path

MODULES = (
    "core/errors.py",
    "ports/execution.py",
    "adapters/sandbox/paths.py",
    "adapters/sandbox/commands.py",
    "adapters/sandbox/windows.py",
    "adapters/execution/bundle.py",
    "adapters/execution/local.py",
    "adapters/execution/editing.py",
    "adapters/execution/worker.py",
)

_lock = threading.Lock()
_built: tempfile.TemporaryDirectory[str] | None = None


def build(destination: Path) -> Path:
    source = Path(__file__).resolve().parents[2]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        dir=destination.parent, suffix=".pyz", delete=False
    ) as stream:
        temporary = Path(stream.name)
    try:
        with zipfile.ZipFile(
            temporary, "w", compression=zipfile.ZIP_DEFLATED
        ) as archive:
            packages = {"huddol"}
            for module in MODULES:
                target = Path("huddol") / module
                archive.write(source / module, target.as_posix())
                packages.update(
                    parent.as_posix()
                    for parent in target.parents
                    if parent != Path(".")
                )
            for package in sorted(packages):
                archive.writestr(f"{package}/__init__.py", "")
            archive.writestr(
                "__main__.py",
                "from huddol.adapters.execution.worker import main\nraise SystemExit(main())\n",
            )
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def component() -> Path:
    if getattr(sys, "frozen", False):
        return Path(vars(sys)["_MEIPASS"]) / "execution" / "execution.pyz"
    if sys.argv[0].endswith(".pyz"):
        return Path(sys.argv[0])
    global _built
    with _lock:
        if _built is None or not (Path(_built.name) / "execution.pyz").is_file():
            directory = tempfile.TemporaryDirectory(prefix="huddol-execution-")
            try:
                archive = build(Path(directory.name) / "execution.pyz")
                if os.name == "nt":
                    from huddol.adapters.sandbox.windows import allow_component_read

                    allow_component_read(Path(directory.name))
                    allow_component_read(archive)
            except Exception:
                directory.cleanup()
                raise
            if _built is None:
                atexit.register(_release)
            _built = directory
        return Path(_built.name) / "execution.pyz"


def _release() -> None:
    global _built
    with _lock:
        if _built is not None:
            _built.cleanup()
            _built = None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    build(parser.parse_args().output)
