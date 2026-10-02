# -*- coding: utf-8 -*-
"""EasyView B 模块服务入口。

HTTP:
    GET  /health
    POST /analyze        body 直接传 elements.json；加 ?ai=1 可选启用模型增强

CLI:
    python app.py --file docs/examples/elements.hospital.json --output out.json
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
    from pipeline import BuilderError, analyze, load_elements_file, write_json
    from llm_client import AIError, LlmConfig, OpenAICompatibleClient
except ImportError:  # 允许从仓库根目录以包方式导入
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from pipeline import BuilderError, analyze, load_elements_file, write_json
    from llm_client import AIError, LlmConfig, OpenAICompatibleClient


MAX_BODY_BYTES = 8 * 1024 * 1024


def _ai_client() -> OpenAICompatibleClient:
    config = LlmConfig.from_env()
    if config is None:
        raise AIError("未配置 EASYVIEW_API_KEY，已拒绝启用 AI；规则引擎仍可直接使用")
    return OpenAICompatibleClient(config)


def _extract_elements(body: Mapping[str, Any]) -> tuple[Mapping[str, Any], bool]:
    use_ai = bool(body.get("_easyview_ai"))
    if isinstance(body.get("elements_data"), Mapping):
        return body["elements_data"], use_ai
    if {"schema_version", "page_url", "elements"}.issubset(body.keys()):
        return body, use_ai
    raise BuilderError("请求体应为 elements.json，或包含 elements_data 对象")


class Handler(BaseHTTPRequestHandler):
    server_version = "EasyViewAI/0.1"

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
            self._json(200, {
                "ok": True,
                "service": "easyview-ai",
                "schema_version": "0.1.0-draft",
                "ai_configured": LlmConfig.from_env() is not None,
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

        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._error(400, f"请求体不是合法 UTF-8 JSON: {exc}")
            return
        if not isinstance(body, Mapping):
            self._error(400, "请求体顶层必须是对象")
            return

        try:
            elements_data, body_ai = _extract_elements(body)
            query = parse_qs(parsed.query)
            use_ai = body_ai or query.get("ai", ["0"])[0] == "1"
            client = _ai_client() if use_ai else None
            result = analyze(elements_data, ai_client=client)
        except AIError as exc:
            self._error(503, str(exc), "ai_unavailable")
            return
        except BuilderError as exc:
            self._error(422, str(exc), "invalid_elements")
            return
        except Exception as exc:  # noqa: BLE001 - HTTP 边界必须返回稳定结构
            self._error(500, f"内部错误: {type(exc).__name__}", "internal_error")
            return

        self._json(200, {"ok": True, "data": result})

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
    parser = argparse.ArgumentParser(description="EasyView B AI service")
    parser.add_argument("--file", help="直接分析一份 elements.json 后退出")
    parser.add_argument("--output", help="配合 --file 将结果写到指定路径")
    parser.add_argument("--ai", action="store_true", help="启用 AI 语义增强（需环境变量）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    if args.file:
        try:
            client = _ai_client() if args.ai else None
            result = analyze(load_elements_file(args.file), ai_client=client)
        except (AIError, BuilderError) as exc:
            print(str(exc), file=sys.stderr)
            return 2
        if args.output:
            write_json(args.output, result)
            print(args.output)
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    run_server(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())