#!/usr/bin/env python3
"""Unit tests for the generated contract inventory in contracts/STATUS.md.

Run with: python3 -m unittest discover -s scripts -p 'test_contract_inventory.py'
"""

from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import contract_inventory as ci  # noqa: E402
import validate_contract_workspace as vcw  # noqa: E402


class ContractInventoryTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_counts_test_attributes_across_rust_files_and_ignores_build_output(self) -> None:
        crate = self.root / "sample"
        (crate / "src").mkdir(parents=True)
        (crate / "src" / "lib.rs").write_text("#[test]\nfn one() {}\n#[test]\nfn two() {}\n")
        (crate / "src" / "test.rs").write_text("#[test]\nfn three() {}\n")
        (crate / "target" / "generated.rs").parent.mkdir()
        (crate / "target" / "generated.rs").write_text("#[test]\nfn ignored() {}\n")

        self.assertEqual(ci.count_test_attributes(crate), 3)

    def test_inventory_uses_effective_excludes(self) -> None:
        manifest = vcw.DEFAULT_MANIFEST
        workspace = vcw.load_workspace(manifest)
        overlap = sorted(set(workspace["members"]) & set(workspace["exclude"]))
        self.assertEqual(overlap, [], "fixture assumes a consistent manifest")

        block = ci.build_inventory(manifest)
        self.assertIn("| `coin-flip` | member | 44 |", block)
        self.assertIn("| `dice-roll` | member | 34 |", block)
        self.assertIn("| `prize-pool` | member | 34 |", block)

    def test_inventory_omits_removed_crates(self) -> None:
        block = ci.build_inventory()
        for removed in ("arena-reserves", "badge-claims-v2", "treasury-streams"):
            self.assertNotIn(removed, block)

    def test_inventory_separates_counts_from_security_signoff(self) -> None:
        block = ci.build_inventory()
        self.assertIn("A test count is not a security sign-off", block)

    def test_committed_status_matches_generated_block(self) -> None:
        self.assertEqual(ci.check(), [])

    def test_check_detects_a_stale_block(self) -> None:
        stale = self.root / "STATUS.md"
        stale.write_text(ci.build_inventory().replace("| `coin-flip` | member | 44 |", "| `coin-flip` | member | 0 |"))
        problems = ci.check(status=stale)
        self.assertTrue(any("does not match" in p for p in problems))

    def test_check_rejects_a_manifest_with_member_exclude_overlap(self) -> None:
        bad_manifest = self.root / "Cargo.toml"
        (self.root / "shared").mkdir()
        (self.root / "shared" / "Cargo.toml").write_text('[package]\nname = "shared"\n')
        bad_manifest.write_text(
            '[workspace]\nmembers = ["shared"]\nexclude = ["shared"]\n'
        )
        problems = ci.check(manifest=bad_manifest, status=vcw.DEFAULT_MANIFEST.parent / "STATUS.md")
        self.assertTrue(any("inconsistent" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
