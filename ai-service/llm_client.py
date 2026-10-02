# -*- coding: utf-8 -*-
"""OpenAI 兼容接口客户端（仅使用 Python 标准库）。

设计要点
--------
**消息结构固定为「system 提示词 + user 页面说明书」**，而且 system 内容不随请求变化。
这样服务端的上下文缓存能命中固定前缀 —— 实测输入单价从 ¥1/M 降到 ¥0.02/M。
任何"每次动态改 system"的写法都会让缓存失效，输入立刻贵 50 倍。

环境变量：
    EASYVIEW_API_KEY       必填；没有它时服务走规则引擎
    EASYVIEW_BASE_URL      默认 https://api.deepseek.com/v1
    EASYVIEW_MODEL         默认 deepseek-flash
    EASYVIEW_TIMEOUT       默认 60 秒
    EASYVIEW_REASONING     推理档位：off / low / high / max，默认 low
                           off 会发送 thinking={"type":"disabled"}，实测输出
                           token 降到约 1/4，代价是复杂页面上略欠斟酌
    EASYVIEW_JSON_MODE     设为 1 时发送 response_format=json_object
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping
from urllib import error, request


class AIError(RuntimeError):
    """AI 调用失败；由 pipeline 捕获并降级。"""


REASONING_LEVELS = ("off", "low", "high", "max")


@dataclass(frozen=True)
class LlmConfig:
    api_key: str
    base_url: str = "https://api.deepseek.com/v1"
    model: str = "deepseek-flash"
    timeout: float = 60.0
    reasoning: str = "low"
    temperature: float = 0.0
    json_mode: bool = False

    @classmethod
    def from_env(cls) -> "LlmConfig | None":
        api_key = os.getenv("EASYVIEW_API_KEY", "").strip()
        if not api_key:
            return None
        reasoning = os.getenv("EASYVIEW_REASONING", cls.reasoning).strip().lower()
        if reasoning not in REASONING_LEVELS:
            reasoning = cls.reasoning
        try:
            temperature = float(os.getenv("EASYVIEW_TEMPERATURE", str(cls.temperature)))
        except ValueError:
            temperature = cls.temperature
        return cls(
            api_key=api_key,
            base_url=os.getenv("EASYVIEW_BASE_URL", cls.base_url).rstrip("/"),
            model=os.getenv("EASYVIEW_MODEL", cls.model),
            timeout=float(os.getenv("EASYVIEW_TIMEOUT", str(cls.timeout))),
            reasoning=reasoning,
            temperature=temperature,
            json_mode=os.getenv("EASYVIEW_JSON_MODE", "0").strip() == "1",
        )


@dataclass
class ModelReply:
    """一次模型调用的结果与用量。"""

    draft: dict[str, Any]
    usage: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0
    model: str = ""

    @property
    def cache_hit_tokens(self) -> int:
        return int(self.usage.get("prompt_cache_hit_tokens") or 0)

    @property
    def cache_miss_tokens(self) -> int:
        return int(self.usage.get("prompt_cache_miss_tokens") or 0)

    @property
    def reasoning_tokens(self) -> int:
        return int((self.usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)


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
            raise AIError("模型没有返回 JSON 对象") from None
        try:
            data = json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError as exc:
            raise AIError(f"模型返回的 JSON 无法解析: {exc.msg}") from exc
    if not isinstance(data, dict):
        raise AIError("模型返回的 JSON 顶层不是对象")
    return data


class OpenAICompatibleClient:
    """调用 /chat/completions 的最小客户端。"""

    def __init__(self, config: LlmConfig, *, prompt_path: Path | None = None):
        self.config = config
        self.prompt_path = prompt_path or (Path(__file__).resolve().parent / "prompts" / "analyze.prompt.md")
        self._system_cache: str | None = None
        self.last_reply: ModelReply | None = None

    @property
    def prompt_version(self) -> str:
        """提示词版本号，写进 ui_schema 的 generator.prompt_version。"""
        return f"{self.prompt_path.stem}-{self.config.model}-{self.config.reasoning}"

    def system_prompt(self) -> str:
        if self._system_cache is None:
            try:
                self._system_cache = self.prompt_path.read_text(encoding="utf-8")
            except OSError as exc:
                raise AIError(f"无法读取提示词: {self.prompt_path}") from exc
        return self._system_cache

    def _body(self, digest: str, feedback: list[str] | None) -> dict[str, Any]:
        user_content = digest
        if feedback:
            lines = "\n".join(f"- {item}" for item in feedback[:20])
            user_content += (
                "\n\n---\n上一次的输出有以下问题，请修正后重新输出完整的 JSON：\n"
                f"{lines}\n"
                "注意：不要新增任何说明文字，只输出修正后的 JSON。"
            )
        body: dict[str, Any] = {
            "model": self.config.model,
            "temperature": self.config.temperature,
            "messages": [
                {"role": "system", "content": self.system_prompt()},
                {"role": "user", "content": user_content},
            ],
        }
        if self.config.reasoning == "off":
            body["thinking"] = {"type": "disabled"}
        else:
            body["reasoning_effort"] = self.config.reasoning
        if self.config.json_mode:
            body["response_format"] = {"type": "json_object"}
        return body

    def analyze_draft(self, digest: str, *, feedback: list[str] | None = None) -> ModelReply:
        """把页面说明书发给模型，拿回任务草稿。"""
        body = self._body(digest, feedback)
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
        started = time.monotonic()
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
        latency_ms = int((time.monotonic() - started) * 1000)

        try:
            envelope = json.loads(raw)
            choice = envelope["choices"][0]
            content = choice["message"]["content"]
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise AIError("AI 接口返回结构不符合 chat/completions 约定") from exc
        if isinstance(content, list):
            content = "".join(str(part.get("text", "")) if isinstance(part, Mapping) else str(part)
                              for part in content)
        if not str(content or "").strip():
            finish = choice.get("finish_reason")
            raise AIError(f"模型返回了空内容（finish_reason={finish}）；"
                          "如果是 length，说明 max_tokens 被推理消耗完了")

        reply = ModelReply(
            draft=_extract_json(str(content)),
            usage=envelope.get("usage") or {},
            latency_ms=latency_ms,
            model=envelope.get("model") or self.config.model,
        )
        self.last_reply = reply
        return reply


__all__ = ["AIError", "LlmConfig", "ModelReply", "OpenAICompatibleClient", "REASONING_LEVELS"]
