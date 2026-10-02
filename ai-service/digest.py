# -*- coding: utf-8 -*-
"""把 elements.json 压缩成给模型读的「页面说明书」。

为什么要这一层
--------------
C 产出的 elements.json 是给机器用的完整快照：每个元素 20 个字段（含
selector / xpath / bbox / order / name / value …）。直接把它丢给模型有三个问题：

1. **token 浪费在模型用不到的字段上。** selector、xpath、bbox 是给执行器定位用的，
   模型不碰定位 —— 按 0.3 约定，定位字段由绑定器从 elements.json 回填。
2. **扁平列表丢掉了结构感。** 102 个元素平铺成一个数组，模型看不出
   「这几行同属一个挂号表单」「这一块是页脚噪声」。而"哪些东西在一起"
   恰恰是判断"这页能办什么事"的关键。
3. **同一内容会重复出现。** 表格既有整体元素、又有逐个单元格；表单标签既有
   独立文字元素、又挂在输入框的 label 上。重复内容会稀释真正的信号。

本模块把快照压成分区的文本说明书：模型看到的是「页面上有哪几块、每块里有什么」。

设计约定
--------
- 每行给出 `[element_id] 类型 字段=原文`，模型据此引用证据（0.3 的
  provenance.evidence 就是 element_id + field）。
- 原文可能被截断，绑定时会从 elements.json 展开成完整字段值（0.3 要求 quote 逐字）。
- 不输出 href / selector / xpath —— 模型不得编造定位信息。
- 链接只给路径（`→ /guahao`）作为理解线索，不给完整 URL，避免模型把 URL 写进文案。
- 页脚、版权、备案等标记为噪声区，但仍列出，让模型自己决定丢弃。

用法
----
    python digest.py ../docs/examples/elements.hospital.json
    python digest.py elements.json --stats-only
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

# 元素类型 -> 中文名，让说明书读起来像人话
TYPE_NAMES = {
    "link": "链接",
    "button": "按钮",
    "input": "输入框",
    "textarea": "多行输入",
    "select": "下拉框",
    "radio": "单选",
    "checkbox": "多选",
    "form": "表单",
    "heading": "标题",
    "text": "文字",
    "table": "表格",
    "image": "图片",
    "nav": "导航",
}

# 分组类型 -> 中文名
GROUP_KIND_NAMES = {
    "form": "表单",
    "nav": "导航",
    "header": "页头区块",
    "footer": "页脚区块（通常是噪声）",
    "table": "表格",
    "list": "列表",
    "group": "区块",
}

# 中文之间被排版插进去的空格（「登 录」），只在标题里还原
_CJK_SPACE = re.compile(r"(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])")

# 表单控件：这些类型优先显示 label（字段名），而不是 placeholder（提示语）
LABEL_FIRST_KINDS = {"input", "textarea", "select", "radio", "checkbox"}

# 「能办事」的类型，超预算时优先保留
ACTIONABLE = {"link", "button", "input", "textarea", "select", "radio", "checkbox"}

# 纯容器元素：本身没有独立信息，内容已由分组或子元素呈现
CONTAINER_KINDS = {"nav"}

# 页脚特征词
FOOTER_MARKERS = ("版权", "©", "ICP", "备案", "公安", "友情链接", "网站地图", "无障碍", "手机版")

TEXT_FIELDS_DEFAULT = ("text", "label", "aria_label", "placeholder", "value")
TEXT_FIELDS_CONTROL = ("label", "aria_label", "placeholder", "text", "value")

MAX_TEXT_CHARS = 60
MAX_PATH_CHARS = 40
DEFAULT_MAX_ROWS = 160


def _clean(value: Any) -> str:
    """折叠空白并去掉首尾空格。"""
    return " ".join(str(value if value is not None else "").split()).strip()


def _text_of(element: Mapping[str, Any]) -> tuple[str, str]:
    """返回 (字段名, 原文)。表单控件优先 label，其余优先 text。"""
    kind = _clean(element.get("type"))
    order = TEXT_FIELDS_CONTROL if kind in LABEL_FIRST_KINDS else TEXT_FIELDS_DEFAULT
    for field in order:
        raw = _clean(element.get(field))
        if raw:
            return field, raw
    return "", ""


def _short_path(href: Any) -> str:
    """从 href 取一个短路径当理解线索，去掉域名和查询串。"""
    raw = _clean(href)
    if not raw or raw.startswith(("javascript:", "tel:", "mailto:", "#")):
        return ""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return ""
    path = parts.path or "/"
    if len(path) > MAX_PATH_CHARS:
        path = path[: MAX_PATH_CHARS - 1] + "…"
    return path


def _options_of(element: Mapping[str, Any]) -> str:
    """select / radio / checkbox 的选项，合并成一行。"""
    options = element.get("options")
    if not isinstance(options, Sequence) or isinstance(options, (str, bytes)):
        return ""
    labels: list[str] = []
    for option in options:
        if isinstance(option, Mapping):
            label = _clean(option.get("label") or option.get("value"))
        else:
            label = _clean(option)
        if label:
            labels.append(label)
    if not labels:
        return ""
    joined = "/".join(labels)
    if len(joined) > MAX_TEXT_CHARS:
        joined = joined[: MAX_TEXT_CHARS - 1] + "…"
    return joined


def _bbox(element: Mapping[str, Any]) -> tuple[float, float]:
    bbox = element.get("bbox")
    if isinstance(bbox, Mapping):
        try:
            y = float(bbox.get("y") or 0.0)
            h = float(bbox.get("height") or 0.0)
            return y, y + h
        except (TypeError, ValueError):
            return 0.0, 0.0
    return 0.0, 0.0


def _y_top(element: Mapping[str, Any]) -> float:
    return _bbox(element)[0]


def _order_of(element: Mapping[str, Any]) -> int:
    """把 order 安全地取成整数。

    正常输入里 order 是提取器给的连续整数，但畸形数据不该让整个请求 500 ——
    模糊测试喂一个 order:"x" 就会在排序里炸掉。
    """
    value = element.get("order")
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _y_bottom(element: Mapping[str, Any]) -> float:
    return _bbox(element)[1]


def _looks_like_footer(element: Mapping[str, Any]) -> bool:
    text = " ".join(_clean(element.get(f)) for f in TEXT_FIELDS_DEFAULT)
    return any(marker in text for marker in FOOTER_MARKERS)


def _row(element: Mapping[str, Any]) -> str:
    """把一个元素渲染成一行说明书。"""
    eid = _clean(element.get("id")) or "?"
    kind_raw = _clean(element.get("type"))
    kind = TYPE_NAMES.get(kind_raw, kind_raw or "元素")
    field, text = _text_of(element)

    if field and text:
        if len(text) > MAX_TEXT_CHARS:
            text = text[: MAX_TEXT_CHARS - 1] + "…"
        body = f"{field}={text}"
    else:
        body = "(无文字)"

    extras: list[str] = []
    # 控件的补充提示：如果 label 和 placeholder 不同，把 placeholder 也带上
    if kind_raw in LABEL_FIRST_KINDS and field != "placeholder":
        hint = _clean(element.get("placeholder"))
        if hint and hint != text:
            if len(hint) > MAX_TEXT_CHARS:
                hint = hint[: MAX_TEXT_CHARS - 1] + "…"
            extras.append(f"提示：{hint}")
    if element.get("required") is True:
        extras.append("必填")
    if element.get("disabled") is True:
        extras.append("禁用")
    if element.get("visible") is False:
        extras.append("隐藏")
    options = _options_of(element)
    if options:
        extras.append(f"选项：{options}")
    path = _short_path(element.get("href"))
    if path:
        extras.append(f"→ {path}")

    tail = ("  " + " ".join(extras)) if extras else ""
    return f"[{eid}] {kind} {body}{tail}"


def _importance(element: Mapping[str, Any]) -> int:
    """越小越优先保留。超预算时据此丢行。"""
    kind = _clean(element.get("type"))
    if kind == "form":
        return 0
    if kind in ("input", "textarea", "select", "radio", "checkbox"):
        return 1
    if kind == "button":
        return 2
    if kind == "link":
        return 3
    if kind == "heading":
        return 4
    if kind in ("table", "image"):
        return 6
    return 5


def _container_element_id(group: Mapping[str, Any]) -> str:
    """分组 id 与容器元素 id 同后缀：form_6f230879 ↔ el_6f230879。

    这是 C 的 ID 约定，用它把"表单容器元素"和"它的分组"对上，
    既能取到分组名，也能避免同一个表单被显示两遍。
    """
    gid = _clean(group.get("id"))
    if "_" not in gid:
        return ""
    return f"el_{gid.rsplit('_', 1)[-1]}"


def _claimed_texts(members: Sequence[Mapping[str, Any]]) -> tuple[set[str], list[str]]:
    """收集这一区里已经被控件、选项或链接承载的文字。

    快照里同一句话常常出现两次："就诊人姓名"既是独立文字元素、又是输入框的 label；
    "医疗服务价格公示"既是文字、又是链接。孤立文字元素与它们重复，只是噪声。

    返回 (完全匹配集合, 前缀列表)。前缀列表用于处理
    「文字=新闻标题+日期、链接=新闻标题」这种带尾巴的重复。
    """
    exact: set[str] = set()
    prefixes: list[str] = []
    for element in members:
        kind = _clean(element.get("type"))
        if kind in LABEL_FIRST_KINDS:
            for field in ("label", "placeholder"):
                value = _clean(element.get(field))
                if value:
                    exact.add(value)
            options = element.get("options")
            if isinstance(options, Sequence) and not isinstance(options, (str, bytes)):
                for option in options:
                    label = option.get("label") if isinstance(option, Mapping) else option
                    value = _clean(label)
                    if value:
                        exact.add(value)
        elif kind in ("link", "button"):
            value = _clean(element.get("text"))
            if value:
                exact.add(value)
                if len(value) >= 6:
                    prefixes.append(value)
    return exact, prefixes


def _dedupe_section(members: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """丢掉与控件/链接文字重复的孤立文字元素。"""
    exact, prefixes = _claimed_texts(members)
    if not exact and not prefixes:
        return members

    def duplicated(value: str) -> bool:
        if not value:
            return False
        if value in exact:
            return True
        return any(value.startswith(prefix) for prefix in prefixes)

    return [
        element for element in members
        if not (_clean(element.get("type")) == "text" and duplicated(_clean(element.get("text"))))
    ]


def _tidy_label(value: str) -> str:
    """「登 录」这类中文里插空格的排版，在标题里还原成「登录」。"""
    return _CJK_SPACE.sub("", value).strip()


def _group_title(
        group: Mapping[str, Any],
        members: Sequence[Mapping[str, Any]],
        container: Mapping[str, Any] | None = None,
) -> str:
    """给分组起个中文标题。

    优先级：分组自带的 label → 容器元素的短标题 → 第一个字段的 label → 类型名。
    容器元素的 text 常常是整段子元素文字的拼接（表单尤其如此），
    太长就不能当标题用，否则会出现"表单：事项名称关键字办理区域全部区域…"。
    """
    gtype = _clean(group.get("type")) or "group"
    base = GROUP_KIND_NAMES.get(gtype, gtype)
    label = _tidy_label(_clean(group.get("label")))

    if not label and container is not None:
        candidate = _tidy_label(_clean(container.get("text")))
        # 容器文本超过 10 个字基本就是子元素文字的拼接（表单尤其如此），
        # 拿来当标题会出现"表单：账号 / 身份证号密码登录"这种读不通的名字。
        if candidate and len(candidate) <= 10:
            label = candidate

    if not label:
        for element in members:
            if _clean(element.get("type")) in LABEL_FIRST_KINDS:
                candidate = _tidy_label(_clean(element.get("label")))
                if candidate:
                    label = candidate[:16]
                    break

    if not label:
        for element in members:
            if _clean(element.get("type")) == "form":
                label = _tidy_label(_clean(element.get("text")))[:16]
                if label:
                    break

    if label:
        sep = "" if base.endswith("：") else "："
        return f"{base}{sep}{label}"
    return base


def _merge_sections(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把标题相同的分区合并（同一页会有多个 list 分组、页脚也会分成几块）。"""
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for section in sections:
        key = section["title"]
        if key in merged:
            merged[key]["elements"].extend(section["elements"])
        else:
            merged[key] = {**section, "elements": list(section["elements"])}
            order.append(key)
    result: list[dict[str, Any]] = []
    for key in order:
        section = merged[key]
        section["elements"].sort(key=lambda e: (_y_top(e), _order_of(e)))
        result.append(section)
    return result


