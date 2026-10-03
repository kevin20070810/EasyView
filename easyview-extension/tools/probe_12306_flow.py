# -*- coding: utf-8 -*-
"""12306 分步引导可行性探针。

问四个问题，缺一个"选出发地→选到达地→选日期→查询"的分步引导就做不成：

  1. 四步能不能被【通用提取器】识别出来（不是靠手写的 site/12306.js）
  2. 找到的元素是不是【可见】的 —— 隐藏元素滚动+高亮，用户看不见
  3. 通用执行器能不能【真的操作】它们（填值后 12306 会不会接受）
  4. 查询后页面变了，还能不能接着分析下一步

用法： python tools/probe_12306_flow.py
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
SCRIPT = (EXTENSION_DIR / "src" / "extract.js").read_text(encoding="utf-8")
URL = "https://www.12306.cn/"

STEPS = {
    "① 出发地": (("出发地", "出发"), ("input",)),
    "② 到达地": (("到达地", "到达", "目的地"), ("input",)),
    "③ 出发日期": (("出发日期", "乘车日期"), ("input",)),
    "④ 查询": (("查询",), ("button", "link")),
}


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await (await browser.new_context(locale="zh-CN")).new_page()

        print(f"打开 {URL} …")
        await page.goto(URL, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(5000)

        await page.add_script_tag(content=SCRIPT)
        doc = await page.evaluate("() => globalThis.EasyViewExtract.run().elements")

        print(f"提取: {doc['stats']['total']} 元素（可见 {doc['stats']['visible']}）")
        print()

        els = doc["elements"]

        # ---------- 问题 1 + 2：能不能识别，可见吗 ----------
        print("=" * 68)
        print("问题 1+2：四步能被通用提取器识别吗？找到的是可见的吗？")
        print("=" * 68)
        found: dict[str, list[dict]] = {}
        for step, (words, types) in STEPS.items():
            hits = []
            for e in els:
                if e.get("type") not in types:
                    continue
                # 字段类型看 label/placeholder/aria_label；按钮和链接看 text。
                # 一律看 text 的话，包含"出发地"三个字的正文段落会命中；
                # 一律不看 text 的话，写着"查询"的按钮又找不到。
                if e.get("type") == "input":
                    hay = f"{e.get('label') or ''}|{e.get('placeholder') or ''}|{e.get('aria_label') or ''}"
                else:
                    hay = f"{e.get('text') or ''}|{e.get('aria_label') or ''}"
                if any(w in hay for w in words):
                    hits.append(e)
            found[step] = hits
            visible = [h for h in hits if h.get("visible")]
            print(f"\n{step}  命中 {len(hits)} 个，其中可见 {len(visible)} 个")
            for e in hits[:6]:
                flag = "可见" if e.get("visible") else "隐藏"
                bbox = e.get("bbox") or {}
                onscreen = ""
                if e.get("visible") and bbox:
                    onscreen = f"  位置 y={bbox.get('y')} h={bbox.get('height')}"
                print(f"    [{flag}] {e['id']:<14} {e['type']:<8} "
                      f"label={str(e.get('label'))[:12]:<14} sel={str(e.get('selector'))[:40]}{onscreen}")

        # ---------- 问题 3：通用执行器能不能真的操作 ----------
        print()
        print("=" * 68)
        print("问题 3：通用执行器能不能真的填进去？12306 会不会接受？")
        print("=" * 68)

        # 取第一个【可见】的出发地输入框，用和扩展同样的原生 setter 手法填值
        departure = next((e for e in found["① 出发地"]
                          if e["visible"] and e["type"] in ("input", "text")), None)
        arrival = next((e for e in found["② 到达地"]
                        if e["visible"] and e["type"] in ("input", "text")), None)

        if not departure or not arrival:
            print("  ❌ 找不到可见的出发地/到达地输入框，分步引导做不成")
        else:
            print(f"  出发地 {departure['id']}  selector={departure['selector']}")
            print(f"  到达地 {arrival['id']}  selector={arrival['selector']}")

            result = await page.evaluate(
                """([depSel, arrSel]) => {
                    const dep = document.querySelector(depSel);
                    const arr = document.querySelector(arrSel);
                    if (!dep || !arr) return { err: '选择器找不到元素' };

                    // 与 site/12306.js 相同的原生 setter 手法：React 受控组件
                    // 直接改 .value 不会触发框架的 onChange
                    const setNative = (el, v) => {
                        const proto = el instanceof HTMLTextAreaElement
                            ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                        if (setter) setter.call(el, v); else el.value = v;
                        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        el.dispatchEvent(new Event('blur', { bubbles: true }));
                    };

                    const before = { dep: dep.value, arr: arr.value };
                    setNative(dep, '北京');
                    setNative(arr, '上海');
                    return { before, after: { dep: dep.value, arr: arr.value } };
                }""",
                [departure["selector"], arrival["selector"]],
            )
            print(f"  填值前: {result.get('before')}")
            print(f"  填值后: {result.get('after')}")

            await page.wait_for_timeout(2500)

            # 站码是 12306 真正的内部状态；它变了才算"接受了"
            codes = await page.evaluate(
                """() => {
                    const pick = (ids) => {
                        for (const id of ids) {
                            const n = document.getElementById(id);
                            if (n) return n.value;
                        }
                        return null;
                    };
                    return {
                        fromStation: pick(['fromStation']),
                        toStation: pick(['toStation']),
                        fromCode: pick(['fromStationCode']),
                        toCode: pick(['toStationCode']),
                        depValue: document.querySelector('#fromStationText')?.value ?? null,
                        arrValue: document.querySelector('#toStationText')?.value ?? null,
                    };
                }"""
            )
            print(f"  12306 内部站码: {json.dumps(codes, ensure_ascii=False)}")
            accepted = bool(codes.get("fromCode") or codes.get("toCode") or codes.get("fromStation"))
            print(f"  ★ 12306 是否接受: {'是' if accepted else '否 —— 只改了输入框显示，站点没认'}")

        # ---------- 问题 4：查询后页面变了还能不能接着分析 ----------
        print()
        print("=" * 68)
        print("问题 4：查询之后页面变了，还能不能继续分析下一步？")
        print("=" * 68)
        search = next((e for e in found["④ 查询"] if e["visible"] and e["type"] in ("button", "link")), None)
        if search:
            print(f"  查询按钮 {search['id']}  selector={search['selector']}")
            before_url = page.url
            before_count = doc["stats"]["total"]
            try:
                await page.evaluate(
                    """(sel) => { const b = document.querySelector(sel); if (b) b.click(); }""",
                    search["selector"],
                )
                await page.wait_for_timeout(6000)
                after_doc = await page.evaluate(
                    "() => { const r = globalThis.EasyViewExtract.run(); return r.elements; }")
                print(f"  查询前: {before_count} 元素  url={before_url[:60]}")
                print(f"  查询后: {after_doc['stats']['total']} 元素  url={page.url[:60]}")
                print(f"  ★ 页面结构{'发生了变化' if after_doc['stats']['total'] != before_count else '几乎没变'}"
                      f" —— 可以{'继续' if after_doc['stats']['total'] != before_count else '难以'}分析下一步")
            except Exception as exc:
                print(f"  ❌ 点查询失败: {str(exc)[:90]}")
        else:
            print("  ❌ 找不到可见的查询按钮")

        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
