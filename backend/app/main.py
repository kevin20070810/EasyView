"""FastAPI 服务：EasyView C 组网页解析服务。

对外接口（任务书 §7 + 联调所需的最小扩展）：
  POST /extract          主接口：url -> elements.json
  GET  /health           健康检查
  GET  /snapshots        列出可用的本地降级快照（演示用）
  GET  /schema/elements  返回冻结的 elements 协议原文，供 B/A 拉取对齐

严格守住 C 组边界：不调用 AI、不判断功能重要程度、不设计 UI。
"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import fallback as fb
from .config import DOCS_DIR, NAV_TIMEOUT_MS, SCHEMA_VERSION
from .extractor import URLRejected, extract, pool, validate_url
from .models import ElementsDocument, ExtractRequest

logger = logging.getLogger("easyview.backend")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("EasyView 解析服务启动（nav_timeout=%sms, schema=%s）", NAV_TIMEOUT_MS, SCHEMA_VERSION)
    yield
    await pool.close()
    logger.info("EasyView 解析服务已关闭，浏览器实例已释放")


app = FastAPI(
    title="EasyView 网页解析服务 (C 组)",
    description="把网页转换成 AI 能够理解的数据。输入 URL，输出符合 docs/elements.schema.json 的 elements.json。",
    version="1.0.0",
    lifespan=lifespan,
)

# A 组的前端在浏览器里直连本服务，必须放开 CORS，否则联调第一步就卡住。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", summary="健康检查")
async def health() -> dict:
    return {
        "status": "ok",
        "service": "easyview-backend",
        "schema_version": SCHEMA_VERSION,
        "snapshots": fb.available_snapshots(),
    }


@app.get("/snapshots", summary="列出可用的本地降级快照")
async def snapshots() -> dict:
    return {"snapshots": fb.available_snapshots(), "default": fb.DEFAULT_SNAPSHOT}


@app.get("/schema/elements", summary="返回冻结的 elements 协议原文")
async def elements_schema() -> JSONResponse:
    path = DOCS_DIR / "elements.schema.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"协议文件不存在：{path}")
    return JSONResponse(content=json.loads(path.read_text(encoding="utf-8")))


@app.post("/extract", response_model=ElementsDocument, summary="解析网页，输出 elements.json")
async def extract_endpoint(req: ExtractRequest) -> ElementsDocument:
    """输入 URL，输出 elements.json。

    真实抓取失败时**不会**返回 5xx，而是自动降级到本地快照并标记
    `source="fallback"` + `fallback_reason`（规范 §9），保证 A 组永远拿得到可渲染数据。
    """
    try:
        validate_url(req.url)
    except URLRejected as exc:
        # 参数问题属于调用方错误，明确返回 400，不要用降级掩盖。
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        return await extract(req.url, demo=req.demo)
    except RuntimeError as exc:
        # 走到这里说明连降级快照都不可用，属于部署问题，必须让人看见。
        logger.error("解析且降级均失败: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("未预期的解析错误")
        raise HTTPException(status_code=500, detail=f"解析失败：{exc}") from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
