# -*- coding: utf-8 -*-
"""给前端评审用：在真实网站上打开敬老版并截图。

用法：
    python tools/shot_for_review.py --sites gov,12306
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import shutil
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
PROFILE_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-shot-profile"
TEST_EXTENSION_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-shot-ext"
OUT_DIR = HERE / "shots"

SITES = {
    "gov": ("中国政府网", "https://www.gov.cn/"),
    "12306": ("中国铁路12306", "https://www.12306.cn/"),
    "bjbus": ("北京公交", "https://www.bjbus.com/"),
    "pumch": ("北京协和医院", "https://www.pumch.cn/"),
}

OVERLAY_STATE = """() => {
  const h = document.getElementById('easyview-ai-root');
  const s = h && h.shadowRoot;
  if (!s) return { present: false };
  return { present: true, cards: s.querySelectorAll('.ev-card').length,
           consent: !!s.querySelector('.ev-ai-consent') };
}"""

CLICK = """(label) => {
  const h = document.getElementById('easyview-ai-root'); const s = h && h.shadowRoot;
  if (!s) return false;
  const b = [...s.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  if (b) { b.click(); return true; }
  return false;
}"""


def build_test_extension() -> pathlib.Path:
    """放宽 host_permissions 的副本 —— 自动化没法伪造 activeTab 的授权。"""
    import json as _json
    shutil.rmtree(TEST_EXTENSION_DIR, ignore_errors=True)
    shutil.copytree(EXTENSION_DIR, TEST_EXTENSION_DIR,
                    ignore=shutil.ignore_patterns("tools", "shots", "__pycache__"))
    path = TEST_EXTENSION_DIR / "manifest.json"
    manifest = _json.loads(path.read_text(encoding="utf-8"))
    manifest["host_permissions"] = ["<all_urls>"]
    path.write_text(_json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return TEST_EXTENSION_DIR


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sites", default="gov,12306")
    args = parser.parse_args()
    keys = [k.strip() for k in args.sites.split(",") if k.strip() in SITES]

    OUT_DIR.mkdir(exist_ok=True)
    shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    load_dir = build_test_extension()

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR), headless=False,
            viewport={"width": 1440, "height": 960},
            args=[f"--disable-extensions-except={load_dir}", f"--load-extension={load_dir}"])
        try:
            worker = None
            for _ in range(75):
                if context.service_workers:
                    worker = context.service_workers[0]
                    break
                await asyncio.sleep(0.2)
            if worker is None:
                print("扩展没加载成功")
                return 1
            files = await worker.evaluate("() => globalThis.__easyviewContentFiles")
            page = await context.new_page()

            for key in keys:
                label, url = SITES[key]
                print(f"→ {label} …", flush=True)
                await page.goto(url, wait_until="domcontentloaded", timeout=45000)
                await page.wait_for_timeout(4000)
                await worker.evaluate(
                    """async (files) => {
                        const t = await chrome.tabs.query({ active: true, currentWindow: true });
                        await chrome.scripting.executeScript({ target: { tabId: t[0].id }, files });
                    }""", files)

                for _ in range(20):
                    await asyncio.sleep(0.5)
                    st = await page.evaluate(OVERLAY_STATE)
                    if st.get("consent"):
                        await page.evaluate(CLICK, "同意并继续")
                        break
                    if st.get("cards"):
                        break

                for _ in range(80):
                    await asyncio.sleep(0.5)
                    st = await page.evaluate(OVERLAY_STATE)
                    if st.get("cards"):
                        break

                state = await page.evaluate(OVERLAY_STATE)
                shot = OUT_DIR / f"{key}.png"
                await page.screenshot(path=str(shot))
                print(f"   {state.get('cards', 0)} 张卡片 → {shot}")
        finally:
            await context.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
