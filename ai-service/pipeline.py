# -*- coding: utf-8 -*-
"""生成 ui_schema 0.3：模型提出任务，程序绑定与校验，规则引擎保底。

架构
----
    页面说明书 ──> 模型提出任务草稿 ──┐
                                      ├──> 绑定器 ──> 0.3 校验 ──> ui_schema
    规则引擎（关键词表）──> 规则草稿 ──┘         │
                                                 └─ 不通过 → 带问题反馈重试一次
                                                            → 仍不通过 → 退回规则草稿

三条路径产出**同一个版本号**，因为最后都经过绑定器：
模型草稿和规则草稿是同构的，绑定器是唯一构造 schema 的地方。
（此前规则引擎直接输出 0.1.0-draft，模型那层只在规则结果上润色，
版本对不上，而且模型没有机会决定"给老人看什么"。）

对外只需要 `analyze()`。
"""

from __future__ import annotations

import importlib.util
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from binder import POLICY_VERSION, bind
from builder import BuilderError, build_ui_schema
from digest import build_digest
from llm_client import AIError, ModelReply

SERVICE_DIR = Path(__file__).resolve().parent
REPO_DIR = SERVICE_DIR.parent
DRAFT_VALIDATOR_PATH = REPO_DIR / "docs" / "drafts" / "ui-schema-0.3" / "validate.py"

_validator_module: Any = None


def _draft_validator() -> Any:
    """按路径加载 0.3 草案校验器（它不在包里）。"""
    global _validator_module
    if _validator_module is None:
        spec = importlib.util.spec_from_file_location("easyview_draft_validator", DRAFT_VALIDATOR_PATH)
        if spec is None or spec.loader is None:
            raise BuilderError(f"找不到 0.3 校验器: {DRAFT_VALIDATOR_PATH}")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _validator_module = module
    return _validator_module


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# 规则引擎草稿
# --------------------------------------------------------------------------

_INTENT_HINTS = (
    ("pay", ("缴费", "交费", "支付", "付款", "充值", "费用", "账单")),
    ("book", ("挂号", "预约", "订票", "买票", "车票")),
    ("contact", ("联系", "客服", "电话", "咨询")),
    ("apply", ("办理", "申请", "申报", "登记", "提交")),
    ("query", ("查询", "查", "查看", "进度", "余额", "记录", "报告")),
    ("help", ("帮助", "指南", "说明", "常见问题")),
)


def _guess_intent(title: str) -> str:
    for intent, words in _INTENT_HINTS:
        if any(word in title for word in words):
            return intent
    return "learn"


def rules_draft(elements_data: Mapping[str, Any]) -> dict[str, Any]:
    """用确定性规则引擎生成一份与模型输出同构的草稿。"""
    ui = build_ui_schema(elements_data)
    cards: list[dict[str, Any]] = []
    for card in ui.get("cards") or []:
        action = card.get("action") or {}
        element_id = action.get("target_element_id")
        if not element_id:
            continue
        cards.append({
            "title": card.get("title"),
            "subtitle": card.get("subtitle"),
            "icon": card.get("icon"),
            "element_id": element_id,
            "intent": _guess_intent(str(card.get("title") or "")),
            "reason": "规则引擎按关键词表选出。",
        })
    page = ui.get("page") or {}
    return {"greeting": page.get("greeting"), "summary": page.get("summary"), "cards": cards}


# --------------------------------------------------------------------------
# 结果
# --------------------------------------------------------------------------

@dataclass
class AnalysisResult:
    ui_schema: dict[str, Any]
    mode: str = "rules"                       # model / rules
    fallback_reason: str | None = None
    dropped: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)   # 校验不通过才算
    notes: list[str] = field(default_factory=list)      # 非致命说明（如"模型超时，已降级"）
    reply: ModelReply | None = None
    digest_chars: int = 0
    attempts: int = 0

    @property
    def ok(self) -> bool:
        """产出是否通过校验。降级本身不算失败。"""
        return not self.problems

    def summary(self) -> dict[str, Any]:
        usage = self.reply.usage if self.reply else {}
        return {
            "mode": self.mode,
            "fallback_reason": self.fallback_reason,
            "cards": len(self.ui_schema.get("cards") or []),
            "state": self.ui_schema.get("state"),
            "attempts": self.attempts,
            "digest_chars": self.digest_chars,
            "problems": self.problems[:5],
            "notes": self.notes[:5],
            "dropped": self.dropped[:8],
            "latency_ms": self.reply.latency_ms if self.reply else None,
            "usage": usage,
        }


