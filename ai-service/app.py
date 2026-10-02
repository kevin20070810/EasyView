# -*- coding: utf-8 -*-
"""EasyView AI 服务入口。

HTTP:
    GET  /health
    POST /analyze        body 直接传 elements.json；加 ?ai=1 启用模型
                         ?debug=1 时额外返回本次生成的诊断信息

CLI:
    python app.py --file docs/examples/elements.hospital.json --ai --output out.json

产出是 ui_schema **0.3**。规则引擎与模型走同一个绑定器，所以版本不会漂移。
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, urlparse

try:
    from binder import SCHEMA_VERSION
    from builder import BuilderError
    from llm_client import AIError, LlmConfig, OpenAICompatibleClient
    from pipeline import analyze
except ImportError:  # 允许从仓库根目录以包方式导入
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from binder import SCHEMA_VERSION
    from builder import BuilderError
    from llm_client import AIError, LlmConfig, OpenAICompatibleClient
    from pipeline import analyze


MAX_BODY_BYTES = 8 * 1024 * 1024
# 说明书是压缩过的精选文字，正常几 KB；给足余量但别让人拿它当文件上传通道
MAX_DIGEST_CHARS = 200_000


def _ai_client() -> OpenAICompatibleClient:
    config = LlmConfig.from_env()
    if config is None:
        raise AIError("未配置 EASYVIEW_API_KEY，已拒绝启用 AI；规则引擎仍可直接使用")
    return OpenAICompatibleClient(config)


def _extract_elements(body: Mapping[str, Any]) -> tuple[Mapping[str, Any], bool]:
    """支持两种请求体：直接是 elements.json，或包一层 {elements_data, _easyview_ai}。"""
    use_ai = bool(body.get("_easyview_ai"))
    if isinstance(body.get("elements_data"), Mapping):
        return body["elements_data"], use_ai
    if {"schema_version", "page_url", "elements"}.issubset(body.keys()):
        return body, use_ai
    raise BuilderError("请求体应为 elements.json，或包含 elements_data 对象")


def _as_bytes(elements_data: Mapping[str, Any], raw: bytes, body: Mapping[str, Any]) -> bytes:
    """拿到 elements 自身的字节，供 input_snapshot.sha256 使用。

    请求体就是 elements.json 时直接用原始字节；包了一层时重新序列化 ——
    0.3 只要求校验时能反序列化回同一个对象，不要求与磁盘文件逐字节相同。
    """
    if elements_data is body:
        return raw
    return json.dumps(elements_data, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "EasyViewAI/0.3"

    def _headers(self, status: int, content_type: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # 页面内容既不落盘也不该被任何中间层缓存
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-EasyView-Retention", "none")

    def _json(self, status: int, payload: Mapping[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self._headers(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, message: str, code: str = "bad_request") -> None:
        self._json(status, {"ok": False, "error": {"code": code, "message": message}})

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._headers(204)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            config = LlmConfig.from_env()
            self._json(200, {
                "ok": True,
                "service": "easyview-ai",
                "schema_version": SCHEMA_VERSION,
                "ai_configured": config is not None,
                "model": config.model if config else None,
                "reasoning": config.reasoning if config else None,
            })
            return
        self._error(404, "接口不存在", "not_found")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path not in ("/analyze", "/draft"):
            self._error(404, "接口不存在", "not_found")
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._error(400, "Content-Length 不合法")
            return
        if length <= 0 or length > MAX_BODY_BYTES:
            self._error(413, "请求体为空或超过 8MB")
            return

        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            # 不回显异常内容：JSONDecodeError 的消息里会带出错的原文片段，
            # 那可能就是页面上的文字。
            self._error(400, "请求体不是合法 UTF-8 JSON", "bad_json")
            return
        if not isinstance(body, Mapping):
            self._error(400, "请求体顶层必须是对象")
            return

        query = parse_qs(parsed.query)
        debug = query.get("debug", ["0"])[0] == "1"

        if parsed.path == "/draft":
            self._handle_draft(body, debug)
            return

        try:
            elements_data, body_ai = _extract_elements(body)
            use_ai = body_ai or query.get("ai", ["0"])[0] == "1"
            client = _ai_client() if use_ai else None
            result = analyze(elements_data, _as_bytes(elements_data, raw, body), ai_client=client)
        except AIError as exc:
            self._error(503, str(exc), "ai_unavailable")
            return
        except BuilderError as exc:
            self._error(422, str(exc), "invalid_elements")
            return
        except Exception as exc:  # noqa: BLE001 - HTTP 边界必须返回稳定结构
            # 只记异常类型。异常消息有时会带上请求体片段，写进日志等于把页面内容留了下来。
            self.log_error("internal error: %s", type(exc).__name__)
            self._error(500, "服务内部错误", "internal_error")
            return

        payload: dict[str, Any] = {"ok": True, "data": result.ui_schema}
        if debug:
            payload["meta"] = result.summary()
        self._json(200, payload)

    def _handle_draft(self, body: Mapping[str, Any], debug: bool) -> None:
        """只收「页面说明书」，只回「任务草稿」。

        扩展里已经有 digest.js 和 binder.js，所以：
          - 定位字段（selector / xpath / href）**根本不需要发过来**
          - 绑定和风险策略在扩展本地跑
          - 这个端点只做一件事：文字进，模型出，JSON 回

        因此服务器永远看不到 DOM 选择器、完整链接，也看不到用户填过的内容。
        """
        digest = body.get("digest")
        if not isinstance(digest, str) or not digest.strip():
            self._error(400, "缺少 digest 字段（页面说明书文本）")
            return
        if len(digest) > MAX_DIGEST_CHARS:
            self._error(413, f"说明书过长（上限 {MAX_DIGEST_CHARS} 字符）")
            return

        try:
            client = _ai_client()
        except AIError as exc:
            self._error(503, str(exc), "ai_unavailable")
            return

        try:
            reply = client.analyze_draft(digest)
        except AIError as exc:
            self._error(503, str(exc), "ai_unavailable")
            return
        except Exception as exc:  # noqa: BLE001
            self.log_error("draft internal error: %s", type(exc).__name__)
            self._error(500, "服务内部错误", "internal_error")
            return

        payload: dict[str, Any] = {
            "ok": True,
            "draft": reply.draft,
            "prompt_version": client.prompt_version,
        }
        if debug:
            payload["meta"] = {
                "latency_ms": reply.latency_ms,
                "usage": reply.usage,
                "digest_chars": len(digest),
            }
        self._json(200, payload)

    def log_message(self, fmt: str, *args: Any) -> None:
        """只记请求行（方法、路径、状态码、字节数）。

        基类默认就是记这个，这里显式写出来是为了固定住：
        **请求体、页面文字、元素内容一律不进日志。**
        """
        sys.stderr.write("[easyview-ai] " + fmt % args + "\n")


def run_server(host: str, port: int) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"EasyView AI service listening on http://{host}:{port}", flush=True)
    print("  留存策略：不记录请求体、不落盘、不回显输入、响应标记 no-store", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description="EasyView AI service (ui_schema 0.3)")
    parser.add_argument("--file", help="直接分析一份 elements.json 后退出")
    parser.add_argument("--output", help="配合 --file 将结果写到指定路径")
    parser.add_argument("--ai", action="store_true", help="启用模型（需 EASYVIEW_API_KEY）")
    parser.add_argument("--debug", action="store_true", help="打印用量与诊断信息")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    if args.file:
        try:
            client = _ai_client() if args.ai else None
            source = Path(args.file)
            raw = source.read_bytes()
            result = analyze(json.loads(raw.decode("utf-8-sig")), raw, ai_client=client)
        except (AIError, BuilderError) as exc:
            print(str(exc), file=sys.stderr)
            return 2

        if args.debug:
            print(json.dumps(result.summary(), ensure_ascii=False, indent=2), file=sys.stderr)

        text = json.dumps(result.ui_schema, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            target = Path(args.output)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
            print(args.output)
        else:
            sys.stdout.write(text)
        if result.problems:
            print(f"⚠ 校验仍有 {len(result.problems)} 项问题", file=sys.stderr)
            return 1
        return 0

    run_server(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
