# -*- coding: utf-8 -*-
"""定位 _URL_LIKE 等价正则的差异（临时排查用）。"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]

PROBE = r"""
() => {
  const PY_WS_CLASS =
    "\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680" +
    "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  const PY_NON_WS_CLASS = "[^" + PY_WS_CLASS + "]";
  const FOLD_EXTRA = { i: "\u0130\u0131", k: "\u212a", s: "\u017f" };
  function escapeClassChar(ch) { return ch.replace(/[\\\]^\-]/g, "\\$&"); }
  function ciClass(ch) {
    const lower = ch.toLowerCase();
    if (lower < "a" || lower > "z") return escapeClassChar(ch);
    const set = [lower, lower.toUpperCase()];
    const extra = FOLD_EXTRA[lower];
    if (extra) for (const c of extra) set.push(c);
    const seen = {};
    let out = "";
    for (const c of set) { if (seen[c]) continue; seen[c] = true; out += escapeClassChar(c); }
    return "[" + out + "]";
  }
  function ciWord(word) {
    let out = "";
    for (const c of word) out += ciClass(c);
    return out;
  }
  const CI_LOWER = "[a-zA-Z\\u0130\\u0131\\u017f\\u212a]";
  const CI_LOWER_DIGITS = "[a-zA-Z0-9+.\\-\\u0130\\u0131\\u017f\\u212a]";
  const CI_PATH_CHARS = "[A-Za-z0-9_.~\\-\\u0130\\u0131\\u017f\\u212a]";
  const CI_LOWER_NUM_DASH = "[a-zA-Z0-9\\-\\u0130\\u0131\\u017f\\u212a]";
  const WORD_BOUNDARY =
    "(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))";
  const src =
    "(?:" +
      CI_LOWER + CI_LOWER_DIGITS + "://" + PY_NON_WS_CLASS + "+" +
      "|" + ciWord("www") + "\\." + PY_NON_WS_CLASS + "+" +
      "|/(?:" + CI_PATH_CHARS + "+)(?:[/?.#]" + PY_NON_WS_CLASS + "*)?" +
      "|" + WORD_BOUNDARY + CI_LOWER_NUM_DASH + "+\\." +
        "(?:" + ciWord("com") + "|" + ciWord("cn") + "|" + ciWord("org") + "|" +
        ciWord("net") + "|" + ciWord("edu") + "|" + ciWord("gov") + "|" +
        ciWord("html") + "?|" + ciWord("php") + "|" + ciWord("asp") + "x?" + ")" +
        WORD_BOUNDARY +
    ")";
  const re = new RegExp(src, "gu");
  const text = "见 https://a.com/very/long/path?q=1 xpath token";
  const out = { src, matches: [] };
  const re2 = new RegExp(src, "gu");
  let m;
  while ((m = re2.exec(text)) !== null) {
    out.matches.push([m.index, m[0]]);
    if (m[0] === "") re2.lastIndex++;
  }
  out.replaced = text.replace(re, " ");
  // 逐个字符试探：从每个位置单独匹配
  out.perIndex = [];
  for (let i = 0; i < 10; i++) {
    const r = new RegExp(src, "u");
    const mm = r.exec(text.slice(i));
    out.perIndex.push([i, mm ? mm[0] : null]);
  }
  out.simple = "https://a.com/x".replace(new RegExp(CI_LOWER + CI_LOWER_DIGITS + "://" + PY_NON_WS_CLASS + "+", "u"), "<URL>");
  out.classSource = CI_LOWER_DIGITS;
  return out;
}
"""


def main():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("about:blank")
        page.add_script_tag(path=str(REPO / "easyview-extension" / "src" / "binder.js"))
        result = page.evaluate(PROBE)
        browser.close()
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
