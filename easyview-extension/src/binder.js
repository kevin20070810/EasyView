/* EasyView · 协议绑定器（浏览器端）
 *
 * 本文件是 ai-service/binder.py 的逐字移植：同样的草稿 + 同样的 elements.json
 * 必须产出完全相同的 ui_schema 0.3 对象（逐字段、逐键序）。
 * 所有"看起来多余"的写法都是为了对齐 Python 的语义，不要随手简化。
 *
 * 与 Python 的差异（仅两处，均为调用方式，不是语义）：
 *   1. sha256 由调用方用 SubtleCrypto 异步算好后传入（JS 里没有同步哈希）。
 *   2. 其余签名一一对应，见下面的 bind() 注释。
 *
 * 正则注意：Python 的 re.IGNORECASE 在 Unicode 下会把 İ/ı/ſ/K(开尔文符号)
 * 也算进 [a-z] 和字面量，JS 的 /i 不会。这里按"穷举所有码点"的实测结果
 * 把这些字符显式写进字符类；\b 也按 Python 的 \w（含 CJK）用 \p{L}\p{N}_
 * 重写；\s 用 Python 的空白集合。
 *
 * 普通 content script：无 import/export、无构建步骤，加载后只挂接口不自动执行。
 */
(function () {
  "use strict";

  // ======================================================================
  // 一、Python 语义兼容层（与 digest.js 同一套，故意重复以保持文件独立）
  // ======================================================================

  var PY_WS_CLASS =
    "\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680" +
    "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  var PY_WS_RUN = new RegExp("[" + PY_WS_CLASS + "]+", "gu");
  var PY_NON_WS_CLASS = "[^" + PY_WS_CLASS + "]";
  var PY_WS_TEXT =
    "\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680" +
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
    "\u2028\u2029\u202f\u205f\u3000";

  function pySplitWs(s) {
    var parts = s.split(PY_WS_RUN);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] !== "") out.push(parts[i]);
    }
    return out;
  }

  function pyStripChars(s, chars) {
    var start = 0;
    var end = s.length;
    while (start < end && chars.indexOf(s.charAt(start)) >= 0) start++;
    while (end > start && chars.indexOf(s.charAt(end - 1)) >= 0) end--;
    return s.slice(start, end);
  }

  function pyLStripChars(s, chars) {
    var start = 0;
    while (start < s.length && chars.indexOf(s.charAt(start)) >= 0) start++;
    return s.slice(start);
  }

  function pyStrip(s) {
    return pyStripChars(s, PY_WS_TEXT);
  }

  function pyFloatRepr(n) {
    if (n === 0) return 1 / n === -Infinity ? "-0.0" : "0.0";
    var s = String(n);
    var m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(s);
    if (!m) return s;
    var sign = m[1];
    var ip = m[2];
    var fp = m[3] || "";
    var ex = m[4] ? parseInt(m[4], 10) : 0;
    var all = ip + fp;
    // value = (ip+fp) × 10^-len(fp) × 10^ex；去掉前导零后写成 0.digits × 10^decpt
    // 再顺带去掉尾零（Python 的最短表示不带尾零，JS 的 String(1e16) 带）。
    var stripped = all.replace(/^0+/, "");
    var decpt = stripped.length - fp.length + ex;
    var digits = stripped === "" ? "0" : stripped.replace(/0+$/, "");
    if (digits === "") digits = "0";
    if (decpt > -4 && decpt <= 16) {
      if (decpt <= 0) return sign + "0." + new Array(-decpt + 1).join("0") + digits;
      if (decpt >= digits.length) {
        return sign + digits + new Array(decpt - digits.length + 1).join("0") + ".0";
      }
      return sign + digits.slice(0, decpt) + "." + digits.slice(decpt);
    }
    var e = decpt - 1;
    var mant = digits.length > 1 ? digits.charAt(0) + "." + digits.slice(1) : digits;
    var eabs = String(Math.abs(e));
    while (eabs.length < 2) eabs = "0" + eabs;
    return sign + mant + "e" + (e < 0 ? "-" : "+") + eabs;
  }

  function pyNumRepr(n) {
    if (Number.isNaN(n)) return "nan";
    if (n === Infinity) return "inf";
    if (n === -Infinity) return "-inf";
    if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
    return pyFloatRepr(n);
  }

  function pyStrRepr(s) {
    var quote = "'";
    if (s.indexOf("'") >= 0 && s.indexOf('"') < 0) quote = '"';
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === "\\") out += "\\\\";
      else if (c === quote) out += "\\" + quote;
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else if (code < 0x20 || code === 0x7f) out += "\\x" + ("0" + code.toString(16)).slice(-2);
      else out += c;
    }
    return quote + out + quote;
  }

  function pyRepr(v) {
    if (v === null || v === undefined) return "None";
    var t = typeof v;
    if (t === "boolean") return v ? "True" : "False";
    if (t === "number") return pyNumRepr(v);
    if (t === "string") return pyStrRepr(v);
    if (Array.isArray(v)) {
      var items = [];
      for (var i = 0; i < v.length; i++) items.push(pyRepr(v[i]));
      return "[" + items.join(", ") + "]";
    }
    var keys = Object.keys(v);
    var pairs = [];
    for (var k = 0; k < keys.length; k++) {
      pairs.push(pyStrRepr(keys[k]) + ": " + pyRepr(v[keys[k]]));
    }
    return "{" + pairs.join(", ") + "}";
  }

  function pyStr(v) {
    if (v === null || v === undefined) return "None";
    var t = typeof v;
    if (t === "string") return v;
    if (t === "boolean") return v ? "True" : "False";
    if (t === "number") return pyNumRepr(v);
    if (t === "bigint") return v.toString();
    return pyRepr(v);
  }

  function pyLower(s) {
    return s.toLowerCase().replace(/\u03c2/g, "\u03c3");
  }

  // Python 的 bool(value)。注意 bool(float('nan')) 是 True，而 JS 里
  // NaN 是 falsy —— 这里的 v !== 0 就是为它写的。
  function pyTruthy(v) {
    if (v === null || v === undefined) return false;
    var t = typeof v;
    if (t === "boolean") return v;
    if (t === "number") return v !== 0;
    if (t === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v).length > 0;
  }

  // Python 的 type(x).__name__（只用于对齐报错文案）
  function pyTypeOf(v) {
    if (v === null || v === undefined) return "NoneType";
    var t = typeof v;
    if (t === "boolean") return "bool";
    if (t === "number") return Number.isInteger(v) ? "int" : "float";
    if (t === "string") return "str";
    if (Array.isArray(v)) return "list";
    return "dict";
  }

  // Python 的 `for x in (value or [])`：字符串按码点、dict 按键，
  // 数字/布尔会抛 TypeError。
  function pyIterateOrEmpty(value) {
    var v = pyTruthy(value) ? value : [];
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return pyCodePoints(v);
    if (isMapping(v)) return Object.keys(v);
    throw PyTypeError("'" + pyTypeOf(v) + "' object is not iterable");
  }

  function pyCodePoints(s) {
    var out = [];
    for (var i = 0; i < s.length; ) {
      var cp = s.codePointAt(i);
      var w = cp > 0xffff ? 2 : 1;
      out.push(s.substr(i, w));
      i += w;
    }
    return out;
  }

  // Python 的 (value or [])[:5]：list/tuple 切片、str 按码点切片、
  // dict 会抛 KeyError(slice(None, 5, None))、数字抛 TypeError。
  function pySubscriptSlice(value) {
    var v = pyTruthy(value) ? value : [];
    if (Array.isArray(v)) return v.slice(0, 5);
    if (typeof v === "string") return pyCodePoints(pySlice(v, 0, 5));
    if (isMapping(v)) throw PyKeyError("slice(None, 5, None)");
    throw PyTypeError("'" + pyTypeOf(v) + "' object is not subscriptable");
  }

  function pyLen(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) i++;
      }
      n++;
    }
    return n;
  }

  function pySlice(s, start, end) {
    var n = pyLen(s);
    if (start === undefined || start === null) start = 0;
    if (end === undefined || end === null) end = n;
    if (start < 0) start = Math.max(0, n + start);
    if (end < 0) end = Math.max(0, n + end);
    if (end > n) end = n;
    if (start > end) return "";
    if (start === 0 && end === n) return s;
    var out = "";
    var idx = 0;
    for (var p = 0; p < s.length; ) {
      var cp = s.codePointAt(p);
      var w = cp > 0xffff ? 2 : 1;
      if (idx >= start && idx < end) out += s.substr(p, w);
      idx++;
      p += w;
      if (idx >= end) break;
    }
    return out;
  }

  function PyValueError(message) {
    var e = new Error(message);
    e.name = "ValueError";
    return e;
  }

  function PyTypeError(message) {
    var e = new Error(message);
    e.name = "TypeError";
    return e;
  }

  function PyAttributeError(message) {
    var e = new Error(message);
    e.name = "AttributeError";
    return e;
  }

  function PyKeyError(message) {
    var e = new Error(message);
    e.name = "KeyError";
    return e;
  }

  function isPyError(e) {
    return !!e && (e.name === "ValueError" || e.name === "TypeError");
  }

  // Python 的 float(value)
  function pyFloat(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number") return value;
    if (typeof value !== "string") {
      throw PyTypeError("float() argument must be a string or a real number");
    }
    var s = pyStrip(value);
    var lower = s.toLowerCase();
    if (lower === "inf" || lower === "+inf" || lower === "infinity" || lower === "+infinity") {
      return Infinity;
    }
    if (lower === "-inf" || lower === "-infinity") return -Infinity;
    if (lower === "nan" || lower === "+nan" || lower === "-nan") return NaN;
    if (!/^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?\d[\d_]*)?$/.test(s)) {
      throw PyValueError("could not convert string to float: " + pyStrRepr(value));
    }
    return Number(s.replace(/_/g, ""));
  }

  // 非字符串调用 .lower() 时 Python 会抛 AttributeError（比如 href 是数字）
  function attrLower(value) {
    if (typeof value !== "string") {
      throw PyAttributeError("'" + typeof value + "' object has no attribute 'lower'");
    }
    return pyLower(value);
  }

  // ===================== urlsplit（CPython 3.14 移植） =====================

  var WHATWG_C0_CONTROL_OR_SPACE = (function () {
    var out = "";
    for (var i = 0; i <= 0x20; i++) out += String.fromCharCode(i);
    return out;
  })();
  var UNSAFE_URL_BYTES = ["\t", "\r", "\n"];
  var SCHEME_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.";

  function isAsciiChar(ch) {
    return ch.charCodeAt(0) < 0x80;
  }

  function isAsciiAlpha(ch) {
    return /^[A-Za-z]$/.test(ch);
  }

  function removeUnsafe(s) {
    for (var i = 0; i < UNSAFE_URL_BYTES.length; i++) {
      s = s.split(UNSAFE_URL_BYTES[i]).join("");
    }
    return s;
  }

  function splitNetloc(url, start) {
    var delim = url.length;
    var delims = "/?#";
    for (var i = 0; i < delims.length; i++) {
      var wdelim = url.indexOf(delims.charAt(i), start);
      if (wdelim >= 0) delim = Math.min(delim, wdelim);
    }
    return [url.slice(start, delim), url.slice(delim)];
  }

  function isIPv4Address(s) {
    var parts = s.split(".");
    if (parts.length !== 4) return false;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!/^[0-9]+$/.test(p)) return false;
      if (p.length > 1 && p.charAt(0) === "0") return false;
      if (Number(p) > 255) return false;
    }
    return true;
  }

  // ipaddress.IPv6Address 的近似实现（支持内嵌 IPv4 与 %zone）。
  // 说明：这是本文件唯一没有逐位复刻的 Python 行为，只影响方括号 IPv6 字面量。
  function isIPv6Address(s) {
    var addr = s;
    var percent = s.indexOf("%");
    if (percent >= 0) addr = s.slice(0, percent);
    if (addr === "") return false;
    var doubleCount = addr.split("::").length - 1;
    if (doubleCount > 1) return false;
    var hasDouble = doubleCount === 1;

    function countGroups(text, allowEmpty) {
      if (text === "") return allowEmpty ? 0 : -1;
      var groups = text.split(":");
      var n = 0;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (g === "") return -1;
        if (g.indexOf(".") >= 0) {
          if (i !== groups.length - 1) return -1;
          if (!isIPv4Address(g)) return -1;
          n += 2;
        } else if (/^[0-9A-Fa-f]{1,4}$/.test(g)) {
          n += 1;
        } else {
          return -1;
        }
      }
      return n;
    }

    if (hasDouble) {
      var at = addr.indexOf("::");
      var ln = countGroups(addr.slice(0, at), true);
      var rn = countGroups(addr.slice(at + 2), true);
      if (ln < 0 || rn < 0) return false;
      return ln + rn <= 7;
    }
    return countGroups(addr, false) === 8;
  }

  function checkBracketedHost(hostname) {
    if (hostname.charAt(0) === "v") {
      if (!/^v[a-fA-F0-9]+\..+$/.test(hostname)) {
        throw PyValueError("IPvFuture address is invalid");
      }
      return;
    }
    if (isIPv4Address(hostname)) throw PyValueError("An IPv4 address cannot be in brackets");
    if (!isIPv6Address(hostname)) {
      throw PyValueError(hostname + " does not appear to be an IPv4 or IPv6 address");
    }
  }

  function checkBracketedNetloc(netloc) {
    var at = netloc.lastIndexOf("@");
    var hostnameAndPort = at >= 0 ? netloc.slice(at + 1) : netloc;
    var br = hostnameAndPort.indexOf("[");
    var hostname;
    var port;
    if (br >= 0) {
      if (hostnameAndPort.slice(0, br) !== "") throw PyValueError("Invalid IPv6 URL");
      var bracketed = hostnameAndPort.slice(br + 1);
      var close = bracketed.indexOf("]");
      hostname = close >= 0 ? bracketed.slice(0, close) : bracketed;
      port = close >= 0 ? bracketed.slice(close + 1) : "";
      if (port !== "" && port.charAt(0) !== ":") throw PyValueError("Invalid IPv6 URL");
    } else {
      var colon = hostnameAndPort.indexOf(":");
      hostname = colon >= 0 ? hostnameAndPort.slice(0, colon) : hostnameAndPort;
      port = colon >= 0 ? hostnameAndPort.slice(colon + 1) : "";
    }
    checkBracketedHost(hostname);
  }

  function checkNetloc(netloc) {
    if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
    var n = netloc.split("@").join("").split(":").join("")
      .split("#").join("").split("?").join("");
    var netloc2 = n.normalize("NFKC");
    if (n === netloc2) return;
    var bad = "/?#@:";
    for (var i = 0; i < bad.length; i++) {
      if (netloc2.indexOf(bad.charAt(i)) >= 0) {
        throw PyValueError(
          "netloc '" + netloc + "' contains invalid characters under NFKC normalization");
      }
    }
  }

  function pyUrlSplit(url, scheme, allowFragments) {
    var u = removeUnsafe(pyLStripChars(url, WHATWG_C0_CONTROL_OR_SPACE));
    var sch = scheme === undefined || scheme === null ? null : scheme;
    if (sch !== null) sch = removeUnsafe(pyStripChars(sch, WHATWG_C0_CONTROL_OR_SPACE));
    var af = allowFragments === undefined ? true : pyTruthy(allowFragments);
    var netloc = null;
    var query = null;
    var fragment = null;
    var i = u.indexOf(":");
    if (i > 0 && isAsciiChar(u.charAt(0)) && isAsciiAlpha(u.charAt(0))) {
      var ok = true;
      for (var j = 0; j < i; j++) {
        if (SCHEME_CHARS.indexOf(u.charAt(j)) < 0) {
          ok = false;
          break;
        }
      }
      if (ok) {
        sch = pyLower(u.slice(0, i));
        u = u.slice(i + 1);
      }
    }
    if (u.slice(0, 2) === "//") {
      var split = splitNetloc(u, 2);
      netloc = split[0];
      u = split[1];
      var hasOpen = netloc.indexOf("[") >= 0;
      var hasClose = netloc.indexOf("]") >= 0;
      if ((hasOpen && !hasClose) || (hasClose && !hasOpen)) throw PyValueError("Invalid IPv6 URL");
      if (hasOpen && hasClose) checkBracketedNetloc(netloc);
    }
    if (af && u.indexOf("#") >= 0) {
      var hash = u.indexOf("#");
      fragment = u.slice(hash + 1);
      u = u.slice(0, hash);
    }
    if (u.indexOf("?") >= 0) {
      var q = u.indexOf("?");
      query = u.slice(q + 1);
      u = u.slice(0, q);
    }
    checkNetloc(netloc);
    return { scheme: sch, netloc: netloc, path: u, query: query, fragment: fragment };
  }

  function urlHostinfo(netloc) {
    var at = netloc.lastIndexOf("@");
    var hostinfo = at >= 0 ? netloc.slice(at + 1) : netloc;
    var br = hostinfo.indexOf("[");
    var hostname;
    var port;
    if (br >= 0) {
      var bracketed = hostinfo.slice(br + 1);
      var close = bracketed.indexOf("]");
      hostname = close >= 0 ? bracketed.slice(0, close) : bracketed;
      var rest = close >= 0 ? bracketed.slice(close + 1) : "";
      var colon = rest.indexOf(":");
      port = colon >= 0 ? rest.slice(colon + 1) : "";
    } else {
      var c = hostinfo.indexOf(":");
      hostname = c >= 0 ? hostinfo.slice(0, c) : hostinfo;
      port = c >= 0 ? hostinfo.slice(c + 1) : "";
    }
    if (port === "") port = null;
    return [hostname, port];
  }

  function urlPort(result) {
    var port = urlHostinfo(result.netloc === null ? "" : result.netloc)[1];
    if (port === null) return null;
    if (!/^[0-9]+$/.test(port)) {
      throw PyValueError("Port could not be cast to integer value as " + pyStrRepr(port));
    }
    var value = parseInt(port, 10);
    if (!(value >= 0 && value <= 65535)) throw PyValueError("Port out of range 0-65535");
    return value;
  }

  // ================= Python 正则的 IGNORECASE / \b / \S 对齐 ==============

  // \u212a K / \u017f ſ / \u0130 İ / \u0131 ı 在 Python re.IGNORECASE 下
  // 会参与 [a-z] 与字面量的匹配（实测穷举所有码点得到的完整集合）。
  var FOLD_EXTRA = { i: "\u0130\u0131", k: "\u212a", s: "\u017f" };

  function escapeClassChar(ch) {
    return ch.replace(/[\\\]^\-]/g, "\\$&");
  }

  // 单个 ASCII 字母在 re.IGNORECASE 下的等价字符类
  function ciClass(ch) {
    var lower = ch.toLowerCase();
    if (lower < "a" || lower > "z") return escapeClassChar(ch);
    var set = [lower, lower.toUpperCase()];
    var extra = FOLD_EXTRA[lower];
    if (extra) {
      for (var i = 0; i < extra.length; i++) set.push(extra.charAt(i));
    }
    var seen = {};
    var out = "";
    for (var j = 0; j < set.length; j++) {
      if (seen[set[j]]) continue;
      seen[set[j]] = true;
      out += escapeClassChar(set[j]);
    }
    return "[" + out + "]";
  }

  function ciWord(word) {
    var out = "";
    for (var i = 0; i < word.length; i++) out += ciClass(word.charAt(i));
    return out;
  }

  // 与 [a-z] / [a-z0-9-] / [A-Za-z0-9_.~-] 在 re.IGNORECASE 下等价
  var CI_LOWER = "[a-zA-Z\\u0130\\u0131\\u017f\\u212a]";
  // Python: [a-z0-9+.-]  under re.IGNORECASE
  var CI_LOWER_DIGITS = "[a-zA-Z0-9+.\\-\\u0130\\u0131\\u017f\\u212a]";
  var CI_PATH_CHARS = "[A-Za-z0-9_.~\\-\\u0130\\u0131\\u017f\\u212a]";
  var CI_LOWER_NUM_DASH = "[a-zA-Z0-9\\-\\u0130\\u0131\\u017f\\u212a]";
  // Python 的 \b：\w = 字母 ∪ 数字 ∪ 下划线（含 CJK）
  var WORD_BOUNDARY =
    "(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))";

  var URL_LIKE = new RegExp(
    "(?:" +
      CI_LOWER + CI_LOWER_DIGITS + "*://" + PY_NON_WS_CLASS + "+" +
      "|" + ciWord("www") + "\\." + PY_NON_WS_CLASS + "+" +
      "|/(?:" + CI_PATH_CHARS + "+)(?:[/?.#]" + PY_NON_WS_CLASS + "*)?" +
      "|" + WORD_BOUNDARY + CI_LOWER_NUM_DASH + "+\\." +
        "(?:" + ciWord("com") + "|" + ciWord("cn") + "|" + ciWord("org") + "|" +
        ciWord("net") + "|" + ciWord("edu") + "|" + ciWord("gov") + "|" +
        ciWord("html") + "?|" + ciWord("php") + "|" + ciWord("asp") + "x?" + ")" +
        WORD_BOUNDARY +
    ")", "gu");

  var TECH_WORDS = new RegExp(
    "(?:" + ciWord("dom") + "|" + ciWord("selector") + "|" + ciWord("xpath") + "|" +
      ciWord("token") + "|" + ciWord("json") + "|" + ciWord("ui_schema") + "|" +
      ciWord("element_id") + "|" + ciWord("target_selector") + "|" +
      "选择器|免责声明|候选元素|技术字段" +
    ")", "gu");

  // re.sub(r"[（(]\s*[)）]", "", result)
  var PAREN_EMPTY = new RegExp("[\uff08(][" + PY_WS_CLASS + "]*[\uff09)]", "gu");

  var SCRUB_STRIP_CHARS = " -\u2014\u00b7\u3001,\uff0c\u3002;\uff1b";

  // ======================================================================
  // 二、binder.py 的移植
  // ======================================================================

  var SCHEMA_VERSION = "0.3.0-draft";
  var POLICY_VERSION = "senior-v0.3";

  var EVIDENCE_FIELDS = ["text", "label", "aria_label", "placeholder"];

  var TITLE_MAX = 12;
  var SUBTITLE_MAX = 48;
  var MAX_CARDS = 7;

  var PAY_HINTS = ["缴费", "交费", "支付", "付款", "充值", "结算", "账单", "欠费", "缴纳"];
  var MEDICAL_SUBMIT_HINTS = ["提交预约", "预约登记", "挂号登记", "预约挂号", "在线预约",
                              "门诊预约", "就诊人", "病历", "挂号"];
  var IDENTITY_HINTS = ["身份证", "实名", "证件号", "人脸", "认证"];
  var PERSONAL_DATA_HINTS = ["报告", "病历", "医保", "社保", "公积金", "账户", "余额",
                             "订单", "我的", "明细", "缴费记录", "办理进度"];
  var HEALTHCARE_HINTS = ["报告", "病历", "挂号", "门诊", "就医", "医保"];

  var RISK_ORDER = new Map([["normal", 0], ["sensitive", 1], ["blocked", 2]]);

  var ESCALATED_REASONS = new Map([
    ["normal", ["normal", ["read_only"], []]],
    ["sensitive", ["sensitive", ["personal_data"], []]],
    ["blocked", ["blocked", ["unknown_effect"], []]]
  ]);

  var FROZEN_ICONS = new Set(["home", "calendar", "document", "payment", "phone", "user",
                              "search", "location", "bus", "train", "hospital", "government",
                              "warning", "info", "help", "back"]);

  function isMapping(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  function clean(value) {
    var s = value === null || value === undefined ? "" : pyStr(value);
    return pySplitWs(s).join(" ");
  }

  // def _scrub_copy(text)
  function scrubCopy(text) {
    var result = text.replace(URL_LIKE, " ").replace(TECH_WORDS, " ");
    result = result.replace(PAREN_EMPTY, "");
    result = pySplitWs(result).join(" ");
    return pyStripChars(result, SCRUB_STRIP_CHARS);
  }

  // def _first_text(element, preferred=None)
  function firstText(element, preferred) {
    var order = EVIDENCE_FIELDS.slice();
    if (preferred && order.indexOf(preferred) >= 0) {
      order.splice(order.indexOf(preferred), 1);
      order.unshift(preferred);
    }
    for (var i = 0; i < order.length; i++) {
      var value = clean(element[order[i]]);
      if (value) return [order[i], value];
    }
    return ["", ""];
  }

  // def _origin(url) → [scheme, netloc, port] 或 null
  function origin(url) {
    var parts;
    try {
      parts = pyUrlSplit(url);
    } catch (e) {
      if (isPyError(e)) return null;
      throw e;
    }
    if (!parts.scheme || !parts.netloc) return null;
    var port;
    try {
      port = urlPort(parts);
    } catch (e) {
      if (isPyError(e)) return null;
      throw e;
    }
    return [pyLower(parts.scheme), pyLower(parts.netloc), port];
  }

  function pageOrigin(elementsData) {
    var final = clean(elementsData.final_url);
    var parsed = origin(final);
    if (parsed !== null && (parsed[0] === "http" || parsed[0] === "https")) return parsed;
    if (clean(elementsData.source) === "fallback" && final.slice(0, 11) === "snapshot://") {
      var fallback = origin(clean(elementsData.page_url));
      if (fallback !== null && (fallback[0] === "http" || fallback[0] === "https")) return fallback;
    }
    return null;
  }

  // ---------------------- 策略：风险等级与确认文案 ----------------------

  function haystack(element, title, subtitle) {
    var parts = [title, subtitle || "", clean(element.text), clean(element.label),
                 clean(element.aria_label), clean(element.placeholder), clean(element.href)];
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i]) out.push(parts[i]);
    }
    return out.join(" ");
  }

  function containsAny(hay, words) {
    for (var i = 0; i < words.length; i++) {
      if (hay.indexOf(words[i]) >= 0) return true;
    }
    return false;
  }

  function policyRisk(element, title, subtitle, intent, actionKind, href) {
    var hay = haystack(element, title, subtitle);

    // 1) 涉钱 —— 一律 blocked，扩展不得代办
    if (intent === "pay" || containsAny(hay, PAY_HINTS)) {
      return ["blocked", ["payment"], ["money"]];
    }
    // 2) 医疗提交 —— blocked + healthcare
    if (containsAny(hay, MEDICAL_SUBMIT_HINTS)) {
      return ["blocked", ["medical_submission"], ["healthcare"]];
    }
    // 3) 身份提交 —— blocked + identity
    if (containsAny(hay, IDENTITY_HINTS)) {
      return ["blocked", ["identity_submission"], ["identity"]];
    }
    // 4) 打电话：交给设备电话处理程序
    if (href && attrLower(href).slice(0, 4) === "tel:") {
      return ["sensitive", ["external_handler"], ["external_handler"]];
    }
    // 5) 读本人数据 —— sensitive，需要先确认
    if (containsAny(hay, PERSONAL_DATA_HINTS)) {
      var domains = containsAny(hay, HEALTHCARE_HINTS) ? ["healthcare"] : [];
      return ["sensitive", ["personal_data"], domains];
    }
    return ["normal", ["read_only"], []];
  }

  function applyModelHint(suggested, level, reasons, domains) {
    var value = pyLower(clean(suggested));
    if (!RISK_ORDER.has(value) || RISK_ORDER.get(value) <= RISK_ORDER.get(level)) {
      return [level, reasons, domains];
    }
    var escalated = ESCALATED_REASONS.get(value);
    var merged = [];
    var seen = new Set();
    var all = domains.concat(escalated[2]);
    for (var i = 0; i < all.length; i++) {
      if (!seen.has(all[i])) {
        seen.add(all[i]);
        merged.push(all[i]);
      }
    }
    return [escalated[0], escalated[1].slice(), merged];
  }

  function confirmation(level, kind, targetKind, element) {
    if (level !== "sensitive") return null;
    var message;
    if (kind === "form") {
      message = "这会把页面定位到需要填写信息的地方，内容仍然由您在原网页填写。";
    } else if (pyTruthy(element.href) && attrLower(element.href).slice(0, 4) === "tel:") {
      message = "这会打开您的电话拨号，可能产生通话费用。";
    } else {
      message = "这会打开需要核对个人信息的页面，请注意保护您的资料。";
    }
    return {
      message: pySlice(message, 0, 80),
      confirm_label: "继续",
      cancel_label: "先不打开"
    };
  }

  // ------------------------------- 动作 -------------------------------

  function resolveAction(element, level, pageOriginValue) {
    var kindOfElement = clean(element.type);
    var selector = clean(element.selector);
    var xpath = clean(element.xpath) || null;
    if (!selector) return null;

    var base = {
      target_element_id: clean(element.id),
      target_selector: selector,
      target_xpath: xpath
    };

    if (kindOfElement === "form") {
      // blocked 不允许用 form（schema 强制）；此时退化成"定位并聚焦"
      if (level === "blocked") {
        return [{ target_element_id: base.target_element_id, target_selector: base.target_selector,
                  target_xpath: base.target_xpath, kind: "scroll", href: null, confirmation: null },
                "scroll"];
      }
      return [{ target_element_id: base.target_element_id, target_selector: base.target_selector,
                target_xpath: base.target_xpath, kind: "form", href: null, confirmation: null },
              "form"];
    }

    if (kindOfElement === "link") {
      var href = element.href;
      var hrefText = clean(href);
      var urlOrigin = origin(hrefText);
      if (urlOrigin === null) return null;
      if (urlOrigin[0] === "tel") {
        return [{ target_element_id: base.target_element_id, target_selector: base.target_selector,
                  target_xpath: base.target_xpath, kind: "external", href: hrefText,
                  confirmation: null }, "external"];
      }
      if (pageOriginValue !== null && urlOrigin[0] === pageOriginValue[0] &&
          urlOrigin[1] === pageOriginValue[1] && urlOrigin[2] === pageOriginValue[2]) {
        return [{ target_element_id: base.target_element_id, target_selector: base.target_selector,
                  target_xpath: base.target_xpath, kind: "navigate", href: hrefText,
                  confirmation: null }, "navigate"];
      }
      return [{ target_element_id: base.target_element_id, target_selector: base.target_selector,
                target_xpath: base.target_xpath, kind: "external", href: hrefText,
                confirmation: null }, "external"];
    }

    // 既不是链接也不是表单：只能滚动定位，不触发任何事件
    return [{ target_element_id: base.target_element_id, target_selector: base.target_selector,
              target_xpath: base.target_xpath, kind: "scroll", href: null, confirmation: null },
            "scroll"];
  }

  // ------------------------------ 主流程 ------------------------------

  function cardId(index, title) {
    var slug = pyStripChars(pyLower(title).replace(/[^a-z0-9]+/gu, "_"), "_");
    if (!slug) return "card_" + pad2(index);
    return pySlice("card_" + pad2(index) + "_" + slug, 0, 60);
  }

  function pad2(n) {
    var s = String(n);
    while (s.length < 2) s = "0" + s;
    return s;
  }

  /**
   * 把模型草稿绑成完整 0.3 ui_schema。
   *
   * @param {object} draft        草稿（与 Python 的 draft 同构）
   * @param {object} elementsData elements.json 的对象形式
   * @param {object} options      { generatedAt, sha256, generator, userGoal, droppedReport }
   *   generatedAt   带时区的 ISO8601 字符串
   *   sha256        elements.json 的 SHA-256 十六进制（调用方用 SubtleCrypto 算好）
   *   generator     { mode, prompt_version, fallback_reason }，可选
   *   userGoal      可选，对应 Python 的 user_goal
   *   droppedReport 传入数组时往里写每张被丢弃卡片的原因（对应 Python 的 dropped_report）
   */
  function bind(draft, elementsData, options) {
    var opts = options || {};
    var generator = opts.generator || {};
    var droppedReport = opts.droppedReport === undefined ? null : opts.droppedReport;

    var elements = [];
    var rawElements = pyIterateOrEmpty(elementsData.elements);
    for (var i = 0; i < rawElements.length; i++) {
      if (isMapping(rawElements[i])) elements.push(rawElements[i]);
    }
    var byId = new Map();
    for (var b = 0; b < elements.length; b++) {
      byId.set(clean(elements[b].id), elements[b]);
    }
    var pageOriginValue = pageOrigin(elementsData);

    var dropped = droppedReport !== null ? droppedReport : [];
    var cards = [];
    var referenced = new Set();

    var rawCards = isMapping(draft) ? draft.cards : null;
    if (!Array.isArray(rawCards)) rawCards = [];

    for (var index = 0; index < rawCards.length; index++) {
      var item = rawCards[index];
      if (!isMapping(item)) {
        dropped.push("cards[" + index + "]: 不是对象");
        continue;
      }
      if (cards.length >= MAX_CARDS) {
        dropped.push("cards[" + index + "]: 超过 7 张上限");
        continue;
      }

      var elementId = clean(item.element_id);
      var element = byId.has(elementId) ? byId.get(elementId) : undefined;
      if (element === undefined) {
        dropped.push("cards[" + index + "]: 元素 " + (elementId || "(空)") + " 不存在");
        continue;
      }
      if (element.disabled === true) {
        dropped.push("cards[" + index + "]: 元素 " + elementId + " 已禁用");
        continue;
      }

      var title = scrubCopy(clean(item.title));
      if (!title) {
        dropped.push("cards[" + index + "]: 标题为空");
        continue;
      }
      if (pyLen(title) > TITLE_MAX) {
        dropped.push("cards[" + index + "]: 标题「" + title + "」超过 " + TITLE_MAX + " 字");
        continue;
      }

      var subtitleRaw = scrubCopy(clean(item.subtitle));
      var subtitle = pyTruthy(subtitleRaw) ? pySlice(subtitleRaw, 0, SUBTITLE_MAX) : null;
      if (subtitle && pyLen(subtitleRaw) > SUBTITLE_MAX) {
        dropped.push("cards[" + index + "]: 副标题被截断（原文 " + pyLen(subtitleRaw) + " 字）");
      }

      var intent = pyLower(clean(item.intent)) || "query";

      // 先算动作，因为风险策略要看动作类型
      var resolved = resolveAction(element, "normal", pageOriginValue);
      if (resolved === null) {
        dropped.push("cards[" + index + "]: 元素 " + elementId +
          " 无法定位（缺少 selector 或 href 不合法）");
        continue;
      }

      var risk = policyRisk(element, title, subtitle, intent, resolved[1], element.href);
      var hint = applyModelHint(item.risk, risk[0], risk[1], risk[2]);
      var level = hint[0];
      var reasons = hint[1];
      var domains = hint[2];

      resolved = resolveAction(element, level, pageOriginValue);
      if (resolved === null) {
        dropped.push("cards[" + index + "]: 按 " + level + " 风险重新解析动作失败");
        continue;
      }
      var action = resolved[0];
      var actionKind = resolved[1];

      // scroll 只是把用户带到原网页的位置，不会替他点
      if (actionKind === "scroll") subtitle = "回到原网页的这个位置，由您自己操作";

      var evidenceField = clean(item.evidence_field) || null;
      var found = firstText(element, evidenceField);
      var field = found[0];
      var quote = found[1];
      if (!field) {
        dropped.push("cards[" + index + "]: 元素 " + elementId + " 没有任何可引用的文字");
        continue;
      }

      var evidenceId = "ev_1";
      var evidence = [{ id: evidenceId, element_id: elementId, field: field, quote: quote }];
      var sourceIds = [elementId];

      // 附加证据：模型可以再引几个同组元素来支撑文案
      var extras = pySubscriptSlice(item.also_cite);
      for (var x = 0; x < extras.length; x++) {
        var extraId = clean(extras[x]);
        if (!byId.has(extraId) || sourceIds.indexOf(extraId) >= 0) continue;
        var extraElement = byId.get(extraId);
        var extraFound = firstText(extraElement, null);
        if (!extraFound[0]) continue;
        evidence.push({
          id: "ev_" + (evidence.length + 1),
          element_id: extraId,
          field: extraFound[0],
          quote: extraFound[1]
        });
        sourceIds.push(extraId);
      }

      // 标题若与来源原文完全一致，如实标成 verbatim；否则是改写
      var titleMode = title === quote ? "verbatim" : "rewritten";
      var contentMeta = {
        title: { mode: titleMode, evidence_ids: [evidenceId] },
        subtitle: subtitle ? { mode: "rewritten", evidence_ids: [evidenceId] } : null
      };

      var reasoning = pySlice(scrubCopy(clean(item.reason)), 0, 160);
      if (!reasoning) reasoning = "来源中与「" + title + "」直接相关的入口。";

      var evidenceIds = [];
      for (var e = 0; e < evidence.length; e++) evidenceIds.push(evidence[e].id);

      var card = {
        id: cardId(cards.length + 1, title),
        title: title,
        subtitle: subtitle,
        icon: clean(item.icon) || "info",
        priority: cards.length + 1,
        intent: intent,
        provenance: { source_element_ids: sourceIds, evidence: evidence },
        content_meta: contentMeta,
        facts: [],
        ranking: {
          reason_codes: ["main_service"],
          explanation: reasoning,
          evidence_ids: evidenceIds
        },
        risk: { level: level, domains: domains, reason_codes: reasons, evidence_ids: evidenceIds },
        action: {
          target_element_id: action.target_element_id,
          target_selector: action.target_selector,
          target_xpath: action.target_xpath,
          kind: action.kind,
          href: action.href,
          confirmation: confirmation(level, actionKind, clean(element.type), element)
        }
      };

      // 模型可以要求保留一段原文事实（verbatim）
      var fact = item.fact;
      if (isMapping(fact)) {
        var factElementId = clean(fact.element_id) || elementId;
        var factElement = byId.has(factElementId) ? byId.get(factElementId) : undefined;
        if (factElement !== undefined) {
          var factFieldWanted = clean(fact.field) || null;
          var factFound = firstText(factElement, factFieldWanted);
          if (factFound[0] && factFound[1]) {
            if (sourceIds.indexOf(factElementId) < 0) sourceIds.push(factElementId);
            var factEvidenceId = "ev_" + (evidence.length + 1);
            evidence.push({
              id: factEvidenceId,
              element_id: factElementId,
              field: factFound[0],
              quote: factFound[1]
            });
            card.facts = [{
              text: factFound[1],
              content_mode: "verbatim",
              evidence_ids: [factEvidenceId]
            }];
            card.content_meta.title.evidence_ids =
              dedupeStrings(card.content_meta.title.evidence_ids);
            var allIds = [];
            for (var ei = 0; ei < evidence.length; ei++) allIds.push(evidence[ei].id);
            card.ranking.evidence_ids = allIds;
            card.risk.evidence_ids = allIds;
            card.provenance.source_element_ids = sourceIds;
          }
        }
      }

      cards.push(card);
      for (var r = 0; r < sourceIds.length; r++) referenced.add(sourceIds[r]);
    }

    // icon 不在冻结集合里的换成 info，避免整体 schema 校验失败
    for (var ci = 0; ci < cards.length; ci++) {
      if (!FROZEN_ICONS.has(cards[ci].icon)) cards[ci].icon = "info";
    }

    // 重排 priority 为连续 1..N，并保证 card id 唯一
    var seenIds = new Set();
    for (var pi = 0; pi < cards.length; pi++) {
      var cardItem = cards[pi];
      cardItem.priority = pi + 1;
      if (seenIds.has(cardItem.id)) cardItem.id = cardItem.id + "_" + (pi + 1);
      seenIds.add(cardItem.id);
    }

    var state = cards.length ? "ready" : "empty";
    var greeting = scrubCopy(clean(draft.greeting));
    if (!greeting) {
      var site = clean(elementsData.page_title) || "这个网站";
      greeting = state === "ready"
        ? "您好，这里是" + site + "。"
        : "您好，这个页面暂时没找到可以代办的事情。";
    }
    var summary = scrubCopy(clean(draft.summary));
    if (!summary) {
      var titles = [];
      for (var ti = 0; ti < cards.length && ti < 4; ti++) titles.push(cards[ti].title);
      summary = titles.length
        ? "您可以" + titles.join("、") + "。"
        : "您可以退出适老模式，继续使用原网页。";
    }

    var statsRaw = pyTruthy(elementsData.stats) ? elementsData.stats : {};
    var truncated = statsRaw.truncated === undefined ? false : statsRaw.truncated;
    var visibleCount = 0;
    for (var vi = 0; vi < elements.length; vi++) {
      if (elements[vi].visible === true) visibleCount++;
    }

    var userGoal = clean(opts.userGoal);
    var generatedAt = opts.generatedAt === undefined ? null : opts.generatedAt;
    var sha256 = opts.sha256 === undefined ? null : opts.sha256;

    return {
      schema_version: SCHEMA_VERSION,
      artifact_kind: "runtime",
      source_elements_schema_version: clean(elementsData.schema_version),
      page_url: clean(elementsData.page_url),
      final_url: clean(elementsData.final_url),
      page_title: clean(elementsData.page_title),
      source: clean(elementsData.source),
      generated_at: generatedAt,
      input_snapshot: {
        sha256: sha256,
        extracted_at: clean(elementsData.extracted_at)
      },
      generator: {
        mode: clean(generator.mode) || "model",
        policy_version: POLICY_VERSION,
        prompt_version: generator.prompt_version === undefined ? null : generator.prompt_version,
        fallback_reason: generator.fallback_reason === undefined ? null : generator.fallback_reason
      },
      user_goal: pyTruthy(userGoal) ? userGoal : null,
      state: state,
      empty_reason: state === "ready" ? null : "no_reliable_tasks",
      page: { greeting: pySlice(greeting, 0, 64), summary: pySlice(summary, 0, 100) },
      stats: {
        input_elements: elements.length,
        visible_elements: visibleCount,
        input_truncated: pyTruthy(truncated),
        referenced_elements: referenced.size,
        task_cards: cards.length
      },
      cards: cards
    };
  }

  function dedupeStrings(values) {
    var seen = new Set();
    var out = [];
    for (var i = 0; i < values.length; i++) {
      if (!seen.has(values[i])) {
        seen.add(values[i]);
        out.push(values[i]);
      }
    }
    return out;
  }

  globalThis.EasyViewBinder = {
    bind: bind,
    SCHEMA_VERSION: SCHEMA_VERSION,
    POLICY_VERSION: POLICY_VERSION,
    TITLE_MAX: TITLE_MAX,
    SUBTITLE_MAX: SUBTITLE_MAX,
    EVIDENCE_FIELDS: EVIDENCE_FIELDS
  };
})();
