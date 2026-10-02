import sys, re
sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
letters = sorted(set("domselectorxpathtokenjsonui_schemaelement_idtarget_selector"))
for ch in letters:
    if not ch.isascii() or not ch.isalpha(): continue
    s = [c for c in range(0x110000) if re.match(re.escape(ch), chr(c), re.I)]
    extra = [hex(c) for c in s if c != ord(ch) and c != ord(ch.upper())]
    print(ch, "->", extra)
print("=== spot: whole-word substitution tests ===")
for lit, cand in [("token","to\u212aen"),("ui_schema","u\u0130_schema"),("element_id","elem\u0130nt_id"),
                  ("selector","s\u017felector"),("json","j\u017fon"),("xpath","xp\u0130th"),("dom","d\u212am")]:
    print(lit, cand, bool(re.search(lit, cand, re.I)))
print("=== word-boundary astral/Zs checks ===")
for pat, s in [(r"\bcom\b","\U0001F600com"),(r"\bcom\b","com\U0001F600"),(r"\bcom\b","\u3000com"),(r"\bcom\b","\u00b2com"),(r"\bcom\b","a-com")]:
    print(repr(pat), repr(s), bool(re.search(pat, s, re.I)))
