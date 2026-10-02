import sys, re
sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
from urllib.parse import urlsplit
print("=== urlsplit ===")
for u in ["https://demo.easyview.local/guahao?x=1#f", "tel:123", "tel://host/1", "javascript:void(0)",
          "/guahao", "//host/p", "HTTP://EXAMPLE.COM:8080/a/b", "https://u:p@Host.COM:443/x",
          "snapshot://abc/def", "www.example.com/x", "mailto:a@b.com", "https://\u4f8b\u5b50.\u4e2d\u56fd/a",
          "https://[::1]:8080/x", "https://[::1/x", "https://host:99999/x", "https://host:abc/x",
          "  https://a.com/x  ", "ht\ntp://a.com/x", "https://a.com/\u00e9\u4e2d\u6587", "http://a.com/" + "p"*60,
          "https://a.com", "a/b:c", "1http://x.com/y", "https://[fe80::1%25eth0]:80/x", "#frag", "?q=1",
          "https://a.com:80", "https://:80/x", "//[::1]/p", "https://a.com/x#y#z", "\u4e2d\u6587://host/p"]:
    try:
        r = urlsplit(u)
        try: h = r.hostname
        except Exception as e: h = "EXC %s" % (e,)
        try: p = r.port
        except Exception as e: p = "EXC %s" % (e,)
        print("URL %r -> sch=%r net=%r path=%r q=%r f=%r host=%r port=%r" % (u, r.scheme, r.netloc, r.path, r.query, r.fragment, h, p))
    except Exception as e:
        print("URL %r -> EXC %s %s" % (u, type(e).__name__, e))
print("=== lower ===")
print(repr("\u039f\u03a3".lower()), repr("\u0130".lower()), repr("\u212a".lower()), repr("\u017f".lower()))
print("=== isspace set (non-ascii) ===")
print([hex(c) for c in range(0x80, 0x11000) if chr(c).isspace()])
print("=== \\s set (non-ascii) ===")
print([hex(c) for c in range(0x80, 0x11000) if re.match(r"\s", chr(c))])
print("=== extras in [a-z] under re.I ===")
ex = [c for c in range(0x110000) if re.match(r"[a-z]", chr(c), re.I) and not re.match(r"[a-zA-Z]", chr(c))]
print([hex(c) for c in ex])
print("=== extras in [a-z0-9-] under re.I ===")
ex2 = [c for c in range(0x110000) if re.match(r"[a-z0-9-]", chr(c), re.I) and not re.match(r"[a-zA-Z0-9-]", chr(c))]
print([hex(c) for c in ex2])
print("=== extras in [A-Za-z0-9_.~-] under re.I ===")
ex3 = [c for c in range(0x110000) if re.match(r"[A-Za-z0-9_.~-]", chr(c), re.I) and not re.match(r"[A-Za-z0-9_.~-]", chr(c))]
print([hex(c) for c in ex3])
print("=== literal IGNORECASE sets ===")
for lit in ["dom", "selector", "xpath", "token", "json", "ui_schema", "element_id", "target_selector",
            "com", "cn", "org", "net", "edu", "gov", "html", "htm", "php", "asp", "aspx", "www", "http"]:
    s = [c for c in range(0x110000) if re.match(re.escape(lit), chr(c), re.I)]
    extra = [hex(c) for c in s if chr(c) not in lit and chr(c).lower() != chr(c)]
    if extra: print(lit, "->", extra)
print("=== word char extras (\\w minus ascii) sample ===")
w = [hex(c) for c in range(0x80, 0x2000) if re.match(r"\w", chr(c))]
print(len(w), w[:20])
