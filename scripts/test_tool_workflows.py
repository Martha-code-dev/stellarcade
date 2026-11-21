#!/usr/bin/env python3
"""Structural tests for the manifest-driven tools CI matrix.

These guard the properties the issue's Required Tests call out: every
supported tool is enumerated once from the workspace manifest, a failed
build/typecheck/test step fails its matrix job, and installs use a frozen
lockfile whose diff is asserted clean.

Run with: python3 -m unittest discover -s scripts -p 'test_tool_workflows.py'
"""

from __future__ import annotations

import pathlib
import unittest

import yaml

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
MATRIX = "${{ fromJSON(needs.discover-tools.outputs.tools) }}"


def load_workflow(name: str) -> dict:
    with (REPO_ROOT / ".github" / "workflows" / name).open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def steps_containing(job: dict, needle: str) -> list[str]:
    return [
        step.get("name", step.get("run", ""))
        for step in job["steps"]
        if needle in step.get("run", "")
    ]


class ToolWorkflowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.lint = load_workflow("lint.yml")
        self.test_web = load_workflow("test-web.yml")

    def test_pnpm_workspace_declares_tools(self) -> None:
        text = (REPO_ROOT / "pnpm-workspace.yaml").read_text()
        self.assertIn('"tools/*"', text)

    def test_both_workflows_discover_from_the_same_manifest_script(self) -> None:
        for workflow in (self.lint, self.test_web):
            discover = workflow["jobs"]["discover-tools"]
            output = discover["outputs"]["tools"]
            self.assertIn("steps.discover.outputs.tools", output)
            run = next(s["run"] for s in discover["steps"] if s.get("id") == "discover")
            self.assertIn("node scripts/workspace_tools.mjs", run)

    def test_check_tools_matrix_builds_and_typechecks_every_tool(self) -> None:
        job = self.lint["jobs"]["check-tools"]
        self.assertEqual(job["needs"], "discover-tools")
        self.assertEqual(job["strategy"]["matrix"]["tool"], MATRIX)
        self.assertIs(job["strategy"]["fail-fast"], False)
        self.assertGreaterEqual(len(steps_containing(job, "run build")), 1)
        self.assertGreaterEqual(len(steps_containing(job, "tsc --noEmit")), 1)

    def test_test_tools_matrix_runs_every_tool_once_in_one_shot_mode(self) -> None:
        job = self.test_web["jobs"]["test-tools"]
        self.assertEqual(job["needs"], "discover-tools")
        self.assertEqual(job["strategy"]["matrix"]["tool"], MATRIX)
        self.assertIs(job["strategy"]["fail-fast"], False)
        runs = steps_containing(job, "exec vitest run")
        self.assertEqual(len(runs), 1)
        self.assertNotIn("run test -- --run", job["steps"][-1]["run"])

    def test_frozen_install_and_lockfile_diff_guard_both_jobs(self) -> None:
        for job in (self.lint["jobs"]["check-tools"], self.test_web["jobs"]["test-tools"]):
            self.assertEqual(len(steps_containing(job, "pnpm install --frozen-lockfile")), 1)
            self.assertEqual(len(steps_containing(job, "git diff --exit-code -- pnpm-lock.yaml")), 1)


if __name__ == "__main__":
    unittest.main()
