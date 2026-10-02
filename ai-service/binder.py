# -*- coding: utf-8 -*-
"""绑定器：把模型的草稿绑成符合 ui_schema 0.3 的完整结果。

为什么需要这一层
----------------
0.3 的分工是「模型提出任务，程序负责绑定与策略」：

    B：规则或模型提出任务、文案、意图、排序及证据引用
      → B 的绑定/策略程序：复制真实定位信息、计算风险和统计
      → 结构检查 + 来源交叉检查 + 文案初筛
      → 通过检查的 ui_schema

模型**不碰**定位字段。它只说「我用 el_514efc10 这个元素的 text 字段支撑这张卡」，
由本模块回到 elements.json 里把 `selector` / `xpath` / `href` / `quote` 原样抄进来。
这样模型没有任何机会编造它们 —— 这是 0.3 相对旧协议的核心理由之一。

三个职责
--------
1. **回填**：元素 ID + 字段名 → 完整证据、定位字段、动作类型
2. **策略**：风险等级与确认文案由程序判定。模型可以"提示"一个等级，
   但只能往上抬，不能往下降（0.3 明确要求：模型不得降低策略要求）
3. **清洗**：把 URL、路径、技术词从给老人看的文案里剔掉

用法
----
    from binder import bind

    schema = bind(draft, elements_data, raw_bytes,
                  generated_at="2026-10-02T12:00:00+08:00",
                  generator={"mode": "model", "prompt_version": "senior-v0.3.1"})
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Mapping, Sequence
from urllib.parse import urlsplit

SCHEMA_VERSION = "0.3.0-draft"
POLICY_VERSION = "senior-v0.3"

EVIDENCE_FIELDS = ("text", "label", "aria_label", "placeholder")

TITLE_MAX = 12
SUBTITLE_MAX = 48

# 风险提示词表。宁可把普通操作判重，也不能把涉钱涉身份的操作判轻。
# 但也不能太宽 —— 早先用了「查」这个字，结果「查看科室、出诊时间」这类
# 完全公开的信息也被判成了涉及个人数据。
PAY_HINTS = ("缴费", "交费", "支付", "付款", "充值", "结算", "账单", "欠费", "缴纳")
MEDICAL_SUBMIT_HINTS = ("提交预约", "预约登记", "挂号登记", "预约挂号", "在线预约",
                        "门诊预约", "就诊人", "病历", "挂号")
IDENTITY_HINTS = ("身份证", "实名", "证件号", "人脸", "认证")
# 只列真正指向「本人数据」的词。公开信息（排班、指南、地图）不应命中。
PERSONAL_DATA_HINTS = ("报告", "病历", "医保", "社保", "公积金", "账户", "余额",
                       "订单", "我的", "明细", "缴费记录", "办理进度")

RISK_ORDER = {"normal": 0, "sensitive": 1, "blocked": 2}

# 给老人看的文案里不得出现的东西。与 validate.py 的 TECHNICAL_COPY 对齐。
_URL_LIKE = re.compile(
    r"(?:[a-z][a-z0-9+.-]*://\S+|www\.\S+|/(?:[A-Za-z0-9_.~-]+)(?:[/?.#]\S*)?|"
    r"\b[a-z0-9-]+\.(?:com|cn|org|net|edu|gov|html?|php|aspx?)\b)",
    re.IGNORECASE,
)
_TECH_WORDS = re.compile(
    r"(?:DOM|selector|xpath|token|JSON|ui_schema|element_id|target_selector|"
    r"选择器|免责声明|候选元素|技术字段)",
    re.IGNORECASE,
)


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------

def _clean(value: Any) -> str:
    return " ".join(str(value if value is not None else "").split()).strip()


def _scrub_copy(text: str) -> str:
    """去掉文案里的 URL、路径和技术词 —— 这些不该让老人看到。"""
    result = _URL_LIKE.sub(" ", text)
    result = _TECH_WORDS.sub(" ", result)
    result = re.sub(r"[（(]\s*[)）]", "", result)
    return " ".join(result.split()).strip(" -—·、,，。;；")


def _first_text(element: Mapping[str, Any], preferred: str | None = None) -> tuple[str, str]:
    """挑一个非空的证据字段。preferred 优先。"""
    order = list(EVIDENCE_FIELDS)
    if preferred and preferred in order:
        order.remove(preferred)
        order.insert(0, preferred)
    for field in order:
        value = _clean(element.get(field))
        if value:
            return field, value
    return "", ""


def _origin(url: str) -> tuple[str, str, int | None] | None:
    """返回 (scheme, netloc, port)；非法或缺少 host 时返回 None。"""
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if not parts.scheme or not parts.netloc:
        return None
    try:
        port = parts.port
    except ValueError:
        return None
    return parts.scheme.lower(), parts.netloc.lower(), port


def _page_origin(elements_data: Mapping[str, Any]) -> tuple[str, str, int | None] | None:
    """页面自身的 HTTP(S) 源。

    离线快照的 final_url 是 `snapshot://xxx` 这类伪协议，它不是真实源，
    不能拿来判同源 —— 否则同站链接会被误判成 external。
    这种情况按 0.3 的约定改用 page_url 提供源。
    """
    final = _clean(elements_data.get("final_url"))
    origin = _origin(final)
    if origin is not None and origin[0] in ("http", "https"):
        return origin
    if _clean(elements_data.get("source")) == "fallback" and final.startswith("snapshot://"):
        fallback = _origin(_clean(elements_data.get("page_url")))
        if fallback is not None and fallback[0] in ("http", "https"):
            return fallback
    return None


# --------------------------------------------------------------------------
# 策略：风险等级与确认文案
# --------------------------------------------------------------------------

def _haystack(element: Mapping[str, Any], title: str, subtitle: str | None) -> str:
    parts = [title, subtitle or "", _clean(element.get("text")), _clean(element.get("label")),
             _clean(element.get("aria_label")), _clean(element.get("placeholder")),
             _clean(element.get("href"))]
    return " ".join(p for p in parts if p)


def _policy_risk(element: Mapping[str, Any], title: str, subtitle: str | None,
                 intent: str, action_kind: str, href: str | None) -> tuple[str, list[str], list[str]]:
    """策略程序判定风险。返回 (level, reason_codes, domains)。

    顺序很重要：越严重的越先判，先命中先返回。
    """
    hay = _haystack(element, title, subtitle)

    # 1) 涉钱 —— 一律 blocked，扩展不得代办
    if intent == "pay" or any(word in hay for word in PAY_HINTS):
        return "blocked", ["payment"], ["money"]

    # 2) 医疗提交 —— blocked + healthcare
    if any(word in hay for word in MEDICAL_SUBMIT_HINTS):
        return "blocked", ["medical_submission"], ["healthcare"]

    # 3) 身份提交 —— blocked + identity
    if any(word in hay for word in IDENTITY_HINTS):
        return "blocked", ["identity_submission"], ["identity"]

    # 4) 打电话：交给设备电话处理程序
    if href and href.lower().startswith("tel:"):
        return "sensitive", ["external_handler"], ["external_handler"]

    # 5) 读本人数据 —— sensitive，需要先确认
    if any(word in hay for word in PERSONAL_DATA_HINTS):
        domains = ["healthcare"] if any(w in hay for w in ("报告", "病历", "挂号", "门诊", "就医", "医保")) else []
        return "sensitive", ["personal_data"], domains

    return "normal", ["read_only"], []


# 每个风险等级对应的「自洽」原因组合。模型的提示只能让等级上升，
# 升级时必须同时换成与该等级自洽的原因码 —— 否则会出现
# 「sensitive 却带着 blocked 原因」或「blocked 却没有 blocked 原因」这类
# 自相矛盾的组合，被 0.3 校验器直接拒绝。
_ESCALATED_REASONS = {
    "normal": ("normal", ["read_only"], []),
    "sensitive": ("sensitive", ["personal_data"], []),
    "blocked": ("blocked", ["unknown_effect"], []),
}


def _apply_model_hint(suggested: Any, level: str,
                      reasons: list[str], domains: list[str]) -> tuple[str, list[str], list[str]]:
    """模型只能把风险往上抬，不能往下降。升级时同时修正原因码。"""
    value = _clean(suggested).lower()
    if value not in RISK_ORDER or RISK_ORDER[value] <= RISK_ORDER[level]:
        return level, reasons, domains
    new_level, new_reasons, new_domains = _ESCALATED_REASONS[value]
    # 已经判出来的域信息保留（比如 healthcare / money 是有依据的）
    merged_domains = list(dict.fromkeys([*domains, *new_domains]))
    return new_level, new_reasons, merged_domains


def _confirmation(level: str, kind: str, target_kind: str, element: Mapping[str, Any]) -> dict[str, str] | None:
    """sensitive 必须有确认；normal / blocked 必须为 null（schema 强制）。"""
    if level != "sensitive":
        return None
    if kind == "form":
        message = "这会把页面定位到需要填写信息的地方，内容仍然由您在原网页填写。"
    elif (element.get("href") or "").lower().startswith("tel:"):
        message = "这会打开您的电话拨号，可能产生通话费用。"
    else:
        message = "这会打开需要核对个人信息的页面，请注意保护您的资料。"
    return {"message": message[:80], "confirm_label": "继续", "cancel_label": "先不打开"}


# --------------------------------------------------------------------------
# 动作
# --------------------------------------------------------------------------

def _resolve_action(element: Mapping[str, Any], level: str,
                    page_origin: tuple[str, str, int | None] | None) -> tuple[dict[str, Any], str] | None:
    """决定动作类型并回填定位字段。返回 (action, kind) 或 None（该卡无法安全执行）。"""
    kind_of_element = _clean(element.get("type"))
    selector = _clean(element.get("selector"))
    xpath = _clean(element.get("xpath")) or None
    if not selector:
        return None

    base = {
        "target_element_id": _clean(element.get("id")),
        "target_selector": selector,
        "target_xpath": xpath,
    }

    if kind_of_element == "form":
        # blocked 不允许用 form（schema 强制）；此时退化成"定位并聚焦"
        if level == "blocked":
            return {**base, "kind": "scroll", "href": None, "confirmation": None}, "scroll"
        return {**base, "kind": "form", "href": None, "confirmation": None}, "form"

    if kind_of_element == "link":
        href = element.get("href")
        href_text = _clean(href)
        url_origin = _origin(href_text)
        if url_origin is None:
            # href 是 javascript:; 之类，不能导航。但元素确实在页面上，
            # 而且它很可能就是老人要点的那个入口。
            #
            # 中文网站（尤其政务、交通、银行）大量用 javascript:; 代替真链接：
            # 实测 12306 首页 210 个链接里有 167 个是 javascript:;。
            # 早先这里直接返回 None，导致整张卡被丢弃 —— 12306 因此一张卡都出不来。
            #
            # 降级成"滚动定位 + 聚焦"，由用户自己点，既不越界也不丢信息。
            return {**base, "kind": "scroll", "href": None, "confirmation": None}, "scroll"
        if url_origin[0] == "tel":
            return {**base, "kind": "external", "href": href_text, "confirmation": None}, "external"
        if page_origin is not None and url_origin == page_origin:
            return {**base, "kind": "navigate", "href": href_text, "confirmation": None}, "navigate"
        return {**base, "kind": "external", "href": href_text, "confirmation": None}, "external"

    # 既不是链接也不是表单：只能滚动定位，不触发任何事件
    return {**base, "kind": "scroll", "href": None, "confirmation": None}, "scroll"


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def _card_id(index: int, title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")
    return f"card_{index:02d}_{slug}"[:60] if slug else f"card_{index:02d}"


def bind(
        draft: Mapping[str, Any],
        elements_data: Mapping[str, Any],
        raw_bytes: bytes,
        *,
        generated_at: str,
        generator: Mapping[str, Any],
        user_goal: str | None = None,
        dropped_report: list[str] | None = None,
) -> dict[str, Any]:
    """把模型草稿绑成完整 0.3 ui_schema。

    dropped_report 传入一个列表时，会往里写每张被丢弃卡片的原因（便于调试和重试反馈）。
    """
    elements = [e for e in (elements_data.get("elements") or []) if isinstance(e, Mapping)]
    by_id = {_clean(e.get("id")): e for e in elements}
    page_origin = _page_origin(elements_data)

    dropped = dropped_report if dropped_report is not None else []
    cards: list[dict[str, Any]] = []
    referenced: set[str] = set()

    raw_cards = draft.get("cards") if isinstance(draft, Mapping) else None
    if not isinstance(raw_cards, Sequence) or isinstance(raw_cards, (str, bytes)):
        raw_cards = []

    for index, item in enumerate(raw_cards):
        if not isinstance(item, Mapping):
            dropped.append(f"cards[{index}]: 不是对象")
            continue
        if len(cards) >= 7:
            dropped.append(f"cards[{index}]: 超过 7 张上限")
            continue

        element_id = _clean(item.get("element_id"))
        element = by_id.get(element_id)
        if element is None:
            dropped.append(f"cards[{index}]: 元素 {element_id or '(空)'} 不存在")
            continue
        if element.get("disabled") is True:
            dropped.append(f"cards[{index}]: 元素 {element_id} 已禁用")
            continue

        title = _scrub_copy(_clean(item.get("title")))
        if not title:
            dropped.append(f"cards[{index}]: 标题为空")
            continue
        if len(title) > TITLE_MAX:
            dropped.append(f"cards[{index}]: 标题「{title}」超过 {TITLE_MAX} 字")
            continue

        subtitle_raw = _scrub_copy(_clean(item.get("subtitle")))
        subtitle = subtitle_raw[:SUBTITLE_MAX] if subtitle_raw else None
        if subtitle and len(subtitle_raw) > SUBTITLE_MAX:
            dropped.append(f"cards[{index}]: 副标题被截断（原文 {len(subtitle_raw)} 字）")

        intent = _clean(item.get("intent")).lower() or "query"

        # 先算动作，因为风险策略要看动作类型
        resolved = _resolve_action(element, "normal", page_origin)
        if resolved is None:
            dropped.append(f"cards[{index}]: 元素 {element_id} 无法定位（缺少 selector 或 href 不合法）")
            continue

        level, reasons, domains = _policy_risk(
            element, title, subtitle, intent, resolved[1], element.get("href"))
        level, reasons, domains = _apply_model_hint(item.get("risk"), level, reasons, domains)

        resolved = _resolve_action(element, level, page_origin)
        if resolved is None:
            dropped.append(f"cards[{index}]: 按 {level} 风险重新解析动作失败")
            continue
        action, action_kind = resolved

        # scroll 只是把用户带到原网页的位置，不会替他点。
        # 如果标题写着"点这里"而实际只滚动，文案就是不诚实的 —— 统一改成如实说明。
        if action_kind == "scroll":
            subtitle = "回到原网页的这个位置，由您自己操作"

        field, quote = _first_text(element, _clean(item.get("evidence_field")) or None)
        if not field:
            dropped.append(f"cards[{index}]: 元素 {element_id} 没有任何可引用的文字")
            continue

        evidence_id = "ev_1"
        evidence = [{"id": evidence_id, "element_id": element_id, "field": field, "quote": quote}]
        source_ids = [element_id]

        # 附加证据：模型可以再引几个同组元素来支撑文案
        for extra in (item.get("also_cite") or [])[:5]:
            extra_id = _clean(extra)
            extra_element = by_id.get(extra_id)
            if extra_element is None or extra_id in source_ids:
                continue
            extra_field, extra_quote = _first_text(extra_element)
            if not extra_field:
                continue
            extra_evidence_id = f"ev_{len(evidence) + 1}"
            evidence.append({"id": extra_evidence_id, "element_id": extra_id,
                             "field": extra_field, "quote": extra_quote})
            source_ids.append(extra_id)

        # 标题若与来源原文完全一致，如实标成 verbatim；否则是改写
        title_mode = "verbatim" if title == quote else "rewritten"
        content_meta = {
            "title": {"mode": title_mode, "evidence_ids": [evidence_id]},
            "subtitle": ({"mode": "rewritten", "evidence_ids": [evidence_id]} if subtitle else None),
        }

        reasoning = _scrub_copy(_clean(item.get("reason")))[:160]
        if not reasoning:
            reasoning = f"来源中与「{title}」直接相关的入口。"

        card = {
            "id": _card_id(len(cards) + 1, title),
            "title": title,
            "subtitle": subtitle,
            "icon": _clean(item.get("icon")) or "info",
            "priority": len(cards) + 1,
            "intent": intent,
            "provenance": {"source_element_ids": source_ids, "evidence": evidence},
            "content_meta": content_meta,
            "facts": [],
            "ranking": {"reason_codes": ["main_service"],
                        "explanation": reasoning,
                        "evidence_ids": [e["id"] for e in evidence]},
            "risk": {"level": level, "domains": domains, "reason_codes": reasons,
                     "evidence_ids": [e["id"] for e in evidence]},
            "action": {**action, "confirmation": _confirmation(level, action_kind,
                                                                _clean(element.get("type")), element)},
        }

        # 模型可以要求保留一段原文事实（verbatim）
        fact = item.get("fact")
        if isinstance(fact, Mapping):
            fact_element_id = _clean(fact.get("element_id")) or element_id
            fact_element = by_id.get(fact_element_id)
            if fact_element is not None:
                fact_field, fact_quote = _first_text(fact_element, _clean(fact.get("field")) or None)
                if fact_field and fact_quote:
                    if fact_element_id not in source_ids:
                        source_ids.append(fact_element_id)
                    fact_evidence_id = f"ev_{len(evidence) + 1}"
                    evidence.append({"id": fact_evidence_id, "element_id": fact_element_id,
                                     "field": fact_field, "quote": fact_quote})
                    card["facts"] = [{"text": fact_quote, "content_mode": "verbatim",
                                      "evidence_ids": [fact_evidence_id]}]
                    card["content_meta"]["title"]["evidence_ids"] = list(
                        dict.fromkeys(card["content_meta"]["title"]["evidence_ids"]))
                    card["ranking"]["evidence_ids"] = [e["id"] for e in evidence]
                    card["risk"]["evidence_ids"] = [e["id"] for e in evidence]
                    card["provenance"]["source_element_ids"] = source_ids

        cards.append(card)
        referenced.update(source_ids)

    # icon 不在冻结集合里的换成 info，避免整体 schema 校验失败
    from_icons = {"home", "calendar", "document", "payment", "phone", "user", "search",
                  "location", "bus", "train", "hospital", "government", "warning",
                  "info", "help", "back"}
    for card in cards:
        if card["icon"] not in from_icons:
            card["icon"] = "info"

    # 重排 priority 为连续 1..N，并保证 card id 唯一
    seen_ids: set[str] = set()
    for index, card in enumerate(cards, start=1):
        card["priority"] = index
        if card["id"] in seen_ids:
            card["id"] = f"{card['id']}_{index}"
        seen_ids.add(card["id"])

    state = "ready" if cards else "empty"
    greeting = _scrub_copy(_clean(draft.get("greeting")))
    if not greeting:
        site = _clean(elements_data.get("page_title")) or "这个网站"
        greeting = f"您好，这里是{site}。" if state == "ready" else "您好，这个页面暂时没找到可以代办的事情。"
    summary = _scrub_copy(_clean(draft.get("summary")))
    if not summary:
        titles = [c["title"] for c in cards[:4]]
        if titles:
            summary = "您可以" + "、".join(titles) + "。"
        else:
            summary = "您可以退出适老模式，继续使用原网页。"

    return {
        "schema_version": SCHEMA_VERSION,
        "artifact_kind": "runtime",
        "source_elements_schema_version": _clean(elements_data.get("schema_version")),
        "page_url": _clean(elements_data.get("page_url")),
        "final_url": _clean(elements_data.get("final_url")),
        "page_title": _clean(elements_data.get("page_title")),
        "source": _clean(elements_data.get("source")),
        "generated_at": generated_at,
        "input_snapshot": {
            "sha256": hashlib.sha256(raw_bytes).hexdigest(),
            "extracted_at": _clean(elements_data.get("extracted_at")),
        },
        "generator": {
            "mode": _clean(generator.get("mode")) or "model",
            "policy_version": POLICY_VERSION,
            "prompt_version": generator.get("prompt_version"),
            "fallback_reason": generator.get("fallback_reason"),
        },
        "user_goal": _clean(user_goal) or None,
        "state": state,
        "empty_reason": None if state == "ready" else "no_reliable_tasks",
        "page": {"greeting": greeting[:64], "summary": summary[:100]},
        "stats": {
            "input_elements": len(elements),
            "visible_elements": sum(1 for e in elements if e.get("visible") is True),
            "input_truncated": bool((elements_data.get("stats") or {}).get("truncated", False)),
            "referenced_elements": len(referenced),
            "task_cards": len(cards),
        },
        "cards": cards,
    }


__all__ = ["bind", "SCHEMA_VERSION", "POLICY_VERSION", "TITLE_MAX", "SUBTITLE_MAX"]
