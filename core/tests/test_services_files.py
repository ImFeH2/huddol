from __future__ import annotations

from pathlib import Path

import pytest

from huddol.adapters.files.tree import MarkdownTree
from huddol.services.library import Library
from huddol.services.memory import Memory


@pytest.fixture
def library(tmp_path: Path) -> Library:
    return Library(MarkdownTree(tmp_path / "library"))


@pytest.fixture
def memory(tmp_path: Path) -> Memory:
    return Memory(MarkdownTree(tmp_path / "agents" / "13" / "memory"))


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
    memory.write("MEMORY.md", content)
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
    memory.write("MEMORY.md", content)
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
    assert [item.path for item in memory.list()] == ["private.md"]
