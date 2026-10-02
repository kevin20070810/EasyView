"""交接文档一致性校验。

「确保接口统一，不要有冲突」这句话，如果只靠人肉比对两份 Markdown，
迟早会漂移 —— 改了一边忘了另一边，A 和 B 就拿着两套字段定义开工了。

本工具把两份交接文件里的**契约表格**抽出来逐行比对，把这件事变成可执行检查。

用法：
    python -m tools.check_docs
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import DOCS_DIR  # noqa: E402

DOC_A = DOCS_DIR / "A_前端交接.md"
DOC_B = DOCS_DIR / "B_AI交接.md"

# 两份文档中必须逐字一致的章节（由 docs/ui.schema.json 派生）
CONTRACT_SECTIONS = ["根对象", "page", "cards[]", "action", "form"]

# ui_schema.json 里冻结的图标集
EXPECTED_ICONS = {
    "home", "calendar", "document", "payment", "phone", "user", "search", "location",
    "bus", "train", "hospital", "government", "warning", "info", "help", "back",
}

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


def normalize_heading(raw: str) -> str:
    """`page`（页面级文案，A 直接渲染） -> page"""
    text = raw.replace("`", "")
    text = re.split(r"[（(]", text)[0]
    return text.strip()


def extract_tables(text: str) -> dict[str, list[list[str]]]:
    """抽取 Markdown 表格，归属到其上方最近的标题。"""
    lines = text.splitlines()
    tables: dict[str, list[list[str]]] = {}
    heading = ""
    i = 0
    while i < len(lines):
        m = re.match(r"^#{2,4}\s+(.*)$", lines[i])
        if m:
            heading = normalize_heading(m.group(1))
        if lines[i].strip().startswith("|"):
            rows: list[str] = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            # 去掉 |---| 分隔行
            rows = [r for r in rows if not re.match(r"^\|[\s:\-|]+\|$", r)]
            tables.setdefault(heading, []).append(rows)
            continue
        i += 1
    return tables


def extract_code_block_after(text: str, heading_key: str) -> str:
    """取某个标题之后第一个 ``` 代码块的内容。"""
    lines = text.splitlines()
    capturing = False
    in_block = False
    buf: list[str] = []
    for line in lines:
        if re.match(r"^#{2,4}\s+", line):
            if capturing and in_block:
                break
            capturing = heading_key in normalize_heading(line)
            continue
        if capturing:
            if line.strip().startswith("```"):
                if in_block:
                    break
                in_block = True
                continue
                # noqa
            if in_block:
                buf.append(line)
    return "\n".join(buf)


def main() -> int:
    print("=== 交接文档存在性 ===")
    for path in (DOC_A, DOC_B):
        check(f"{path.name} 存在", path.exists(), str(path))
    if not (DOC_A.exists() and DOC_B.exists()):
        return 1

    text_a = DOC_A.read_text(encoding="utf-8")
    text_b = DOC_B.read_text(encoding="utf-8")
    tables_a = extract_tables(text_a)
    tables_b = extract_tables(text_b)

    print("\n=== 契约表格逐行比对（A 文档 vs B 文档）===")
    for section in CONTRACT_SECTIONS:
        rows_a = tables_a.get(section)
        rows_b = tables_b.get(section)
        if rows_a is None:
            check(f"「{section}」章节在 A 文档中存在", False, f"未找到该标题下的表格")
            continue
        if rows_b is None:
            check(f"「{section}」章节在 B 文档中存在", False, f"未找到该标题下的表格")
            continue

        flat_a = [r for t in rows_a for r in t]
        flat_b = [r for t in rows_b for r in t]

        if flat_a == flat_b:
            check(f"「{section}」字段表两份文档完全一致（{len(flat_a)} 行）", True)
        else:
            only_a = [r for r in flat_a if r not in flat_b]
            only_b = [r for r in flat_b if r not in flat_a]
            detail = ""
            if only_a:
                detail += f"\n        仅 A 文档有: {only_a[:3]}"
            if only_b:
                detail += f"\n        仅 B 文档有: {only_b[:3]}"
            check(f"「{section}」字段表两份文档完全一致", False, detail)

    print("\n=== 图标集比对 ===")
    icons_a = extract_code_block_after(text_a, "图标集")
    icons_b = extract_code_block_after(text_b, "图标集")
    set_a = set(icons_a.split())
    set_b = set(icons_b.split())
    check("A 文档图标集非空", bool(set_a))
    check("B 文档图标集非空", bool(set_b))
    check("两份文档图标集完全一致", set_a == set_b,
          f"(A-B={sorted(set_a - set_b)} B-A={sorted(set_b - set_a)})")

    # 与 schema 文件三方对齐
    import json
    ui_schema = json.loads((DOCS_DIR / "ui.schema.json").read_text(encoding="utf-8-sig"))
    schema_icons = set(
        ui_schema["$defs"]["card"]["properties"]["icon"]["oneOf"][0]["enum"]
    )
    check("文档图标集与 docs/ui.schema.json 完全一致", set_a == schema_icons,
          f"(文档-chema={sorted(set_a - schema_icons)} schema-文档={sorted(schema_icons - set_a)})")

    print("\n=== 关键约定在两侧均被声明 ===")
    key_rules = [
        ("target_element_id 必须是 el_ 前缀元素 ID", "target_element_id"),
        ("priority 不得重复", "priority"),
        ("source 必须原样透传", "source"),
        ("降级时必须提示用户", "fallback"),
    ]
    for label, needle in key_rules:
        check(f"A 文档声明了「{label}」", needle in text_a)
        check(f"B 文档声明了「{label}」", needle in text_b)

    print(f"\n{'=' * 46}")
    print(f"文档一致性检查: {_ok} 通过 / {_fail} 失败")
    print("=" * 46)
    return 1 if _fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
