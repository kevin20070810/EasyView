# -*- coding: utf-8 -*-
"""测支付页识别：正例要认出来，反例必须返回 null。

反例比正例重要 —— 这块功能指错了是钱没了，所以"看不准就不引导"
这条规则必须真的成立，不能只是注释里写着。
"""

import asyncio
import http.server
import pathlib
import socketserver
import threading

from playwright.async_api import async_playwright

REPO = pathlib.Path(r"D:\EasyView")
EXT = REPO / "easyview-extension"
PORT = 8942

HEAD = "<!doctype html><meta charset=utf-8>"

CASES = {
    # ① 正例：金额有标签、支付按钮明确
    "/ok": HEAD + "<title>DeepSeek 开放平台</title><body>"
        "<div>收款方：DeepSeek</div>"
        "<div>应付金额 <b>¥100.00</b></div>"
        "<button>确认支付</button></body>",
    # ② 反例：有支付按钮，但读不到金额 → 必须 null
    "/no-amount": HEAD + "<title>某站</title><body>"
        "<div>请选择充值方式</div>"
        "<button>确认支付</button></body>",
    # ③ 反例：有金额，但没有支付按钮 → 必须 null
    "/no-button": HEAD + "<title>某站</title><body>"
        "<div>应付金额 ¥100.00</div><div>请到柜台办理</div></body>",
    # ④ 反例：普通页面，只有一个 ¥ 价格，没有支付按钮 → 必须 null
    "/shop": HEAD + "<title>某商城</title><body>"
        "<div>商品价格 ¥299.00</div><button>加入购物车</button></body>",
    # ⑤ 正例：金额带"元"、按钮是"立即充值"
    "/recharge": HEAD + "<title>某某充值中心</title><body>"
        "<div>充值金额：50元</div><div>收款方：某某科技</div>"
        "<button>立即充值</button></body>",
    # ⑥ 反例：按钮文字像支付，但那是"取消支付"之类 → 不该命中
    "/trap": HEAD + "<title>某站</title><body>"
        "<div>应付金额 ¥10.00</div><button>取消支付</button></body>",
}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = CASES.get(self.path.split("?")[0])
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, *args):
        pass


SCRIPT = (EXT / "src" / "site" / "pay-page.js").read_text(encoding="utf-8")

DETECT = """() => {
  const api = globalThis.EasyViewPayPage;
  if (!api) return { err: 'not loaded' };
  const r = api.detect();
  if (!r) return { detected: false };
  return { detected: true, amount: r.amount, payee: r.payee, button: r.buttonLabel };
}"""

EXPECT = {
    "/ok": True,
    "/no-amount": False,
    "/no-button": False,
    "/shop": False,
    "/recharge": True,
    "/trap": False,
}


async def main() -> int:
    srv = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    ok = 0
    bad = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await (await browser.new_context(locale="zh-CN")).new_page()
        for path, want in EXPECT.items():
            await page.goto(f"http://127.0.0.1:{PORT}{path}", wait_until="domcontentloaded", timeout=20000)
            await page.add_script_tag(content=SCRIPT)
            got = await page.evaluate(DETECT)
            hit = bool(got.get("detected"))
            verdict = "✅" if hit == want else "❌"
            if hit == want:
                ok += 1
            else:
                bad += 1
            want_s = "该认出" if want else "该返回 null"
            got_s = (f"认出  金额={got.get('amount')} 收款方={got.get('payee')} 按钮={got.get('button')}"
                     if hit else "null")
            print(f"  {verdict} {path:<12} {want_s:<12} → {got_s}")
        await browser.close()
    srv.shutdown()
    print()
    print(f"  通过 {ok} / {ok + bad}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
