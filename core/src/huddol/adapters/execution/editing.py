from __future__ import annotations

import difflib
import os
import tempfile
from pathlib import Path

from huddol.adapters.sandbox.paths import is_within
from huddol.core.errors import DomainError
from huddol.ports.execution import EditResult


def edit_file(
    path: str,
    old_text: str,
    new_text: str,
    *,
    directories: list[str],
    replace_all: bool = False,
) -> EditResult:
    if not isinstance(old_text, str) or not old_text:
        raise DomainError("invalid_edit", "old_text must be a non-empty string")
    if not isinstance(new_text, str):
        raise DomainError("invalid_edit", "new_text must be a string")
    candidate = Path(path)
    if not candidate.is_absolute():
        raise DomainError("invalid_path", "path must be an absolute path")
    target = candidate.resolve()
    if not is_within(target, [Path(item).resolve() for item in directories]):
        raise DomainError(
            "not_writable", "Path is outside the configured writable directories"
        )
    if not target.is_file():
        raise DomainError("not_found", f"{path} does not exist")
    try:
        original = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise DomainError("not_text", f"{path} is not valid UTF-8") from error
    occurrences = original.count(old_text)
    if not occurrences:
        raise DomainError("no_match", "old_text does not appear in the file")
    if occurrences > 1 and not replace_all:
        raise DomainError(
            "ambiguous_match",
            "old_text appears multiple times; pass replace_all to change all",
        )
    updated = (
        original.replace(old_text, new_text)
        if replace_all
        else original.replace(old_text, new_text, 1)
    )
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=target.parent,
            prefix=".huddol-edit-",
            delete=False,
        ) as stream:
            temporary = stream.name
            stream.write(updated)
        os.chmod(temporary, target.stat().st_mode)
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    return EditResult(
        str(target),
        "".join(
            difflib.unified_diff(
                original.splitlines(keepends=True),
                updated.splitlines(keepends=True),
                fromfile=str(target),
                tofile=str(target),
                n=3,
            )
        ),
        occurrences if replace_all else 1,
    )
