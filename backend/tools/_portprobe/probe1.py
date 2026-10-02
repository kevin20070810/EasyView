import re, sys
print("py", sys.version.split()[0])
tests = [
 ("[a-z] vs KELVIN", lambda: bool(re.search(r"[a-z]", "\u212a", re.I))),
 ("[a-z] vs LONG S", lambda: bool(re.search(r"[a-z]", "\u017f", re.I))),
 ("[a-z0-9-] vs KELVIN", lambda: bool(re.search(r"[a-z0-9-]", "\u212a", re.I))),
 ("literal k vs KELVIN", lambda: bool(re.search(r"token", "to\u212aen", re.I))),
 ("literal i vs U+0130", lambda: bool(re.search(r"ui_schema", "u\u0130_schema", re.I))),
 ("literal s vs LONG S", lambda: bool(re.search(r"selector", "s\u017felector", re.I))),
 ("literal S vs long s upper", lambda: bool(re.search(r"JSON", "j\u017fon", re.I))),
 ("word boundary CJK", lambda: bool(re.search(r"\bcom\b", "\u75c5\u5386com", re.I))),
 ("word boundary CJK after", lambda: bool(re.search(r"\bcom\b", "com\u75c5\u5386", re.I))),
 ("word boundary digit", lambda: bool(re.search(r"\bcom\b", "1com", re.I))),
 ("word boundary underscore", lambda: bool(re.search(r"\bcom\b", "_com", re.I))),
 ("\\S vs NEL", lambda: bool(re.match(r"\S", "\u0085"))),
 ("\\S vs FEFF", lambda: bool(re.match(r"\S", "\ufeff"))),
 ("\\S vs FS 0x1c", lambda: bool(re.match(r"\S", "\x1c"))),
 ("\\S vs NBSP", lambda: bool(re.match(r"\S", "\u00a0"))),
 ("\\s vs NEL", lambda: bool(re.match(r"\s", "\u0085"))),
 ("\\s vs FEFF", lambda: bool(re.match(r"\s", "\ufeff"))),
 ("\\s vs FS", lambda: bool(re.match(r"\s", "\x1c"))),
 ("split vs FS", lambda: "a\x1cb".split()),
 ("split vs NEL", lambda: "a\u0085b".split()),
 ("split vs FEFF", lambda: "a\ufeffb".split()),
 ("split vs VT", lambda: "a\x0bb".split()),
 ("islower final sigma", lambda: "\u039f\u03a3".lower()),
 ("str(KELVIN) lower", lambda: "\u212a".lower()),
 ("sha empty", lambda: None),
]
for name, fn in tests:
    try:
        print(f"{name}: {fn()!r}")
    except Exception as e:
        print(f"{name}: EXC {e!r}")
# urlsplit behaviours
from urllib.parse import urlsplit
for u in ["https://demo.easyview.local/guahao?x=1#f", "tel:123", "tel://host/1", "javascript:void(0)",
          "/guahao", "//host/p", "HTTP://EXAMPLE.COM:8080/a/b", "https://u:p@Host.COM:443/x",
          "snapshot://abc/def", "www.example.com/x", "mailto:a@b.com", "https://\u4f8b\u5b50.\u4e2d\u56fd/a",
          "https://[::1]:8080/x", "https://[::1/x", "https://host:99999/x", "https://host:abc/x",
          "  https://a.com/x  ", "ht\ntp://a.com/x", "https://a.com/\u00e9\u4e2d\u6587", "http://a.com/" + "p"*60,
          "https://a.com", "a/b:c", "1http://x.com/y", "https://[fe80::1%25eth0]:80/x"]:
    try:
        r = urlsplit(u)
        try: h = r.hostname
        except Exception as e: h = f"EXC {e!r}"
        try: p = r.port
        except Exception as e: p = f"EXC {e!r}"
        print(f"URL {u!r} -> scheme={r.scheme!r} netloc={r.netloc!r} path={r.path!r} q={r.query!r} f={r.fragment!r} host={h!r} port={p!r}")
    except Exception as e:
        print(f"URL {u!r} -> EXC {type(e).__name__} {e}")
