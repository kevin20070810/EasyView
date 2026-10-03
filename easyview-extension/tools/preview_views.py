# -*- coding: utf-8 -*-
"""把核对屏渲染出来量尺寸 —— 不走登录，用 EasyViewAI.preview 钩子。

为什么需要它：核对屏只在登录后的乘车人页出现，我走不到那儿。
这个脚本在本地空白页上注入扩展脚本，直接调预览钩子，然后量每个元素的
实际尺寸（含横向溢出），这样即使我看不到画面，也能发现版式问题。
"""

import asyncio
import http.server
import pathlib
import shutil
import socketserver
import threading

from playwright.async_api import async_playwright

REPO = pathlib.Path(r"D:\EasyView")
EXT = REPO / "easyview-extension"
PROFILE = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "e2e-preview"
PORT = 8931

PAGE = "<!doctype html><meta charset=utf-8><title>preview</title><body><h1>preview</h1></body>"


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(PAGE.encode("utf-8"))

    def log_message(self, *args):
        pass


CALL_PREVIEW = """() => {
  const api = globalThis.EasyViewAI;
  if (!api || !api.preview) return { err: 'no preview hook' };
  api.preview.order(
    { code: 'G531', from: '北京南', to: '上海虹桥', depart: '06:08', arrive: '12:04',
      duration: '05:56', price: 525, priceClass: '二等座', left: '有' },
    [ { name: '张爷爷', checked: true, node: null },
      { name: '李奶奶', checked: true, node: null },
      { name: '王大爷', checked: false, node: null } ]
  );
  return { ok: true };
}"""

MEASURE = """() => {
  const host = document.getElementById('easyview-ai-root');
  const s = host && host.shadowRoot;
  if (!s) return { err: 'no overlay' };
  const panel = s.querySelector('.ev-panel');
  const pr = panel.getBoundingClientRect();
  const box = (sel) => {
    const n = s.querySelector(sel);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const st = getComputedStyle(n);
    return { w: Math.round(r.width), h: Math.round(r.height), fs: st.fontSize,
             over: n.scrollWidth > n.clientWidth + 2 };
  };
  const pcards = [...s.querySelectorAll('.ev-order-pcard')].map((c) => {
    const r = c.getBoundingClientRect();
    const nm = c.querySelector('.ev-order-pname');
    return { w: Math.round(r.width), h: Math.round(r.height),
             on: c.classList.contains('ev-on'),
             name: nm ? nm.textContent : null,
             fs: nm ? getComputedStyle(nm).fontSize : null };
  });
  return {
    panel: [Math.round(pr.width), Math.round(pr.height)],
    code: box('.ev-order-code'),
    route: box('.ev-order-route'),
    times: box('.ev-order-times'),
    seat: box('.ev-order-seat'),
    total: box('.ev-order-total-price'),
    go: box('.ev-confirm-go'),
    inputs: s.querySelectorAll('.ev-order-input').length,
    pcards,
    secs: [...s.querySelectorAll('.ev-order-sec')].map((x) => Math.round(x.getBoundingClientRect().height)),
    overflow: s.querySelector('.ev-order').scrollWidth > pr.width + 4
  };
}"""


async def main() -> int:
    srv = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    shutil.rmtree(PROFILE, ignore_errors=True)
    PROFILE.mkdir(parents=True)

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE), headless=False,
            viewport={"width": 1600, "height": 950},
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"])
        try:
            sw = None
            for _ in range(75):
                if ctx.service_workers:
                    sw = ctx.service_workers[0]
                    break
                await asyncio.sleep(0.2)
            if sw is None:
                print("扩展没加载")
                return 1

            files = await sw.evaluate("() => globalThis.__easyviewContentFiles")
            page = await ctx.new_page()
            await page.goto(f"http://127.0.0.1:{PORT}/", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(1200)

            # 必须经由后台注入：内容脚本跑在隔离世界，主世界拿不到 chrome.runtime
            tab = await sw.evaluate(
                "async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0]")
            await sw.evaluate(
                """async ([f, t]) => {
                    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: f });
                }""", [files, tab])
            await asyncio.sleep(1.5)

            got = await sw.evaluate(
                """async ([func, t]) => {
                    const r = await chrome.scripting.executeScript(
                        { target: { tabId: t.id }, func: eval('(' + func + ')') });
                    return r[0].result;
                }""", [CALL_PREVIEW, tab])
            print("  调用预览:", got)
            await asyncio.sleep(1.2)

            m = await page.evaluate(MEASURE)
            if not m or m.get("err"):
                print("  量不到:", m)
                return 1

            print(f"  面板 {m['panel'][0]}x{m['panel'][1]}    横向溢出={m['overflow']}")
            for key, label in [("code", "车次号"), ("route", "线路"), ("times", "时刻"),
                               ("seat", "座位"), ("total", "合计"), ("go", "按钮")]:
                v = m.get(key)
                if v:
                    print(f"  {label:<6} {v['w']}x{v['h']}  字号 {v['fs']}  溢出={v['over']}")
            print(f"  输入框 {m['inputs']} 个")
            print(f"  乘车人卡 {len(m['pcards'])} 张:")
            for c in m["pcards"]:
                print(f"      {c['w']}x{c['h']}  字号 {c['fs']}  选中={c['on']}  {c['name']}")
            print(f"  各区块高 {m['secs']}")

            await page.screenshot(path=str(EXT / "tools" / "shots" / "preview-order.png"),
                                  full_page=True)
            print("  截图 tools/shots/preview-order.png")
        finally:
            await ctx.close()
    srv.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
