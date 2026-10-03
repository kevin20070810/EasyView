# -*- coding: utf-8 -*-
"""真实医院网站能不能拿来演示？只回答一个关键问题：

    挂号流程是否免登录可达？

首页能出几张卡是次要的 —— 首页再好看，如果"选科室→选医生→选时间"
全在登录之后，那演示就走不完闭环。

做法：进首页 → 提取 → 找挂号相关链接 → 跟进去 → 判断落在哪：
    挂号流程页 / 登录页 / 微信公众号引导 / 报错

用法： python tools/hospital_probe.py
"""

from __future__ import annotations

import asyncio
import pathlib
import re
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
EXTENSION_DIR = HERE.parent
SCRIPT = (EXTENSION_DIR / "src" / "extract.js").read_text(encoding="utf-8")

HOSPITALS = [
    ("北京协和医院", "https://www.pumch.cn/"),
    ("上海瑞金医院", "https://www.rjh.com.cn/"),
    ("四川大学华西医院", "https://www.wchscu.cn/"),
    ("北京医院", "https://www.bjhmoh.cn/"),
    ("北京预约挂号统一平台", "https://www.114yygh.com/"),
]

BOOKING_WORDS = ("挂号", "预约", "门诊", "就诊")
# 落在这些特征上，说明有登录墙或者把我们推给了微信
LOGIN_MARKS = ("请输入手机号", "手机号", "验证码", "密码", "登录", "注册", "忘记密码")
WECHAT_MARKS = ("微信", "公众号", "扫码", "小程序", "关注")


def classify(url: str, title: str, body: str) -> tuple[str, str]:
    text = f"{title}\n{body[:4000]}"
    has_booking_form = any(w in text for w in ("选择科室", "选择医生", "就诊时间", "预约时间", "选择日期"))
    login_hits = sum(1 for w in LOGIN_MARKS if w in text)
    wechat_hits = sum(1 for w in WECHAT_MARKS if w in text)

    if has_booking_form and login_hits < 2:
        return "可走通", "页面上直接出现了选科室/选时间这类控件"
    if "login" in url.lower() or login_hits >= 3:
        return "登录墙", f"命中登录特征 {login_hits} 项"
    if wechat_hits >= 2 and not has_booking_form:
        return "导向微信", f"命中微信特征 {wechat_hits} 项"
    if has_booking_form:
        return "可能可走通", "有预约控件，但登录特征也不少"
    return "未识别", "没找到预约流程特征"


async def probe(page, name: str, url: str) -> None:
    print(f"{'=' * 64}")
    print(f"【{name}】{url}")
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=35000)
        await page.wait_for_timeout(3500)
    except Exception as exc:
        print(f"  ❌ 打不开: {str(exc)[:90]}")
        return

    try:
        await page.add_script_tag(content=SCRIPT)
        doc = await page.evaluate("() => globalThis.EasyViewExtract.run().elements")
    except Exception as exc:
        print(f"  ❌ 提取失败: {str(exc)[:90]}")
        return

    stats = doc["stats"]
    print(f"  首页提取: {stats['total']} 元素（可见 {stats['visible']}）")

    # 找挂号相关入口
    booking = [
        e for e in doc["elements"]
        if e.get("type") == "link"
        and any(w in f"{e.get('text') or ''}{e.get('label') or ''}" for w in BOOKING_WORDS)
        and e.get("href")
    ]
    print(f"  含「{'/'.join(BOOKING_WORDS)}」的链接: {len(booking)} 个")
    for e in booking[:6]:
        print(f"    {(e.get('text') or '')[:22]:<24} → {e['href'][:70]}")

    # 跟一个最像"挂号入口"的进去
    target = None
    for e in booking:
        if "挂号" in (e.get("text") or "") and not e["href"].startswith("javascript"):
            target = e
            break
    if target is None:
        for e in booking:
            if not e["href"].startswith("javascript"):
                target = e
                break

    if target is None:
        print("  ⚠️ 首页没有可跟进的挂号链接（全是 javascript: 或没有）")
        print()
        return

    href = target["href"]
    print(f"  → 跟进「{(target.get('text') or '')[:20]}」 {href[:80]}")
    try:
        await page.goto(href, wait_until="domcontentloaded", timeout=35000)
        await page.wait_for_timeout(3000)
    except Exception as exc:
        print(f"  ❌ 打不开挂号页: {str(exc)[:80]}")
        print()
        return

    title = await page.title()
    try:
        body = await page.evaluate("() => document.body ? document.body.innerText : ''")
    except Exception:
        body = ""
    verdict, why = classify(page.url, title, body)
    print(f"  落点: {page.url[:90]}")
    print(f"  标题: {title[:60]}")
    print(f"  ★ 判定: {verdict}  （{why}）")
    print()
    return


async def main() -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
        context = await browser.new_context(locale="zh-CN")
        page = await context.new_page()
        for name, url in HOSPITALS:
            try:
                await probe(page, name, url)
            except Exception as exc:  # noqa: BLE001
                print(f"  ❌ 异常: {type(exc).__name__}: {str(exc)[:80]}\n")
        await browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
