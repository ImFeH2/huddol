from __future__ import annotations

from pathlib import Path

import pytest

from huddol.adapters.files.tree import MAX_FILE_BYTES, DirectoryTree, content_hash
from huddol.core.errors import DomainError
from huddol.ports.files import ConflictError


@pytest.fixture
def tree(tmp_path: Path) -> DirectoryTree:
    return DirectoryTree(tmp_path / "library")


def require_symlinks(tmp_path: Path) -> None:
    probe = tmp_path / "symlink-probe"
    try:
        probe.symlink_to(tmp_path)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symlinks are unavailable on this host: {error}")
    probe.unlink()


def test_creates_reads_and_lists_nested_files_and_empty_directories(tree) -> None:
    tree.write("notes.txt", "top level")
    tree.write("guides/protocol.md", "nested")
    tree.mkdir("empty")
    tree.write("guides.txt", "sibling")
    entries = tree.list()
    assert [(item.path, item.kind) for item in entries] == [
        ("empty", "directory"),
        ("guides", "directory"),
        ("guides/protocol.md", "file"),
        ("guides.txt", "file"),
        ("notes.txt", "file"),
    ]
    assert all(item.size == 0 and item.content_hash is None for item in entries[:2])
    assert all(item.modified_at.endswith("Z") for item in entries)
    assert [item.path for item in tree.list("guides")] == ["guides/protocol.md"]
    assert tree.read("guides/protocol.md") == ("nested", content_hash("nested"))
    assert tree.root.is_absolute()


@pytest.mark.parametrize("markdown_only", [False, True])
@pytest.mark.parametrize("path", ["", ".", "./", "/", " / ", "///", " \t\n", "/ \t/\n"])
def test_root_paths_allow_listing_and_mkdir_but_not_file_operations(
    tmp_path, markdown_only, path
) -> None:
    tree = DirectoryTree(tmp_path / "tree", markdown_only=markdown_only)
    tree.write("a/b.md", "content")
    assert tree.list(path) == tree.list()
    entry = tree.mkdir(path)
    assert entry.path == "" and entry.kind == "directory"
    assert entry.size == 0 and entry.content_hash is None
    for operation in (
        lambda: tree.read(path),
        lambda: tree.write(path, "replacement"),
        lambda: tree.edit(path, "content", "replacement"),
        lambda: tree.delete(path),
        lambda: tree.move(path, "x"),
        lambda: tree.move("a/b.md", path),
        lambda: tree.move("a", path),
    ):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "invalid_path"
        assert str(error.value) == "Path must name a file or folder inside the tree"
    assert tree.read("a/b.md")[0] == "content"


@pytest.mark.parametrize("markdown_only", [False, True])
def test_leading_dot_slash_resolves_relative_paths(tmp_path, markdown_only) -> None:
    tree = DirectoryTree(tmp_path / "tree", markdown_only=markdown_only)
    assert tree.mkdir("./a").path == "a"
    assert tree.write("./a/b.md", "content").path == "a/b.md"
    assert tree.read("./a/b.md") == tree.read("a/b.md")
    assert tree.list("./a") == tree.list("a")
    tree.edit("./a/b.md", "content", "updated")
    assert tree.read("a/b.md")[0] == "updated"
    assert tree.move("./a/b.md", "./a/c.md").path == "a/c.md"
    tree.delete("./a/c.md")
    assert tree.list("a") == ()


def test_overwrite_requires_matching_expected_hash(tree) -> None:
    entry = tree.write("doc.md", "first")
    with pytest.raises(DomainError) as missing:
        tree.write("doc.md", "second")
    assert missing.value.code == "expected_hash_required"
    with pytest.raises(ConflictError) as stale:
        tree.write("doc.md", "second", expected_hash="0" * 16)
    assert stale.value.actual == entry.content_hash
    updated = tree.write("doc.md", "second", expected_hash=entry.content_hash)
    assert updated.content_hash == content_hash("second")


@pytest.mark.parametrize(
    "path",
    [
        "../escape.md",
        "/etc/passwd.md",
        "a/../../b.md",
        "./../escape.md",
        "./.hidden",
        "./a/.hidden/file.md",
        ".hidden",
        "a/.hidden/file.md",
        "a\\..\\b.md",
        "C:\\file.md",
        "bad\0.md",
    ],
)
def test_rejects_invalid_and_hidden_paths(tree, path) -> None:
    for operation in (lambda: tree.write(path, "nope"), lambda: tree.mkdir(path)):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "invalid_path"


def test_markdown_only_applies_to_files_not_directories(tmp_path) -> None:
    tree = DirectoryTree(tmp_path / "memory", markdown_only=True)
    tree.mkdir("topics")
    tree.write("topics/note.md", "ok")
    (tree.root / "ignored.txt").write_text("text")
    assert [item.path for item in tree.list()] == ["topics", "topics/note.md"]
    for operation in (
        lambda: tree.write("script.sh", "text"),
        lambda: tree.read("ignored.txt"),
        lambda: tree.move("topics/note.md", "note.txt"),
    ):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "invalid_path"


