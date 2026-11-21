#!/usr/bin/env python3
"""Generate the source-backed contract inventory embedded in contracts/STATUS.md.

The inventory is derived from two sources of truth only:

* ``contracts/Cargo.toml`` -- which crates are workspace members and which are
  effectively excluded (a crate in both lists is a member).
* ``#[test]`` attributes in each crate's ``.rs`` files -- a mechanical count
  of test attributes, deliberately NOT a measure of test quality or coverage.

Usage::

    python3 scripts/contract_inventory.py             # print the markdown block
    python3 scripts/contract_inventory.py --check     # fail if STATUS.md is stale

``--check`` is what CI (and scripts/test_contract_inventory.py) uses to keep
the committed documentation in sync with the repository.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

from validate_contract_workspace import (
    DEFAULT_MANIFEST,
    effective_excludes,
    load_workspace,
    validate,
)

REPO_ROOT = DEFAULT_MANIFEST.parents[1]
STATUS_MD = DEFAULT_MANIFEST.parent / "STATUS.md"
BEGIN = "<!-- BEGIN GENERATED CONTRACT INVENTORY -->"
END = "<!-- END GENERATED CONTRACT INVENTORY -->"
TEST_ATTR_RE = re.compile(r"#\[test\]")
SKIP_DIRS = {"target", "test_snapshots", ".git"}


def rust_files(crate_dir: pathlib.Path) -> list[pathlib.Path]:
    """All .rs files in a crate, excluding build output and snapshots."""
    return [
        path
        for path in crate_dir.rglob("*.rs")
        if not any(part in SKIP_DIRS for part in path.relative_to(crate_dir).parts)
    ]


def count_test_attributes(crate_dir: pathlib.Path) -> int:
    """Count literal #[test] attributes in a crate's Rust source."""
    return sum(
        len(TEST_ATTR_RE.findall(path.read_text(encoding="utf-8", errors="ignore")))
        for path in rust_files(crate_dir)
    )


def build_inventory(manifest: pathlib.Path = DEFAULT_MANIFEST) -> str:
    """Return the markdown inventory block, derived entirely from ``manifest``."""
    workspace = load_workspace(manifest)
    members = list(workspace.get("members", []))
    excludes = effective_excludes(workspace)
    root = manifest.parent
    crate_dirs = sorted(
        path.name
        for path in root.iterdir()
        if path.is_dir() and (path / "Cargo.toml").is_file()
    )

    lines = [
        BEGIN,
        "### Source-backed workspace inventory",
        "",
        "Generated from `contracts/Cargo.toml` and `#[test]` attributes in each crate's",
        "`.rs` files by `python3 scripts/contract_inventory.py`. Re-run it and commit the",
        "result whenever membership or test attributes change;",
        "`python3 scripts/contract_inventory.py --check` fails when this block is stale.",
        "",
        f"- Workspace members: **{len(members)}**",
        f"- Effectively excluded crates: **{len(excludes)}** (a crate listed in both",
        "  `members` and `exclude` is a member, not an exclusion)",
        f"- Crate directories containing a `Cargo.toml`: **{len(crate_dirs)}**",
        "",
        "**Excluded crates** (" + str(len(excludes)) + "): "
        + ", ".join(f"`{name}`" for name in excludes)
        + ".",
        "",
        "#### Test attributes by crate",
        "",
        "| Crate | Membership | `#[test]` attributes |",
        "| --- | --- | ---: |",
    ]
    for name in crate_dirs:
        membership = "member" if name in members else "excluded"
        lines.append(f"| `{name}` | {membership} | {count_test_attributes(root / name)} |")

    lines += [
        "",
        "> **A test count is not a security sign-off.** These numbers count `#[test]`",
        "> attributes mechanically. They do not say what a test asserts, whether it is",
        "> enabled in CI, whether a crate is authorized correctly, or whether its",
        "> Soroban release build passes. Nothing in this document certifies any crate as",
        "> audited or production-ready; that requires a separate review recorded in the",
        "> linked issue and PR.",
        END,
    ]
    return "\n".join(lines)


def check(manifest: pathlib.Path = DEFAULT_MANIFEST, status: pathlib.Path = STATUS_MD) -> list[str]:
    """Return reasons the committed STATUS.md block is stale; empty means current."""
    problems = validate(manifest)
    if problems:
        return ["Cargo.toml is inconsistent: " + "; ".join(problems)]

    text = status.read_text(encoding="utf-8")
    if BEGIN not in text or END not in text:
        return [f"STATUS.md is missing the {BEGIN} / {END} markers"]

    start = text.index(BEGIN)
    end = text.index(END, start) + len(END)
    committed = text[start:end]
    generated = build_inventory(manifest)
    if committed != generated:
        return ["STATUS.md inventory block does not match Cargo.toml and current #[test] attributes"]
    return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify STATUS.md is in sync")
    parser.add_argument("--manifest", type=pathlib.Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--status", type=pathlib.Path, default=STATUS_MD)
    args = parser.parse_args(argv)

    if args.check:
        problems = check(args.manifest, args.status)
        for problem in problems:
            print(f"STALE: {problem}", file=sys.stderr)
        if not problems:
            print("Contract inventory is in sync with Cargo.toml and #[test] attributes.")
        return 1 if problems else 0

    print(build_inventory(args.manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
