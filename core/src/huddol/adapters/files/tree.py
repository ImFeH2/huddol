from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath, PureWindowsPath

from huddol.adapters.execution.editing import edit_file
from huddol.core.errors import DomainError
from huddol.ports.files import ConflictError, TreeEntry

MAX_FILE_BYTES = 1_000_000
ALLOWED_SUFFIX = ".md"


def content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


class DirectoryTree:
    def __init__(self, root: Path | str, *, markdown_only: bool = False) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)
        self._markdown_only = markdown_only

    @property
    def root(self) -> Path:
        return self._root

    def _resolve(self, path: str, *, file: bool = False) -> Path:
        if not isinstance(path, str) or not path.strip() or "\0" in path:
            raise DomainError("invalid_path", "Path must not be empty or contain NUL")
        parts = path.replace("\\", "/").split("/")
        pure = PurePosixPath(path.replace("\\", "/"))
        if (
            PureWindowsPath(path).drive
            or pure.is_absolute()
            or any(part.startswith(".") for part in parts)
        ):
            raise DomainError("invalid_path", "Path must be relative and not hidden")
        target = (self._root / pure).resolve()
        if target == self._root or self._root not in target.parents:
            raise DomainError("invalid_path", "Path must stay inside the tree")
        if any(part.startswith(".") for part in target.relative_to(self._root).parts):
            raise DomainError("invalid_path", "Hidden paths are not allowed")
        if (
            self._markdown_only
            and (file or target.is_file())
            and (pure.suffix != ALLOWED_SUFFIX or target.suffix != ALLOWED_SUFFIX)
        ):
            raise DomainError("invalid_path", "Only Markdown files are allowed")
        return target

    def _relative(self, target: Path) -> str:
        return target.relative_to(self._root).as_posix()

    def _content(self, target: Path) -> str:
        try:
            with target.open("rb") as stream:
                data = stream.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                raise DomainError("not_readable", "File is too large")
            return data.decode("utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise DomainError("not_readable", "File cannot be read as UTF-8") from error

    def _entry(self, target: Path) -> TreeEntry:
        stat = target.stat()
        directory = target.is_dir()
        digest = None
        if not directory:
            try:
                digest = content_hash(self._content(target))
            except DomainError:
                pass
        modified = datetime.fromtimestamp(stat.st_mtime, UTC)
        return TreeEntry(
            path=self._relative(target),
            kind="directory" if directory else "file",
            size=0 if directory else stat.st_size,
            modified_at=modified.isoformat(timespec="seconds").replace("+00:00", "Z"),
            content_hash=digest,
        )

    def list(self, path: str | None = None) -> tuple[TreeEntry, ...]:
        base = self._root if path is None else self._resolve(path)
        if not base.is_dir():
            return ()
        found = []
        for directory, directories, files in base.walk():
            directories[:] = sorted(
                name
                for name in directories
                if not name.startswith(".") and not (directory / name).is_symlink()
            )
            for name in [*directories, *files]:
                item = directory / name
                if name.startswith(".") or item.is_symlink():
                    continue
                if (
                    item.is_file()
                    and (not self._markdown_only or item.suffix == ALLOWED_SUFFIX)
                    or item.is_dir()
                ):
                    found.append(self._entry(item))
        return tuple(sorted(found, key=lambda entry: entry.path.split("/")))

    def read(self, path: str) -> tuple[str, str]:
        target = self._resolve(path)
        if not target.is_file():
            raise DomainError("not_found", f"{path} does not exist")
        content = self._content(target)
        return content, content_hash(content)

    def write(
        self, path: str, content: str, *, expected_hash: str | None = None
    ) -> TreeEntry:
        if not isinstance(content, str):
            raise DomainError("invalid_content", "Content must be a string")
        if len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise DomainError("invalid_content", "Content is too large")
        target = self._resolve(path, file=True)
        if target.is_dir():
            raise DomainError("invalid_path", "Path is a directory")
        if target.exists():
            current = content_hash(self._content(target))
            if expected_hash is None:
                raise DomainError(
                    "expected_hash_required",
                    "expected_hash is required when overwriting an existing document",
                )
            if expected_hash != current:
                raise ConflictError(path, expected_hash, current)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(content.encode("utf-8"))
            os.replace(temporary, target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return self._entry(target)

    def edit(
        self, path: str, old_text: str, new_text: str, *, replace_all: bool = False
    ) -> tuple[TreeEntry, str]:
        original, _ = self.read(path)
        if isinstance(old_text, str) and old_text and isinstance(new_text, str):
            updated = original.replace(old_text, new_text, -1 if replace_all else 1)
            if len(updated.encode("utf-8")) > MAX_FILE_BYTES:
                raise DomainError("invalid_content", "Content is too large")
        target = self._resolve(path, file=True)
        result = edit_file(
            str(target),
            old_text,
            new_text,
            directories=[str(self._root)],
            replace_all=replace_all,
        )
        return self._entry(target), result.diff

    def mkdir(self, path: str) -> TreeEntry:
        target = self._resolve(path)
        if target.exists() and not target.is_dir():
            raise DomainError("invalid_path", "Path is a file")
        target.mkdir(parents=True, exist_ok=True)
        return self._entry(target)

    def delete(self, path: str) -> None:
        target = self._resolve(path)
        if not target.exists():
            raise DomainError("not_found", f"{path} does not exist")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()

    def move(self, source: str, destination: str) -> TreeEntry:
        origin = self._resolve(source)
        if not origin.exists():
            raise DomainError("not_found", f"{source} does not exist")
        target = self._resolve(destination, file=origin.is_file())
        if origin.is_dir() and (target == origin or origin in target.parents):
            raise DomainError("invalid_path", "Cannot move a directory into itself")
        if (
            target.exists()
            or (self._root / destination.replace("\\", "/")).is_symlink()
        ):
            raise DomainError("already_exists", f"{destination} already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(origin, target)
        return self._entry(target)
