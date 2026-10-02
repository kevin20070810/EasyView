# -*- coding: utf-8 -*-
"""OpenAI 兼容接口客户端（仅使用 Python 标准库）。

环境变量：
    EASYVIEW_API_KEY       必填，没有它时服务自动走规则引擎
    EASYVIEW_BASE_URL      默认 https://api.openai.com/v1
    EASYVIEW_MODEL         默认 gpt-4.1-mini
    EASYVIEW_TIMEOUT       默认 20 秒
    EASYVIEW_JSON_MODE     设为 1 时发送 response_format=json_object
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib import error, request


class AIError(RuntimeError):
    """AI 调用失败；由 pipeline 捕获并降级。"""


@dataclass(frozen=True)
class LlmConfig:
    api_key: str
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4.1-mini"
    timeout: float = 20.0
    json_mode: bool = False

    @classmethod
    def from_env(cls) -> "LlmConfig | None":
        api_key = os.getenv("EASYVIEW_API_KEY", "").strip()
        if not api_key:
            return None
        return cls(
            api_key=api_key,
            base_url=os.getenv("EASYVIEW_BASE_URL", cls.base_url).rstrip("/"),
            model=os.getenv("EASYVIEW_MODEL", cls.model),
            timeout=float(os.getenv("EASYVIEW_TIMEOUT", str(cls.timeout))),
            json_mode=os.getenv("EASYVIEW_JSON_MODE", "0").strip() == "1",
        )


def _extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise AIError("模型没有返回 JSON 对象")
        try:
            data = json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError as exc:
            raise AIError(f"模型返回的 JSON 无法解析: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise AIError("模型返回的 JSON 顶层不是对象")
    return data


class OpenAICompatibleClient:
    """调用 /chat/completions 的最小客户端。"""

    def __init__(self, config: LlmConfig):
        self.config = config
        self.prompt_path = Path(__file__).resolve().parent / "prompts" / "analyze.prompt.md"

    def _system_prompt(self) -> str:
        try:
            return self.prompt_path.read_text(encoding="utf-8")
        except OSError as exc:
            raise AIError(f"无法读取提示词: {self.prompt_path}") from exc

    def _payload(self, elements_data: Mapping[str, Any], ui_schema: Mapping[str, Any]) -> dict[str, Any]:
        cards = []
        for card in ui_schema.get("cards", []):
            if not isinstance(card, Mapping):
                continue
            action = card.get("action") or {}
            cards.append({
                "id": card.get("id"),
                "title": card.get("title"),
                "subtitle": card.get("subtitle"),
                "icon": card.get("icon"),
                "kind": action.get("kind"),
                "target_element_id": action.get("target_element_id"),
            })
        return {
            "page": {
                "url": elements_data.get("page_url"),
                "title": elements_data.get("page_title"),
            },
            "candidate_cards": cards,
        }

    def analyze(
            self,
            elements_data: Mapping[str, Any],
            ui_schema: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        body: dict[str, Any] = {
            "model": self.config.model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": self._system_prompt()},
                {
                    "role": "user",
                    "content": json.dumps(self._payload(elements_data, ui_schema), ensure_ascii=False),
                },
            ],
        }
        if self.config.json_mode:
            body["response_format"] = {"type": "json_object"}

        request_obj = request.Request(
            f"{self.config.base_url}/chat/completions",
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with request.urlopen(request_obj, timeout=self.config.timeout) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise AIError(f"AI 接口返回 HTTP {exc.code}: {detail}") from exc
        except error.URLError as exc:
            raise AIError(f"AI 接口连接失败: {exc.reason}") from exc
        except TimeoutError as exc:
            raise AIError("AI 接口超时") from exc

        try:
            envelope = json.loads(raw)
            content = envelope["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise AIError("AI 接口返回结构不符合 chat/completions 约定") from exc
        if isinstance(content, list):
            content = "".join(str(part.get("text", "")) if isinstance(part, Mapping) else str(part) for part in content)
        return _extract_json(str(content))


__all__ = ["AIError", "LlmConfig", "OpenAICompatibleClient"]