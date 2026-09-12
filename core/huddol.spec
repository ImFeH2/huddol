from pathlib import Path, PurePosixPath

from PyInstaller.utils.hooks import copy_metadata

from huddol.adapters.execution.wsl import COMPONENT_SOURCES

datas = copy_metadata("pydantic-ai-slim", recursive=True)
datas.extend(
    (f"src/{source}", str(PurePosixPath("execution", source).parent))
    for source in COMPONENT_SOURCES
)
web = Path(SPECPATH, "..", "web", "dist")
if web.is_dir():
    datas.append((str(web), "web"))


a = Analysis(
    ["src/huddol/__main__.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="huddol",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="huddol",
)
