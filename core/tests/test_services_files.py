from __future__ import annotations

from pathlib import Path

import pytest

from huddol.adapters.files.tree import DirectoryTree
from huddol.core.errors import DomainError
from huddol.services.library import Library
from huddol.services.memory import Memory


@pytest.fixture
def library(tmp_path: Path) -> Library:
    return Library(DirectoryTree(tmp_path / "library"))


@pytest.fixture
def memory(tmp_path: Path) -> Memory:
    return Memory(
        DirectoryTree(tmp_path / "agents" / "13" / "memory", markdown_only=True)
    )


def test_library_round_trips_a_document(library: Library) -> None:
    entry = library.write("guides/onboarding.md", "welcome")
    document = library.read("guides/onboarding.md")
    assert document.content == "welcome"
    assert document.content_hash == entry.content_hash


def test_library_concurrent_edit_is_rejected_then_recoverable(library: Library) -> None:
    first = library.write("shared.md", "v1")
    library.write("shared.md", "v2", expected_hash=first.content_hash)
    latest = library.read("shared.md")
    assert latest.content == "v2"
    assert library.write("shared.md", "v3", expected_hash=latest.content_hash)


def test_memory_index_is_empty_without_files(memory: Memory) -> None:
    assert memory.index(16_384) == ""


@pytest.mark.parametrize("content", ["", "  - remember this\n", "记忆😀"])
def test_memory_index_returns_only_the_unchanged_index(
    memory: Memory, content: str
) -> None:
    _, digest = memory.read("MEMORY.md")
    memory.write("MEMORY.md", content, expected_hash=digest)
    memory.write("topics/rewrite.md", "details")
    assert memory.index(len(content.encode("utf-8"))) == content


def test_memory_does_not_list_files_without_an_index(memory: Memory) -> None:
    memory.write("topics/rewrite.md", "details")
    assert memory.index(16_384) == ""


@pytest.mark.parametrize(
    "limit,prefix",
    [
        (0, ""),
        (1, ""),
        (3, "记"),
        (4, "记"),
        (6, "记忆"),
        (7, "记忆"),
        (8, "记忆"),
        (10, "记忆😀"),
    ],
)
def test_memory_index_is_cut_at_a_utf8_boundary(
    memory: Memory, limit: int, prefix: str
) -> None:
    content = "记忆😀 more"
    _, digest = memory.read("MEMORY.md")
    memory.write("MEMORY.md", content, expected_hash=digest)
    assert memory.index(limit) == prefix + (
        f"\n[MEMORY.md is longer than {limit} bytes and was cut here. "
        "Reorganize it: keep only what you must always remember and a map of "
        "your other memory files.]"
    )
    assert len(prefix.encode("utf-8")) <= limit
    assert memory.read("MEMORY.md")[0] == content


def test_library_and_memory_are_separate_trees(
    library: Library, memory: Memory
) -> None:
    library.write("shared.md", "org wide")
    memory.write("private.md", "mine")
    assert [item.path for item in library.list()] == ["shared.md"]
    assert [item.path for item in memory.list()] == ["MEMORY.md", "private.md"]


def test_memory_recreates_its_index_after_deletion_or_movement(memory: Memory) -> None:
    entries = memory.list()
    assert [(entry.path, entry.kind, entry.size) for entry in entries] == [
        ("MEMORY.md", "file", 0)
    ]
    memory.delete("MEMORY.md")
    assert memory.index(100) == ""
    memory.move("MEMORY.md", "other.md")
    assert memory.index(100) == ""
    assert memory.read("other.md")[0] == ""


def test_memory_directory_operations_and_edit(memory: Memory) -> None:
    memory.mkdir("topics")
    memory.write("topics/note.md", "before")
    entry, diff = memory.edit("topics/note.md", "before", "after")
    assert entry.content_hash == memory.read(entry.path)[1] and "+after" in diff
    memory.move("topics", "renamed")
    assert [item.path for item in memory.list("renamed")] == ["renamed/note.md"]
    memory.delete("renamed")
    assert [item.path for item in memory.list()] == ["MEMORY.md"]


def test_library_snapshots_detect_presence_and_metadata_changes(
    library: Library,
) -> None:
    library.write("changed.txt", "before")
    library.write("removed.txt", "gone")
    library.write("retained.txt", "same")
    (library.root / "binary").write_bytes(b"\xff")
    before = library.snapshot()
    library.edit("changed.txt", "before", "after")
    library.delete("removed.txt")
    library.delete("binary")
    library.mkdir("empty")
    library.write("added.txt", "new")
    (library.root / "new-binary").write_bytes(b"\xff")
    after = library.snapshot()
    assert Library.changes(before, after) == (
        "added.txt",
        "binary",
        "changed.txt",
        "new-binary",
        "removed.txt",
    )
    assert Library.changes(after, after) == ()
    assert "empty" not in after
    stat = (library.root / "new-binary").stat()
    assert after["new-binary"] == (1, stat.st_mtime_ns)


def test_library_snapshot_reads_metadata_only_including_hidden_files(
    library, monkeypatch
) -> None:
    import os

    hidden = library.root / ".hidden"
    hidden.mkdir()
    target = hidden / "note.txt"
    target.write_text("before", encoding="utf-8")
    stat = target.stat()

    def fail(*args, **kwargs):
        pytest.fail("Snapshots must not read file contents")

    monkeypatch.setattr(library._tree, "list", fail)
    monkeypatch.setattr(Path, "open", fail)
    before = library.snapshot()
    assert before == {".hidden/note.txt": (stat.st_size, stat.st_mtime_ns)}
    os.utime(target, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    assert Library.changes(before, library.snapshot()) == (".hidden/note.txt",)


@pytest.mark.parametrize(
    "error",
    [
        OSError("Read-only filesystem"),
        DomainError("invalid_path", "Cannot create index"),
    ],
)
def test_memory_index_is_empty_when_creation_fails(memory, monkeypatch, error) -> None:
    def fail(*args, **kwargs):
        raise error

    monkeypatch.setattr(memory._tree, "write", fail)
    assert memory.index(100) == ""
    assert not (memory._tree.root / "MEMORY.md").exists()


def test_unreadable_memory_index_does_not_hide_the_tree(tmp_path: Path) -> None:
    tree = DirectoryTree(tmp_path / "memory", markdown_only=True)
    (tree.root / "MEMORY.md").write_bytes(b"\xff")
    memory = Memory(tree)
    (entry,) = memory.list()
    assert entry.path == "MEMORY.md" and entry.content_hash is None
    memory.write("other.md", "readable")
    assert memory.read("other.md")[0] == "readable"
    with pytest.raises(DomainError) as error:
        memory.index(100)
    assert error.value.code == "not_readable"
