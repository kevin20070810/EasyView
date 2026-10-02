# -*- coding: utf-8 -*-
"""EasyView B 模块管线：规则引擎保底，AI 仅做可选的语义增强。"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from builder import (
    BuilderError,
    build_summary,
    build_ui_schema,
    is_clear_action_title,
    looks_like_news_or_marketing,
)


class SemanticClient(Protocol):
    """AI 客户端协议；实现 analyze() 即可注入。"""

    def analyze(self, elements_data: Mapping[str, Any], ui_schema: Mapping[str, Any]) -> Mapping[str, Any]:
        ...


def load_elements_file(path: str | Path) -> dict[str, Any]:
    source = Path(path)
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise BuilderError(f"找不到输入文件: {source}") from exc
    except json.JSONDecodeError as exc:
        raise BuilderError(f"elements.json 不是合法 JSON: {exc.msg} (line {exc.lineno})") from exc
    if not isinstance(data, dict):
        raise BuilderError("elements.json 顶层必须是对象")
    return data


def _clean_title(value: Any) -> str:
    text = " ".join(str(value or "").split()).strip()
    return text[:16]


def _clean_subtitle(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split()).strip()
    return text[:48] if text else None


def apply_ai_hints(
        ui_schema: Mapping[str, Any],
        hints: Mapping[str, Any],
) -> dict[str, Any]:
    """把模型返回的软建议应用到规则产出的结构上。

    模型只能修改已有卡片的标题、副标题和顺序，不能新增/删除卡片，
    也不能改 action、form 和任何元素 ID。
    """
    result = copy.deepcopy(dict(ui_schema))
    cards = result.get("cards")
    if not isinstance(cards, list) or not cards:
        return result

    hint_items = hints.get("cards") if isinstance(hints, Mapping) else None
    if not isinstance(hint_items, list):
        return result

    by_id = {str(card.get("id")): card for card in cards if isinstance(card, dict)}
    order: dict[str, int] = {}
    for item in hint_items:
        if not isinstance(item, Mapping):
            continue
        card_id = str(item.get("id") or "")
        card = by_id.get(card_id)
        if not card:
            continue

        title = _clean_title(item.get("title"))
        # 模型也可能把新闻、营销文案或纯业务名词塞回卡片；
        # 只有明确的动作标题才能覆盖规则标题，否则保留规则结果。
        if title and is_clear_action_title(title) and not looks_like_news_or_marketing(title):
            card["title"] = title

        subtitle = _clean_subtitle(item.get("subtitle"))
        card["subtitle"] = subtitle

        raw_priority = item.get("priority")
        try:
            priority = int(raw_priority)
        except (TypeError, ValueError):
            priority = len(order) + 1000
        order[card_id] = priority

    if order:
        indexed = list(enumerate(cards))
        indexed.sort(key=lambda pair: (order.get(str(pair[1].get("id")), 1000 + pair[0]), pair[0]))
        result["cards"] = [card for _, card in indexed]
        for idx, card in enumerate(result["cards"], start=1):
            card["priority"] = idx

    titles = [str(card.get("title") or "").strip() for card in result["cards"][:4]]
    titles = [title for title in titles if title]
    if titles:
        result["page"]["summary"] = build_summary(titles)
    return result


def analyze(
        elements_data: Mapping[str, Any],
        *,
        ai_client: SemanticClient | None = None,
) -> dict[str, Any]:
    """生成 ui_schema；AI 失败永远不阻断基础功能。"""
    ui_schema = build_ui_schema(elements_data)
    if ai_client is None:
        return ui_schema

    try:
        hints = ai_client.analyze(elements_data, ui_schema)
        return apply_ai_hints(ui_schema, hints)
    except Exception as exc:  # noqa: BLE001 - 降级必须是最后一道防线
        fallback = copy.deepcopy(ui_schema)
        extensions = fallback.setdefault("extensions", {})
        extensions["ai"] = {
            "enabled": False,
            "fallback_reason": type(exc).__name__,
        }
        return fallback


def analyze_file(
        path: str | Path,
        *,
        ai_client: SemanticClient | None = None,
) -> dict[str, Any]:
    return analyze(load_elements_file(path), ai_client=ai_client)


def write_json(path: str | Path, data: Mapping[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


__all__ = [
    "SemanticClient",
    "analyze",
    "analyze_file",
    "apply_ai_hints",
    "load_elements_file",
    "write_json",
]