#!/usr/bin/env python3
"""Render arbitrary compiler output as one safe Markdown table cell."""

import re
import sys

_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")


def sanitize(text: str) -> str:
    """Strip ANSI control sequences and collapse text into a single cell.

    Cargo and rustc can emit colour codes even when their output is
    redirected if CI sets CARGO_TERM_COLOR=always. Those bytes, along with
    raw newlines and pipes, corrupt the generated report table.
    """
    cleaned = _ANSI.sub("", text)
    cleaned = cleaned.replace("\r", " ")
    cleaned = " ".join(cleaned.split())
    return cleaned.replace("|", r"\|")


if __name__ == "__main__":
    sys.stdout.write(sanitize(sys.stdin.read()))