def _build_sections(data: Mapping[str, Any]) -> list[dict[str, Any]]:
    """把元素组织成分区：分组优先，其余按可见位置分带。"""
    all_elements = [e for e in (data.get("elements") or []) if isinstance(e, Mapping)]
    groups = [g for g in (data.get("groups") or []) if isinstance(g, Mapping)]
    by_id = {_clean(e.get("id")): e for e in all_elements if _clean(e.get("id"))}

    page_bottom = max((_y_bottom(e) for e in all_elements), default=0.0) or 1.0

    in_group: dict[str, Mapping[str, Any]] = {}
    for group in groups:
        for eid in group.get("element_ids") or []:
            key = _clean(eid)
            if key and key in by_id:
                in_group[key] = group

    sections: list[dict[str, Any]] = []
    consumed: set[str] = set()

    for index, group in enumerate(groups):
        gtype = _clean(group.get("type")) or "group"

        # 表格分组不单独成区：20 个单元格的信息已经完整地在表格元素的 text 里。
        # 0.3 明确要求整表保留、不混拼不同列，所以这里保留表格元素、丢掉散列单元格。
        if gtype == "table":
            for eid in group.get("element_ids") or []:
                key = _clean(eid)
                if key:
                    consumed.add(key)
            continue

        members = [by_id[_clean(eid)] for eid in (group.get("element_ids") or []) if _clean(eid) in by_id]
        if not members:
            continue
        members = _dedupe_section(members)
        members.sort(key=lambda e: (_y_top(e), _order_of(e)))
        for element in members:
            consumed.add(_clean(element.get("id")))
        # 容器元素（表单/导航本身）与它的分组是同一件事：既用它取名，也不重复显示
        container_id = _container_element_id(group)
        container = by_id.get(container_id) if container_id else None
        if container_id:
            consumed.add(container_id)

        sections.append({
            "title": _group_title(group, members, container),
            "kind": gtype,
            "elements": members,
            "y": min((_y_top(e) for e in members), default=page_bottom),
            "seq": index,
        })

    # 没有进入任何分组的元素，按可见位置分带
    loose = [
        e for e in all_elements
        if _clean(e.get("id")) not in in_group
        and _clean(e.get("id")) not in consumed
        and _clean(e.get("type")) not in CONTAINER_KINDS
    ]
    bands: dict[str, list[Mapping[str, Any]]] = {"头": [], "主体": [], "尾": []}
    for element in loose:
        if _looks_like_footer(element) or _y_top(element) >= page_bottom * 0.85:
            bands["尾"].append(element)
        elif _y_top(element) < page_bottom * 0.10:
            bands["头"].append(element)
        else:
            bands["主体"].append(element)

    band_titles = {
        "头": "页面顶部（站点标识、快捷入口）",
        "主体": "主体内容",
        "尾": "页面底部（页脚 / 版权，通常是噪声）",
    }
    band_y = {"头": 0.0, "主体": page_bottom * 0.20, "尾": page_bottom * 0.90}
    for band in ("头", "主体", "尾"):
        members = bands[band]
        if not members:
            continue
        members = _dedupe_section(members)
        if not members:
            continue
        members.sort(key=lambda e: (_y_top(e), _order_of(e)))
        sections.append({
            "title": band_titles[band],
            "kind": f"band_{band}",
            "elements": members,
            "y": band_y[band],
            "seq": 900,
        })

    sections.sort(key=lambda s: (s["y"], s["seq"]))
    return _merge_sections(sections)


