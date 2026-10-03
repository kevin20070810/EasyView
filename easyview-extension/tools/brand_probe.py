# -*- coding: utf-8 -*-
"""品牌探测：在真实网页上跑一遍 EasyViewBrand.extract()，打印主色 / Logo / 站名。

用途：判断某个站点的品牌提取是否符合预期，尤其是排查「覆盖层颜色不对、没有 Logo」。
内容脚本跑在 isolated world，主世界 eval 看不到它的全局变量，所以这里直接把
src/brand.js 的源码注入页面主世界再调用，等价于内容脚本里的那次 extract()。

用法：
    python tools/brand_probe.py
    python tools/brand_probe.py --urls https://www.bilibili.com/,https://10086.cn/
    python tools/brand_probe.py --headless
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import shutil
import sys

from playwright.async_api import async_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from _chrome_launcher import (  # noqa: E402
    fix_console_encoding,
    launch_chrome,
    stop_chrome,
    wait_for_cdp,
)

HERE = pathlib.Path(__file__).resolve().parent
BRAND_JS = HERE.parent / "src" / "brand.js"
PROFILE_DIR = pathlib.Path.home() / "AppData" / "Local" / "Temp" / "easyview-brand-profile"

DEFAULT_URLS = [
    "https://www.bilibili.com/",
    "https://www.12306.cn/index/",
    "https://www.10086.cn/",
]

DUMP_VARS_JS = """() => {
  const hint = /brand|primary|theme|main|accent/i;
  const pick = (node) => {
    const out = [];
    if (!node) return out;
    const s = getComputedStyle(node);
    for (let i = 0; i < s.length; i += 1) {
      const name = s[i];
      if (!name || name.indexOf('--') !== 0 || !hint.test(name)) continue;
      out.push([name, s.getPropertyValue(name).trim()]);
    }
    return out;
  };
  const histogram = {};
  const bump = (value) => {
    if (!value || value === 'rgba(0, 0, 0, 0)' || value === 'transparent') return;
    histogram[value] = (histogram[value] || 0) + 1;
  };
  const nodes = [...document.querySelectorAll(
    'header, nav, button, [role="button"], .btn, [class*="btn-"], [class*="button"], a'
  )].slice(0, 260);
  for (const node of nodes) {
    const s = getComputedStyle(node);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    bump(s.backgroundColor);
    bump(s.color);
  }
  const top = Object.entries(histogram).sort((a, b) => b[1] - a[1]).slice(0, 14);
  return { rootVars: pick(document.documentElement), bodyVars: pick(document.body), topColors: top };
}"""

DUMP_SAMPLES_JS = """() => {
  const opaque = (v) => Boolean(v) && v !== 'transparent' && !/^rgba\\([^)]*,\\s*0(\\.0+)?\\)$/.test(v);
  const buckets = new Map();
  const push = (color, weight, where, layer) => {
    const entry = buckets.get(color) || { color, weight: 0, count: 0, where: [], layers: {} };
    entry.weight += weight;
    entry.count += 1;
    entry.layers[layer] = (entry.layers[layer] || 0) + 1;
    if (entry.where.length < 4 && !entry.where.includes(where)) entry.where.push(where);
    buckets.set(color, entry);
  };
  const seen = new Set();
  const add = (node, weight, where) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const s = getComputedStyle(node);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return;
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const label = node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(/\\s+/)[0] : '');
    if (opaque(s.backgroundColor)) push(s.backgroundColor, weight, where + '|' + label, 'bg');
    if (opaque(s.color)) push(s.color, weight * 0.45, where + '|' + label, 'fg');
  };
  const sel = (selector, limit) => [...document.querySelectorAll(selector)].slice(0, limit);
  sel("header, [role='banner'], #header, .header, .site-header, .navbar, .top-bar, .masthead", 8)
    .forEach((n) => add(n, 12, 'header'));
  sel("nav, [role='navigation']", 6).forEach((n) => add(n, 9, 'nav'));
  sel("button, [role='button'], .btn, [class*='btn-'], [class*='button'], input[type='submit'], input[type='button']", 45)
    .forEach((n) => add(n, 18, 'button'));
  sel('a', 30).forEach((n) => add(n, 3, 'link'));
  const root = getComputedStyle(document.documentElement);
  for (const name of ['--primary', '--brand', '--main-color', '--theme-color']) {
    const value = root.getPropertyValue(name).trim();
    if (opaque(value)) push(value, 26, 'var' + name, 'bg');
  }
  return [...buckets.values()].sort((a, b) => b.weight - a.weight).slice(0, 12);
}"""


async def probe(page, url: str) -> dict:
    await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_timeout(4000)
    source = BRAND_JS.read_text(encoding="utf-8")
    await page.add_script_tag(content=source)
    theme = await page.evaluate("() => window.EasyViewBrand.extract()")
    theme["title"] = await page.title()
    return theme


async def dump(page, url: str) -> dict:
    await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_timeout(4000)
    dump_state = await page.evaluate(DUMP_VARS_JS)
    dump_state["title"] = await page.title()
    return dump_state


async def dump_samples(page, url: str) -> list:
    await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    await page.wait_for_timeout(4000)
    return await page.evaluate(DUMP_SAMPLES_JS)


async def main() -> int:
    fix_console_encoding()
    parser = argparse.ArgumentParser(description="品牌提取探测")
    parser.add_argument("--urls", default=",".join(DEFAULT_URLS))
    parser.add_argument("--headless", action="store_true", help="无窗口跑（部分站点会出验证码页）")
    parser.add_argument("--dump-vars", action="store_true", help="额外打印候选 CSS 变量与出现最多的颜色")
    parser.add_argument("--dump-samples", action="store_true", help="打印品牌提取的加权采样明细")
    args = parser.parse_args()
    urls = [u.strip() for u in args.urls.split(",") if u.strip()]

    shutil.rmtree(PROFILE_DIR, ignore_errors=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    chrome = launch_chrome(PROFILE_DIR, headless=args.headless)
    if chrome is None:
        print("找不到 Chrome，请改 CHROME_CANDIDATES", file=sys.stderr)
        return 2
    proc, port = chrome

    results = []
    try:
        await wait_for_cdp(port)
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            for url in urls:
                print(f"→ {url} …", flush=True)
                page = await context.new_page()
                try:
                    item = {"url": url, "theme": await probe(page, url)}
                    if args.dump_vars:
                        item["dump"] = await dump(page, url)
                    if args.dump_samples:
                        item["samples"] = await dump_samples(page, url)
                    results.append(item)
                except Exception as exc:  # noqa: BLE001
                    results.append({"url": url, "error": f"{type(exc).__name__}: {str(exc)[:200]}"})
                finally:
                    try:
                        await page.close()
                    except Exception:  # noqa: BLE001
                        pass
            await browser.close()
    finally:
        stop_chrome(proc)

    for item in results:
        print("=" * 66)
        print(item["url"])
        if item.get("error"):
            print(f"  ! {item['error']}")
            continue
        theme = item["theme"]
        print(f"  站名: {theme.get('name') or '(空)'}   页面标题: {theme.get('title') or '(空)'}")
        print(f"  主色: {theme.get('brand')}  深色: {theme.get('brandDeep')}  强调: {theme.get('accent')}"
              f"  圆角: {theme.get('radius')}  深色模式: {theme.get('dark')}")
        print(f"  Logo: {theme.get('logoUrl') or '(无)'}")
        print(f"  文字标识: {theme.get('logoText') or '(空)'}")
        dump_state = item.get("dump")
        if dump_state:
            print(f"  [变量] :root {dump_state['rootVars']}")
            print(f"  [变量] body  {dump_state['bodyVars']}")
            print(f"  [高频] {dump_state['topColors']}")
        samples = item.get("samples")
        if samples:
            print("  [采样] color            权重   次数  来源")
            for row in samples:
                print(f"         {row['color']:<18} {row['weight']:>6.1f} {row['count']:>5}  "
                      f"{row['layers']} {row['where']}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
