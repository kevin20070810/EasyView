# -*- coding: utf-8 -*-
"""采集端隐私测试：确认用户已经填进表单的内容不会被采集。

场景：老人先在页面里填了身份证号、手机号，然后才点「适老」。
这些内容必须**根本不进入 elements.json** —— 没被读到的数据不可能泄漏。

用法： python tools/test_extract_privacy.py
"""

from __future__ import annotations

import asyncio
import functools
import http.server
import json
import pathlib
import threading

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
FIXTURES_DIR = EXTENSION_DIR.parent / "backend" / "fixtures"
PORT = 8914

# 故意填进去的"隐私"，全部都是最坏情况：真实格式、真实长度
SECRETS = {
    "#name": "张三",                       # 就诊人姓名
    "input[name='idcard']": "110101199001011234",   # 身份证
    "input[name='phone']": "13812345678",           # 手机号
}


async def main() -> int:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(FIXTURES_DIR))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    script = (EXTENSION_DIR / "src" / "extract.js").read_text(encoding="utf-8")
    failures: list[str] = []

    def check(label: str, ok: bool, detail: str = "") -> None:
        if ok:
            print(f"  [PASS] {label}")
        else:
            failures.append(label)
            print(f"  [FAIL] {label}{('  ' + detail) if detail else ''}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        page = await (await browser.new_context()).new_page()
        await page.goto(f"http://127.0.0.1:{PORT}/hospital.html", wait_until="load")

        print("=== 1. 往表单里填真实的隐私数据 ===")
        filled = 0
        for selector, value in SECRETS.items():
            try:
                await page.fill(selector, value)
                filled += 1
                print(f"  已填入 {selector} -> {value[:6]}…")
            except Exception as exc:
                print(f"  跳过 {selector}（fixture 里没有这个控件）: {str(exc)[:60]}")
        check("至少填进去一项", filled > 0, f"只填了 {filled} 项")

        print()
        print("=== 2. 此时点「适老」，看采集到什么 ===")
        await page.add_script_tag(content=script)
        doc = await page.evaluate("() => globalThis.EasyViewExtract.run().elements")
        blob = json.dumps(doc, ensure_ascii=False)

        for value in SECRETS.values():
            check(f"整份 elements.json 里不含「{value}」", value not in blob)

        print()
        print("=== 3. 逐个字段检查 value 字段 ===")
        with_value = [e for e in doc["elements"] if e.get("value")]
        for element in with_value:
            print(f"  {element['id']}  type={element['type']}  value={element['value']!r}")
        # 只有按钮类的 value 是标签，输入类的一律为 null
        bad = [e for e in with_value if e["type"] in ("input", "select", "textarea")]
        check("没有任何输入类元素带 value", not bad,
              f"这些仍带 value: {[e['id'] for e in bad]}")

        print()
        print("=== 4. 表单结构和标签仍然完整（隐私不能以牺牲可用性为代价）===")
        labels = {e.get("label") for e in doc["elements"] if e.get("label")}
        for expected in ("就诊人姓名", "身份证号", "手机号码"):
            check(f"标签「{expected}」仍在", expected in labels)
        forms = [g for g in doc["groups"] if g["type"] == "form"]
        check("表单分组仍在", len(forms) >= 1, f"找到 {len(forms)} 个表单分组")

        await browser.close()

    server.shutdown()
    print()
    print("=" * 46)
    print(f"结果: {'全部通过' if not failures else str(len(failures)) + ' 项失败'}")
    print("=" * 46)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
