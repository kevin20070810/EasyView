# -*- coding: utf-8 -*-
"""绑定器测试：模型草稿 → 0.3 ui_schema，并交给官方校验器检查。

不调用任何 API —— 草稿是写死的，用来验证绑定逻辑本身。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # tests/
SERVICE = HERE.parent                           # ai-service/
sys.path.insert(0, str(SERVICE))

from binder import bind  # noqa: E402

REPO = SERVICE.parent
EXAMPLES = REPO / "docs" / "examples"
VALIDATOR_PATH = REPO / "docs" / "drafts" / "ui-schema-0.3" / "validate.py"

_spec = importlib.util.spec_from_file_location("draft_validator", VALIDATOR_PATH)
assert _spec and _spec.loader
validator = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(validator)

GENERATED_AT = "2026-10-02T21:00:00+08:00"
GENERATOR = {"mode": "model", "prompt_version": "senior-v0.3.1", "fallback_reason": None}

_ok = 0
_fail = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global _ok, _fail
    if condition:
        _ok += 1
        print(f"  [PASS] {label}")
    else:
        _fail += 1
        print(f"  [FAIL] {label} {detail}")


def load(name: str) -> tuple[dict, bytes]:
    path = EXAMPLES / f"elements.{name}.json"
    raw = path.read_bytes()
    return json.loads(raw.decode("utf-8-sig")), raw


# 模拟模型输出：故意混入几种"脏"情况，看绑定器能不能挡住
HOSPITAL_DRAFT = {
    "greeting": "您好，这里是市第一人民医院网上服务，您想先办哪件事？",
    "summary": "挂号、看报告、缴费和查医保都可以从这里开始。",
    "cards": [
        {"title": "我要挂号", "subtitle": "打开医院的预约挂号入口", "element_id": "el_514efc10",
         "evidence_field": "text", "intent": "book", "icon": "calendar", "reason": "就医主流程里最常用的入口。"},
        {"title": "我要看报告", "subtitle": "查看检验检查结果", "element_id": "el_816c3fc2",
         "evidence_field": "text", "intent": "query", "icon": "document", "reason": "涉及个人就医数据。"},
        {"title": "我要缴费", "subtitle": "缴纳就医费用", "element_id": "el_d4e15498",
         "evidence_field": "text", "intent": "pay", "icon": "payment", "reason": "涉及钱款，扩展不得代办。"},
        {"title": "我要查医保", "subtitle": "查询医保信息", "element_id": "el_20acb35b",
         "evidence_field": "text", "intent": "query", "icon": "search", "reason": "涉及个人参保信息。"},
        {"title": "看门诊排班", "subtitle": "查看科室、医生和出诊时间", "element_id": "el_733e3e79",
         "evidence_field": "text", "intent": "query", "icon": "calendar", "reason": "选就诊时间时要用。"},
        {"title": "联系在线客服", "subtitle": "找医院工作人员问事情", "element_id": "el_177a57da",
         "evidence_field": "text", "intent": "contact", "icon": "phone", "reason": "需要人帮忙时用。"},
        # ↓ 下面几张故意有问题，应该被丢弃
        {"title": "这个标题特别特别长超过十二个字了", "element_id": "el_fd42c274", "intent": "book"},
        {"title": "不存在的元素", "element_id": "el_deadbeef", "intent": "query"},
        {"title": "点提交按钮", "element_id": "el_0a5dde7d", "intent": "apply"},
    ],
}


def main() -> int:
    elements, raw = load("hospital")

    print("=== 1. 绑定器丢弃了不该留的卡片 ===")
    dropped: list[str] = []
    ui = bind(HOSPITAL_DRAFT, elements, raw, generated_at=GENERATED_AT,
              generator=GENERATOR, dropped_report=dropped)
    print(f"  进入草稿 {len(HOSPITAL_DRAFT['cards'])} 张 → 绑定后 {len(ui['cards'])} 张")
    for reason in dropped:
        print(f"    · {reason}")
    check("超长标题被丢弃", any("超过 12 字" in r for r in dropped))
    check("不存在的元素被丢弃", any("不存在" in r for r in dropped))
    check("留下的都是可执行的", len(ui["cards"]) == 7, f"实际 {len(ui['cards'])}")

    print()
    print("=== 2. 交给 0.3 官方校验器 ===")
    errors = validator.validate(ui, elements, raw)
    if errors:
        for e in errors:
            print(f"    ❌ {e}")
    check("通过 validate.py 全部检查", not errors, f"{len(errors)} 项错误")

    print()
    print("=== 3. 策略程序判定的风险等级 ===")
    for card in ui["cards"]:
        print(f"    [{card['risk']['level']:<9}] {card['title']:<8} "
              f"{card['action']['kind']:<8} 确认={'有' if card['action']['confirmation'] else '无'}  "
              f"{'/'.join(card['risk']['reason_codes'])}")
    by_title = {c["title"]: c for c in ui["cards"]}
    check("缴费 → blocked", by_title["我要缴费"]["risk"]["level"] == "blocked")
    check("缴费 → 原因含 payment", "payment" in by_title["我要缴费"]["risk"]["reason_codes"])
    check("缴费 → 域含 money", "money" in by_title["我要缴费"]["risk"]["domains"])
    check("报告 → sensitive 且有确认",
          by_title["我要看报告"]["risk"]["level"] == "sensitive"
          and by_title["我要看报告"]["action"]["confirmation"] is not None)
    check("排班 → normal 且无确认",
          by_title["看门诊排班"]["risk"]["level"] == "normal"
          and by_title["看门诊排班"]["action"]["confirmation"] is None)
    check("挂号 → blocked（与 golden_cases 的判定一致）",
          by_title["我要挂号"]["risk"]["level"] == "blocked"
          and "medical_submission" in by_title["我要挂号"]["risk"]["reason_codes"]
          and "healthcare" in by_title["我要挂号"]["risk"]["domains"])
    check("同站链接用 navigate，不是 external",
          by_title["我要挂号"]["action"]["kind"] == "navigate",
          by_title["我要挂号"]["action"]["kind"])

    print()
    print("=== 3b. scroll 卡的文案必须诚实 ===")
    scroll_cards = [c for c in ui["cards"] if c["action"]["kind"] == "scroll"]
    for card in scroll_cards:
        print(f"    {card['title']} → {card['subtitle']}")
    check("scroll 卡不承诺自动点击",
          all("由您自己操作" in (c["subtitle"] or "") for c in scroll_cards))

    print()
    print("=== 4. 定位字段是从 elements.json 抄的，不是模型给的 ===")
    source = {e["id"]: e for e in elements["elements"]}
    all_match = True
    for card in ui["cards"]:
        target = source[card["action"]["target_element_id"]]
        if card["action"]["target_selector"] != target["selector"]:
            all_match = False
            print(f"    ❌ {card['title']} selector 不一致")
        if any(ev["quote"] != source[ev["element_id"]].get(ev["field"])
               for ev in card["provenance"]["evidence"]):
            all_match = False
            print(f"    ❌ {card['title']} evidence quote 与原文不符")
    check("selector / xpath / quote 全部与源数据逐字一致", all_match)

    print()
    print("=== 5. 文案里没有 URL / 路径 / 技术词 ===")
    clean = True
    for card in ui["cards"]:
        for text in (card["title"], card["subtitle"] or "", card["ranking"]["explanation"]):
            if validator.TECHNICAL_COPY.search(text):
                clean = False
                print(f"    ❌ 命中技术文案: {text}")
    if validator.TECHNICAL_COPY.search(ui["page"]["greeting"]):
        clean = False
        print(f"    ❌ greeting: {ui['page']['greeting']}")
    check("呈现文案干净", clean)

    print()
    print("=== 6. 统计字段是数出来的，不是模型自报的 ===")
    stats = ui["stats"]
    print(f"    {json.dumps(stats, ensure_ascii=False)}")
    check("input_elements 与输入一致", stats["input_elements"] == len(elements["elements"]))
    check("task_cards 与实际卡片数一致", stats["task_cards"] == len(ui["cards"]))
    referenced = set()
    for card in ui["cards"]:
        referenced.update(card["provenance"]["source_element_ids"])
    check("referenced_elements 等于并集大小", stats["referenced_elements"] == len(referenced))
    check("priority 是连续的 1..N",
          sorted(c["priority"] for c in ui["cards"]) == list(range(1, len(ui["cards"]) + 1)))

    print()
    print("=== 7. 空结果必须如实返回 empty，而不是硬凑 ===")
    empty = bind({"greeting": "您好"}, elements, raw, generated_at=GENERATED_AT,
                 generator={**GENERATOR, "mode": "rules", "prompt_version": None})
    check("state=empty", empty["state"] == "empty")
    check("empty_reason 已填", empty["empty_reason"] == "no_reliable_tasks")
    check("cards 为空", empty["cards"] == [])
    check("空结果也通过校验器", not validator.validate(empty, elements, raw),
          str(validator.validate(empty, elements, raw)[:2]))

    print()
    print("=== 8. 模型的风险提示只能升级，且必须自洽 ===")
    from binder import _apply_model_hint  # noqa: PLC0415

    lv, rs, dm = _apply_model_hint("sensitive", "normal", ["read_only"], [])
    check("normal 被模型抬到 sensitive 时原因码同步换成 personal_data",
          lv == "sensitive" and rs == ["personal_data"], f"{lv} {rs}")

    lv, rs, dm = _apply_model_hint("blocked", "sensitive", ["personal_data"], ["healthcare"])
    check("sensitive 被抬到 blocked 时原因码换成 blocked 原因，且保留已判定的域",
          lv == "blocked" and rs == ["unknown_effect"] and "healthcare" in dm, f"{lv} {rs} {dm}")

    lv, rs, dm = _apply_model_hint("normal", "blocked", ["payment"], ["money"])
    check("模型想把 blocked 降成 normal 时被忽略",
          lv == "blocked" and rs == ["payment"], f"{lv} {rs}")

    print()
    print("=" * 46)
    print(f"结果: {_ok} 通过 / {_fail} 失败")
    print("=" * 46)
    return 1 if _fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
