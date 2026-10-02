# -*- coding: utf-8 -*-
"""稳定性压测：同一份输入跑 N 次，看选中的任务稳不稳。

为什么需要这个
--------------
模型产出一度极不稳定：同一份 12306 页面，连跑 5 次分别给出 1/1/3/4/3 张卡，
没有任何一个任务每次都出现。演示会变成掷骰子，而且没法评估 prompt 改动
到底有没有用 —— 全被噪声淹没。

度量口径很重要：**不能比标题逐字相同**。0.3 明确允许同义改写，
「我要买票」和「买火车票」是同一个任务。真正该比的是**选中的底层元素是不是同一批**。

用法：
    python tools/stability_check.py --payload payload.json --runs 5
    python tools/stability_check.py --url https://www.12306.cn/ --runs 5

需要分析服务在跑，并且服务端已配好 EASYVIEW_API_KEY。
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.request

SERVICE = "http://127.0.0.1:8787"


def analyze(doc: dict) -> dict:
    request = urllib.request.Request(
        f"{SERVICE}/analyze?ai=1&debug=1",
        data=json.dumps(doc, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        return json.load(response)


def grab_payload(url: str) -> dict:
    """用扩展的 extract.js 在真实页面上跑一次，拿到载荷。"""
    import asyncio
    from playwright.async_api import async_playwright

    here = pathlib.Path(__file__).resolve().parents[1]
    script = (here.parent / "easyview-extension" / "src" / "extract.js").read_text(encoding="utf-8")

    async def run() -> dict:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=["--no-sandbox"])
            page = await (await browser.new_context(locale="zh-CN")).new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(4000)
            await page.add_script_tag(content=script)
            doc = await page.evaluate("() => globalThis.EasyViewExtract.run().elements")
            await browser.close()
            return doc

    return asyncio.run(run())


def main() -> int:
    parser = argparse.ArgumentParser(description="模型产出稳定性压测")
    parser.add_argument("--payload", help="已保存的 elements.json 载荷")
    parser.add_argument("--url", help="真实网址（会现场抓一次生成载荷）")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--save", help="把现场抓到的载荷存下来，便于反复压测")
    args = parser.parse_args()

    if args.payload:
        doc = json.loads(pathlib.Path(args.payload).read_text(encoding="utf-8"))
    elif args.url:
        print(f"现场抓取 {args.url} …")
        doc = grab_payload(args.url)
        if args.save:
            pathlib.Path(args.save).write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
            print(f"载荷已存到 {args.save}")
    else:
        parser.error("需要 --payload 或 --url")

    print(f"输入 {doc['stats']['total']} 元素，跑 {args.runs} 次\n")
    runs: list[list[tuple[str, str]]] = []
    reasoning: list[int] = []

    for index in range(args.runs):
        out = analyze(doc)
        cards = [(c["title"], c["action"]["target_element_id"]) for c in out["data"]["cards"]]
        runs.append(cards)
        usage = out["meta"]["usage"]
        reasoning.append((usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0))
        print(f"  {index + 1}. {len(cards)} 张  " + "、".join(t for t, _ in cards))

    counts = [len(r) for r in runs]
    id_sets = [frozenset(e for _, e in r) for r in runs]
    always = set(id_sets[0])
    for s in id_sets[1:]:
        always &= s
    ever = set()
    for s in id_sets:
        ever |= s

    title_of = {e: t for r in runs for t, e in r}
    print()
    print("=== 按底层元素判定（同义改写算同一个任务）===")
    for element in sorted(always):
        print(f"  [每次都有] {title_of[element]}  ({element})")
    for element in sorted(ever - always):
        print(f"  [{sum(1 for s in id_sets if element in s)}/{args.runs} 次]  "
              f"{title_of[element]}  ({element})")
    if not ever:
        print("  （一次都没选中元素）")

    jaccards = []
    for i in range(len(id_sets)):
        for j in range(i + 1, len(id_sets)):
            union = id_sets[i] | id_sets[j]
            jaccards.append(len(id_sets[i] & id_sets[j]) / len(union) if union else 1.0)
    avg = sum(jaccards) / len(jaccards) if jaccards else 0.0

    print()
    print("=== 评分 ===")
    print(f"  卡片数: {counts}   范围 {min(counts)}~{max(counts)}"
          f"   {'一致' if min(counts) == max(counts) else '有波动'}")
    print(f"  每次都选中: {len(always)} 个 / 出现过 {len(ever)} 个")
    print(f"  两两 Jaccard 均值: {avg:.2f}   （1.00 = 每次完全同一批）")
    print(f"  推理 token: {sorted(reasoning)}")

    # Jaccard 低于 0.8 基本没法做演示：同一份页面给出明显不同的东西
    if avg < 0.8:
        print()
        print("  ⚠️ 一致性偏低。先查这两件事：")
        print("     1. prompt 里有没有留给模型「自己拿主意」的模糊判断")
        print("        —— 这类判断每次重新发明，正是飘的来源")
        print("     2. 页面里有没有「是步骤还是任务」这类需要明确的边界")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
