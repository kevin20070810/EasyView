"""把页面内脚本吐出的原始结构，封装为符合 docs/elements.schema.json 的文档。

这里是协议规则的**唯一实现点**：ID 生成、分组归属、截断、统计都在此完成，
extractor 只负责「把网页打开并读到数据」，两边职责不混。
"""

from __future__ import annotations

from . import ids
from .config import MAX_ELEMENTS, SCHEMA_VERSION
from .models import BBox, Element, ElementsDocument, Group, Stats

# 截断优先级（由 extract_dom.js 计算）：
#   0 = 可见的交互/结构元素   1 = 可见文本
#   2 = 隐藏的交互/结构元素   3 = 隐藏文本
# rank 0 属于「必须保留」；其余按序补足。
# 依据只是「可见性」这一客观 DOM 属性（属于任务书 §5 的数据清洗），
# 不含任何「对老人重要不重要」的判断 —— 那是 B 的职责。
_KEEP_ALWAYS_MAX_RANK = 0


def _bbox(raw: dict | None) -> BBox | None:
    if not raw:
        return None
    return BBox(
        x=float(raw.get("x", 0)),
        y=float(raw.get("y", 0)),
        width=float(raw.get("width", 0)),
        height=float(raw.get("height", 0)),
    )


def build_document(
    raw: dict,
    *,
    page_url: str,
    source: str = "live",
    fallback_reason: str | None = None,
) -> ElementsDocument:
    """raw 为 extract_dom.js 的返回值。"""

    # ---------- 1. 分组：selector -> 稳定 group id ----------
    group_id_by_selector: dict[str, str] = {}
    raw_groups: list[dict] = []
    for g in raw.get("groups", []):
        sel = g.get("selector")
        if not sel or sel in group_id_by_selector:
            continue
        gid = ids.form_id(sel) if g.get("type") == "form" else ids.group_id(sel)
        group_id_by_selector[sel] = gid
        raw_groups.append({"id": gid, "type": g.get("type", "section"), "label": g.get("label", "")})

    # ---------- 2. 元素 ----------
    seen_ids: set[str] = set()
    built: list[tuple[int, int, Element]] = []   # (rank, dom_order, element)
    for item in raw.get("elements", []):
        selector = item.get("selector")
        if not selector:
            continue
        eid = ids.element_id(selector)
        # 防御：选择器理论上唯一（extract_dom.js 已保证），万一碰撞则丢弃后来者，
        # 绝不允许出现两个元素共用一个 ID —— 那会让 B 的引用指向错误节点。
        if eid in seen_ids:
            continue
        seen_ids.add(eid)

        g_sel = item.get("group_selector")
        f_sel = item.get("form_selector")
        built.append((
            int(item.get("_rank", 1)),
            int(item.get("_order", len(built))),
            Element(
                id=eid,
                type=item.get("type", "other"),
                text=item.get("text", "") or "",
                label=item.get("label"),
                aria_label=item.get("aria_label"),
                placeholder=item.get("placeholder"),
                name=item.get("name"),
                value=item.get("value"),
                href=item.get("href"),
                selector=selector,
                xpath=item.get("xpath", ""),
                visible=bool(item.get("visible", False)),
                bbox=_bbox(item.get("bbox")),
                group_id=group_id_by_selector.get(g_sel) if g_sel else None,
                in_form=bool(item.get("in_form", False)),
                form_id=group_id_by_selector.get(f_sel) if f_sel else None,
                required=item.get("required"),
                disabled=bool(item.get("disabled", False)),
                level=item.get("level"),
                order=0,  # 截断后统一编号
            ),
        ))

    # ---------- 3. 截断：优先保可见的交互/结构元素，最后才牺牲隐藏元素 ----------
    truncated = False
    if len(built) > MAX_ELEMENTS:
        truncated = True
        always = [b for b in built if b[0] <= _KEEP_ALWAYS_MAX_RANK]
        optional = [b for b in built if b[0] > _KEEP_ALWAYS_MAX_RANK]
        if len(always) >= MAX_ELEMENTS:
            built = always[:MAX_ELEMENTS]
        else:
            built = always + optional[: MAX_ELEMENTS - len(always)]

    # 截断后恢复 DOM 文档序。
    # 优先级只用于决定「谁被保留」，绝不能变成「输出顺序即重要性排序」——
    # 那等于 C 在替 B 做功能排序，违反规范 §3。
    built.sort(key=lambda b: b[1])

    elements = [b[2] for b in built]
    for i, el in enumerate(elements):
        el.order = i

    # ---------- 4. 分组只保留仍有元素归属的 ----------
    grouped: dict[str, list[str]] = {}
    for el in elements:
        if el.group_id:
            grouped.setdefault(el.group_id, []).append(el.id)

    groups = [
        Group(id=g["id"], type=g["type"], label=g["label"], element_ids=grouped[g["id"]])
        for g in raw_groups
        if grouped.get(g["id"])
    ]

    # ---------- 5. 统计 ----------
    by_type: dict[str, int] = {}
    for el in elements:
        by_type[el.type] = by_type.get(el.type, 0) + 1

    stats = Stats(
        total=len(elements),
        visible=sum(1 for el in elements if el.visible),
        by_type=by_type,
        truncated=truncated,
    )

    return ElementsDocument(
        schema_version=SCHEMA_VERSION,
        page_url=page_url,
        final_url=raw.get("final_url") or page_url,
        page_title=(raw.get("page_title") or "").strip(),
        lang=raw.get("lang"),
        source=source,  # type: ignore[arg-type]
        fallback_reason=fallback_reason,
        stats=stats,
        elements=elements,
        groups=groups,
    )