def _bind(draft: Mapping[str, Any], elements_data: Mapping[str, Any], raw_bytes: bytes,
          generated_at: str, mode: str, prompt_version: str | None,
          fallback_reason: str | None, dropped: list[str]) -> dict[str, Any]:
    return bind(
        draft, elements_data, raw_bytes,
        generated_at=generated_at,
        generator={"mode": mode, "prompt_version": prompt_version, "fallback_reason": fallback_reason},
        dropped_report=dropped,
    )


def _strict_problems(ui: Mapping[str, Any], elements_data: Mapping[str, Any],
                     raw_bytes: bytes) -> list[str]:
    """只看结构性错误 —— 绑定期丢弃的卡片不作为失败依据。"""
    return list(_draft_validator().validate(ui, elements_data, raw_bytes))


def _problems(ui: Mapping[str, Any], elements_data: Mapping[str, Any],
              raw_bytes: bytes, dropped: list[str]) -> list[str]:
    """结构 + 来源 + 策略校验，外加绑定期的丢弃原因（用于反馈给模型）。"""
    errors = _strict_problems(ui, elements_data, raw_bytes)
    errors.extend(f"卡片被丢弃：{item}" for item in dropped)
    return errors


def _rules_result(elements_data: Mapping[str, Any], raw_bytes: bytes, stamp: str,
                  fallback_reason: str | None, attempts: int,
                  digest_chars: int = 0,
                  notes: list[str] | None = None,
                  reply: ModelReply | None = None) -> AnalysisResult:
    dropped: list[str] = []
    ui = _bind(rules_draft(elements_data), elements_data, raw_bytes, stamp,
               "rules", None, fallback_reason, dropped)
    return AnalysisResult(ui_schema=ui, mode="rules", fallback_reason=fallback_reason,
                          dropped=dropped, problems=_strict_problems(ui, elements_data, raw_bytes),
                          notes=list(notes or []), reply=reply,
                          digest_chars=digest_chars, attempts=attempts)


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------

def analyze(
        elements_data: Mapping[str, Any],
        raw_bytes: bytes,
        *,
        ai_client: Any | None = None,
        generated_at: str | None = None,
) -> AnalysisResult:
    """生成 ui_schema 0.3。ai_client 为 None 时只走规则引擎。

    模型失败永远不阻断基础功能 —— 这是 0.3 明确要求的最后一道防线。
    """
    stamp = generated_at or _now()

    if ai_client is None:
        return _rules_result(elements_data, raw_bytes, stamp, None, 0)

    digest = build_digest(elements_data)
    prompt_version = getattr(ai_client, "prompt_version", None)
    feedback: list[str] | None = None
    last: AnalysisResult | None = None

    for attempt in (1, 2):
        try:
            reply = ai_client.analyze_draft(digest, feedback=feedback)
        except AIError as exc:
            return _rules_result(elements_data, raw_bytes, stamp, "network_error", attempt,
                                 len(digest), [f"模型调用失败: {exc}"])
        except Exception as exc:  # noqa: BLE001 - 降级必须是最后一道防线
            return _rules_result(elements_data, raw_bytes, stamp, "invalid_output", attempt,
                                 len(digest), [f"模型调用异常: {type(exc).__name__}"])

        dropped: list[str] = []
        ui = _bind(reply.draft, elements_data, raw_bytes, stamp,
                   "model", prompt_version, None, dropped)
        problems = _problems(ui, elements_data, raw_bytes, dropped)

        last = AnalysisResult(ui_schema=ui, mode="model", dropped=dropped, problems=problems,
                              reply=reply, digest_chars=len(digest), attempts=attempt)
        if not problems:
            return last

        feedback = [p.replace("被丢弃的卡片：", "这张卡不能用：") for p in problems[:12]]

    # 两次都没通过 → 退回规则草稿，如实记录原因
    return _rules_result(elements_data, raw_bytes, stamp, "invalid_output", 2,
                         len(digest),
                         [f"模型两次输出均未通过校验，退回规则引擎。最后一次问题: {p}"
                          for p in (last.problems[:5] if last else [])],
                         reply=last.reply if last else None)


def analyze_file(path: str | Path, *, ai_client: Any | None = None) -> AnalysisResult:
    raw = Path(path).read_bytes()
    return analyze(json.loads(raw.decode("utf-8-sig")), raw, ai_client=ai_client)


__all__ = ["AnalysisResult", "analyze", "analyze_file", "rules_draft", "POLICY_VERSION", "AIError"]
