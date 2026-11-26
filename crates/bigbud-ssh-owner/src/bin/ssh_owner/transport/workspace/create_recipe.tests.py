import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SOURCE = Path(__file__).with_name("create_recipe.py").read_text(encoding="utf-8")
PREFIX = b"BIGBUD_WORKSPACE_CREATE_V1 "
CAP = 48 * 1024


class CreateRecipeTest(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve() / "fixture's root; literal"
        self.root.mkdir()

    def invoke(
        self,
        path: str,
        data: bytes = b"",
        *,
        size: int | None = None,
        root: Path | None = None,
    ) -> bytes:
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                SOURCE,
                str(self.root if root is None else root),
                path,
                str(len(data) if size is None else size),
            ],
            input=data,
            capture_output=True,
            timeout=5,
            check=True,
        )
        self.assertEqual(result.stderr, b"")
        return result.stdout

    def test_empty_and_maximum_size_publish_private_files(self) -> None:
        (self.root / "nested").mkdir()
        for name, data in [("empty", b""), ("._quoted '雪\n", bytes(range(256)) * 192)]:
            self.assertEqual(self.invoke(f"nested/{name}", data), PREFIX + b"created\n")
            target = self.root / "nested" / name
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(len(list((self.root / "nested").iterdir())), 2)

    def test_existing_entries_are_never_replaced_or_followed(self) -> None:
        original = self.root / "original"
        original.write_bytes(b"keep")
        inode = original.stat().st_ino
        os.link(original, self.root / "hardlink")
        (self.root / "dangling").symlink_to("missing")
        (self.root / "linked-directory").symlink_to("directory")
        (self.root / "directory").mkdir()
        for name in (
            "original",
            "hardlink",
            "dangling",
            "linked-directory",
            "directory",
        ):
            with self.subTest(name=name):
                self.assertEqual(
                    self.invoke(name, b"replace"), PREFIX + b"alreadyExists\n"
                )
        self.assertEqual(original.read_bytes(), b"keep")
        self.assertEqual(original.stat().st_ino, inode)
        self.assertEqual((self.root / "hardlink").stat().st_ino, inode)
        self.assertEqual(os.readlink(self.root / "dangling"), "missing")
        self.assertEqual(os.readlink(self.root / "linked-directory"), "directory")
        self.assertFalse((self.root / "missing").exists())
        self.assertEqual(list((self.root / "directory").iterdir()), [])
        self.assertEqual(len(list(self.root.iterdir())), 5)

    def test_requires_existing_non_symlink_parent_and_complete_bounded_stdin(
        self,
    ) -> None:
        alias = self.root.parent / "alias"
        alias.symlink_to(self.root)
        (self.root / "escape").symlink_to(self.root.parent)
        for path, root in [
            ("missing/file", self.root),
            ("escape/new", self.root),
            ("new", alias),
        ]:
            with self.subTest(path=path, root=root):
                self.assertEqual(self.invoke(path, root=root), PREFIX + b"pathDenied\n")
        for path, data, size in [
            ("../new", b"", 0),
            ("file", b"short", 6),
            ("file", b"extra", 4),
            ("file", b"", CAP + 1),
        ]:
            with self.subTest(path=path, size=size):
                self.assertEqual(
                    self.invoke(path, data, size=size), PREFIX + b"invalidRequest\n"
                )
        self.assertEqual(list(self.root.iterdir()), [self.root / "escape"])
        self.assertFalse((self.root.parent / "new").exists())

    def test_cleanup_failure_after_publication_has_no_acknowledgement(self) -> None:
        fault = "import os\ndef fail(*args, **kwargs): raise OSError('injected')\nos.unlink = fail\n"
        result = subprocess.run(
            [
                sys.executable,
                "-I",
                "-B",
                "-c",
                fault + SOURCE,
                str(self.root),
                "file",
                "3",
            ],
            input=b"new",
            capture_output=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual((self.root / "file").read_bytes(), b"new")

    def test_concurrent_creates_have_one_winner(self) -> None:
        payloads = [bytes([i]) * CAP for i in range(8)]
        with ThreadPoolExecutor(max_workers=len(payloads)) as executor:
            results = list(
                executor.map(lambda data: self.invoke("race", data), payloads)
            )
        created = PREFIX + b"created\n"
        self.assertCountEqual(results, [created] + [PREFIX + b"alreadyExists\n"] * 7)
        self.assertEqual(
            (self.root / "race").read_bytes(), payloads[results.index(created)]
        )
        self.assertEqual(list(self.root.iterdir()), [self.root / "race"])


if __name__ == "__main__":
    unittest.main()
