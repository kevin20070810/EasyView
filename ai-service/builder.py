# -*- coding: utf-8 -*-
"""规则引擎：从 elements.json 构造候选卡片。

本模块保留旧结构作为规则草稿的内部来源；pipeline.rules_draft()
会提取任务，再由 0.3 绑定器和校验器生成最终 ui_schema。
当前输出协议见 docs/drafts/ui-schema-0.3/ui.schema.json。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlsplit

UI_SCHEMA_VERSION = "0.1.0-draft"
TZ_CST = timezone(timedelta(hours=8))

# 协议冻结的图标名（见 docs/drafts/ui-schema-0.3/ui.schema.json）
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
SPARSE_MIN_CARDS = 4

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

# ---------------------------------------------------------------------------
# 真实站点防退化：新闻标题和营销文案往往含有“办理/预约/养老”等词，
# 但并不是用户现在可以点击执行的功能。下面的判定先回答
# “它是不是一个清楚的动作入口”，再用关键词决定优先级。
# ---------------------------------------------------------------------------

ACTION_VERBS = (
    "挂号", "预约", "缴费", "交费", "支付", "办理", "申请", "申报",
    "购票", "订票", "退票", "改签", "查询", "查看", "查", "开具",
    "登记", "认证", "报销", "领取", "充值", "缴纳", "联系", "拨打",
    "咨询", "导航", "下载", "打印", "提交", "搜索", "填写", "更新",
    "变更", "取消", "退订", "找", "办", "买", "坐", "打车", "提", "开通",
)

DOMAIN_TERMS = (
    "挂号", "预约", "门诊", "就诊", "急诊", "住院", "科室", "医生",
    "专家", "报告", "缴费", "医保", "社保", "公积金", "办事", "证件",
    "证明", "补贴", "退休", "养老", "残疾人", "户籍", "违章", "车票",
    "火车", "公交", "地铁", "出租", "网约", "ETC", "路况", "停车场",
    "联系", "客服", "电话", "地址", "导航", "地图", "指南", "服务",
    "药房", "体检", "导医", "大厅",
)

NEWS_MARKERS = (
    "新闻", "公告", "通知", "通告", "动态", "要闻", "报道", "记者",
    "发布", "公示", "公开", "政策解读", "解读", "专题", "聚焦", "科普",
    "召开", "举行", "调研", "视察", "慰问", "表彰", "荣获", "获奖",
    "入选", "启动", "上线", "开通", "开售", "讲座", "论坛", "峰会",
    "签约", "倡议", "喜讯", "简讯", "快讯", "会议", "部署", "强调",
    "指出", "印发", "出台", "任免", "座谈", "会见",
)

MARKETING_MARKERS = (
    "广告", "推广", "畅行", "惠享", "尊享", "乐无忧", "无忧", "专属",
    "精选", "特惠", "优惠", "折扣", "领券", "限时", "首发", "全新",
    "焕新", "升级", "匠心", "品质", "尊贵", "重磅", "惊喜", "福利",
    "火热", "抢购", "秒杀", "品牌", "官方推荐", "钜惠", "惠民",
)

# 政策、条例、知识攻略等通常是对资讯的阅读，不是老人现在要办的事情。
# “always” 即使句中夹带动词也按资讯处理；“without_action” 只在缺少动作时处理，
# 这样“查政策”“医保政策查询”仍能保留为真实查询入口。
INFORMATIONAL_MARKERS_ALWAYS = (
    "新政策", "新政", "新规", "条例", "实施方案", "发展规划", "体系建设",
    "征求意见", "草案", "政策解读", "政策问答", "科普", "知识", "攻略",
    "百科", "风险提示", "预警", "辟谣",
)
INFORMATIONAL_MARKERS_WITHOUT_ACTION = (
    "政策", "办法", "方案", "规划", "规定", "意见", "最新", "提醒", "解读",
)

# 这些词也可能出现在正常业务入口里；只有同时具备“动作 + 业务对象”
# 且标题很短时，才允许覆盖资讯/营销判定。
NEWS_ACTION_OVERRIDES = ("开通", "发布", "上线", "启动")
MARKETING_ACTION_OVERRIDES = ("惠民", "无忧", "专属", "福利", "升级")
ACTION_PREFIXES = ("开户籍", "开证明", "开卡", "开票", "开户")


GENERIC_LOW_TEXTS = {
    "更多", "详情", "了解详情", "点击", "进入", "首页", "返回", "菜单",
    "服务", "登录", "注册", "english", "en", "网站首页",
    "查看页面", "查看页面内容",
}

# 稀疏页面兜底：只把页面已有标题/章节名改写为可执行入口。
SPARSE_TITLE_MAP = (
    ("预约挂号", "去挂号"),
    ("挂号", "去挂号"),
    ("门诊预约", "去挂号"),
    ("预约", "去预约"),
    ("科室", "查找科室"),
    ("医生", "查找医生"),
    ("专家", "查找专家"),
    ("门诊", "查看门诊"),
    ("急诊", "查看急诊"),
    ("住院", "查看住院服务"),
    ("体检", "查看体检"),
    ("药房", "查找药房"),
    ("就诊指南", "查看就诊指南"),
    ("就医指南", "查看就医指南"),
    ("患者服务", "查看患者服务"),
    ("便民服务", "查看便民服务"),
    ("特色医疗", "查看特色医疗"),
    ("护理", "查看护理服务"),
    ("缴费", "去缴费"),
    ("报告", "查报告"),
    ("医保", "查医保"),
    ("社保", "查社保"),
    ("公积金", "查公积金"),
    ("户籍", "查户籍"),
    ("证件", "办证件"),
    ("证明", "开证明"),
    ("补贴", "查补贴"),
    ("办事大厅", "查找办事大厅"),
    ("办事", "查看办事服务"),
    ("地址", "查看地址"),
    ("交通", "查看交通"),
    ("公交", "查公交"),
    ("地铁", "查看地铁"),
    ("停车", "查看停车"),
    ("地图", "查看地图"),
    ("大厅", "查找办事大厅"),
    ("医院概况", "了解医院"),
    ("医院介绍", "了解医院"),
    ("概况", "查看简介"),
    ("联系我们", "联系客服"),
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
    "医保查询": "查医保",
    "药品查询": "查药品",
    "住院服务": "查看住院服务",
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
    "ETC服务": "查ETC服务",
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

# 高频刚性需求：医疗、政务、交通中老人最常办理的事项。
# 这些词只用于同类高价值入口之间的排序，不会把新闻/广告拉回卡片。
CORE_CARD_TERMS = (
    "挂号", "报告", "缴费", "交费", "医保", "社保", "公积金", "违章",
    "办事指南", "户籍", "证件", "证明", "补贴", "养老金", "退休", "报销",
    "购票", "车票", "退票", "改签",
)
SECONDARY_CARD_TERMS = (
    "公交", "地铁", "打车", "出租", "网约", "ETC", "路况", "停车场",
    "住院", "门诊", "体检", "药房",
)

# 组合关键词：命中越多，越应当排到前面
_STRONG_COMBOS = (
    ("预约", "挂号"), ("门诊", "预约"), ("查询", "违章"), ("查询", "报告"),
    ("缴纳", "费用"), ("在线", "缴费"), ("医保", "查询"), ("社保", "查询"),
    ("公积金", "查询"), ("办事", "指南"), ("证件", "办理"),
)

_SPACE_RE = re.compile(r"\s+")
_MULTI_PUNCT_RE = re.compile(r"[|｜·•]+")
_AMOUNT_RE = re.compile(r"\d+(?:\.\d+)?\s*(?:亿|万|千)?\s*(?:元|人|人次)")
_DATE_RE = re.compile(r"(?:19|20)\d{2}\s*年|\d{1,2}\s*月\s*\d{1,2}\s*日|第\s*\d+\s*届")
_PERCENT_RE = re.compile(r"\d+(?:\.\d+)?\s*%")


class BuilderError(ValueError):
    """输入数据不满足 B 模块最小构造条件时抛出。"""


def _clean_text(value: Any) -> str:
    """把 DOM 文本整理成适合大字卡片的一行文本。"""
    if value is None:
        return ""
    text = _MULTI_PUNCT_RE.sub(" ", str(value))
    text = _SPACE_RE.sub(" ", text).strip()
    return text


def _safe_external_href(href: Any, page_url: Any = "") -> str | None:
    """返回可安全交给 A 打开的外部地址。

    同源 http(s) 链接继续走 ``navigate``，由 A 点击原网页元素，避免绕过站点
    自身的脚本和登录态。只有跨源链接以及 tel/mailto/sms/geo 这类明确协议才
    使用 ``external``；javascript/data 等伪协议一律拒绝。
    """
    raw = str(href or "").strip()
    if not raw or len(raw) > 2048:
        return None
    if any(ord(char) < 32 for char in raw):
        return None

    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https", "tel", "mailto", "sms", "geo"}:
        return None

    if scheme in {"http", "https"}:
        if not parsed.netloc:
            return None
        base = urlsplit(str(page_url or "").strip())
        if (
            base.scheme.lower() == scheme
            and base.netloc.lower() == parsed.netloc.lower()
        ):
            return None
        return raw

    # 非网页协议也必须有实际目标，不能是裸露的 ``tel:``。
    if len(raw) <= len(scheme) + 1:
        return None
    return raw


def _hits(text: str, words: Iterable[str]) -> int:
    """统计关键词命中数；同一关键词只计一次。"""
    if not text:
        return 0
    return sum(1 for word in words if word and word in text)


def _normalise_title(text: str) -> str:
    return _clean_text(text).replace(" ", "")


def _has_action_verb(text: str) -> bool:
    return any(text.startswith(prefix) for prefix in ACTION_PREFIXES) or any(
        word in text for word in ACTION_VERBS
    )


def _has_domain_term(text: str) -> bool:
    return any(word in text for word in DOMAIN_TERMS)


def looks_like_news_or_marketing(text: str) -> bool:
    """判断一段文本是否更像新闻/公告/营销，而不是可执行功能。

    真实站点经常把“办理留抵退税2818亿元”“铁路畅行惠享出行”放在
    可点击链接里。如果只依赖关键词，它们会因为“办理/出行”被误当成
    核心入口。这里用长度、金额、日期、栏目词和宣传词做结构化拦截。
    """
    title = _normalise_title(text)
    if not title:
        return False

    if any(word in title for word in LOW_CONTAINS):
        return True

    has_action = _has_action_verb(title)
    has_domain = _has_domain_term(title)
    # 短小的动宾结构优先；例如“开通电子医保凭证”是功能，
    # 而“铁路畅行惠享出行”没有清楚动作，仍是营销文案。
    action_entry = has_action and has_domain and len(title) <= 16
    news_hits = tuple(word for word in NEWS_MARKERS if word in title)
    marketing_hits = tuple(word for word in MARKETING_MARKERS if word in title)
    if news_hits and not (
            action_entry and all(word in NEWS_ACTION_OVERRIDES for word in news_hits)):
        return True
    if marketing_hits and not (
            action_entry and all(word in MARKETING_ACTION_OVERRIDES for word in marketing_hits)):
        return True

    if any(word in title for word in INFORMATIONAL_MARKERS_ALWAYS):
        return True
    if not has_action and any(word in title for word in INFORMATIONAL_MARKERS_WITHOUT_ACTION):
        return True

    # “2818亿元”“5万人”这类数字通常是新闻正文，不是按钮。
    if _AMOUNT_RE.search(title):
        return True

    # 日期本身不一定代表新闻；例如“2026年医保缴费”仍可能是入口。
    # 只有它同时缺少明确动作、或标题偏长时才降级。
    if _DATE_RE.search(title) and not (_has_action_verb(title) and len(title) <= 16):
        return True
    if _PERCENT_RE.search(title) and not _has_action_verb(title):
        return True

    # 常见新闻/宣传句式。
    if any(marker in title for marker in ("以人民为中心", "你对", "让出行", "让生活", "为您")):
        return True

    # 长句通常来自标题或摘要；只有当它同时有明确动作和业务对象时才保留。
    if len(title) >= 20 and not (_has_action_verb(title) and _has_domain_term(title)):
        return True
    if len(title) >= 16 and not _has_action_verb(title) and not _has_domain_term(title):
        return True
    return False


def is_action_like_title(text: str) -> bool:
    """判断文本是否像一个老人可以直接执行的功能入口。"""
    title = _normalise_title(text)
    if not title or title.lower() in GENERIC_LOW_TEXTS or looks_like_news_or_marketing(title):
        return False
    if title in TITLE_MAP:
        return True
    if _has_action_verb(title):
        # 动作动词开头，或“动作 + 业务对象”，都算可执行入口。
        if _has_domain_term(title):
            return True
        if any(title.startswith(verb) for verb in ACTION_VERBS if len(verb) >= 2):
            return len(title) <= 14
        return len(title) <= 12
    # “就医指南/科室导航”这类短业务词没有动词，但仍值得作为兜底入口。
    return _has_domain_term(title) and len(title) <= 16


def judge_importance(text: str, el_type: str = "") -> str:
    """返回 high / mid / low。

    规则引擎必须先把高风险、低价值的资讯排除；这是适老化改造的核心。
    """
    title = _normalise_title(text)
    if not title:
        return "low"

    if looks_like_news_or_marketing(title):
        return "low"
    if title in GENERIC_LOW_TEXTS:
        return "low"
    if title.endswith(LOW_SUFFIX):
        return "low"
    if not is_action_like_title(title) and el_type not in ("heading", "text", "nav"):
        return "low"

    high_hits = _hits(title, HIGH_KEYWORDS)
    mid_hits = _hits(title, MID_KEYWORDS)
    combo_hits = sum(1 for pair in _STRONG_COMBOS if all(word in title for word in pair))

    # 只有“咨询/介绍”等信息词时，不给高优先级。
    if high_hits >= 1 or combo_hits >= 1:
        return "high"

    if mid_hits >= 1:
        return "mid"
    if is_action_like_title(title):
        return "mid"
    return "low"


def is_clear_action_title(text: str) -> bool:
    """判断标题是否是明确的动作短语，供 AI 回写时做严格校验。"""
    title = _normalise_title(text)
    return bool(
        title
        and title.lower() not in GENERIC_LOW_TEXTS
        and len(title) <= MAX_TITLE_LEN
        and not looks_like_news_or_marketing(title)
        and _has_action_verb(title)
    )


def _ensure_action_title(title: str) -> str:
    """让兜底标题也保持“动词 + 对象”，避免只出现业务名词。"""
    cleaned = _normalise_title(title)
    if not cleaned:
        return "查看页面"
    if _has_action_verb(cleaned):
        return cleaned[:MAX_TITLE_LEN]

    if any(word in cleaned for word in ("专家", "医生", "科室", "药房")):
        prefix = "查找"
    elif any(word in cleaned for word in (
            "医保", "社保", "公积金", "户籍", "证明", "补贴", "养老金",
            "退休", "报销", "余额", "记录", "进度", "药品", "报告",
            "公交", "地铁", "车票", "时刻", "班次", "停车场", "ETC",
            "路况", "违章")):
        prefix = "查"
    else:
        prefix = "查看"

    available = MAX_TITLE_LEN - len(prefix)
    body = cleaned[:available] if available > 0 else cleaned[:MAX_TITLE_LEN]
    return (prefix + body)[:MAX_TITLE_LEN]


def simplify_title(text: str) -> str:
    """把网页原文改写成老人一眼能懂的大字标题。"""
    raw = _normalise_title(text)
    if not raw:
        return "查看页面"

    # 新闻/广告不应当被截短后伪装成功能卡片。
    if looks_like_news_or_marketing(raw):
        return "查看页面"

    if raw in TITLE_MAP:
        return _ensure_action_title(TITLE_MAP[raw])

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
        return _ensure_action_title(TITLE_MAP[title])

    # “医保查询 / 报告查询”等后置动词改写成更口语的“查医保 / 查报告”。
    if title.endswith("查询") and len(title) > 2 and not title.startswith("查询"):
        title = "查" + title[:-2]

    # 链接原文本身就是很短的动作短语时，保持原文。
    if len(title) <= MAX_TITLE_LEN:
        return _ensure_action_title(title)

    # 超长标题优先保留“动作 + 对象”，避免截成看不懂的半句话。
    for marker in ("查询", "查看", "办理", "申请", "缴费", "挂号", "预约", "联系"):
        idx = title.find(marker)
        if idx > 0:
            title = title[idx:]
            break

    if len(title) > MAX_TITLE_LEN:
        title = title[:MAX_TITLE_LEN]
    return _ensure_action_title(title)


def build_summary(titles: Sequence[Any]) -> str:
    """把卡片标题拼成自然、适合老年人阅读的一句话。"""
    clean_titles: list[str] = []
    for value in titles:
        title = _clean_text(value).rstrip("。！？!?；;，,、")
        for prefix in ("我要", "去", "请", "点此", "点击"):
            if title.startswith(prefix) and len(title) > len(prefix):
                title = title[len(prefix):]
                break
        if title:
            clean_titles.append(title)

    clean_titles = clean_titles[:4]
    if not clean_titles:
        return "这里可以帮助您查看页面上的常用功能"
    if len(clean_titles) == 1:
        return f"这里可以{clean_titles[0]}"
    if len(clean_titles) == 2:
        return f"这里可以{clean_titles[0]}和{clean_titles[1]}"
    return "这里可以" + "、".join(clean_titles[:-1]) + "和" + clean_titles[-1]


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


def build_card_for_element(
        element: Mapping[str, Any],
        page_url: Any = "",
) -> dict[str, Any] | None:
    """把单个可点击元素转成导航卡片。

    同源链接保留 ``navigate``，让 A 在原页面触发真实元素；跨源网页、电话、
    邮件等明确目标则输出 ``external``，同时保留元素 ID 便于追溯。
    """
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
    # 纯英文、单独一个“服务/首页”等无信息量标题不进入老人主界面。
    if _normalise_title(title).lower() in GENERIC_LOW_TEXTS:
        return None
    if title.lower() in {"english", "login", "register"}:
        return None

    subtitle = None
    if _normalise_title(title) != _normalise_title(raw_text):
        subtitle = raw_text[:30]

    external_href = _safe_external_href(element.get("href"), page_url)
    action = {
        "kind": "external" if external_href else "navigate",
        "target_element_id": str(element["id"]),
        "href": external_href,
    }

    return {
        "id": str(element["id"]),
        "title": title,
        "subtitle": _safe_subtitle(subtitle),
        "icon": categorize(raw_text),
        "importance": importance,
        "order": int(element.get("order") or 0),
        "action": action,
        "form": None,
    }


def _importance_score(card: Mapping[str, Any]) -> int:
    kind = card.get("action", {}).get("kind")
    importance = card.get("importance")
    score = {"high": 100, "mid": 50, "low": 10}.get(str(importance), 10)
    if kind == "form":
        score += 40

    text = _normalise_title(card.get("title"))
    if any(word in text for word in CORE_CARD_TERMS):
        score += 35
    elif any(word in text for word in SECONDARY_CARD_TERMS):
        score += 15

    if any(word in text for word in ("登录", "账号")):
        score -= 60
    # 联系方式是补充入口，不应压过挂号、报告、医保、违章等主流程。
    if any(word in text for word in ("联系", "客服", "咨询", "电话")):
        score += 5
    if any(word in text for word in ("介绍", "导航", "专家")):
        score -= 10
    if "指南" in text:
        score += 15
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


def _safe_order(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _form_card_is_visible(
        group: Mapping[str, Any],
        card: Mapping[str, Any],
        elements_by_id: Mapping[str, Mapping[str, Any]],
) -> bool:
    root_id = str(card.get("action", {}).get("target_element_id") or "")
    root = elements_by_id.get(root_id)
    if root and bool(root.get("visible", True)):
        return True
    for element_id in group.get("element_ids") or []:
        element = elements_by_id.get(str(element_id))
        if element and bool(element.get("visible", True)):
            return True
    return False


def _append_unique_cards(
        base: Sequence[dict[str, Any]],
        extras: Sequence[dict[str, Any]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_titles: set[str] = set()
    seen_targets: set[str] = set()
    for card in [*base, *extras]:
        card_id = str(card.get("id") or "")
        title_key = _normalise_title(card.get("title"))
        target_key = str(card.get("action", {}).get("target_element_id") or "")
        if not card_id or card_id in seen_ids:
            continue
        if title_key in seen_titles:
            continue
        if target_key and target_key in seen_targets:
            continue
        result.append(card)
        seen_ids.add(card_id)
        seen_titles.add(title_key)
        if target_key:
            seen_targets.add(target_key)
    return result


def _sparse_scroll_title(text: str) -> str | None:
    """把可见标题/区块名改写为保守的滚动入口；不确定时不生成卡片。"""
    cleaned = _clean_text(text)
    compact = _normalise_title(cleaned)
    if not compact or looks_like_news_or_marketing(compact):
        return None
    if compact in TITLE_MAP:
        return TITLE_MAP[compact]
    for marker, title in SPARSE_TITLE_MAP:
        if marker in compact:
            return title
    if is_action_like_title(compact):
        title = simplify_title(compact)
        if title and title != "查看页面" and len(title) <= MAX_TITLE_LEN:
            return title
    return None


def _sparse_element_types(stats_by_type: Mapping[str, Any] | None) -> list[str]:
    """按优先级返回确实存在的兜底来源类型；stats 缺失时保留全部候选。"""
    preferred = ["heading", "text", "link", "button", "submit", "nav", "image", "other"]
    if not isinstance(stats_by_type, Mapping) or not stats_by_type:
        return preferred
    available: list[str] = []
    for element_type in preferred:
        try:
            count = int(stats_by_type.get(element_type, 0))
        except (TypeError, ValueError):
            count = 0
        if count > 0:
            available.append(element_type)
    return available


def _sparse_scroll_cards(
        elements_data: Mapping[str, Any],
        existing: Sequence[Mapping[str, Any]],
        limit: int,
        *,
        stats_by_type: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """候选过少时，用可见标题/区块补足入口，而不是伪造新元素。"""
    if limit <= 0:
        return []
    elements = elements_data.get("elements") or []
    groups = elements_data.get("groups") or []
    if not isinstance(elements, list) or not isinstance(groups, list):
        return []

    by_id = {
        str(item.get("id")): item
        for item in elements
        if isinstance(item, Mapping) and item.get("id")
    }
    used_ids = {str(card.get("id") or "") for card in existing}
    used_titles = {_normalise_title(card.get("title")) for card in existing}
    used_targets = {
        str(card.get("action", {}).get("target_element_id") or "")
        for card in existing
    }
    result: list[dict[str, Any]] = []

    def add(target_id: Any, raw_text: Any, order: Any = 0) -> None:
        if len(result) >= limit:
            return
        element_id = str(target_id or "")
        if not element_id or element_id in used_ids or element_id in used_targets:
            return
        element = by_id.get(element_id)
        if not element or not bool(element.get("visible", True)):
            return
        title = _sparse_scroll_title(str(raw_text or ""))
        if not title:
            return
        title_key = _normalise_title(title)
        if not title_key or title_key in used_titles:
            return
        result.append({
            "id": element_id,
            "title": title,
            "subtitle": _safe_subtitle(raw_text) if _normalise_title(raw_text) != title_key else None,
            "icon": categorize(str(raw_text or title)),
            "importance": "mid",
            "order": _safe_order(order if order is not None else element.get("order")),
            "action": {
                "kind": "scroll",
                "target_element_id": element_id,
                "href": None,
            },
            "form": None,
        })
        used_ids.add(element_id)
        used_titles.add(title_key)
        used_targets.add(element_id)

    # 先看 main/section/nav 等区块标签，再看标题、文本和交互元素。
    for group in groups:
        if not isinstance(group, Mapping) or group.get("type") in {"form", "header", "footer"}:
            continue
        label = _clean_text(group.get("label"))
        if not label:
            continue
        member_ids = group.get("element_ids") or []
        members = [by_id.get(str(eid)) for eid in member_ids if str(eid) in by_id]
        visible_members = [item for item in members if bool(item.get("visible", True))]
        if not visible_members:
            continue
        target = next(
            (item for item in visible_members if item.get("type") in
             ("heading", "text", "nav", "form", "image", "link", "button")),
            visible_members[0],
        )
        add(target.get("id"), label, target.get("order"))

    for element_type in _sparse_element_types(stats_by_type):
        for element in elements:
            if not isinstance(element, Mapping) or element.get("type") != element_type:
                continue
            if not bool(element.get("visible", True)):
                continue
            raw_text = (
                _clean_text(element.get("text"))
                or _clean_text(element.get("aria_label"))
                or _clean_text(element.get("label"))
                or _clean_text(element.get("title"))
            )
            add(element.get("id"), raw_text, element.get("order"))

    return result


def _fallback_card(elements_data: Mapping[str, Any]) -> dict[str, Any] | None:
    elements = elements_data.get("elements") or []
    if not isinstance(elements, list) or not elements:
        return None
    candidates = sorted(
        [e for e in elements if isinstance(e, Mapping) and e.get("id")],
        key=lambda e: (not bool(e.get("visible", True)), _safe_order(e.get("order"))),
    )
    element = candidates[0]
    return {
        "id": str(element["id"]),
        "title": "查看页面内容",
        "subtitle": "页面上暂时没有识别到常用按钮",
        "icon": "info",
        "importance": "low",
        "order": _safe_order(element.get("order")),
        "action": {
            "kind": "scroll",
            "target_element_id": str(element["id"]),
            "href": None,
        },
        "form": None,
    }


def _stats_snapshot(elements_data: Mapping[str, Any], element_count: int) -> dict[str, Any]:
    """保留输入统计，并在 total 大于实际数组时保守地视为截断。"""
    raw = elements_data.get("stats")
    if not isinstance(raw, Mapping):
        return {}

    result: dict[str, Any] = {}
    for key in ("total", "visible"):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            result[key] = value

    by_type = raw.get("by_type")
    if isinstance(by_type, Mapping):
        cleaned_by_type: dict[str, int] = {}
        for key, value in by_type.items():
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                cleaned_by_type[str(key)] = value
        result["by_type"] = cleaned_by_type

    truncated = bool(raw.get("truncated", False))
    total = result.get("total")
    if isinstance(total, int) and total > element_count:
        truncated = True
    result["truncated"] = truncated
    return result


def _extend_input_stats(
        stats: Mapping[str, Any],
        elements_data: Mapping[str, Any],
        cards: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """补充只读诊断信息；A 可以忽略，B 用它定位真实站点退化。"""
    result = dict(stats)
    elements = elements_data.get("elements")
    actual_elements = elements if isinstance(elements, list) else []
    actual_visible = sum(
        1 for element in actual_elements
        if isinstance(element, Mapping) and bool(element.get("visible", True))
    )

    total = result.get("total")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        total = len(actual_elements)
    visible = result.get("visible")
    if not isinstance(visible, int) or isinstance(visible, bool) or visible < 0:
        visible = actual_visible

    result["visible_ratio"] = round(min(visible / total, 1.0), 3) if total else 0.0
    result["card_count"] = len(cards)
    result["external_count"] = sum(
        1 for card in cards
        if card.get("action", {}).get("kind") == "external"
    )
    result["scroll_count"] = sum(
        1 for card in cards
        if card.get("action", {}).get("kind") == "scroll"
    )
    result["sparse_fallback_used"] = bool(result["scroll_count"])
    return result


def build_cards(elements_data: Mapping[str, Any]) -> list[dict[str, Any]]:
    """构建、排序并截断卡片，确保 priority 从 1 连续递增。"""
    elements = elements_data.get("elements") or []
    groups = elements_data.get("groups") or []
    if not isinstance(elements, list) or not isinstance(groups, list):
        raise BuilderError("elements 和 groups 必须是数组")

    stats = _stats_snapshot(elements_data, len(elements))
    truncated = bool(stats.get("truncated", False))
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
            card["_visible"] = _form_card_is_visible(group, card, by_id)
            candidates.append(card)

    for element in elements:
        if not isinstance(element, Mapping):
            continue
        card = build_card_for_element(element, elements_data.get("page_url"))
        if card:
            card["_visible"] = True
            candidates.append(card)

    # 数据被截断时不假装看见了完整页面：主路径只接受可见候选。
    # 如果页面只有隐藏表单（例如弹窗里的购票表单），才把它当最后兜底。
    if truncated:
        visible_candidates = [card for card in candidates if card.get("_visible", True)]
        if visible_candidates:
            candidates = visible_candidates

    selected = _dedupe_cards(candidates)[:MAX_CARDS]
    if len(selected) < SPARSE_MIN_CARDS:
        extras = _sparse_scroll_cards(
            elements_data,
            selected,
            SPARSE_MIN_CARDS - len(selected),
            stats_by_type=stats.get("by_type"),
        )
        selected = _append_unique_cards(selected, extras)[:MAX_CARDS]

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
    summary = build_summary(titles)
    return {"greeting": greeting, "summary": summary}


def build_ui_schema(
        elements_data: Mapping[str, Any],
        *,
        generated_at: datetime | None = None,
) -> dict[str, Any]:
    """生成旧结构的规则结果，供 pipeline 转为 0.3 草稿。"""
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

    result = {
        "schema_version": UI_SCHEMA_VERSION,
        "source_elements_schema_version": str(elements_data["schema_version"]),
        "page_url": str(elements_data["page_url"]),
        "page_title": str(elements_data["page_title"]),
        "source": str(elements_data["source"]),
        "generated_at": generated.isoformat(timespec="seconds"),
        "page": _page_text(elements_data, cards),
        "cards": cards,
    }

    input_stats = _stats_snapshot(elements_data, len(elements_data.get("elements") or []))
    if input_stats:
        result["extensions"] = {
            "input_stats": _extend_input_stats(input_stats, elements_data, cards)
        }
    return result
