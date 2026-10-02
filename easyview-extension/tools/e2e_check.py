# -*- coding: utf-8 -*-
"""EasyView 扩展端到端检查。

真的把未打包扩展加载进 Chrome，走完整链路：

    注入 extract.js + ai-content.js
      -> 页面内提取
      -> background 代发到分析服务
      -> 渲染 0.3 卡片

前置条件：
    1. 分析服务在跑： cd ai-service && python app.py
    2. 已 pip install playwright 并装好 chromium

注意：**必须以有窗口模式运行**。实测在无头模式下 Chrome 不会启动扩展的
service worker（`context.service_workers` 一直为空），拿不到后台就没法代发请求。

用法：
    python tools/e2e_check.py                    # 用 hospital fixture
    python tools/e2e_check.py --fixture gov
    python tools/e2e_check.py --no-ai            # 只跑规则引擎，验证链路本身
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import http.server
import pathlib
import shutil
import sys
import threading

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
FIXTURES_DIR = EXTENSION_DIR.parent / "backend" / "fixtures"
PROFILE_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-e2e-profile"
FIXTURE_PORT = 8911

READ_OVERLAY = """
() => {
  const host = document.getElementById('easyview-ai-root');
  const shadow = host && host.shadowRoot;
  if (!shadow) return null;
  const text = (sel) => { const n = shadow.querySelector(sel); return n ? n.textContent.trim() : null; };
  return {
    title: text('.ev-header h1'),
    summary: text('.ev-header p'),
    banner: text('.ev-ai-banner'),
    error: text('.ev-error'),
    message: text('.ev-message'),
    loading: text('.ev-content .ev-message'),
    stats: text('.ev-ai-stats'),
    consent: (() => {
      const box = shadow.querySelector('.ev-ai-consent');
      if (!box) return null;
      const list = box.querySelector('ul');
      return list ? [...list.children].map((li) => li.textContent.trim()).join(' / ') : null;
    })(),
    previewShown: (() => {
      const box = shadow.querySelector('.ev-ai-preview');
      return box && !box.hidden ? box.textContent.trim().slice(0, 60) : null;
    })(),
    foot: text('.ev-ai-foot'),
    buttons: [...shadow.querySelectorAll('button')].map((b) => b.textContent.trim()),
    cards: [...shadow.querySelectorAll('.ev-card')].map((card) => ({
      icon: card.dataset.icon || null,
      title: card.querySelector('strong') ? card.querySelector('strong').textContent.trim() : null,
      detail: card.querySelector('.ev-card-copy > span') ? card.querySelector('.ev-card-copy > span').textContent.trim() : null,
      note: card.querySelector('.ev-ai-note') ? card.querySelector('.ev-ai-note').textContent.trim() : null,
      blocked: card.classList.contains('ev-ai-risk-blocked'),
    })),
  };
}
"""

CLICK_BUTTON = """
(label) => {
  const host = document.getElementById('easyview-ai-root');
  const shadow = host && host.shadowRoot;
  if (!shadow) return false;
  const target = [...shadow.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  if (!target) return false;
  target.click();
  return true;
}
"""


def serve_fixtures() -> http.server.ThreadingHTTPServer:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(FIXTURES_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", FIXTURE_PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def wait_for_service_worker(context, timeout_s: float = 15.0):
    for _ in range(int(timeout_s / 0.2)):
        workers = context.service_workers
        if workers:
            return workers[0]
        await asyncio.sleep(0.2)
    return None


async def run(fixture: str, use_ai: bool) -> int:
    server = serve_fixtures()
    print(f"fixture 静态服务: http://127.0.0.1:{FIXTURE_PORT}  (目录 {FIXTURES_DIR})")
    print(f"扩展目录: {EXTENSION_DIR}")
    print(f"模式: {'模型（需分析服务在跑）' if use_ai else '仅规则引擎'}")
    print()

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    failures: list[str] = []

    # 每次都用全新的 profile：同意状态存在里面，复用的话第二次就不会再问，
    # 那条断言也就形同虚设。
    if PROFILE_DIR.exists():
        shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            # 必须有窗口：无头模式下 Chrome 不启动扩展的 service worker
            headless=False,
            args=[
                f"--disable-extensions-except={EXTENSION_DIR}",
                f"--load-extension={EXTENSION_DIR}",
            ],
        )
        try:
            worker = await wait_for_service_worker(context)
            if worker is None:
                print("  [FAIL] 没等到扩展的 service worker —— 扩展可能没加载成功")
                return 1
            print("  [PASS] 扩展已加载，service worker 就绪")

            page = await context.new_page()
            await page.goto(f"http://127.0.0.1:{FIXTURE_PORT}/{fixture}.html", wait_until="load")
            print(f"  [PASS] 已打开 fixture: {fixture}.html")

            # 从 service worker 里注入内容脚本 —— 等价于用户点扩展图标
            result = await worker.evaluate(
                """async (files) => {
                    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (!tabs.length) return '没有活动标签页';
                    await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files });
                    return null;
                }""",
                ["src/extract.js", "src/ai-content.js"],
            )
            if result:
                failures.append(f"注入失败: {result}")
                print(f"  [FAIL] {result}")
            else:
                print("  [PASS] 内容脚本注入成功")

            async def wait_for(predicate, timeout_s: float):
                for _ in range(int(timeout_s / 0.5)):
                    await asyncio.sleep(0.5)
                    snapshot = await page.evaluate(READ_OVERLAY)
                    if snapshot and predicate(snapshot):
                        return snapshot
                return await page.evaluate(READ_OVERLAY)

            # 首次使用应当先征求同意 —— 这一屏是隐私保证的一部分，必须测到
            state = await wait_for(lambda s: s["consent"] or s["cards"] or s["error"], 30)
            if state and state["consent"]:
                print("  [PASS] 首次使用先出现了同意界面")
                print(f"        将发送: {state['consent']}")
                # 顺便验证「查看将发送的内容」确实能展开 —— 这是透明度的关键
                if await page.evaluate(CLICK_BUTTON, "查看将发送的内容"):
                    await asyncio.sleep(0.4)
                    shown = await page.evaluate(READ_OVERLAY)
                    if shown and shown["previewShown"]:
                        print("  [PASS] 可以展开查看将发送的原文")
                    else:
                        failures.append("点了预览按钮但内容没展开")
                        print("  [FAIL] 预览没展开")
                else:
                    failures.append("找不到预览按钮")
                    print("  [FAIL] 找不到「查看将发送的内容」")
                clicked = await page.evaluate(CLICK_BUTTON, "同意并继续")
                if clicked:
                    print("  [PASS] 「同意并继续」可点击")
                else:
                    failures.append("同意按钮不存在")
                    print("  [FAIL] 找不到「同意并继续」按钮")
                state = await wait_for(lambda s: s["cards"] or s["error"], 90)
            else:
                failures.append("首次使用没有出现同意界面")
                print("  [FAIL] 没有出现同意界面（隐私保证的一部分）")
                state = await wait_for(lambda s: s["cards"] or s["error"], 90)

            if not state:
                failures.append("overlay 一直没出现")
                print("  [FAIL] overlay 没出现")
            else:
                print(f"  [PASS] overlay 已渲染")
                print(f"        标题: {state['title']}")
                if state["banner"]:
                    print(f"        横幅: {state['banner']}")
                if state["error"]:
                    failures.append(f"渲染了错误面板: {state['error']}")
                    print(f"  [FAIL] 错误面板: {state['error']}")
                if state["stats"]:
                    print(f"        统计: {state['stats']}")
                if state["consent"]:
                    print(f"        同意界面: {state['consent'].splitlines()[0][:80]}")
                if state["foot"]:
                    print(f"        发送说明: {state['foot'].splitlines()[0][:100]}")
                if state["cards"]:
                    print(f"  [PASS] 渲染出 {len(state['cards'])} 张卡片:")
                    for card in state["cards"]:
                        mark = " [blocked]" if card["blocked"] else ""
                        note = f"  ⚠{card['note']}" if card["note"] else ""
                        print(f"        · [{card['icon']}] {card['title']}｜{card['detail']}{mark}{note}")
                else:
                    failures.append("没有渲染出任何卡片")
                    print("  [FAIL] 没有卡片")

            # 渲染完再截一张图，方便人工看
            shot = HERE / f"e2e-{fixture}.png"
            await page.screenshot(path=str(shot))
            print(f"\n截图: {shot}")
        finally:
            await context.close()
            server.shutdown()

    print()
    if failures:
        print(f"结果: {len(failures)} 项失败")
        return 1
    print("结果: 全部通过")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="EasyView 扩展端到端检查")
    parser.add_argument("--fixture", default="hospital",
                        choices=["hospital", "gov", "traffic", "generic"])
    parser.add_argument("--no-ai", action="store_true", help="不启用模型，只验证链路")
    args = parser.parse_args()
    return asyncio.run(run(args.fixture, not args.no_ai))


if __name__ == "__main__":
    sys.exit(main())
