# -*- coding: utf-8 -*-
"""在隔离 Chrome 配置中检查多类真实网站的敬老版首张卡片。"""

from __future__ import annotations

import asyncio
import json
import os
import pathlib
import shutil
import sys
import tempfile
import uuid

from playwright.async_api import async_playwright

from _chrome_launcher import launch_chrome, load_unpacked, stop_chrome, wait_for_cdp, wait_for_worker

EXTENSION = pathlib.Path(__file__).resolve().parent.parent
PROFILE = pathlib.Path(tempfile.gettempdir()) / f"easyview-smoke-{uuid.uuid4().hex}"
SITES = [
    ("社区", "https://www.zhihu.com/hot"),
    ("AI 工具", "https://www.deepseek.com/"),
    ("政务", "https://www.gov.cn/"),
    ("百科", "https://www.wikipedia.org/"),
    ("购物", "https://www.jd.com/"),
    ("医院", "https://www.pumch.cn/"),
    ("视频", "https://www.bilibili.com/"),
    ("天气", "https://www.weather.com.cn/"),
    ("铁路", "https://www.12306.cn/index/"),
    ("邮政", "https://www.11185.cn/"),
    ("通信", "https://www.10086.cn/"),
]

STATE = """() => {
  const roots = ['easyview-ai-root', 'easyview-root', 'easyview-weather-root',
    'easyview-postal-root', 'easyview-mobile-root'];
  const host = roots.map(id => document.getElementById(id)).find(Boolean);
  const shadow = host?.shadowRoot;
  const panel = shadow?.querySelector('.ev-overlay');
  const cards = [...(shadow?.querySelectorAll('.ev-card') || [])];
  const launcher = document.getElementById('easyview-quick-launcher')?.shadowRoot;
  return {
    url: location.href,
    quickLauncher: !!launcher?.querySelector('.ev-open'),
    quickLogoImage: !!launcher?.querySelector('.ev-open img'),
    root: host?.id || null,
    overlay: !!panel && !panel.hidden,
    consent: !!shadow?.querySelector('.ev-ai-consent'),
    error: shadow?.querySelector('.ev-error')?.textContent?.trim() || null,
    heading: shadow?.querySelector('.ev-header h1')?.textContent?.trim() || null,
    panelText: shadow?.querySelector('.ev-content')?.textContent?.trim().slice(0, 110) || null,
    cards: cards.map(card => card.querySelector('strong, h3, h2')?.textContent?.trim()
      || card.textContent.trim().slice(0, 45)),
    listenButtons: shadow?.querySelectorAll('.ev-card-listen').length || 0,
    giantProjectLogo: [...document.querySelectorAll('img')].some(img =>
      img.getBoundingClientRect().width > 250 &&
      /easyview-logo|EasyView/i.test(img.src + ' ' + img.alt)),
    zoom: !!document.getElementById('easyview-page-assist')
  };
}"""

CLICK_BUTTON = """(label) => {
  const host = ['easyview-ai-root', 'easyview-root', 'easyview-weather-root',
    'easyview-postal-root', 'easyview-mobile-root']
    .map(id => document.getElementById(id)).find(Boolean);
  const buttons = [...(host?.shadowRoot?.querySelectorAll('button') || [])];
  const button = buttons.find(item => item.textContent.trim() === label);
  if (!button) return false;
  button.click();
  return true;
}"""

async def await_state(page, predicate, seconds=45):
    for _ in range(seconds * 2):
        state = await page.evaluate(STATE)
        if predicate(state):
            return state
        await asyncio.sleep(0.5)
    return await page.evaluate(STATE)


