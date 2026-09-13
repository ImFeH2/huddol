from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from huddol.ports.files import FileTree, TreeEntry


@dataclass(frozen=True)
class Document:
    path: str
    content: str
    content_hash: str


class Library:
    def __init__(self, tree: FileTree) -> None:
        self._tree = tree

    @property
    def root(self) -> Path:
        return self._tree.root

    def snapshot(self) -> dict[str, str | None]:
        return {
            item.path: item.content_hash for item in self.list() if item.kind == "file"
        }

    @staticmethod
    def changes(
        before: dict[str, str | None], after: dict[str, str | None]
    ) -> tuple[str, ...]:
        return tuple(
            sorted(
                path
                for path in before.keys() | after.keys()
                if path not in before
                or path not in after
                or before[path] != after[path]
            )
        )

    def list(self, path: str | None = None) -> tuple[TreeEntry, ...]:
        return self._tree.list(path)

    def read(self, path: str) -> Document:
        content, digest = self._tree.read(path)
        return Document(path, content, digest)

    def write(
        self, path: str, content: str, *, expected_hash: str | None = None
    ) -> TreeEntry:
        return self._tree.write(path, content, expected_hash=expected_hash)

    def edit(
        self, path: str, old_text: str, new_text: str, *, replace_all: bool = False
    ) -> tuple[TreeEntry, str]:
        return self._tree.edit(path, old_text, new_text, replace_all=replace_all)

    def mkdir(self, path: str) -> TreeEntry:
        return self._tree.mkdir(path)

    def delete(self, path: str) -> None:
        self._tree.delete(path)

    def move(self, source: str, destination: str) -> TreeEntry:
        return self._tree.move(source, destination)
