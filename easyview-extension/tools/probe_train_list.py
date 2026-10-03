# -*- coding: utf-8 -*-
"""探针：12306 车次查询结果页，能提取到什么？

这是"车次列表 → 大字卡片"那一步的前提。在没看到真实数据之前写解析大概率白写，
所以先量清楚：

  1. 结果页一共有多少元素、多少可见
  2. 一趟车能不能被认出来（DOM 里有没有可分辨的行结构）
  3. 出发/到达/历时/二等座价格这几个字段在不在一行里、选择器稳不稳
  4. 现在的通用提取器把它们拍成了什么样（判断要不要写专用解析）

查票不需要登录，所以这个探针可以独立跑。

用法： python tools/probe_train_list.py
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
SRC = EXTENSION_DIR / "src"
EXTRACT = (SRC / "extract.js").read_text(encoding="utf-8")
SITE = (SRC / "site" / "12306.js").read_text(encoding="utf-8")

DEPART = "北京"
ARRIVE = "上海"
DATE_OFFSET_DAYS = 7          # 往后挑几天，避开当天票已售完的情况


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await (await browser.new_context(locale="zh-CN")).new_page()

        print("打开 12306 …")
        await page.goto("https://www.12306.cn/", wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(5000)

        await page.add_script_tag(content=SITE)
        ok = await page.evaluate("() => typeof window.EasyView12306 === 'object'")
        print(f"手写模块 EasyView12306 已挂载: {ok}")
        if not ok:
            print("拿不到手写模块，退出")
            return 1

        # 用和扩展一样的原生 setter 手法填站名，并等自动补全
        print(f"填 {DEPART} → {ARRIVE} …")
        r1 = await page.evaluate(
            "async ([d, a]) => ({ dep: await window.EasyView12306.setDeparture(d), "
            "arr: await window.EasyView12306.setArrival(a) })",
            [DEPART, ARRIVE],
        )
        print(f"  出发地: {json.dumps(r1['dep'], ensure_ascii=False)}")
        print(f"  到达地: {json.dumps(r1['arr'], ensure_ascii=False)}")

        # 日期：直接用页面上的 #train_date
        date_value = await page.evaluate(
            """(days) => {
                const el = document.querySelector('#train_date');
                if (!el) return null;
                const d = new Date(); d.setDate(d.getDate() + days);
                const pad = (n) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
            }""",
            DATE_OFFSET_DAYS,
        )
        print(f"  日期: {date_value}")
        r3 = await page.evaluate("(v) => window.EasyView12306.setDate(v)", date_value)
        print(f"  setDate: {json.dumps(r3, ensure_ascii=False)}")

        print("点查询 …")
        # 12306 的查询是【新标签页】打开结果（kyfw.12306.cn/otn/leftTicket/...），
        # 不跟过去就什么都看不到 —— 第一版探针就卡在这里，URL 一直停在 /index/。
        try:
            async with page.context.expect_page(timeout=25000) as new_page_info:
                r4 = await page.evaluate("() => window.EasyView12306.submitSearch()")
            print(f"  submitSearch: {json.dumps(r4, ensure_ascii=False)}")
            page = await new_page_info.value
            await page.wait_for_load_state("domcontentloaded")
            print("  ★ 结果在新标签页里打开了")
        except Exception as exc:  # noqa: BLE001
            print(f"  没等到新标签页（{type(exc).__name__}），也许在原页渲染")
        await page.wait_for_timeout(9000)

        print(f"  结果页地址: {page.url[:130]}")
        print(f"  结果页 title: {await page.title()}")

        # ---------- 结果页分析 ----------
        await page.add_script_tag(content=EXTRACT)
        doc = await page.evaluate("() => globalThis.EasyViewExtract.run().elements")
        stats = doc["stats"]
        print()
        print("=" * 66)
        print("通用提取器看到的结果页")
        print("=" * 66)
        print(f"  元素 {stats['total']}（可见 {stats['visible']}）  截断={stats['truncated']}")
        from collections import Counter
        print(f"  类型分布 {dict(Counter(e['type'] for e in doc['elements']))}")

        # ---------- 一行车长什么样 ----------
        print()
        print("=" * 66)
        print("DOM 里有没有可分辨的「一趟车」")
        print("=" * 66)
        probe = await page.evaluate(
            """() => {
                const out = {};
                // 常见车次行容器
                const tries = [
                  ['#queryLeftTable tr', 'queryLeftTable 的行'],
                  ['.ticket-list tr', 'ticket-list 的行'],
                  ['tbody tr', '任意 tbody 行'],
                  ['[id^="ticket_"]', 'id 以 ticket_ 开头'],
                  ['li[class*="ticket"]', 'class 含 ticket 的 li'],
                ];
                for (const [sel, label] of tries) {
                    let n = 0;
                    try { n = document.querySelectorAll(sel).length; } catch (_) {}
                    out[label] = n;
                }
                // 抓一行看里面有什么
                const row = document.querySelector('#queryLeftTable tr')
                         || document.querySelector('tbody tr');
                if (row) {
                    out['_行文本'] = (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 220);
                    out['_行内单元格'] = [...row.querySelectorAll('td, th')].length;
                    // 12306 的车次号在 .number 里
                    const num = row.querySelector('.number');
                    out['_车次号'] = num ? num.innerText.trim() : null;
                } else {
                    out['_行文本'] = null;
                }
                // 页面上有没有"预订"按钮
                const book = [...document.querySelectorAll('a, button')]
                    .filter(n => (n.innerText || '').trim() === '预订');
                out['_预订按钮数'] = book.length;
                return out;
            }"""
        )
        for k, v in probe.items():
            print(f"  {k}: {v}")

        # ---------- 通用提取器把车次拍成了什么样 ----------
        print()
        print("=" * 66)
        print("通用提取器把车次拍成了什么（决定要不要写专用解析）")
        print("=" * 66)
        rows = [
            e for e in doc["elements"]
            if e.get("type") == "text" and e.get("text") and len(e["text"]) > 8
        ]
        for e in rows[:10]:
            print(f"  [{e['id']}] {e['text'][:88]}")

        await page.screenshot(path=str(EXTENSION_DIR / "tools" / "shots" / "12306-results.png"),
                              full_page=False)
        print()
        print("截图: tools/shots/12306-results.png")
        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