def _apply_budget(sections: list[dict[str, Any]], max_rows: int) -> tuple[list[dict[str, Any]], int]:
    """超出预算时按重要性丢行。返回 (新分区, 丢弃数)。"""
    total = sum(len(s["elements"]) for s in sections)
    if total <= max_rows:
        return sections, 0

    scored: list[tuple[int, float, Mapping[str, Any]]] = []
    for section in sections:
        penalty = 10 if section["kind"] == "band_尾" else 0
        for element in section["elements"]:
            scored.append((_importance(element) + penalty, _y_top(element), element))
    scored.sort(key=lambda item: (item[0], item[1]))

    keep = {id(element) for _, _, element in scored[:max_rows]}
    dropped = total - len(keep)

    trimmed: list[dict[str, Any]] = []
    for section in sections:
        members = [e for e in section["elements"] if id(e) in keep]
        if members:
            trimmed.append({**section, "elements": members})
    return trimmed, dropped


def build_sections(data: Mapping[str, Any], *, max_rows: int = DEFAULT_MAX_ROWS) -> tuple[list[dict[str, Any]], int]:
    """对外暴露：返回 (分区列表, 被丢弃行数)。"""
    return _apply_budget(_build_sections(data), max_rows)


def _site_of(data: Mapping[str, Any]) -> str:
    """站点名。page_url 是真实地址；final_url 在快照数据里可能是 snapshot:// 伪协议。"""
    for key in ("page_url", "final_url"):
        raw = _clean(data.get(key))
        if not raw:
            continue
        try:
            parts = urlsplit(raw)
        except ValueError:
            continue
        host = parts.hostname
        if host:
            return host
        if parts.scheme and parts.scheme not in ("http", "https"):
            return f"{parts.scheme}://{parts.netloc or parts.path}"
    return "(未知)"


