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

from builder import (  # noqa: E402
    BuilderError,
    build_summary,
    build_ui_schema,
    is_clear_action_title,
    judge_importance,
    looks_like_news_or_marketing,
)
from llm_client import AIError  # noqa: E402
from pipeline import analyze  # noqa: E402

FIXED_TIME = datetime.fromisoformat("2026-10-02T10:00:00+08:00")


class BrokenClient:
    """模拟模型调用失败，用来验证降级到规则引擎。

    新架构下客户端只需要 analyze_draft(digest, *, feedback=None) 返回任务草稿。
    """

    prompt_version = "broken-test"

    def analyze_draft(self, digest, *, feedback=None):
        raise AIError("simulated failure")


class BuilderTests(unittest.TestCase):
    def fixture(self, name: str) -> dict:
        path = REPO_DIR / "docs" / "examples" / f"elements.{name}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_pipeline_output_is_valid_0_3(self):
        """两条路径都必须产出能通过 0.3 校验的 schema。

        早先 builder.py 直接输出 0.1.0-draft，而仓库声明的是 0.2.0-draft，
        版本漂移被目录结构掩盖（ai-service 原在独立分支工作区，那里的 docs/ 是旧 schema）。
        现在规则草稿和模型草稿是同构的，都经过绑定器，版本不再漂移。
        """
        for name in ("hospital", "gov", "traffic"):
            with self.subTest(name=name):
                path = REPO_DIR / "docs" / "examples" / f"elements.{name}.json"
                raw = path.read_bytes()
                result = analyze(json.loads(raw.decode("utf-8-sig")), raw)
                self.assertEqual(result.problems, [], f"{name} 校验问题: {result.problems}")
                self.assertEqual(result.mode, "rules")
                self.assertEqual(result.ui_schema["schema_version"], "0.3.0-draft")
                self.assertGreaterEqual(len(result.ui_schema["cards"]), 1)
                self.assertLessEqual(len(result.ui_schema["cards"]), 7)

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

    def test_real_site_news_and_marketing_titles_are_filtered(self):
        bad_titles = (
            "办理留抵退税2818亿元",
            "以人民为中心你对养老、托育、教育",
            "计次订票开售直刷乘车、出行乐无忧",
            "铁路畅行惠享出行尊享体验",
        )
        for title in bad_titles:
            with self.subTest(title=title):
                self.assertEqual(judge_importance(title), "low")
                self.assertTrue(looks_like_news_or_marketing(title))

        texts = [*bad_titles, "预约挂号", "查看报告", "缴费"]
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://example.test/",
            "page_title": "真实站点",
            "source": "live",
            "stats": {"total": len(texts), "visible": len(texts), "by_type": {}, "truncated": False},
            "elements": [
                {
                    "id": f"el_{index:08x}",
                    "type": "link",
                    "text": text,
                    "visible": True,
                    "order": index,
                }
                for index, text in enumerate(texts)
            ],
            "groups": [],
        }
        result = build_ui_schema(data, generated_at=FIXED_TIME)
        titles = [card["title"] for card in result["cards"]]
        for title in bad_titles:
            self.assertNotIn(title, titles)
        self.assertEqual(titles, ["我要挂号", "查看报告", "缴费"])

    def test_business_entries_are_not_mistaken_for_news(self):
        for title in ("开通电子医保凭证", "查惠民补贴", "预约挂号", "查政策"):
            with self.subTest(title=title):
                self.assertFalse(looks_like_news_or_marketing(title))
                self.assertNotEqual(judge_importance(title), "low")

    def test_short_policy_and_knowledge_headlines_are_filtered(self):
        bad_titles = (
            "医保新政策",
            "养老服务体系建设",
            "购票新规",
            "健康知识科普",
            "积分兑换攻略",
            "个人养老金政策",
        )
        for title in bad_titles:
            with self.subTest(title=title):
                self.assertTrue(looks_like_news_or_marketing(title))
                self.assertEqual(judge_importance(title), "low")

        for title in ("查政策", "医保政策查询", "办理医保"):
            with self.subTest(title=title):
                self.assertFalse(looks_like_news_or_marketing(title))

    def test_noun_only_entries_become_clear_action_titles(self):
        texts = ("社保医保", "住院服务", "ETC服务")
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://service.test/",
            "page_title": "动作标题测试",
            "source": "live",
            "stats": {"total": 3, "visible": 3, "by_type": {"link": 3}, "truncated": False},
            "elements": [
                {"id": f"el_{index:08x}", "type": "link", "text": value, "visible": True, "order": index}
                for index, value in enumerate(texts, start=1)
            ],
            "groups": [],
        }
        result = build_ui_schema(data, generated_at=FIXED_TIME)
        titles = [card["title"] for card in result["cards"]]
        self.assertEqual(titles, ["查社保医保", "查看住院服务", "查ETC服务"])
        self.assertTrue(all(is_clear_action_title(title) for title in titles))

    def test_fixture_titles_are_expected_action_phrases(self):
        expected = {
            "hospital": ["我要挂号", "查看报告", "缴费", "查医保", "查看就医指南", "查看住院服务"],
            "gov": ["查办事指南", "查社保医保", "办医保", "查公积金", "开户籍证明", "查社保缴费"],
            "traffic": ["查违章", "办证件", "查公交", "坐地铁", "打车", "查ETC服务"],
        }
        for name, titles in expected.items():
            with self.subTest(name=name):
                result = build_ui_schema(self.fixture(name), generated_at=FIXED_TIME)
                self.assertEqual([card["title"] for card in result["cards"]], titles)
                for card in result["cards"]:
                    self.assertTrue(
                        is_clear_action_title(card["title"]),
                        f"{name}: 标题不是明确动作短语: {card['title']}",
                    )

    def test_summary_is_natural_chinese(self):
        result = build_ui_schema(self.fixture("hospital"), generated_at=FIXED_TIME)
        self.assertEqual(result["page"]["summary"], "这里可以挂号、查看报告、缴费和查医保")
        self.assertEqual(build_summary(["我要挂号"]), "这里可以挂号")

    def test_truncated_input_prefers_visible_candidates(self):
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://example.test/",
            "page_title": "截断页面",
            "source": "live",
            "stats": {
                "total": 4,
                "visible": 1,
                "by_type": {"form": 1, "input": 1, "submit": 1, "link": 1},
                "truncated": True,
            },
            "elements": [
                {
                    "id": "el_aaaaaaaa",
                    "type": "form",
                    "text": "预约挂号",
                    "visible": False,
                    "order": 0,
                    "form_id": "form_cccccccc",
                },
                {
                    "id": "el_bbbbbbbb",
                    "type": "input",
                    "text": "",
                    "label": "姓名",
                    "visible": False,
                    "order": 1,
                    "form_id": "form_cccccccc",
                },
                {
                    "id": "el_dddddddd",
                    "type": "submit",
                    "text": "提交",
                    "visible": False,
                    "order": 2,
                    "form_id": "form_cccccccc",
                },
                {
                    "id": "el_eeeeeeee",
                    "type": "link",
                    "text": "查看报告",
                    "visible": True,
                    "order": 3,
                },
            ],
            "groups": [
                {
                    "id": "form_cccccccc",
                    "type": "form",
                    "label": "预约挂号",
                    "element_ids": ["el_aaaaaaaa", "el_bbbbbbbb", "el_dddddddd"],
                }
            ],
        }
        result = build_ui_schema(data, generated_at=FIXED_TIME)
        self.assertEqual([card["title"] for card in result["cards"]], ["查看报告"])
        input_stats = result["extensions"]["input_stats"]
        self.assertTrue(input_stats["truncated"])
        self.assertEqual(input_stats["by_type"]["link"], 1)

    def test_sparse_page_adds_visible_scroll_fallbacks(self):
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://example.test/",
            "page_title": "稀疏医院首页",
            "source": "live",
            "stats": {"total": 4, "visible": 4, "by_type": {}, "truncated": False},
            "elements": [
                {"id": "el_00000001", "type": "link", "text": "预约挂号", "visible": True, "order": 0},
                {"id": "el_00000002", "type": "heading", "text": "科室导航", "visible": True, "order": 1},
                {"id": "el_00000003", "type": "heading", "text": "专家团队", "visible": True, "order": 2},
                {"id": "el_00000004", "type": "heading", "text": "就医指南", "visible": True, "order": 3},
            ],
            "groups": [],
        }
        result = build_ui_schema(data, generated_at=FIXED_TIME)
        known_ids = {element["id"] for element in data["elements"]}
        self.assertGreaterEqual(len(result["cards"]), 4)
        self.assertEqual(result["cards"][0]["title"], "我要挂号")
        self.assertTrue(any(card["action"]["kind"] == "scroll" for card in result["cards"]))
        for card in result["cards"]:
            self.assertIn(card["action"]["target_element_id"], known_ids)

    def test_external_actions_only_for_safe_external_targets(self):
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://example.test/start",
            "page_title": "外链测试",
            "source": "live",
            "stats": {"total": 4, "visible": 4, "by_type": {"link": 4}, "truncated": False},
            "elements": [
                {
                    "id": "el_00000101", "type": "link", "text": "查办事指南",
                    "href": "https://example.test/guide", "visible": True, "order": 0,
                },
                {
                    "id": "el_00000102", "type": "link", "text": "拨打客服",
                    "href": "tel:12345", "visible": True, "order": 1,
                },
                {
                    "id": "el_00000103", "type": "link", "text": "查政策",
                    "href": "https://other.test/policy", "visible": True, "order": 2,
                },
                {
                    "id": "el_00000104", "type": "link", "text": "查询进度",
                    "href": "javascript:alert(1)", "visible": True, "order": 3,
                },
            ],
            "groups": [],
        }
        result = build_ui_schema(data, generated_at=FIXED_TIME)
        by_title = {card["title"]: card for card in result["cards"]}

        same_site = by_title["查办事指南"]["action"]
        self.assertEqual(same_site["kind"], "navigate")
        self.assertIsNone(same_site["href"])
        self.assertEqual(same_site["target_element_id"], "el_00000101")

        phone = by_title["拨打客服"]["action"]
        self.assertEqual(phone["kind"], "external")
        self.assertEqual(phone["href"], "tel:12345")
        self.assertEqual(phone["target_element_id"], "el_00000102")

        other_site = by_title["查政策"]["action"]
        self.assertEqual(other_site["kind"], "external")
        self.assertEqual(other_site["href"], "https://other.test/policy")

        unsafe = by_title["查进度"]["action"]
        self.assertEqual(unsafe["kind"], "navigate")
        self.assertIsNone(unsafe["href"])

        derived = result["extensions"]["input_stats"]
        self.assertEqual(derived["card_count"], 4)
        self.assertEqual(derived["external_count"], 2)
        self.assertEqual(derived["visible_ratio"], 1.0)
        self.assertFalse(derived["sparse_fallback_used"])

    def test_image_only_sparse_page_uses_scroll_not_fake_navigation(self):
        image_ids = [f"el_0000020{index}" for index in range(1, 6)]
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://hospital.test/",
            "page_title": "图片导航医院首页",
            "source": "live",
            "stats": {"total": 5, "visible": 5, "by_type": {"image": 5}, "truncated": False},
            "elements": [
                {"id": image_ids[0], "type": "image", "text": "预约挂号", "visible": True, "order": 0},
                {"id": image_ids[1], "type": "image", "text": "医保查询", "visible": True, "order": 1},
                {"id": image_ids[2], "type": "image", "text": "科室导航", "visible": True, "order": 2},
                {"id": image_ids[3], "type": "image", "text": "查看报告", "visible": True, "order": 3},
                {"id": image_ids[4], "type": "image", "text": "专家团队", "visible": True, "order": 4},
            ],
            "groups": [
                {
                    "id": "grp_00000201", "type": "nav", "label": "就医指南",
                    "element_ids": image_ids,
                }
            ],
        }
        result = build_ui_schema(data, generated_at=FIXED_TIME)
        self.assertGreaterEqual(len(result["cards"]), 4)
        self.assertTrue(any(card["title"] == "查看就医指南" for card in result["cards"]))
        for card in result["cards"]:
            self.assertEqual(card["action"]["kind"], "scroll")
            self.assertIn(card["action"]["target_element_id"], image_ids)
        derived = result["extensions"]["input_stats"]
        self.assertGreaterEqual(derived["scroll_count"], 4)
        self.assertTrue(derived["sparse_fallback_used"])
        self.assertEqual(derived["external_count"], 0)

    def test_core_services_rank_before_contact_and_guides(self):
        data = {
            "schema_version": "1.0.0",
            "page_url": "https://service.test/",
            "page_title": "排序测试",
            "source": "live",
            "stats": {"total": 5, "visible": 5, "by_type": {"link": 5}, "truncated": False},
            "elements": [
                {"id": "el_00000301", "type": "link", "text": "联系客服", "href": "https://service.test/contact", "visible": True, "order": 0},
                {"id": "el_00000302", "type": "link", "text": "就医指南", "href": "https://service.test/guide", "visible": True, "order": 1},
                {"id": "el_00000303", "type": "link", "text": "办证件", "href": "https://service.test/id", "visible": True, "order": 2},
                {"id": "el_00000304", "type": "link", "text": "医保查询", "href": "https://service.test/insurance", "visible": True, "order": 3},
                {"id": "el_00000305", "type": "link", "text": "查违章", "href": "https://service.test/violation", "visible": True, "order": 4},
            ],
            "groups": [],
        }
        titles = [card["title"] for card in build_ui_schema(data, generated_at=FIXED_TIME)["cards"]]
        self.assertLess(titles.index("查违章"), titles.index("办证件"))
        self.assertLess(titles.index("办证件"), titles.index("联系客服"))
        self.assertLess(titles.index("查医保"), titles.index("查看就医指南"))

    def test_empty_elements_raises_clean_error(self):
        data = self.fixture("hospital")
        data["elements"] = []
        data["groups"] = []
        with self.assertRaises(BuilderError):
            build_ui_schema(data, generated_at=FIXED_TIME)

    def test_model_failure_falls_back_to_rules(self):
        """模型挂掉不能阻断基础功能 —— 0.3 要求的最后一道防线。"""
        path = REPO_DIR / "docs" / "examples" / "elements.hospital.json"
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8-sig"))
        result = analyze(data, raw, ai_client=BrokenClient())
        self.assertEqual(result.mode, "rules")
        self.assertEqual(result.fallback_reason, "network_error")
        self.assertEqual(result.ui_schema["generator"]["mode"], "rules")
        self.assertEqual(result.ui_schema["generator"]["fallback_reason"], "network_error")
        self.assertGreaterEqual(len(result.ui_schema["cards"]), 1)
        # 降级不是校验失败：problems 必须为空，原因如实记在 notes 里
        self.assertEqual(result.problems, [])
        self.assertTrue(any("模型调用失败" in n for n in result.notes), result.notes)
        self.assertTrue(result.ok)

    def test_analyze_file_rejects_dirty_json(self):
        from pipeline import analyze_file

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("{ broken", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                analyze_file(path)


if __name__ == "__main__":
    unittest.main()