#!/usr/bin/env python3
"""Unit tests for scripts/validate-contract-workspace.py.

Run with: python3 -m unittest discover -s scripts -p 'test_validate_contract_workspace.py'
"""

from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import validate_contract_workspace as vcw  # noqa: E402

MANIFEST_TEMPLATE = """[workspace]
resolver = "2"

members = [
{members}
]

exclude = [
{excludes}
]
"""


def write_manifest(root: pathlib.Path, members: list[str], excludes: list[str]) -> pathlib.Path:
    """Write a synthetic workspace manifest with a real Cargo.toml per crate."""
    for name in set(members) | set(excludes):
        crate = root / name
        crate.mkdir(parents=True, exist_ok=True)
        (crate / "Cargo.toml").write_text(f'[package]\nname = "{name}"\nversion = "0.0.0"\n')
    manifest = root / "Cargo.toml"
    manifest.write_text(
        MANIFEST_TEMPLATE.format(
            members="".join(f'    "{name}",\n' for name in members),
            excludes="".join(f'    "{name}",\n' for name in excludes),
        )
    )
    return manifest


class ValidateContractWorkspaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_accepts_disjoint_lists(self) -> None:
        manifest = write_manifest(self.root, ["member-a", "member-b"], ["excluded-a"])
        self.assertEqual(vcw.validate(manifest), [])

    def test_rejects_a_crate_listed_in_both(self) -> None:
        manifest = write_manifest(self.root, ["member-a", "shared"], ["shared"])
        problems = vcw.validate(manifest)
        self.assertEqual(len(problems), 1)
        self.assertIn("members/exclude overlap", problems[0])
        self.assertIn("shared", problems[0])

    def test_rejects_duplicate_entries(self) -> None:
        manifest = write_manifest(self.root, ["member-a"], ["excluded-a", "excluded-a"])
        problems = vcw.validate(manifest)
        self.assertTrue(any("duplicate exclude entries" in p for p in problems))

    def test_rejects_unlisted_crate_directory(self) -> None:
        manifest = write_manifest(self.root, ["member-a"], ["excluded-a"])
        stray = self.root / "stray"
        stray.mkdir()
        (stray / "Cargo.toml").write_text('[package]\nname = "stray"\nversion = "0.0.0"\n')
        problems = vcw.validate(manifest)
        self.assertTrue(any("neither list" in p for p in problems))

    def test_effective_excludes_drops_members(self) -> None:
        manifest = write_manifest(self.root, ["member-a", "shared"], ["shared", "excluded-a"])
        workspace = vcw.load_workspace(manifest)
        self.assertEqual(vcw.effective_excludes(workspace), ["excluded-a"])

    def test_real_manifest_is_consistent(self) -> None:
        problems = vcw.validate(vcw.DEFAULT_MANIFEST)
        self.assertEqual(problems, [], "contracts/Cargo.toml must keep members/exclude disjoint")


if __name__ == "__main__":
    unittest.main()
