"""Unit tests for subtitle parsing and YouTube id extraction (no network)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.main import extract_youtube_id, parse_vtt, parse_json3  # noqa: E402


class ExtractIdTests(unittest.TestCase):
    def test_watch_url(self):
        self.assertEqual(
            extract_youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            "dQw4w9WgXcQ",
        )

    def test_short_url(self):
        self.assertEqual(extract_youtube_id("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ")

    def test_bare_id(self):
        self.assertEqual(extract_youtube_id("dQw4w9WgXcQ"), "dQw4w9WgXcQ")

    def test_invalid(self):
        with self.assertRaises(ValueError):
            extract_youtube_id("https://example.com/watch?v=nope")


class VttParseTests(unittest.TestCase):
    def test_basic_cues(self):
        sample = """WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello world

2
00:00:04.000 --> 00:00:06.000
Second <b>line</b>
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.vtt"
            path.write_text(sample, encoding="utf-8")
            cues = parse_vtt(path)
        self.assertEqual(len(cues), 2)
        self.assertEqual(cues[0]["text"], "Hello world")
        self.assertEqual(cues[0]["start"], 1.0)
        self.assertEqual(cues[0]["end"], 3.5)
        self.assertEqual(cues[1]["text"], "Second line")


class Json3ParseTests(unittest.TestCase):
    def test_events(self):
        sample = {
            "events": [
                {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "Hi there"}]},
                {"tStartMs": 4000, "dDurationMs": 1000, "segs": [{"utf8": "Again"}]},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.json3"
            path.write_text(__import__("json").dumps(sample), encoding="utf-8")
            cues = parse_json3(path)
        self.assertEqual(cues[0]["text"], "Hi there")
        self.assertEqual(cues[0]["start"], 1.0)
        self.assertEqual(cues[1]["start"], 4.0)


if __name__ == "__main__":
    unittest.main()