def build_digest(data: Mapping[str, Any], *, max_rows: int = DEFAULT_MAX_ROWS) -> str:
    """把 elements.json 渲染成给模型读的页面说明书（纯文本）。"""
    sections, dropped = build_sections(data, max_rows=max_rows)

    title = _clean(data.get("page_title")) or "(无标题)"
    source = _clean(data.get("source")) or "unknown"
    stats = data.get("stats") if isinstance(data.get("stats"), Mapping) else {}
    total = stats.get("total") or len(data.get("elements") or [])
    visible = stats.get("visible")

    head = [
        f"站点：{_site_of(data)}",
        f"页面：{title}",
        f"来源：{source}｜采集元素 {total} 个" + (f"，其中可见 {visible} 个" if visible is not None else ""),
    ]
    if _clean(data.get("fallback_reason")):
        head.append(f"降级原因：{_clean(data.get('fallback_reason'))}")
    head += [
        "",
        "下面是这张页面按可见位置切成的区块。每行格式：[元素ID] 类型 字段=原文。",
        "引用证据时请使用元素ID和字段名；原文若被截断，绑定时会自动补全。",
        "链接后的 → 只是路径提示，不要写进给老人看的文案。",
    ]

    lines = list(head)
    for section in sections:
        lines.append("")
        lines.append(f"━━ {section['title']}（{len(section['elements'])} 项）━━")
        lines.extend(_row(e) for e in section["elements"])

    if dropped:
        lines.append("")
        lines.append(f"（为控制长度省略了 {dropped} 项次要元素，多为重复文字或页脚）")

    return "\n".join(lines)


