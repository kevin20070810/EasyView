# -*- coding: utf-8 -*-
"""跑 golden_cases 评测：规则引擎 vs 模型，并给出机器可判的覆盖报告。

用法：
    cd ai-service
    python tools/eval_golden.py              # 只跑规则引擎，不花钱
    python tools/eval_golden.py --ai         # 接模型（需 EASYVIEW_API_KEY）
    python tools/eval_golden.py --ai --output out/

注意：语义质量最终要人看。本工具只判三件机器能确定的事 ——
产出是否通过 0.3 校验、是否覆盖 golden_cases 的 must_keep 任务、成本与延迟。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

SERVICE = pathlib.Path(__file__).resolve().parents[1]
REPO = SERVICE.parent
sys.path.insert(0, str(SERVICE))

from llm_client import LlmConfig, OpenAICompatibleClient  # noqa: E402
from pipeline import analyze  # noqa: E402

EXAMPLES = REPO / "docs" / "examples"
GOLDEN = REPO / "docs" / "drafts" / "ui-schema-0.3" / "golden_cases.json"

# golden_cases 的 must_keep_card_ids → 判定关键词。
# 这是人工映射，用于机器初筛；语义是否真的等价仍需人工评审。
MUST_KEEP_KEYWORDS = {
    "hospital": {
        "card_hospital_booking": ("挂号", "预约"),
        "card_hospital_report": ("报告",),
        "card_hospital_payment": ("缴费", "费用", "付费", "交费"),
        "card_hospital_contact": ("联系", "客服", "电话", "咨询"),
    },
    "gov": {
        "card_gov_guide": ("指南", "办事"),
        "card_gov_retirement": ("退休",),
        "card_gov_progress": ("进度",),
        "card_gov_materials": ("材料",),
        "card_gov_phone": ("电话", "联系", "咨询"),
    },
    "traffic": {
        "card_traffic_bus": ("公交", "巴士"),
        "card_traffic_metro": ("地铁",),
        "card_traffic_concessions": ("优惠", "老年", "免费", "敬老"),
        "card_traffic_contact": ("联系", "客服", "电话", "咨询"),
    },
}


def short(card_id: str, name: str) -> str:
    return card_id.replace("card_", "").replace(f"{name}_", "")


def coverage(name: str, ui: dict) -> tuple[list[str], list[str]]:
    produced = " ".join(f"{c['title']} {c['subtitle'] or ''}" for c in ui.get("cards") or [])
    cases = {c["name"]: c for c in json.loads(GOLDEN.read_text(encoding="utf-8"))["cases"]}
    hit, miss = [], []
    for card_id in cases[name]["must_keep_card_ids"]:
        words = MUST_KEEP_KEYWORDS[name][card_id]
        (hit if any(w in produced for w in words) else miss).append(short(card_id, name))
    return hit, miss


def show(ui: dict, indent: str = "      ") -> None:
    for card in ui.get("cards") or []:
        print(f"{indent}· {card['title']}｜{card['subtitle'] or ''}")


def main() -> int:
    parser = argparse.ArgumentParser(description="golden_cases 评测")
    parser.add_argument("--ai", action="store_true", help="启用模型（需 EASYVIEW_API_KEY）")
    parser.add_argument("--output", help="把生成的 ui_schema 写到这个目录")
    args = parser.parse_args()

    client = None
    if args.ai:
        config = LlmConfig.from_env()
        if config is None:
            print("没有 EASYVIEW_API_KEY，无法启用模型", file=sys.stderr)
            return 2
        client = OpenAICompatibleClient(config)
        print(f"模型={config.model}  推理档位={config.reasoning}  提示词={client.prompt_version}")
    else:
        print("只跑规则引擎（加 --ai 接模型）")
    print()

    out_dir = pathlib.Path(args.output) if args.output else None
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)

    totals = {"hit": 0, "must": 0, "calls": 0, "cached": 0, "miss": 0, "out": 0, "reason": 0}
    rows: list[dict] = []

    for name in ("hospital", "gov", "traffic"):
        path = EXAMPLES / f"elements.{name}.json"
        raw = path.read_bytes()
        data = json.loads(raw.decode("utf-8-sig"))
        result = analyze(data, raw, ai_client=client)
        ui = result.ui_schema
        hit, miss = coverage(name, ui)

        print("━" * 62)
        print(f"【{name}】mode={result.mode}  卡片={len(ui['cards'])}  "
              f"必留覆盖={len(hit)}/{len(hit) + len(miss)}"
              + ("  ✅ 全中" if not miss else f"  漏={miss}"))
        if result.problems:
            for problem in result.problems[:5]:
                print(f"    ❌ {problem}")
        if result.notes:
            for note in result.notes[:3]:
                print(f"    ℹ {note}")
        if result.dropped:
            for item in result.dropped[:5]:
                print(f"    · 丢弃: {item}")
        show(ui)

        usage = result.reply.usage if result.reply else {}
        cached = int(usage.get("prompt_cache_hit_tokens") or 0)
        miss_tok = int(usage.get("prompt_cache_miss_tokens") or 0)
        out_tok = int(usage.get("completion_tokens") or 0)
        reason = int((usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
        if result.reply:
            totals["calls"] += 1
            print(f"    用量 缓存命中={cached} 未命中={miss_tok} 输出={out_tok}（推理={reason}） "
                  f"延迟={result.reply.latency_ms}ms")
        totals.update(hit=totals["hit"] + len(hit), must=totals["must"] + len(hit) + len(miss),
                      cached=totals["cached"] + cached, miss=totals["miss"] + miss_tok,
                      out=totals["out"] + out_tok, reason=totals["reason"] + reason)

        rows.append({"name": name, "mode": result.mode, "cards": len(ui["cards"]),
                     "ok": result.ok, "covered": hit, "missing": miss,
                     "usage": usage, "dropped": result.dropped})
        if out_dir:
            (out_dir / f"ui_schema.{name}.json").write_text(
                json.dumps(ui, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("=" * 62)
    print(f"必留任务覆盖：{totals['hit']}/{totals['must']}")
    if totals["calls"]:
        print(f"模型调用 {totals['calls']} 次｜缓存命中输入 {totals['cached']}｜未命中 {totals['miss']}"
              f"｜输出 {totals['out']}（推理 {totals['reason']}）")
    if out_dir:
        (out_dir / "eval_report.json").write_text(
            json.dumps({"rows": rows, "totals": totals}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8")
        print(f"产物写入 {out_dir}")
    fail = sum(1 for row in rows if not row["ok"])
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
