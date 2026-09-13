from __future__ import annotations

from huddol.core.errors import DomainError
from huddol.ports.files import FileTree, TreeEntry

INDEX = "MEMORY.md"


class Memory:
    def __init__(self, tree: FileTree) -> None:
        self._tree = tree

    def list(self) -> tuple[TreeEntry, ...]:
        return self._tree.list()

    def read(self, path: str) -> tuple[str, str]:
        return self._tree.read(path)

    def write(
        self, path: str, content: str, *, expected_hash: str | None = None
    ) -> TreeEntry:
        return self._tree.write(path, content, expected_hash=expected_hash)

    def delete(self, path: str) -> None:
        self._tree.delete(path)

    def index(self, limit_bytes: int) -> str:
        try:
            content, _ = self._tree.read(INDEX)
        except DomainError as error:
            if error.code != "not_found":
                raise
            return ""
        encoded = content.encode("utf-8")
        if len(encoded) <= limit_bytes:
            return content
        return encoded[:limit_bytes].decode("utf-8", errors="ignore") + (
            f"\n[MEMORY.md is longer than {limit_bytes} bytes and was cut here. "
            "Reorganize it: keep only what you must always remember and a map of "
            "your other memory files.]"
        )
