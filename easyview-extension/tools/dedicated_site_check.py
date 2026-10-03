# -*- coding: utf-8 -*-
"""专用站点敬老版检查：真实网站上点开悬浮按钮 → 覆盖层 → 走一条任务链路 → 截图。

与 real_site_check.py 的分工
---------------------------
real_site_check.py 跑的是**通用**网页那条链路（提取 → 说明书 → 分析服务 → 草稿卡片），
目标是 easyview-ai-root。这里跑的是**专用**站点覆盖层（12306 / 中国移动 / 天气 / 邮政），
目标是 easyview-*-root，验证的是：
    - 品牌令牌是否跟着原站走（--ev-brand 是否等于原站主色）
    - 原站 Logo 是否挂进标题栏
    - 悬浮按钮能否点开覆盖层、任务卡片能否继续跳转

自动化同样没法伪造 activeTab 授权（专用覆盖层平时靠点扩展图标打开），
所以和 real_site_check.py 一样用放宽 host_permissions 的副本：
释放权限后 content_scripts 会直接注入，悬浮按钮就在页面上，等价于用户点图标后的状态。

用法：
    python tools/dedicated_site_check.py                 # 默认 12306
    python tools/dedicated_site_check.py --sites 12306,10086
    python tools/dedicated_site_check.py --headed false  # 无窗口（调试用）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import shutil
import sys

from playwright.async_api import async_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _chrome_launcher import (  # noqa: E402
    fix_console_encoding,
    launch_chrome,
    load_unpacked,
    stop_chrome,
    wait_for_cdp,
)

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
PROFILE_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-dedicated-profile"
TEST_EXTENSION_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-dedicated-ext"
OUT_DIR = HERE / "shots"

# root_id 用来定位 Shadow DOM；flow 是"点进去之后"用来判断任务链路真的换页了的选择器。
SITES = {
    "12306": {
        "label": "中国铁路12306",
        "url": "https://www.12306.cn/index/",
        "root": "easyview-root",
        "expect_brand": "#0472e7",
        "first_task": "我要买票",
        "flow_marker": ".ev-field, .ev-ticket, input",
    },
    "10086": {
        "label": "中国移动",
        "url": "https://www.10086.cn/",
        "root": "easyview-mobile-root",
        "expect_brand": None,
        "first_task": None,
        "flow_marker": None,
    },
    "10086bare": {
        "label": "中国移动（裸域入口）",
        "url": "https://10086.cn/index/zj_index_571_571.html",
        "root": "easyview-mobile-root",
        "expect_brand": None,
        "first_task": None,
        "flow_marker": None,
    },
    "weather": {
        "label": "中国天气网",
        "url": "https://www.weather.com.cn/",
        "root": "easyview-weather-root",
        "expect_brand": None,
        "first_task": None,
        "flow_marker": None,
    },
    "postal": {
        "label": "中国邮政",
        "url": "https://www.11185.cn/",
        "root": "easyview-postal-root",
        "expect_brand": None,
        "first_task": None,
        "flow_marker": None,
    },
}


def build_test_extension() -> pathlib.Path:
    """放宽 host_permissions 的副本 —— 自动化没法伪造 activeTab 的授权。"""
    shutil.rmtree(TEST_EXTENSION_DIR, ignore_errors=True)
    shutil.copytree(EXTENSION_DIR, TEST_EXTENSION_DIR,
                    ignore=shutil.ignore_patterns("tools", "shots", "__pycache__"))
    path = TEST_EXTENSION_DIR / "manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    manifest["host_permissions"] = ["<all_urls>"]
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return TEST_EXTENSION_DIR


def probe_js(root: str) -> str:
    """在主页世界读 Shadow DOM：品牌令牌、Logo、卡片、标题。"""
    return """(root) => {
      const host = document.getElementById(root);
      if (!host) return { mounted: false };
      const shadow = host.shadowRoot;
      if (!shadow) return { mounted: true, shadow: false };
      const css = getComputedStyle(host);
      const overlay = shadow.querySelector('.ev-overlay');
      const logo = shadow.querySelector('.ev-logo');
      const launcher = shadow.querySelector('.ev-launcher');
      const cards = [...shadow.querySelectorAll('.ev-card, .ev-login-entry, .ev-guide-actions > button')];
      return {
        mounted: true,
        shadow: true,
        brand: (css.getPropertyValue('--ev-brand') || '').trim(),
        accent: (css.getPropertyValue('--ev-accent') || '').trim(),
        radius: (css.getPropertyValue('--ev-radius') || '').trim(),
        font: (css.getPropertyValue('--ev-font') || '').trim().slice(0, 40),
        launcherVisible: !!launcher && !launcher.hidden,
        overlay: !!overlay,
        logo: logo ? (logo.getAttribute('src') || 'no-src') : null,
        logoLoaded: !!logo && logo.complete && logo.naturalWidth > 0,
        heading: (shadow.querySelector('.ev-brandcopy h1') || {}).textContent || null,
        cards: cards.length,
        cardLabels: [...shadow.querySelectorAll('.ev-card, .ev-login-entry')]
          .map(n => (n.querySelector('h3, h2, strong, span') || n).textContent.trim()).slice(0, 8)
      };
    }"""


CLICK_LAUNCHER = """(root) => {
  const host = document.getElementById(root); const s = host && host.shadowRoot;
  if (!s) return false;
  const b = s.querySelector('.ev-launcher');
  if (!b || b.hidden) return false;
  b.click();
  return true;
}"""


CLICK_TEXT = """([root, label]) => {
  const host = document.getElementById(root); const s = host && host.shadowRoot;
  if (!s) return false;
  const node = [...s.querySelectorAll('button, .ev-card, .ev-login-entry')]
    .find(n => n.textContent.trim().includes(label));
  if (!node) return false;
  node.click();
  return true;
}"""


async def open_overlay(page, root: str, timeout_s: float = 12.0) -> bool:
    """等悬浮按钮就位并点开覆盖层。"""
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        state = await page.evaluate(probe_js(root), root)
        if state.get("overlay"):
            return True
        if state.get("launcherVisible"):
            await page.evaluate(CLICK_LAUNCHER, root)
        await asyncio.sleep(0.4)
    return False


async def check_site(page, key: str, args) -> dict:
    cfg = SITES[key]
    root = cfg["root"]
    result = {"key": key, "label": cfg["label"], "url": cfg["url"], "ok": False, "notes": []}

    await page.goto(cfg["url"], wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_timeout(4000)

    if not await open_overlay(page, root, args.timeout):
        state = await page.evaluate(probe_js(root), root)
        result["notes"].append(f"覆盖层没打开：{json.dumps(state, ensure_ascii=False)[:200]}")
        result["state"] = state
        return result

    state = await page.evaluate(probe_js(root), root)
    result["state"] = state

    home_shot = OUT_DIR / f"{key}-home.png"
    await page.screenshot(path=str(home_shot))
    result["home_shot"] = str(home_shot)

    if cfg["expect_brand"]:
        actual = (state.get("brand") or "").lower()
        if actual != cfg["expect_brand"]:
            result["notes"].append(f"品牌色对不上：期望 {cfg['expect_brand']} 实得 {actual or '空'}")

    if state.get("logo") and not state.get("logoLoaded"):
        result["notes"].append(f"Logo 没加载成功：{state['logo']}")

    # 任务链路：点第一张卡，看内容区是否真的换了页面
    if cfg["first_task"]:
        clicked = await page.evaluate(CLICK_TEXT, [root, cfg["first_task"]])
        if not clicked:
            result["notes"].append(f"找不到入口「{cfg['first_task']}」")
        else:
            await page.wait_for_timeout(800)
            flow = await page.evaluate(
                """([root, marker]) => {
                  const host = document.getElementById(root); const s = host && host.shadowRoot;
                  const content = s && s.querySelector('.ev-content');
                  if (!content) return { found: false, html: 0 };
                  return { found: !!content.querySelector(marker),
                           html: content.children.length,
                           text: content.textContent.trim().slice(0, 60) };
                }""",
                [root, cfg["flow_marker"]],
            )
            result["flow"] = flow
            if not flow.get("found"):
                result["notes"].append(f"点了「{cfg['first_task']}」但内容区没换：{flow}")
            else:
                flow_shot = OUT_DIR / f"{key}-flow.png"
                await page.screenshot(path=str(flow_shot))
                result["flow_shot"] = str(flow_shot)

    result["ok"] = not result["notes"]
    return result


async def main() -> int:
    fix_console_encoding()
    parser = argparse.ArgumentParser(description="专用站点敬老版检查")
    parser.add_argument("--sites", default="12306", help="逗号分隔：" + ",".join(SITES))
    parser.add_argument("--timeout", type=float, default=12.0)
    parser.add_argument("--headed", default="true", help="true 开窗口（扩展必须在有窗口的 Chrome 里跑）")
    args = parser.parse_args()
    keys = [k.strip() for k in args.sites.split(",") if k.strip() in SITES]
    if not keys:
        print("没有匹配的站点", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(exist_ok=True)
    shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    load_dir = build_test_extension()
    print(f"测试副本：{load_dir}")

    results: list[dict] = []
    chrome = launch_chrome(PROFILE_DIR)
    if chrome is None:
        print("找不到 Chrome，请改 CHROME_CANDIDATES", file=sys.stderr)
        return 2
    proc, port = chrome
    try:
        await wait_for_cdp(port)
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            ext_id = await load_unpacked(browser, load_dir)
            print(f"扩展已加载，id={ext_id}")
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            await asyncio.sleep(2)
            page = await context.new_page()
            await page.set_viewport_size({"width": 1440, "height": 960})
            for key in keys:
                print(f"→ {SITES[key]['label']} …", flush=True)
                try:
                    results.append(await check_site(page, key, args))
                except Exception as exc:  # noqa: BLE001
                    results.append({"key": key, "label": SITES[key]["label"], "url": SITES[key]["url"],
                                    "ok": False, "notes": [f"{type(exc).__name__}: {str(exc)[:200]}"]})
                    try:
                        await page.close()
                    except Exception:  # noqa: BLE001
                        pass
                    page = await context.new_page()
            await browser.close()
    finally:
        stop_chrome(proc)

    for r in results:
        print("=" * 66)
        print(f"【{r['label']}】{r['url']}")
        state = r.get("state") or {}
        if state:
            print(f"  品牌:  --ev-brand {state.get('brand') or '(空)'}  强调色 {state.get('accent') or '-'}"
                  f"  圆角 {state.get('radius') or '-'}")
            print(f"  Logo:  {state.get('logo') or '(无)'}"
                  f"{'  [已加载]' if state.get('logoLoaded') else ''}")
            print(f"  标题:  {state.get('heading') or '-'}")
            print(f"  卡片:  {state.get('cards')} 张  {state.get('cardLabels')}")
        if r.get("flow"):
            print(f"  链路:  {r['flow']}")
        for note in r["notes"]:
            print(f"  ! {note}")
        if r.get("home_shot"):
            print(f"  截图:  {r['home_shot']}")
        if r.get("flow_shot"):
            print(f"  截图:  {r['flow_shot']}")
        print(f"  结果:  {'通过' if r['ok'] else '未通过'}")
    print("=" * 66)
    print(f"总结: {sum(1 for r in results if r['ok'])}/{len(results)} 个专用站点通过")
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
