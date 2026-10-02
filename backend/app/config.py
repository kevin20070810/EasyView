"""C 组后端配置。所有可调参数集中在此，便于联调时快速改动。"""

from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent      # backend/
FIXTURES_DIR = BASE_DIR / "fixtures"
DOCS_DIR = BASE_DIR.parent / "docs"

# ---------- 抓取 ----------
# 真实站点（医院/政务）往往慢且重，25s 是「给足机会」与「不拖垮前端」之间的折中。
NAV_TIMEOUT_MS = int(os.getenv("EASYVIEW_NAV_TIMEOUT_MS", "25000"))
# 等待 JS 渲染（很多政务站点的入口是前端异步渲染的）后再提取。
SETTLE_MS = int(os.getenv("EASYVIEW_SETTLE_MS", "1500"))
HEADLESS = os.getenv("EASYVIEW_HEADLESS", "1") != "0"
# 浏览器内核选择。留空则依次尝试：Playwright 自带 chromium -> 系统 Chrome -> 系统 Edge。
# 现场演示时的保命开关：即使 `playwright install` 没跑成功，服务依然能起来。
BROWSER_CHANNEL = os.getenv("EASYVIEW_BROWSER_CHANNEL", "").strip()
VIEWPORT = {"width": 1366, "height": 900}
USER_AGENT = os.getenv(
    "EASYVIEW_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
)

# ---------- 输出上限 ----------
# 超大页面会撑爆 B 的 token 预算，必须设上限并如实标记 truncated。
MAX_ELEMENTS = int(os.getenv("EASYVIEW_MAX_ELEMENTS", "400"))

# ---------- 安全 ----------
# 只允许 http/https，挡住 file:// javascript: data: 等危险协议。
ALLOWED_SCHEMES = ("http", "https")
# SSRF 防护：默认禁止抓取内网/本机地址。需要本地联调时置 1 放开。
ALLOW_PRIVATE_HOSTS = os.getenv("EASYVIEW_ALLOW_PRIVATE_HOSTS", "0") == "1"

# ---------- 降级（规范 §9） ----------
# 命中这些关键字时判定为被拦截，直接走 fallback，不浪费时间重试。
BLOCK_KEYWORDS = (
    "captcha", "验证码", "人机验证", "安全验证", "访问受限",
    "access denied", "are you a robot", "请开启javascript",
)

SCHEMA_VERSION = "1.1.0"