def digest_stats(text: str, data: Mapping[str, Any]) -> dict[str, Any]:
    """给调试用的压缩统计。"""
    raw = json.dumps(data, ensure_ascii=False)
    return {
        "raw_chars": len(raw),
        "digest_chars": len(text),
        "ratio": round(len(text) / len(raw), 3) if raw else 0.0,
        "digest_lines": text.count("\n") + 1,
        "raw_elements": len(data.get("elements") or []),
    }


def _load(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 elements.json 压成页面说明书")
    parser.add_argument("paths", nargs="+", help="elements.json 路径，可多个")
    parser.add_argument("--max-rows", type=int, default=DEFAULT_MAX_ROWS, help="说明书行数上限")
    parser.add_argument("--stats-only", action="store_true", help="只打印压缩统计")
    args = parser.parse_args(argv)

    for raw_path in args.paths:
        data = _load(raw_path)
        text = build_digest(data, max_rows=args.max_rows)
        stats = digest_stats(text, data)
        print(f"=== {Path(raw_path).name} ===")
        print(f"  原始 JSON {stats['raw_chars']:,} 字符 → 说明书 {stats['digest_chars']:,} 字符"
              f"（{stats['ratio']:.0%}，{stats['digest_lines']} 行，{stats['raw_elements']} 个元素）")
        if not args.stats_only:
            print()
            print(text)
            print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
