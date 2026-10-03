"""本地 fixture 与 elements 协议校验工具使用的路径和输出上限。"""

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
