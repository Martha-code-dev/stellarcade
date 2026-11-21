#!/usr/bin/env python3
"""Validate the Soroban contracts Cargo workspace manifest.

A crate listed in both `workspace.members` and `workspace.exclude` is a
member: Cargo ignores its `exclude` entry. Keeping it in both lists is
contradictory and makes the excluded-crates report claim a crate is
excluded when CI actually builds and tests it.

This script is the single source of truth for that invariant. The
excluded-crates-report workflow calls it before generating the report, and
scripts/test_validate_contract_workspace.py exercises it with broken
manifests so the check cannot silently rot.

Exit status: 0 when the manifest is consistent, 1 when it is not.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import tomllib
from typing import Iterable

DEFAULT_MANIFEST = pathlib.Path(__file__).resolve().parents[1] / "contracts" / "Cargo.toml"


def load_workspace(manifest: pathlib.Path) -> dict:
    """Load the `[workspace]` table from a Cargo manifest."""
    with manifest.open("rb") as handle:
        data = tomllib.load(handle)
    return data.get("workspace", {})


def effective_excludes(workspace: dict) -> list[str]:
    """Return excludes with members removed: the crates Cargo really omits."""
    members = set(workspace.get("members", []))
    return [crate for crate in workspace.get("exclude", []) if crate not in members]


def validate(manifest: pathlib.Path, require_dirs: bool = True) -> list[str]:
    """Return a list of human-readable problems; empty means consistent.

    `require_dirs=False` is used by the unit tests with synthetic manifests
    that point at a temporary directory tree.
    """
    workspace = load_workspace(manifest)
    members: list[str] = workspace.get("members", [])
    excludes: list[str] = workspace.get("exclude", [])
    problems: list[str] = []

    overlap = sorted(set(members) & set(excludes))
    if overlap:
        problems.append(
            "members/exclude overlap (these are members, Cargo ignores their exclude entry): "
            + ", ".join(overlap)
        )

    duplicates_members = sorted({name for name in members if members.count(name) > 1})
    if duplicates_members:
        problems.append("duplicate members entries: " + ", ".join(duplicates_members))

    duplicates_excludes = sorted({name for name in excludes if excludes.count(name) > 1})
    if duplicates_excludes:
        problems.append("duplicate exclude entries: " + ", ".join(duplicates_excludes))

    if require_dirs:
        root = manifest.parent
        listed = set(members) | set(excludes)
        missing = sorted(name for name in listed if not (root / name / "Cargo.toml").is_file())
        if missing:
            problems.append("listed crates without a Cargo.toml: " + ", ".join(missing))

        actual = {
            path.name
            for path in root.iterdir()
            if path.is_dir() and (path / "Cargo.toml").is_file()
        }
        unlisted = sorted(actual - listed)
        if unlisted:
            problems.append("crate directories in neither list: " + ", ".join(unlisted))

    return problems


def format_report(manifest: pathlib.Path, problems: Iterable[str]) -> str:
    problems = list(problems)
    lines = [f"Contract workspace check: {manifest}"]
    if not problems:
        workspace = load_workspace(manifest)
        lines.append(
            f"  OK: {len(workspace.get('members', []))} members, "
            f"{len(effective_excludes(workspace))} effective excludes, no overlap."
        )
    else:
        for problem in problems:
            lines.append(f"  ERROR: {problem}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "manifest",
        nargs="?",
        type=pathlib.Path,
        default=DEFAULT_MANIFEST,
        help="path to contracts/Cargo.toml (default: %(default)s)",
    )
    args = parser.parse_args(argv)
    problems = validate(args.manifest)
    print(format_report(args.manifest, problems))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
