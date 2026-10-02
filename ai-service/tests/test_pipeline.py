# -*- coding: utf-8 -*-
"""B 组基础功能自动化测试。"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

AI_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = AI_DIR.parent
sys.path.insert(0, str(AI_DIR))

from builder import BuilderError, build_ui_schema  # noqa: E402
from pipeline import analyze, apply_ai_hints, load_elements_file  # noqa: E402

FIXED_TIME = datetime.fromisoformat("2026-10-02T10:00:00+08:00")


class FakeClient:
    def analyze(self, elements_data, ui_schema):
        cards = ui_schema["cards"]
        return {
            "cards": [
                {
                    "id": cards[-1]["id"],
                    "title": "最后再看",
                    "subtitle": "测试排序",
                    "priority": 1,
                },
                *[
                    {"id": card["id"], "priority": index + 2}
                    for index, card in enumerate(cards[:-1])
                ],
            ]
        }


class BrokenClient:
    def analyze(self, elements_data, ui_schema):
        raise TimeoutError("simulated timeout")


class BuilderTests(unittest.TestCase):
    def fixture(self, name: str) -> dict:
        path = REPO_DIR / "docs" / "examples" / f"elements.{name}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_three_fixtures_match_json_schema(self):
        import jsonschema

        schema = json.loads((REPO_DIR / "docs" / "ui.schema.json").read_text(encoding="utf-8"))
        for name in ("hospital", "gov", "traffic"):
            with self.subTest(name=name):
                result = build_ui_schema(self.fixture(name), generated_at=FIXED_TIME)
                jsonschema.validate(result, schema)
                self.assertGreaterEqual(len(result["cards"]), 1)
                self.assertLessEqual(len(result["cards"]), 6)

    def test_hospital_form_card_is_traceable_and_typed(self):
        result = build_ui_schema(self.fixture("hospital"), generated_at=FIXED_TIME)
        card = result["cards"][0]
        self.assertEqual(card["title"], "我要挂号")
        self.assertEqual(card["action"]["kind"], "form")
        self.assertEqual(card["action"]["target_element_id"], "el_6f230879")
        fields = card["form"]["fields"]
        by_id = {field["element_id"]: field for field in fields}
        self.assertEqual(by_id["el_3a19b50d"]["input_type"], "idcard")
        self.assertEqual(by_id["el_f2848cc3"]["input_type"], "tel")
        self.assertEqual(by_id["el_bf9607cb"]["input_type"], "date")
        self.assertTrue(by_id["el_1ccf3fbc"]["required"])

    def test_low_value_news_is_filtered(self):
        result = build_ui_schema(self.fixture("hospital"), generated_at=FIXED_TIME)
        titles = [card["title"] for card in result["cards"]]
        self.assertNotIn("新闻动态", titles)
        self.assertNotIn("院务公开", titles)
        self.assertIn("查看报告", titles)
        self.assertIn("缴费", titles)

    def test_all_references_exist(self):
        for name in ("hospital", "gov", "traffic"):
            with self.subTest(name=name):
                data = self.fixture(name)
                known_elements = {item["id"] for item in data["elements"]}
                known_groups = {item["id"] for item in data["groups"]}
                result = build_ui_schema(data, generated_at=FIXED_TIME)
                for card in result["cards"]:
                    self.assertIn(card["id"], known_elements | known_groups)
                    action = card["action"]
                    if action["target_element_id"] is not None:
                        self.assertIn(action["target_element_id"], known_elements)
                    if card.get("form"):
                        self.assertIn(card["form"]["submit_element_id"], known_elements)
                        for field in card["form"]["fields"]:
                            self.assertIn(field["element_id"], known_elements)

    def test_empty_elements_raises_clean_error(self):
        data = self.fixture("hospital")
        data["elements"] = []
        data["groups"] = []
        with self.assertRaises(BuilderError):
            build_ui_schema(data, generated_at=FIXED_TIME)

    def test_ai_hints_can_reorder_without_breaking_structure(self):
        data = self.fixture("hospital")
        base = build_ui_schema(data, generated_at=FIXED_TIME)
        updated = apply_ai_hints(base, FakeClient().analyze(data, base))
        self.assertEqual(updated["cards"][0]["id"], base["cards"][-1]["id"])
        self.assertEqual([card["priority"] for card in updated["cards"]], list(range(1, len(updated["cards"]) + 1)))
        before_by_id = {card["id"]: card for card in base["cards"]}
        for card in updated["cards"]:
            self.assertEqual(before_by_id[card["id"]]["action"], card["action"])

    def test_ai_failure_falls_back(self):
        data = self.fixture("hospital")
        result = analyze(data, ai_client=BrokenClient())
        self.assertFalse(result["extensions"]["ai"]["enabled"])
        self.assertEqual(result["cards"][0]["title"], "我要挂号")

    def test_dirty_json_has_clear_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("{ broken", encoding="utf-8")
            with self.assertRaises(BuilderError) as ctx:
                load_elements_file(path)
            self.assertIn("不是合法 JSON", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()