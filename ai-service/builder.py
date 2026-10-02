# -*- coding: utf-8 -*-
"""EasyView B 模块 · 卡片构建核心（规则引擎）

把 C 组的 elements.json（协议 v1.0.0）转成 A 组可渲染的 ui_schema.json（协议 0.1.0-draft）。

设计原则（这是「JSON 稳定」的保证）：
    大模型只做语义判断，**结构由本文件用纯 Python 组装**。
    即使完全不联网、不调用任何模型，本文件也能独立产出通过
    `backend/tools/check_ui.py` 全部校验的合规结果。

对应协议：
    docs/elements.schema.json   v1.0.0
    docs/ui.schema.json         v0.1.0-draft
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence

UI_SCHEMA_VERSION = "0.1.0-draft"
TZ_CST = timezone(timedelta(hours=8))

# 协议冻结的 16 个图标名（见 docs/ui.schema.json），填错会让卡片退化为默认图标
ICON_NAMES = (
    "home", "calendar", "document", "payment", "phone", "user", "search",
    "location", "bus", "train", "hospital", "government", "warning",
    "info", "help", "back",
)

INPUT_TYPES = {"input", "select", "textarea"}
SUBMIT_TYPES = {"submit", "button"}
INTERACTIVE_TYPES = {"button", "link", "submit"}
FORM_FIELD_TYPES = {"input", "select", "textarea"}

MAX_CARDS = 6
MAX_TITLE_LEN = 16

# ---------------------------------------------------------------------------
# 关键词表：任务书 §4「高=挂号/查询/缴费/办理，低=新闻/广告/介绍」
# ---------------------------------------------------------------------------

HIGH_KEYWORDS = (
    "挂号", "预约", "缴费", "交费", "支付", "办理", "申请", "申报",
    "购票", "退票", "改签", "订票", "报告", "社保", "医保", "公积金",
    "退休", "补贴", "报销", "证明", "进度", "记录", "余额", "时刻", "班次",
    "违章", "认证", "登记", "开具", "待遇", "救助", "养老", "残疾人",
)

MID_KEYWORDS = (
    "指南", "介绍", "导航", "联系", "电话", "地址", "位置", "时间", "须知",
    "流程", "说明", "帮助", "客服", "咨询", "科室", "专家", "地图",
    "公交", "地铁", "出租", "网约", "ETC", "路况", "停车场", "出行",
)

LOW_CONTAINS = (
    "新闻", "公告", "通知", "广告", "推广", "关于我们", "招聘", "隐私",
    "版权", "友情链接", "网站地图", "网站声明", "免责声明", "English",
    "管理入口", "返回首页", "网站首页", "注册", "忘记密码", "找回密码",
    "短信登录", "登录帮助", "使用帮助", "操作手册", "无障碍声明",
)

LOW_SUFFIX = (
    "公告", "通知", "通告", "说明", "活动", "指引", "手册", "开始了", "动态",
    "新闻", "声明", "启事", "招聘", "安排", "调整", "简讯", "快讯", "名单",
)

CATEGORY_ICONS = {
    "booking": "calendar",
    "payment": "payment",
    "query": "search",
    "report": "document",
    "contact": "phone",
    "login": "user",
    "profile": "user",
    "location": "location",
    "bus": "bus",
    "train": "train",
    "hospital": "hospital",
    "government": "government",
    "help": "help",
    "info": "info",
}

CATEGORY_KEYWORDS = {
    "booking": ("挂号", "预约", "门诊", "就诊"),
    "payment": ("缴费", "交费", "支付", "缴纳", "付款", "充值"),
    "report": ("报告", "化验", "检验", "结果"),
    "train": ("火车", "列车", "车票", "购票", "改签", "退票"),
    "bus": ("公交", "巴士", "换乘"),
    "contact": ("联系", "电话", "客服", "咨询"),
    "login": ("登录", "密码", "账号"),
    "location": ("地址", "位置", "导航", "地图", "大厅"),
    "query": ("查询", "查", "进度", "记录", "余额", "时刻", "班次", "违章"),
    "hospital": ("医院", "住院", "科室", "医生"),
    "government": ("政务", "办事", "医保", "社保", "公积金", "户籍", "补贴", "退休"),
}

# 换个老人一看就懂的说法（任务书 §4 的范例是基准线）
TITLE_MAP = {
    "门诊预约登记": "我要挂号",
    "预约挂号": "我要挂号",
    "门诊预约": "我要挂号",
    "挂号": "我要挂号",
    "在线缴费": "缴费",
    "缴费记录查询": "查交过的钱",
    "查看报告": "查看报告",
    "报告查询": "查看报告",
    "医保查询": "医保查询",
    "药品查询": "查药品",
    "住院服务": "住院服务",
    "联系我们": "联系客服",
    "联系在线客服": "联系客服",
    "投诉建议": "提建议",
    "办件进度查询": "查办件进度",
    "公积金查询": "查公积金",
    "社保缴费记录": "查社保缴费",
    "医保参保登记": "办医保",
    "户籍证明开具": "开户籍证明",
    "退休待遇申请": "办退休待遇",
    "残疾人补贴": "查残疾人补贴",
    "公租房申请": "申请公租房",
    "就业困难认定": "办就业认定",
    "各部门咨询电话": "查咨询电话",
    "办事大厅位置导航": "找办事大厅",
    "违章查询": "查违章",
    "查询违章记录": "查违章",
    "车票预订": "买火车票",
    "时刻表查询": "查时刻表",
    "改签退票": "退票改签",
    "公交查询": "查公交",
    "公交线路查询": "查公交",
    "地铁出行": "坐地铁",
    "出租网约": "打车",
    "ETC 服务": "ETC服务",
    "ETC 充值": "ETC充值",
    "停车场查询": "查停车场",
    "实时路况": "查看路况",
    "证照办理": "办证件",
    "失物招领": "找失物",
    "服务投诉": "提意见",
    "违章记录查询": "查违章",
    "办事指南查询": "查办事指南",
    "查询办事指南": "查办事指南",
    "登录": "登录账号",
    "用户登录": "登录账号",
    "登 录": "登录账号",
}

# 组合关键词：命中越多，越应当排到前面
_STRONG_COMBOS = (
    ("预约", "挂号"), ("门诊", "预约"), ("查询", "违章"), ("查询", "报告"),
    ("缴纳", "费用"), ("在线", "缴费"), ("医保", "查询"), ("社保", "查询"),
    ("公积金", "查询"), ("办事", "指南"), ("证件", "办理"),
)

_SPACE_RE = re.compile(r"\s+")
_MULTI_PUNCT_RE = re.compile(r"[|｜·•]+")


class BuilderError(ValueError):
    """输入数据不满足 B 模块最小构造条件时抛出。"""


def _clean_text(value: Any) -> str:
    """把 DOM 文本整理成适合大字卡片的一行文本。"""
    if value is None:
        return ""
    text = _MULTI_PUNCT_RE.sub(" ", str(value))
    text = _SPACE_RE.sub(" ", text).strip()
    return text


def _hits(text: str, words: Iterable[str]) -> int:
    """统计关键词命中数；同一关键词只计一次。"""
    if not text:
        return 0
    return sum(1 for word in words if word and word in text)


def _normalise_title(text: str) -> str:
    return _clean_text(text).replace(" ", "")


def judge_importance(text: str, el_type: str = "") -> str:
    """返回 high / mid / low。

    规则引擎必须先把高风险、低价值的资讯排除；这是适老化改造的核心。
    """
    title = _normalise_title(text)
    if not title:
        return "low"

    if any(word in title for word in LOW_CONTAINS) and not any(
            word in title for word in ("医保", "社保", "公积金", "挂号", "缴费")):
        return "low"

    if title.endswith(LOW_SUFFIX):
        return "low"

    high_hits = _hits(title, HIGH_KEYWORDS)
    mid_hits = _hits(title, MID_KEYWORDS)
    combo_hits = sum(1 for pair in _STRONG_COMBOS if all(word in title for word in pair))

    # 只有“咨询/介绍”等信息词时，不给高优先级。
    if high_hits >= 1 or combo_hits >= 1:
        return "high"

    if mid_hits >= 1:
        return "mid"
    return "low"


def simplify_title(text: str) -> str:
    """把网页原文改写成老人一眼能懂的大字标题。"""
    raw = _normalise_title(text)
    if not raw:
        return "查看页面"

    if raw in TITLE_MAP:
        return TITLE_MAP[raw]

    title = raw
    if "登录" in title or ("账号" in title and "密码" in title):
        return "登录账号"
    # 常见的“查询X”改成更口语化的“查X”。
    if title.startswith("查询") and len(title) > 2:
        title = "查" + title[2:]
    # “在线办理X”这类前缀不增加信息量。
    for prefix in ("在线办理", "网上办理", "在线", "网上"):
        if title.startswith(prefix) and len(title) > len(prefix):
            title = title[len(prefix):]
            break

    if title in TITLE_MAP:
        return TITLE_MAP[title]

    # 链接原文本身就是很短的动作短语时，保持原文。
    if len(title) <= MAX_TITLE_LEN:
        return title

    # 超长标题优先保留“动作 + 对象”，避免截成看不懂的半句话。
    for marker in ("查询", "查看", "办理", "申请", "缴费", "挂号", "预约", "联系"):
        idx = title.find(marker)
        if idx > 0:
            title = title[idx:]
            break

    if len(title) > MAX_TITLE_LEN:
        title = title[:MAX_TITLE_LEN]
    return title or "查看页面"


def categorize(text: str) -> str:
    """根据文本选择协议允许的图标名。"""
    title = _normalise_title(text)
    for category, words in CATEGORY_KEYWORDS.items():
        if any(word in title for word in words):
            return CATEGORY_ICONS.get(category, "info")
    return "info"


def _input_type_for(element: Mapping[str, Any]) -> str:
    """把 DOM 元素映射到协议允许的 9 种 input_type。"""
    el_type = element.get("type")
    if el_type == "select":
        return "select"
    if el_type == "textarea":
        return "text"

    # input 的 type 没有在 elements 协议中单独保留，因此按 name / label / placeholder 推断。
    haystack = _normalise_title(" ".join(
        _clean_text(element.get(key)) for key in ("name", "label", "placeholder", "text")
    ))
    if any(word in haystack for word in ("idcard", "身份证", "证件号")):
        return "idcard"
    if "password" in haystack or "密码" in haystack:
        return "password"
    if any(word in haystack for word in ("phone", "mobile", "tel", "手机", "电话")):
        return "tel"
    if any(word in haystack for word in ("date", "birth", "日期", "出生")):
        return "date"
    if any(word in haystack for word in ("number", "amount", "数量", "金额", "年龄")):
        return "number"
    if any(word in haystack for word in ("checkbox", "勾选", "同意")):
        return "checkbox"
    if any(word in haystack for word in ("radio", "选择")):
        return "radio"
    return "text"


def _field_label(element: Mapping[str, Any]) -> str:
    # label 是 C 已解析好的关联标签；placeholder/name 只是兜底。
    for key in ("label", "placeholder", "name", "text"):
        value = _clean_text(element.get(key))
        if value:
            return value[:24]
    return "请填写"


def _safe_subtitle(value: Any) -> str | None:
    text = _clean_text(value)
    return text if text else None


def _id_suffix(value: Any) -> str:
    text = str(value or "")
    return text.rsplit("_", 1)[-1] if "_" in text else text


def _form_root_id(group: Mapping[str, Any], members: Sequence[Mapping[str, Any]]) -> str | None:
    group_id = str(group.get("id") or "")
    suffix = _id_suffix(group_id)
    for element in members:
        if element.get("type") != "form":
            continue
        element_id = str(element.get("id") or "")
        if (
                element_id == group_id
                or element.get("form_id") == group_id
                or (suffix and _id_suffix(element_id) == suffix)):
            return element_id
    for element in members:
        if element.get("type") == "form":
            return str(element["id"])
    return None


def _submit_element(members: Sequence[Mapping[str, Any]]) -> Mapping[str, Any] | None:
    candidates = [e for e in members if e.get("type") in SUBMIT_TYPES]
    if not candidates:
        return None

    def rank(element: Mapping[str, Any]) -> tuple[int, int]:
        text = _normalise_title(element.get("text"))
        if any(word in text for word in ("重置", "清空", "取消", "返回")):
            return (9, int(element.get("order") or 0))
        if any(word in text for word in ("提交", "查询", "登录", "预约", "确认", "保存", "发送")):
            return (0, int(element.get("order") or 0))
        return (3, int(element.get("order") or 0))

    return sorted(candidates, key=rank)[0]


def build_card_for_form(
        group: Mapping[str, Any],
        elements_by_id: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any] | None:
    """把 groups 中的 form 转成一张可填写卡片。"""
    group_id = _clean_text(group.get("id"))
    member_ids = group.get("element_ids") or []
    if not group_id or not isinstance(member_ids, list):
        return None

    members = [elements_by_id[eid] for eid in member_ids if eid in elements_by_id]
    fields = [e for e in members if e.get("type") in FORM_FIELD_TYPES]
    submit = _submit_element(members)
    root_id = _form_root_id(group, members)
    if root_id is None:
        # 表单根节点本身不一定被 groups[].element_ids 收录；
        # 从全量元素里按 form_id 或同一 8 位哈希后缀找回。
        suffix = _id_suffix(group_id)
        for element in elements_by_id.values():
            if element.get("type") != "form":
                continue
            element_id = str(element.get("id") or "")
            if (
                    element.get("form_id") == group_id
                    or (suffix and _id_suffix(element_id) == suffix)):
                root_id = element_id
                break
    if not fields or submit is None or root_id is None:
        return None

    raw_title = (
        _clean_text(group.get("label"))
        or _clean_text(submit.get("text"))
        or _clean_text(next((e.get("text") for e in members if e.get("type") == "form"), ""))
        or _clean_text(fields[0].get("label"))
    )
    title = simplify_title(raw_title)

    # 登录表单在医疗/政务主流程中保留，但放到后面。
    login_form = any(word in _normalise_title(raw_title) for word in ("登录", "密码", "账号"))
    importance = "low" if login_form else judge_importance(raw_title, "button")
    if not login_form and importance == "low" and len(fields) >= 2:
        importance = "mid"

    form_fields: list[dict[str, Any]] = []
    seen: set[str] = set()
    for element in fields:
        eid = str(element.get("id") or "")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        form_fields.append({
            "element_id": eid,
            "label": _field_label(element),
            "input_type": _input_type_for(element),
            "placeholder": _safe_subtitle(element.get("placeholder")),
            "required": bool(element.get("required")),
        })

    if not form_fields:
        return None

    subtitle = _clean_text(group.get("label"))
    if subtitle and _normalise_title(subtitle) == _normalise_title(title):
        subtitle = "按提示填写信息"
    if not subtitle:
        subtitle = None

    return {
        "id": group_id,
        "title": title,
        "subtitle": _safe_subtitle(subtitle),
        "icon": categorize(raw_title or title),
        "importance": importance,
        "order": min((int(e.get("order") or 0) for e in members), default=0),
        "action": {
            "kind": "form",
            "target_element_id": root_id,
            "href": None,
        },
        "form": {
            "submit_element_id": str(submit["id"]),
            "fields": form_fields,
        },
    }


def build_card_for_element(element: Mapping[str, Any]) -> dict[str, Any] | None:
    """把单个可点击元素转成导航卡片。"""
    if element.get("type") not in INTERACTIVE_TYPES:
        return None
    if element.get("type") in {"submit", "button"} and element.get("form_id"):
        return None
    if not element.get("visible", True):
        return None

    raw_text = (
        _clean_text(element.get("text"))
        or _clean_text(element.get("aria_label"))
        or _clean_text(element.get("label"))
        or _clean_text(element.get("title"))
    )
    if not raw_text:
        return None

    importance = judge_importance(raw_text, str(element.get("type") or ""))
    if importance == "low":
        return None

    title = simplify_title(raw_text)
    # 纯英文和明显辅助项不进入老人主界面。
    if title.lower() in {"english", "login", "register"}:
        return None

    subtitle = None
    if _normalise_title(title) != _normalise_title(raw_text):
        subtitle = raw_text[:30]

    return {
        "id": str(element["id"]),
        "title": title,
        "subtitle": _safe_subtitle(subtitle),
        "icon": categorize(raw_text),
        "importance": importance,
        "order": int(element.get("order") or 0),
        "action": {
            "kind": "navigate",
            "target_element_id": str(element["id"]),
            "href": None,
        },
        "form": None,
    }


def _importance_score(card: Mapping[str, Any]) -> int:
    kind = card.get("action", {}).get("kind")
    importance = card.get("importance")
    score = {"high": 100, "mid": 50, "low": 10}.get(str(importance), 10)
    if kind == "form":
        score += 40
    text = _normalise_title(card.get("title"))
    if any(word in text for word in ("挂号", "缴费", "报告", "查违章", "查办事", "医保", "社保", "公积金")):
        score += 30
    if any(word in text for word in ("登录", "账号")):
        score -= 60
    if any(word in text for word in ("联系", "客服", "咨询", "电话")):
        score += 15
    if any(word in text for word in ("指南", "介绍", "导航", "专家")):
        score -= 5
    return score


def _dedupe_cards(cards: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """同一动作只保留信息量最高的一张卡片。"""
    kept: list[dict[str, Any]] = []
    seen_titles: set[str] = set()
    seen_targets: set[str] = set()

    for card in sorted(
            cards,
            key=lambda c: (-_importance_score(c), int(c.get("order") or 0), str(c.get("id") or "")),
    ):
        title_key = _normalise_title(card.get("title"))
        target = card.get("action", {}).get("target_element_id")
        target_key = str(target or "")
        # 表单和链接都可能写“我要挂号”；保留表单卡片。
        if title_key in seen_titles:
            continue
        if target_key and target_key in seen_targets:
            continue
        kept.append(card)
        seen_titles.add(title_key)
        if target_key:
            seen_targets.add(target_key)
    return kept


def _fallback_card(elements_data: Mapping[str, Any]) -> dict[str, Any] | None:
    elements = elements_data.get("elements") or []
    if not isinstance(elements, list) or not elements:
        return None
    candidates = sorted(
        [e for e in elements if isinstance(e, Mapping) and e.get("id")],
        key=lambda e: (not bool(e.get("visible", True)), int(e.get("order") or 0)),
    )
    element = candidates[0]
    return {
        "id": str(element["id"]),
        "title": "查看页面内容",
        "subtitle": "页面上暂时没有识别到常用按钮",
        "icon": "info",
        "importance": "low",
        "order": int(element.get("order") or 0),
        "action": {
            "kind": "scroll",
            "target_element_id": str(element["id"]),
            "href": None,
        },
        "form": None,
    }


def build_cards(elements_data: Mapping[str, Any]) -> list[dict[str, Any]]:
    """构建、排序并截断卡片，确保 priority 从 1 连续递增。"""
    elements = elements_data.get("elements") or []
    groups = elements_data.get("groups") or []
    if not isinstance(elements, list) or not isinstance(groups, list):
        raise BuilderError("elements 和 groups 必须是数组")

    by_id = {
        str(e.get("id")): e
        for e in elements
        if isinstance(e, Mapping) and e.get("id")
    }

    candidates: list[dict[str, Any]] = []
    for group in groups:
        if not isinstance(group, Mapping) or group.get("type") != "form":
            continue
        card = build_card_for_form(group, by_id)
        if card:
            candidates.append(card)

    for element in elements:
        if not isinstance(element, Mapping):
            continue
        card = build_card_for_element(element)
        if card:
            candidates.append(card)

    selected = _dedupe_cards(candidates)[:MAX_CARDS]
    if not selected:
        fallback = _fallback_card(elements_data)
        if fallback:
            selected = [fallback]

    cards: list[dict[str, Any]] = []
    for priority, card in enumerate(selected, start=1):
        clean_card = {
            "id": card["id"],
            "title": card["title"],
            "subtitle": card.get("subtitle"),
            "icon": card.get("icon") if card.get("icon") in ICON_NAMES else "info",
            "priority": priority,
            "action": card["action"],
            "form": card.get("form"),
        }
        cards.append(clean_card)
    return cards


def _page_text(elements_data: Mapping[str, Any], cards: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    page_title = _clean_text(elements_data.get("page_title"))
    if page_title:
        greeting = f"您好，这里是{page_title}"
    else:
        greeting = "您好，欢迎使用"

    titles = [_clean_text(card.get("title")) for card in cards[:4]]
    titles = [title for title in titles if title]
    if titles:
        summary = "这里可以" + "、".join(titles)
    else:
        summary = "这里可以帮助您查看页面上的常用功能"
    return {"greeting": greeting, "summary": summary}


def build_ui_schema(
        elements_data: Mapping[str, Any],
        *,
        generated_at: datetime | None = None,
) -> dict[str, Any]:
    """生成符合 docs/ui.schema.json 的完整对象。"""
    if not isinstance(elements_data, Mapping):
        raise BuilderError("输入必须是 JSON 对象")

    for key in ("schema_version", "page_url", "page_title", "source", "elements"):
        if key not in elements_data:
            raise BuilderError(f"缺少必填字段: {key}")

    cards = build_cards(elements_data)
    if not cards:
        raise BuilderError("页面中没有可生成卡片的元素")

    generated = generated_at or datetime.now(TZ_CST)
    if generated.tzinfo is None:
        generated = generated.replace(tzinfo=TZ_CST)

    return {
        "schema_version": UI_SCHEMA_VERSION,
        "source_elements_schema_version": str(elements_data["schema_version"]),
        "page_url": str(elements_data["page_url"]),
        "page_title": str(elements_data["page_title"]),
        "source": str(elements_data["source"]),
        "generated_at": generated.isoformat(timespec="seconds"),
        "page": _page_text(elements_data, cards),
        "cards": cards,
    }