async def inspect(context, label, url):
    page = await context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error.stack or error)[:280]))
    result = {"type": label, "url": url}
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(2500)
        result["initial"] = await page.evaluate(STATE)
        try:
            await page.locator("#easyview-quick-launcher .ev-open").click(timeout=10000)
            result["opened"] = True
        except Exception as exc:  # noqa: BLE001
            result["opened"] = False
            result["openError"] = str(exc)[:180]
        if not result["opened"]:
            result["status"] = "快捷入口缺失"
            result["ok"] = False
            return result
        state = await await_state(page, lambda s: s["consent"] or s["cards"] or s["error"], 20)
        if state["consent"]:
            result["consentClicked"] = await page.evaluate(CLICK_BUTTON, "同意并继续")
            state = await await_state(page, lambda s: s["cards"] or s["error"], 55)
        result["beforeClick"] = state
        if not state["cards"]:
            result["status"] = state["error"] or "卡片未生成"
            result["ok"] = False
            return result
        if state["listenButtons"]:
            await page.locator(f"#{state['root']} .ev-card-listen").first.click(timeout=10000)
            await page.wait_for_timeout(500)
            audio_state = await page.evaluate(STATE)
            result["listen"] = {
                "buttons": state["listenButtons"],
                "stayedOnCards": audio_state["overlay"] and len(audio_state["cards"]) == len(state["cards"]),
                "error": audio_state["error"],
            }
        existing_pages = set(context.pages)
        card_index = int(os.environ.get("EASYVIEW_SMOKE_CARD_INDEX", "0"))
        result["cardIndex"] = card_index
        await page.locator(f"#{state['root']} .ev-card").nth(card_index).click(timeout=10000)
        result["firstClicked"] = True
        await page.wait_for_timeout(1800)
        result["afterClick"] = await page.evaluate(STATE)
        result["newTabs"] = [tab.url for tab in context.pages if tab not in existing_pages]
        if result["afterClick"]["zoom"]:
            await page.locator("#easyview-page-assist button[aria-label*='还原']").click(timeout=10000)
            await page.wait_for_timeout(500)
            result["zoomReset"] = not (await page.evaluate(STATE))["zoom"]
        after = result["afterClick"]
        advanced = (after["url"] != state["url"] or after["heading"] != state["heading"]
                    or not after["overlay"] or bool(result["newTabs"]))
        result["ok"] = (advanced and not after["giantProjectLogo"]
                        and not after["quickLogoImage"]
                        and result.get("zoomReset", True)
                        and result.get("listen", {}).get("stayedOnCards", True)
                        and (label == "铁路" or after["heading"] != "买火车票"))
        result["status"] = f"已点击第 {card_index + 1} 张卡"
        return result
    except Exception as exc:  # noqa: BLE001
        result["status"] = f"{type(exc).__name__}: {str(exc)[:180]}"
        result["ok"] = False
        return result
    finally:
        result["pageErrors"] = errors[:5]
        await page.close()


async def main():
    temporary = pathlib.Path(tempfile.gettempdir()).resolve()
    if PROFILE.parent.resolve() != temporary or not PROFILE.name.startswith("easyview-smoke-"):
        raise RuntimeError("测试配置目录不在预期临时目录内")
    chrome = launch_chrome(PROFILE, headless=True)
    if chrome is None:
        raise RuntimeError("找不到 Chrome")
    proc, port = chrome
    try:
        await wait_for_cdp(port)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            ext_id = await load_unpacked(browser, EXTENSION)
            context = browser.contexts[0]
            if not await wait_for_worker(context, ext_id):
                raise RuntimeError("扩展 service worker 未启动")
            print(f"EXTENSION={ext_id}", flush=True)
            selected = [item for item in SITES if not sys.argv[1:] or item[0] in sys.argv[1:]]
            results = []
            for label, url in selected:
                result = await inspect(context, label, url)
                results.append(result)
                print(json.dumps(result, ensure_ascii=True), flush=True)
            print(f"SUMMARY={sum(item.get('ok', False) for item in results)}/{len(results)}", flush=True)
            await browser.close()
            return 0 if all(item.get("ok", False) for item in results) else 1
    finally:
        stop_chrome(proc)
        if PROFILE.parent.resolve() == temporary and PROFILE.name.startswith("easyview-smoke-"):
            shutil.rmtree(PROFILE, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
