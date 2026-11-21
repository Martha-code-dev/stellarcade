import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sanitize_report_cell import sanitize


class SanitizeReportCellTests(unittest.TestCase):
    def test_strips_cargo_colour_codes(self):
        raw = "\x1b[1m\x1b[91merror\x1b[0m: could not compile `example` (lib)"
        self.assertEqual(sanitize(raw), "error: could not compile `example` (lib)")

    def test_strips_the_exact_escape_pattern_from_issue_1550(self):
        raw = "\x1b[1m\x1b[91merror[E0599]\x1b[0m\x1b[1m: no method named `bump`\x1b[0m"
        self.assertEqual(sanitize(raw), "error[E0599]: no method named `bump`")

    def test_collapses_newlines_tabs_and_carriage_returns(self):
        self.assertEqual(sanitize("first\r\nsecond\tthird"), "first second third")

    def test_escapes_pipes_so_the_table_cell_is_not_split(self):
        self.assertEqual(sanitize("a | b"), r"a \| b")

    def test_leaves_plain_status_text_alone(self):
        self.assertEqual(sanitize("pass"), "pass")


if __name__ == "__main__":
    unittest.main()