def test_hidden_names_and_symlinked_files_and_directories_are_not_listed(
    tree, tmp_path
) -> None:
    require_symlinks(tmp_path)
    tree.write("real.md", "content")
    tree.mkdir("visible")
    (tree.root / ".hidden").mkdir()
    (tree.root / ".hidden/note.md").write_text("hidden")
    (tree.root / ".file.md").write_text("hidden")
    (tree.root / "alias.md").symlink_to(tree.root / "real.md")
    (tree.root / "alias").symlink_to(tree.root / "visible", target_is_directory=True)
    (tree.root / "outside").symlink_to(tmp_path, target_is_directory=True)
    assert [item.path for item in tree.list()] == ["real.md", "visible"]
    with pytest.raises(DomainError) as error:
        tree.write("outside/escape.md", "no")
    assert error.value.code == "invalid_path"
    assert not (tmp_path / "escape.md").exists()
    (tree.root / "dangling.md").symlink_to(tree.root / "missing.md")
    with pytest.raises(DomainError) as error:
        tree.move("real.md", "dangling.md")
    assert error.value.code == "already_exists"
    assert tree.read("real.md")[0] == "content"
    assert not (tree.root / "missing.md").exists()


@pytest.mark.parametrize("data", [b"\xff\xfe", b"x" * (MAX_FILE_BYTES + 1)])
def test_unreadable_files_are_listed_but_cannot_be_read_written_or_edited(
    tree, data
) -> None:
    (tree.root / "unreadable.txt").write_bytes(data)
    (entry,) = tree.list()
    assert (
        entry.kind == "file" and entry.content_hash is None and entry.size == len(data)
    )
    for operation in (
        lambda: tree.read(entry.path),
        lambda: tree.write(entry.path, "replacement", expected_hash="stale"),
        lambda: tree.edit(entry.path, "x", "y"),
    ):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "not_readable"
    assert (tree.root / entry.path).read_bytes() == data


def test_edit_exact_replacements_and_errors(tree) -> None:
    tree.write("doc.txt", "alpha\nbeta\nbeta\n")
    for old, code in [("missing", "no_match"), ("beta", "ambiguous_match")]:
        with pytest.raises(DomainError) as error:
            tree.edit("doc.txt", old, "new")
        assert error.value.code == code
    entry, diff = tree.edit("doc.txt", "beta", "gamma", replace_all=True)
    assert tree.read("doc.txt") == ("alpha\ngamma\ngamma\n", entry.content_hash)
    assert "-beta" in diff and "+gamma" in diff
    tree.edit("doc.txt", "alpha", "first")
    with pytest.raises(DomainError) as error:
        tree.edit("missing.txt", "a", "b")
    assert error.value.code == "not_found"


def test_size_limit_applies_to_writes_and_edit_results(tree) -> None:
    entry = tree.write("limit.txt", "x" * MAX_FILE_BYTES)
    assert tree.read(entry.path)[1] == entry.content_hash
    for operation in (
        lambda: tree.write("large.txt", "x" * (MAX_FILE_BYTES + 1)),
        lambda: tree.edit("limit.txt", "x", "xx", replace_all=True),
    ):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "invalid_content"
    assert tree.read(entry.path)[1] == entry.content_hash
    assert not (tree.root / "large.txt").exists()


def test_mkdir_is_idempotent_and_file_directory_types_are_checked(tree) -> None:
    entry = tree.mkdir("a/b")
    assert tree.mkdir("a/b") == entry
    tree.write("file.txt", "content")
    for operation in (
        lambda: tree.mkdir("file.txt"),
        lambda: tree.write("a/b", "content"),
    ):
        with pytest.raises(DomainError) as error:
            operation()
        assert error.value.code == "invalid_path"
    for path in ("a/b", "missing.txt"):
        with pytest.raises(DomainError) as error:
            tree.read(path)
        assert error.value.code == "not_found"


def test_delete_keeps_empty_parents_and_removes_nonempty_directories(tree) -> None:
    tree.write("a/b/c.md", "deep")
    tree.delete("a/b/c.md")
    assert [item.path for item in tree.list()] == ["a", "a/b"]
    tree.write("a/b/c.txt", "deep")
    tree.delete("a")
    assert tree.list() == ()
    with pytest.raises(DomainError) as error:
        tree.delete("a")
    assert error.value.code == "not_found"


def test_move_files_and_directories_without_clobbering(tree) -> None:
    tree.write("old.md", "content")
    tree.write("taken.md", "other")
    assert tree.move("old.md", "folder/new.md").path == "folder/new.md"
    assert tree.move("folder", "parent/renamed").kind == "directory"
    assert tree.read("parent/renamed/new.md")[0] == "content"
    with pytest.raises(DomainError) as error:
        tree.move("parent/renamed/new.md", "taken.md")
    assert error.value.code == "already_exists"
    for destination in ("parent", "parent/child"):
        with pytest.raises(DomainError) as error:
            tree.move("parent", destination)
        assert error.value.code == "invalid_path"
    assert tree.read("taken.md")[0] == "other"


def test_writes_preserve_neighboring_temporary_names_and_exact_utf8_bytes(tree) -> None:
    tree.write("doc.txt.tmp", "keep")
    tree.write("doc.txt", "a\r\nb\n")
    assert tree.read("doc.txt") == ("a\r\nb\n", content_hash("a\r\nb\n"))
    assert tree.read("doc.txt.tmp")[0] == "keep"
    assert [item.path for item in tree.list()] == ["doc.txt", "doc.txt.tmp"]
