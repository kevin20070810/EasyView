# -*- coding: utf-8 -*-
"""测试 12306 上的步骤引导：点「我要买火车票」后是否出现「第 N 步 / 共 M 步」。"""

from __future__ import annotations

import asyncio
import json
import pathlib
import shutil
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXT = HERE.parent
PROFILE = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-step-profile"
TEST_EXT = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-step-ext"

READ_OVERLAY = """() => {
  const h = document.getElementById('easyview-ai-root');
  const s = h && h.shadowRoot;
  if (!s) return null;
  return {
    consent: !!s.querySelector('.ev-ai-consent'),
    cards: [...s.querySelectorAll('.ev-card strong')].map(n => n.textContent.trim()),
  };
}"""

READ_STEP = """() => {
  const h = document.getElementById('easyview-step-host');
  const s = h && h.shadowRoot;
  if (!s) return null;
  const bar = s.querySelector('.ev-stepbar');
  if (!bar) return null;
  return {
    count: bar.querySelector('.ev-step-count') ? bar.querySelector('.ev-step-count').textContent.trim() : null,
    text: bar.querySelector('.ev-step-text') ? bar.querySelector('.ev-step-text').textContent.trim() : null,
    buttons: [...bar.querySelectorAll('button')].map(b => b.textContent.trim()),
  };
}"""

CLICK_LABEL = """(label) => {
  const h = document.getElementById('easyview-ai-root'); const s = h && h.shadowRoot;
  if (!s) return false;
  const b = [...s.querySelectorAll('button')].find(x => x.textContent.trim() === label);
  if (b) { b.click(); return true; }
  return false;
}"""

CLICK_CARD = """(text) => {
  const h = document.getElementById('easyview-ai-root'); const s = h && h.shadowRoot;
  if (!s) return false;
  const card = [...s.querySelectorAll('.ev-card')].find(c => (c.textContent||'').includes(text));
  if (card) { card.click(); return true; }
  return false;
}"""


def build_ext() -> pathlib.Path:
    shutil.rmtree(TEST_EXT, ignore_errors=True)
    shutil.copytree(EXT, TEST_EXT, ignore=shutil.ignore_patterns("tools", "shots", "__pycache__"))
    path = TEST_EXT / "manifest.json"
    m = json.loads(path.read_text(encoding="utf-8"))
    m["host_permissions"] = ["<all_urls>"]
    path.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")
    return TEST_EXT


async def main() -> int:
    shutil.rmtree(PROFILE, ignore_errors=True)
    PROFILE.mkdir(parents=True, exist_ok=True)
    load_dir = build_ext()

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE), headless=False, viewport={"width": 1440, "height": 960},
            args=[f"--disable-extensions-except={load_dir}", f"--load-extension={load_dir}"])
        try:
            worker = None
            for _ in range(75):
                if ctx.service_workers:
                    worker = ctx.service_workers[0]
                    break
                await asyncio.sleep(0.2)
            if worker is None:
                print("扩展没加载")
                return 1

            files = await worker.evaluate("() => globalThis.__easyviewContentFiles")
            page = await ctx.new_page()
            print("打开 12306 …")
            await page.goto("https://www.12306.cn/", wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(4500)
            await worker.evaluate(
                """async (files) => {
                    const t = await chrome.tabs.query({ active: true, currentWindow: true });
                    await chrome.scripting.executeScript({ target: { tabId: t[0].id }, files });
                }""", files)

            for _ in range(20):
                await asyncio.sleep(0.5)
                st = await page.evaluate(READ_OVERLAY)
                if st and st.get("consent"):
                    await page.evaluate(CLICK_LABEL, "同意并继续")
                    break
                if st and st.get("cards"):
                    break

            cards = []
            for _ in range(90):
                await asyncio.sleep(0.5)
                st = await page.evaluate(READ_OVERLAY)
                if st and st.get("cards"):
                    cards = st["cards"]
                    break
            print(f"卡片 {len(cards)} 张: {cards}")

            # 找一张指向表单控件的卡（买票类）
            pick = next((c for c in cards if any(w in c for w in ("买票", "买火车票", "购票"))), None)
            if not pick:
                pick = cards[0] if cards else None
            if not pick:
                print("❌ 没有卡片可点")
                return 1
            print(f"点击「{pick}」…")
            await page.evaluate(CLICK_CARD, pick[:4])
            await asyncio.sleep(1.5)

            step = await page.evaluate(READ_STEP)
            print()
            if step:
                print("★ 步骤条出现了")
                print(f"   {step['count']}")
                print(f"   {step['text']}")
                print(f"   按钮: {step['buttons']}")
                shot = HERE / "shots" / "12306-steps.png"
                shot.parent.mkdir(exist_ok=True)
                await page.screenshot(path=str(shot))
                print(f"   截图: {shot}")

                # 点「下一步」看会不会推进
                await page.evaluate(
                    """() => {
                        const h = document.getElementById('easyview-step-host');
                        const s = h && h.shadowRoot;
                        const b = s && [...s.querySelectorAll('button')].find(x => x.textContent.trim() === '下一步');
                        if (b) b.click();
                    }""")
                await asyncio.sleep(1.2)
                step2 = await page.evaluate(READ_STEP)
                print(f"   点「下一步」后: {step2['count'] if step2 else '(步骤条消失了)'}  "
                      f"{step2['text'] if step2 else ''}")
            else:
                print("❌ 没有出现步骤条（退回单次定位了）")
                print("   可能是卡片目标附近凑不出两个表单控件")
                return 1
        finally:
            await ctx.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
