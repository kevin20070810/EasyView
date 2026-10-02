"""协议自检：验证 elements.json 严格符合 docs/elements.schema.json。

这是本项目最重要的一道防线 —— 协议对不上，B/A 全部返工。

校验对象是 docs/examples/ 下已提交的真实产出。这里原先还会用 Playwright
现场抓取真实站点，但服务端抓取已经退役：产品改为浏览器扩展在页面内提取，
不再由服务端访问网页。因此本工具只做「已固化产出」的协议校验。

用法：
    python -m tools.selfcheck
    python -m tools.selfcheck --file path/to/elements.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# 允许以脚本方式直接运行
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import jsonschema  # noqa: E402

from app.config import DOCS_DIR, MAX_ELEMENTS  # noqa: E402

ID_RE = re.compile(r"^el_[0-9a-f]{8}$")
GROUP_RE = re.compile(r"^(grp|form)_[0-9a-f]{8}$")

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


def validate_invariants(doc: dict) -> None:
    """schema 之外的业务不变量 —— 这些错了 schema 也拦不住。"""
    elements = doc["elements"]
    groups = doc["groups"]

    ids = [e["id"] for e in elements]
    check("元素 ID 无重复", len(ids) == len(set(ids)), f"(共 {len(ids)} 个，去重后 {len(set(ids))} 个)")
    check("元素 ID 全部合规", all(ID_RE.match(i) for i in ids))

    check("order 连续从 0 开始", [e["order"] for e in elements] == list(range(len(elements))))

    group_ids = {g["id"] for g in groups}
    check("分组 ID 全部合规", all(GROUP_RE.match(g) for g in group_ids))
    dangling = [e["id"] for e in elements if e["group_id"] and e["group_id"] not in group_ids]
    check("元素的 group_id 全部有对应分组", not dangling, f"悬空引用: {dangling[:5]}")

    form_ids = {e["form_id"] for e in elements if e["form_id"]}
    check("form_id 全部指向 form_ 分组",
          all(f.startswith("form_") for f in form_ids), f"收到: {sorted(form_ids)[:5]}")

    # 每个分组的 element_ids 必须真实存在且指向本分组
    by_id = {e["id"]: e for e in elements}
    bad = []
    for g in groups:
        for eid in g["element_ids"]:
            el = by_id.get(eid)
            if el is None or el["group_id"] != g["id"]:
                bad.append((g["id"], eid))
    check("分组的 element_ids 与元素归属双向一致", not bad, f"不一致: {bad[:5]}")

    # 统计必须如实
    check("stats.total 与实际元素数一致", doc["stats"]["total"] == len(elements))
    check("stats.visible 与实际可见数一致",
          doc["stats"]["visible"] == sum(1 for e in elements if e["visible"]))

    # 截断标记必须如实。
    # 注意：这里**不**断言「可见元素占比 > 50%」—— 该比例取决于页面本身有多少可见元素
    # （实测 12306 首页可见候选仅 145 个，上限 400 只能用隐藏元素补足）。
    # 截断策略的语义是「可见优先保留」，而不是「保证可见占多数」，占比仅作信息展示。
    if doc["stats"]["truncated"]:
        check("truncated 时元素数恰等于上限", len(elements) == MAX_ELEMENTS,
              f"(实际 {len(elements)}，上限 {MAX_ELEMENTS})")
        ratio = doc["stats"]["visible"] / max(len(elements), 1)
        print(f"  [INFO] 截断后可见元素 {doc['stats']['visible']}/{len(elements)}"
              f"（{ratio:.0%}，取决于页面自身可见候选数量）")
    else:
        check("未截断时元素数不超过上限", len(elements) <= MAX_ELEMENTS,
              f"(实际 {len(elements)}，上限 {MAX_ELEMENTS})")

    # href 必须已解析为绝对 URL（协议承诺），不能残留 "/guahao" 这类相对路径，
    # 否则 B 判断「这个入口通向哪」时会拿到无意义的值。
    scheme_re = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:")
    bad_hrefs = [e["href"] for e in elements if e["href"] and not scheme_re.match(e["href"])]
    check("href 均为绝对 URL", not bad_hrefs, f"相对/异常: {bad_hrefs[:3]}")

    # 表单控件必须能拿到中文标签，否则 B 只能靠文档序猜字段含义
    unlabeled = [
        e["id"] for e in elements
        if e["type"] in ("input", "select", "textarea") and e["visible"] and not e["label"]
    ]
    if unlabeled:
        print(f"  [INFO] {len(unlabeled)} 个可见表单控件无关联 label（页面自身未提供）")

    # 降级必须如实标记
    if doc["source"] == "fallback":
        check("降级结果带 fallback_reason", bool(doc["fallback_reason"]))
    else:
        check("live 结果不带 fallback_reason", doc["fallback_reason"] is None)

    # 边界：C 组绝不能输出 UI 决策字段（规范 §3）
    forbidden = {"importance", "priority", "score", "rank", "ui_schema", "html", "css"}
    leaked = forbidden & set(doc.keys())
    check("未越界输出 UI/重要性字段", not leaked, f"越界字段: {leaked}")


def run_case(label: str, payload: dict) -> dict | None:
    print(f"\n=== {label} ===")
    print(f"  标题: {payload['page_title']}")
    print(f"  来源: {payload['source']}  reason={payload['fallback_reason']}")
    print(f"  元素: {payload['stats']['total']} 个（可见 {payload['stats']['visible']}）"
          f"  分组: {len(payload['groups'])} 个")
    print(f"  类型分布: {payload['stats']['by_type']}")

    check(f"{label} 解析到元素", payload["stats"]["total"] > 0)
    check(f"{label} 解析到分组", len(payload["groups"]) > 0)
    check(f"{label} 页面标题非空", bool(payload["page_title"]))

    try:
        jsonschema.validate(payload, SCHEMA)
        check(f"{label} 通过 elements.schema.json 校验", True)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(p) for p in exc.absolute_path)
        check(f"{label} 通过 elements.schema.json 校验", False,
              f"\n        路径: {path}\n        原因: {exc.message}")

    validate_invariants(payload)
    return payload


SCHEMA = json.loads((DOCS_DIR / "elements.schema.json").read_text(encoding="utf-8-sig"))


def main() -> int:
    parser = argparse.ArgumentParser(description="EasyView 协议自检")
    parser.add_argument("--file", action="append", default=[],
                        help="额外校验的 elements.json，可重复指定")
    args = parser.parse_args()

    # 先校验 schema 文件本身是合法 JSON Schema
    print("=== 协议文件自检 ===")
    try:
        jsonschema.Draft202012Validator.check_schema(SCHEMA)
        check("docs/elements.schema.json 是合法的 JSON Schema", True)
    except jsonschema.SchemaError as exc:
        check("docs/elements.schema.json 是合法的 JSON Schema", False, str(exc.message))

    examples_dir = DOCS_DIR / "examples"
    targets = sorted(examples_dir.glob("elements.*.json"))
    targets += [Path(p) for p in args.file]
    print(f"\n待校验的产出: {[p.name for p in targets]}")

    if not targets:
        check("找到待校验的 elements.json", False, f"{examples_dir} 下没有 elements.*.json")

    for path in targets:
        label = path.stem
        try:
            payload = json.loads(path.read_text(encoding="utf-8-sig"))
        except Exception as exc:  # noqa: BLE001
            check(f"{label} 可读取", False, f"异常: {exc!r}")
            continue
        run_case(label, payload)

    print(f"\n{'=' * 46}")
    print(f"自检结果: {_ok} 通过 / {_fail} 失败")
    print("=" * 46)
    return 1 if _fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
