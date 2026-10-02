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
        if parsed.path != "/analyze":
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
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(400, f"请求体不是合法 UTF-8 JSON: {exc}")
            return
        if not isinstance(body, Mapping):
            self._error(400, "请求体顶层必须是对象")
            return

        query = parse_qs(parsed.query)
        debug = query.get("debug", ["0"])[0] == "1"
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
            self._error(500, f"内部错误: {type(exc).__name__}: {exc}", "internal_error")
            return

        payload: dict[str, Any] = {"ok": True, "data": result.ui_schema}
        if debug:
            payload["meta"] = result.summary()
        self._json(200, payload)

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[easyview-ai] " + fmt % args + "\n")


def run_server(host: str, port: int) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"EasyView AI service listening on http://{host}:{port}", flush=True)
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
