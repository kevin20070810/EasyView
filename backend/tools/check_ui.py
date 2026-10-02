"""B -> A 接口交叉校验。

这是「接口统一」的**可执行证据**：光在文档里写「ID 必须存在」没有意义，
本工具真的去 elements.json 里逐个查证 ui_schema.json 引用的每个 ID。

校验三层：
  1. ui_schema.json 自身符合 docs/ui.schema.json
  2. ui_schema.json 与配对的 elements.json 元信息一致（page_url / source / 版本）
  3. ui_schema.json 引用的每一个 element_id 都真实存在，且类型正确

用法：
    python -m tools.check_ui                    # 校验 docs/examples 下全部配对
    python -m tools.check_ui --pair hospital     # 只校验一组
    python -m tools.check_ui --elements A.json --ui B.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import jsonschema  # noqa: E402

from app.config import DOCS_DIR  # noqa: E402

EXAMPLES_DIR = DOCS_DIR / "examples"
UI_SCHEMA = json.loads((DOCS_DIR / "ui.schema.json").read_text(encoding="utf-8-sig"))

# 可作为表单输入项的元素类型（radio / checkbox 在 elements.json 里代表整个选项组）
INPUT_TYPES = {"input", "select", "textarea", "radio", "checkbox"}
# 可作为表单提交按钮的元素类型
SUBMIT_TYPES = {"submit", "button"}
# 必须有 options 的 input_type
OPTION_REQUIRED_INPUT_TYPES = {"select", "radio", "checkbox"}
# 这些 input_type 的每个选项都必须自带 selector（A 靠它逐项勾选）
PER_OPTION_SELECTOR_REQUIRED = {"radio", "checkbox"}

# 协议里 ID 的形态。用于区分「引用了真实 ID」和「随手写的字符串」。
ID_PATTERN = re.compile(r"^(el|grp|form)_[0-9a-f]{8}$")

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


def _by_id(elements: dict) -> dict:
    return {e["id"]: e for e in elements["elements"]}


def check_pair(ui: dict, elements: dict, label: str) -> None:
    print(f"\n=== {label} ===")

    # 顶层形状不对时给出清晰提示，而不是让 KeyError 冒到用户面前
    if not isinstance(ui, dict) or "cards" not in ui:
        got = sorted(ui)[:8] if isinstance(ui, dict) else type(ui).__name__
        check("ui_schema 顶层含 cards 字段", False,
              "\n        实际顶层字段: " + str(got)
              + "\n        提示: 若这是 POST /analyze 的原始响应，工具会自动拆 ok/data 信封；"
                "若仍失败，说明 data 内也不是 ui_schema。")
        return

    by_id = _by_id(elements)
    group_ids = {g["id"] for g in elements["groups"]}
    cards = ui["cards"]

    # ---- 1. ui_schema 自身合法性 ----
    try:
        jsonschema.validate(ui, UI_SCHEMA)
        check("ui_schema 通过 docs/ui.schema.json 校验", True)
    except jsonschema.ValidationError as exc:
        path = "/".join(str(p) for p in exc.absolute_path)
        check("ui_schema 通过 docs/ui.schema.json 校验", False,
              f"\n        路径: {path}\n        原因: {exc.message}")

    # ---- 2. 与 elements.json 的元信息一致 ----
    check("page_url 与 elements.json 完全一致",
          ui["page_url"] == elements["page_url"],
          f'(ui="{ui["page_url"]}" vs elements="{elements["page_url"]}")')
    check("source 原样透传自 elements.json",
          ui["source"] == elements["source"],
          f'(ui="{ui["source"]}" vs elements="{elements["source"]}")')
    check("source_elements_schema_version 与 elements 版本一致",
          ui["source_elements_schema_version"] == elements["schema_version"],
          f'(ui="{ui["source_elements_schema_version"]}" vs elements="{elements["schema_version"]}")')

    # ---- 3. 卡片自身约束（JSON Schema 无法表达，必须工具强制）----
    card_ids = [c["id"] for c in cards]
    dup_ids = {i for i in card_ids if card_ids.count(i) > 1}
    check("card.id 无重复", not dup_ids, f"重复: {sorted(dup_ids)}")

    priorities = [c["priority"] for c in cards]
    dup_pri = {p for p in priorities if priorities.count(p) > 1}
    check("priority 无重复（否则 A 渲染顺序不确定）", not dup_pri, f"重复: {sorted(dup_pri)}")

    # card.id 若写成了 ID 形式，就必须真能追溯到 elements[] 或 groups[]，
    # 否则「便于双向追溯」只是句空话，且无法发现拼写错误。
    unresolved = [
        c["id"] for c in cards
        if ID_PATTERN.match(c["id"]) and c["id"] not in by_id and c["id"] not in group_ids
    ]
    check("card.id 若为 ID 形式则必须可追溯", not unresolved,
          f"\n        既不在 elements[] 也不在 groups[]: {unresolved}")

    print(f"  [INFO] 卡片渲染顺序: "
          + " -> ".join(c["title"] for c in sorted(cards, key=lambda c: c["priority"])))

    # ---- 4. 引用完整性：这是最容易出冲突的地方 ----
    missing_targets: list[str] = []
    missing_submits: list[str] = []
    bad_submits: list[str] = []
    missing_fields: list[str] = []
    bad_fields: list[str] = []
    form_mismatch: list[str] = []
    bad_selectors: list[str] = []
    bad_options: list[str] = []

    def check_selector(path: str, selector, element: dict) -> None:
        """断言 selector 与 elements.json 中该元素的 selector 完全一致。

        这是「A 能不能定位到 DOM」的核心保证：A 只有 ui_schema，
        必须靠 selector 找到节点，对不上就等于点不动。
        """
        if not selector:
            bad_selectors.append(f"{path}: 缺少 selector（A 无法定位 DOM）")
        elif selector != element.get("selector"):
            bad_selectors.append(
                f"{path}: selector 与 elements.json 不一致\n"
                f"            ui: {selector}\n"
                f"            el: {element.get('selector')}")

    for card in cards:
        action = card["action"]
        kind = action["kind"]
        tid = action.get("target_element_id")

        # kind 与 form 字段必须匹配
        if kind == "form" and not card.get("form"):
            form_mismatch.append(f'{card["id"]}: kind=form 但缺 form')
        if kind != "form" and card.get("form"):
            form_mismatch.append(f'{card["id"]}: kind={kind} 却带了 form')

        # target_element_id 必须存在于 elements[]（注意：分组 ID 不在其中）
        if kind in ("navigate", "form", "scroll"):
            if not tid:
                missing_targets.append(f'{card["id"]}: kind={kind} 但无 target_element_id')
            elif tid not in by_id:
                hint = " ← 这是分组 ID，不在 elements[] 中，请改用该表单/区块元素自身的 el_ id" \
                    if tid in group_ids else ""
                missing_targets.append(f'{card["id"]} -> {tid} 不存在{hint}')
            else:
                check_selector(f'{card["id"]}.action.target_selector',
                               action.get("target_selector"), by_id[tid])

        # 表单引用必须存在且类型正确
        form = card.get("form")
        if form:
            sid = form["submit_element_id"]
            if sid not in by_id:
                missing_submits.append(f'{card["id"]} -> {sid} 不存在')
            elif by_id[sid]["type"] not in SUBMIT_TYPES:
                bad_submits.append(
                    f'{card["id"]} -> {sid} 类型为 {by_id[sid]["type"]}，应为 {SUBMIT_TYPES}')
            else:
                check_selector(f'{card["id"]}.form.submit_selector',
                               form.get("submit_selector"), by_id[sid])

            seen_fields: set[str] = set()
            for f in form["fields"]:
                fid = f["element_id"]
                if fid in seen_fields:
                    bad_fields.append(f'{card["id"]}: 字段 {fid} 重复出现')
                seen_fields.add(fid)
                if fid not in by_id:
                    missing_fields.append(f'{card["id"]} -> {fid} 不存在')
                    continue
                el = by_id[fid]
                if el["type"] not in INPUT_TYPES:
                    bad_fields.append(
                        f'{card["id"]} -> {fid} 类型为 {el["type"]}，应为 {INPUT_TYPES}')

                check_selector(f'{card["id"]}.field[{fid}].selector',
                               f.get("selector"), el)

                # 选项：类型要求 + 逐项定位能力
                itype = f.get("input_type")
                opts = f.get("options")
                if itype in OPTION_REQUIRED_INPUT_TYPES:
                    if not opts:
                        bad_options.append(
                            f'{card["id"]} -> {fid} input_type={itype} 但缺 options')
                        continue
                    if itype in PER_OPTION_SELECTOR_REQUIRED:
                        for i, o in enumerate(opts):
                            if not o.get("selector"):
                                bad_options.append(
                                    f'{card["id"]} -> {fid} options[{i}]「{o.get("label")}」'
                                    f' 缺 selector —— A 无法勾选这一项')
                elif opts:
                    bad_options.append(
                        f'{card["id"]} -> {fid} input_type={itype} 不该有 options')

    check("所有 action.target_element_id 均存在于 elements.json",
          not missing_targets, f"\n        {missing_targets}")
    check("所有 form.submit_element_id 均存在", not missing_submits, f"\n        {missing_submits}")
    check("提交按钮类型正确（submit / button）", not bad_submits, f"\n        {bad_submits}")
    check("所有 form.field.element_id 均存在", not missing_fields, f"\n        {missing_fields}")
    check("表单字段类型正确且不重复（input/select/textarea/radio/checkbox）",
          not bad_fields, f"\n        {bad_fields}")
    check("action.kind 与 form 字段配套", not form_mismatch, f"\n        {form_mismatch}")
    check("所有 selector 与 elements.json 完全一致（A 靠它定位 DOM）",
          not bad_selectors, f"\n        {bad_selectors}")
    check("radio/checkbox 每个选项都有独立 selector；select 带 options",
          not bad_options, f"\n        {bad_options}")

    # ---- 5. 覆盖率信息（不判定失败，供 B 自查是否漏了关键入口）----
    referenced = {
        c["action"].get("target_element_id") for c in cards
    } | {f["element_id"] for c in cards for f in (c.get("form") or {}).get("fields", [])}
    referenced.discard(None)
    visible_interactive = [
        e for e in elements["elements"]
        if e["visible"] and e["type"] in ("button", "link", "submit")
    ]
    print(f"  [INFO] ui_schema 引用 {len(referenced)} 个元素；"
          f"elements.json 中可见交互元素共 {len(visible_interactive)} 个")


def _unwrap_ui(payload):
    """兼容 HTTP 服务常见的 {ok, data} 信封。

    B 组的 POST /analyze 返回 {"ok": true, "data": {…ui_schema…}}。
    A 拿到的是这种信封形状，把响应存成文件再校验是很自然的操作，
    工具应当自动识别，而不是抛一个让人摸不着头脑的 KeyError: 'cards'。
    """
    if isinstance(payload, dict) and "cards" not in payload:
        data = payload.get("data")
        if isinstance(data, dict) and "cards" in data:
            return data
    return payload


def load(path: Path) -> dict:
    """读取 JSON。

    用 utf-8-sig 而非 utf-8：Windows 上（记事本、PowerShell 5 的 Out-File、
    某些导出工具）写出的 JSON 常带 BOM，纯 utf-8 解码会在第一个字符就报
    "Unexpected UTF-8 BOM"，而 utf-8-sig 对有无 BOM 都能正确读取。
    """
    try:
        text = path.read_text(encoding="utf-8-sig")
    except FileNotFoundError as exc:
        raise SystemExit(f"找不到文件: {path}") from exc
    except UnicodeDecodeError as exc:
        raise SystemExit(f"{path.name} 不是 UTF-8 文本: {exc}") from exc
    try:
        return _unwrap_ui(json.loads(text))
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"{path.name} 不是合法 JSON: {exc.msg}（第 {exc.lineno} 行第 {exc.colno} 列）"
        ) from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="EasyView B->A 接口交叉校验")
    parser.add_argument("--pair", action="append", default=[],
                        help="校验 docs/examples 下的一组配对（如 hospital）")
    parser.add_argument("--elements", help="自定义 elements.json 路径")
    parser.add_argument("--ui", help="自定义 ui_schema.json 路径")
    args = parser.parse_args()

    print("=== ui 协议文件自检 ===")
    try:
        jsonschema.Draft202012Validator.check_schema(UI_SCHEMA)
        check("docs/ui.schema.json 是合法的 JSON Schema", True)
    except jsonschema.SchemaError as exc:
        check("docs/ui.schema.json 是合法的 JSON Schema", False, str(exc.message))

    pairs: list[tuple[str, Path, Path]] = []
    if args.elements and args.ui:
        pairs.append(("自定义", Path(args.elements), Path(args.ui)))
    else:
        names = args.pair or ["hospital"]
        for name in names:
            el = EXAMPLES_DIR / f"elements.{name}.json"
            ui = EXAMPLES_DIR / f"ui_schema.{name}.json"
            if ui.exists():
                pairs.append((name, el, ui))
            else:
                print(f"\n=== {name} ===")
                print(f"  [SKIP] 尚未提供 {ui.name}（B 组产出后放入 docs/examples/ 即可校验）")

    for label, el_path, ui_path in pairs:
        if not el_path.exists():
            print(f"\n=== {label} ===")
            check(f"elements 文件存在: {el_path.name}", False, str(el_path))
            continue
        check_pair(load(ui_path), load(el_path), label)

    print(f"\n{'=' * 46}")
    print(f"交叉校验结果: {_ok} 通过 / {_fail} 失败")
    print("=" * 46)
    return 1 if _fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
