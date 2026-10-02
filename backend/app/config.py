"""EasyView 提取层配置。

服务端抓取已经退役（产品改为浏览器扩展在页面内提取），所以这里不再有
Playwright 超时、浏览器通道、SSRF 防护、拦截关键词等抓取期参数。
剩下的只有校验工具和提取参考实现需要的路径与输出上限。
"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent      # backend/
FIXTURES_DIR = BASE_DIR / "fixtures"
DOCS_DIR = BASE_DIR.parent / "docs"

# ---------- 输出上限 ----------
# 超大页面会撑爆 B 的 token 预算，必须设上限并如实标记 truncated。
MAX_ELEMENTS = int(os.getenv("EASYVIEW_MAX_ELEMENTS", "400"))

SCHEMA_VERSION = "1.1.0"
