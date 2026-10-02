"""Playwright 网页访问与 DOM 提取。

职责边界（规范 §3 / 任务书 §9）：
  ✅ 打开网页、读 DOM、清洗数据、输出 JSON
  ❌ 不调用 AI、不判断功能重要程度、不设计 UI

本模块只管「拿到原始结构」，协议封装全部交给 builder.py。
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import Browser, TimeoutError as PWTimeoutError, async_playwright

from . import fallback as fb
from .builder import build_document
from .config import (
    ALLOW_PRIVATE_HOSTS,
    ALLOWED_SCHEMES,
    BLOCK_KEYWORDS,
    BROWSER_CHANNEL,
    HEADLESS,
    NAV_TIMEOUT_MS,
    SETTLE_MS,
    USER_AGENT,
    VIEWPORT,
)
from .models import ElementsDocument

_JS_FN = Path(__file__).with_name("extract_dom.js").read_text(encoding="utf-8")
# 包成自执行表达式，避免 Playwright 对「字符串是不是函数」的判定歧义。
_EXTRACT_EXPR = f"({_JS_FN})()"

_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--no-sandbox",
]

logger = logging.getLogger("easyview.backend.extractor")


class URLRejected(ValueError):
    """URL 未通过安全校验。"""


# --------------------------------------------------------------------------- #
# URL 安全校验
# --------------------------------------------------------------------------- #
def _is_private_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False  # 解析不了就交给 Playwright 去失败，这里不误杀
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return True
    return False


def validate_url(url: str) -> str:
    """只放行 http/https，并默认挡住内网地址（SSRF 防护）。"""
    if not url or not url.strip():
        raise URLRejected("url 不能为空")
    url = url.strip()
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise URLRejected(
            f"仅支持 {'/'.join(ALLOWED_SCHEMES)} 协议，收到：{parsed.scheme or '(空)'}"
        )
    if not parsed.hostname:
        raise URLRejected("URL 缺少主机名")
    if not ALLOW_PRIVATE_HOSTS and _is_private_host(parsed.hostname):
        raise URLRejected(
            "拒绝访问内网/本机地址。本地联调请设置环境变量 EASYVIEW_ALLOW_PRIVATE_HOSTS=1"
        )
    return url


# --------------------------------------------------------------------------- #
# 浏览器复用（每请求启动一次浏览器太慢，改为进程内单例）
# --------------------------------------------------------------------------- #
class BrowserPool:
    """进程内浏览器单例。

    每请求启动一次浏览器要几百毫秒，视频演示时会明显拖慢；这里复用同一个实例。
    另外做**内核自动回退**：Playwright 自带 chromium 没装上时，自动改用系统 Chrome / Edge，
    避免现场因为一个下载失败就让整个服务起不来。
    """

    def __init__(self) -> None:
        self._playwright = None
        self._browser: Browser | None = None
        self._lock = asyncio.Lock()
        self._channel_used: str | None = None

    def _launch_options(self) -> list[dict]:
        if BROWSER_CHANNEL:
            return [{"channel": BROWSER_CHANNEL}]
        return [{}, {"channel": "chrome"}, {"channel": "msedge"}]

    async def get(self) -> Browser:
        async with self._lock:
            if self._browser is not None and self._browser.is_connected():
                return self._browser
            if self._playwright is None:
                self._playwright = await async_playwright().start()

            errors: list[str] = []
            for opts in self._launch_options():
                try:
                    self._browser = await self._playwright.chromium.launch(
                        headless=HEADLESS, args=_LAUNCH_ARGS, **opts
                    )
                    self._channel_used = opts.get("channel", "bundled-chromium")
                    logger.info("浏览器内核已启动: %s", self._channel_used)
                    return self._browser
                except Exception as exc:  # noqa: BLE001 - 逐个尝试，全部失败才报错
                    errors.append(f"{opts.get('channel', 'bundled-chromium')}: {exc}")

            raise RuntimeError(
                "无法启动任何浏览器内核。请先执行 `python -m playwright install chromium`，"
                "或设置 EASYVIEW_BROWSER_CHANNEL=chrome / msedge 使用系统浏览器。\n"
                + "\n".join(f"  - {e}" for e in errors)
            )

    async def close(self) -> None:
        async with self._lock:
            if self._browser is not None:
                try:
                    await self._browser.close()
                except Exception:  # noqa: BLE001 - 关闭失败不应影响退出
                    pass
                self._browser = None
            if self._playwright is not None:
                try:
                    await self._playwright.stop()
                except Exception:  # noqa: BLE001
                    pass
                self._playwright = None


pool = BrowserPool()


def _looks_blocked(title: str, body: str) -> bool:
    blob = f"{title}\n{body}".lower()
    return any(kw.lower() in blob for kw in BLOCK_KEYWORDS)


async def _read_page(page) -> dict:
    """在已打开的页面上执行提取脚本。"""
    return await page.evaluate(_EXTRACT_EXPR)


def _with_base(html: str, base_url: str) -> str:
    """给快照注入 <base>，让快照里的相对链接也能解析成绝对 URL。

    真实抓取时浏览器自带 URL 上下文，相对链接会自动补全；
    而本地快照走 set_content，页面地址是 about:blank，`a.href` 会停在相对值上。
    协议规定 href 必须是绝对 URL，因此这里补齐，保证两条路径产出同构数据。
    """
    tag = f'<base href="{base_url}">'
    lower = html.lower()
    idx = lower.find("<head")
    if idx != -1:
        end = html.find(">", idx)
        if end != -1:
            return html[: end + 1] + tag + html[end + 1:]
    return tag + html


async def _extract_from_html(html: str, *, base_url: str, wait_ms: int = 0) -> dict:
    """把一段 HTML（本地快照）载入浏览器并提取，保证与真实抓取走完全同一条解析路径。"""
    browser = await pool.get()
    context = await browser.new_context(
        viewport=VIEWPORT, user_agent=USER_AGENT, locale="zh-CN"
    )
    try:
        page = await context.new_page()
        await page.set_content(_with_base(html, base_url), wait_until="domcontentloaded")
        if wait_ms:
            await page.wait_for_timeout(wait_ms)
        return await _read_page(page)
    finally:
        await context.close()


async def _extract_live(url: str) -> dict:
    browser = await pool.get()
    context = await browser.new_context(
        viewport=VIEWPORT, user_agent=USER_AGENT, locale="zh-CN"
    )
    try:
        page = await context.new_page()
        await page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        await page.wait_for_timeout(SETTLE_MS)

        title = await page.title()
        body = (await page.inner_text("body"))[:5000] if await page.query_selector("body") else ""
        if _looks_blocked(title, body):
            raise RuntimeError("blocked: 疑似被人机验证/访问限制拦截")

        return await _read_page(page)
    finally:
        await context.close()


def _classify(exc: Exception) -> str:
    """把异常归类为协议冻结的 fallback_reason 取值。"""
    if isinstance(exc, PWTimeoutError):
        return "timeout"
    if isinstance(exc, URLRejected):
        return "unsupported"
    msg = str(exc)
    if msg.startswith("blocked:"):
        return "blocked"
    if msg.startswith("empty:"):
        return "empty"
    return "nav_error"


# --------------------------------------------------------------------------- #
# 对外入口
# --------------------------------------------------------------------------- #
async def extract(url: str, demo: str | None = None) -> ElementsDocument:
    """解析 URL，产出 elements.json。

    demo 指定时直接走本地快照；否则先真实抓取，失败自动降级（规范 §9）。
    """
    validated = validate_url(url)

    if demo:
        doc = await _snapshot_document(validated, demo, reason="requested")
        return doc

    try:
        raw = await _extract_live(validated)
        if not raw.get("elements"):
            raise RuntimeError("empty: 页面未解析到任何元素")
        return build_document(raw, page_url=validated, source="live")
    except Exception as exc:  # noqa: BLE001 - 任何失败都必须降级，不能把 500 抛给 A
        reason = _classify(exc)
        return await _snapshot_document(
            validated, fb.guess_snapshot(validated), reason=reason
        )


async def _snapshot_document(
    url: str, snapshot: str, *, reason: str
) -> ElementsDocument:
    path = fb.resolve_snapshot(snapshot)
    if path is None:
        raise RuntimeError(
            f"本地快照不可用（{fb.FIXTURES_DIR} 下没有 .html）。降级链路失效，请检查 backend/fixtures/。"
        )
    html = path.read_text(encoding="utf-8")
    # 用稳定的合成域名做 base，快照内的相对链接也能产出可读的绝对 URL
    raw = await _extract_from_html(html, base_url=f"https://demo.easyview.local/{path.stem}/")
    if not raw.get("elements"):
        raise RuntimeError(f"快照 {path.name} 未解析到任何元素，请检查该文件内容。")

    doc = build_document(
        raw,
        page_url=url,
        source="fallback",
        fallback_reason=reason,
    )
    # 快照是本地演示页，落地 URL 无意义，统一回报为 snapshot://，避免 A 误以为跳转到了真实站
    doc.final_url = f"snapshot://{path.stem}"
    if fb.SNAPSHOT_TITLES.get(path.stem):
        doc.page_title = fb.SNAPSHOT_TITLES[path.stem]
    return doc
