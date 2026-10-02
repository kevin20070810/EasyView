/* EasyView · 页面说明书生成（浏览器端）
 *
 * 本文件是 ai-service/digest.py 的逐字移植：同样的输入必须产出逐字节相同的
 * 文本。所有"看起来多余"的写法都是为了对齐 Python 的语义，不要随手简化。
 *
 * 与 Python 的对应关系（逐条核对过）：
 *   - 空白：Python str.split() / re 的 \s = Unicode White_Space ∪ U+001C..U+001F，
 *     比 JS 的 \s 多 U+001C..U+001F 和 U+0085，少 U+FEFF。见 PY_WS_CLASS。
 *   - 长度与切片：Python 按码点，JS 的 String#length/slice 按 UTF-16 码元。
 *     统一走 pyLen / pySlice（emoji、生僻字才看得出差别）。
 *   - str.lower() / str.strip(chars) / float() / int() / dict 保序 都有对应实现。
 *   - urlsplit 按 CPython 3.14 的 urllib.parse 逻辑重写（含 IPv6 方括号校验）。
 *   - 排序一律先算 key 再排（Python 的 list.sort(key=...) 也是这样，
 *     这样 key 计算抛错的行为才一致），并用 Python 的元组比较语义。
 *   - round() 只出现在 digest.py 的 digest_stats() 里；那是调试用统计，
 *     还依赖 Python json.dumps 的分隔符，不属于本移植面，故未移植。
 *
 * 用法：
 *   globalThis.EasyViewDigest.build(elementsDoc)            // → 说明书文本
 *   globalThis.EasyViewDigest.build(doc, { maxRows: 160 })  // 与 Python 的 max_rows 对应
 *
 * 普通 content script：无 import/export、无构建步骤，加载后只挂接口不自动执行。
 */
(function () {
  "use strict";

  // ======================================================================
  // 一、Python 语义兼容层
  // ======================================================================

  // Python 认定的空白字符（str.split() 与 re 的 \s 同一套）。
  var PY_WS_CLASS =
    "\\t\\n\\x0b\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680" +
    "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  var PY_WS_RUN = new RegExp("[" + PY_WS_CLASS + "]+", "gu");
  // 用于把 Python 正则里的 \S 翻译成 JS 字符类
  var PY_NON_WS_CLASS = "[^" + PY_WS_CLASS + "]";
  var PY_WS_TEXT =
    "\t\n\u000b\f\r\u001c\u001d\u001e\u001f \u0085\u00a0\u1680" +
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
    "\u2028\u2029\u202f\u205f\u3000";

  function pySplitWs(s) {
    // 等价于 Python 的 str.split()（无参数）
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

  // Python 的 str.strip()
  function pyStrip(s) {
    return pyStripChars(s, PY_WS_TEXT);
  }

  // Python 的 float repr（最短往返表示）
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

  // Python 的 repr(number)。注意 Python 区分 int/float，JS 只有一个 number：
  // JSON 里的 100.0 到了 JS 就是 100，无法还原成 Python 的 "100.0"。
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

  // Python 的 repr(value)（仅用于 str(value) 落到容器上的兜底路径）
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

  // Python 的 str(value)（None 由调用方折算成 ""）
  function pyStr(v) {
    if (v === null || v === undefined) return "None";
    var t = typeof v;
    if (t === "string") return v;
    if (t === "boolean") return v ? "True" : "False";
    if (t === "number") return pyNumRepr(v);
    if (t === "bigint") return v.toString();
    return pyRepr(v);
  }

  // Python 的 str.lower()。JS 的 toLowerCase 会对希腊大写 sigma 做
  // Final_Sigma 上下文处理（ΟΣ→ος），Python 不做（ΟΣ→οσ），改回来。
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

  // Python 的 len(value or [])：字符串按码点、dict 按键数，
  // 数字会抛 TypeError。
  function pyLenOrEmpty(value) {
    var v = pyTruthy(value) ? value : [];
    if (Array.isArray(v)) return v.length;
    if (typeof v === "string") return pyLen(v);
    if (isMapping(v)) return Object.keys(v).length;
    throw PyTypeError("object of type '" + pyTypeOf(v) + "' has no len()");
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

  // Python 的 len()（按码点）
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

  // Python 的切片 s[start:end]（按码点，只实现非负下标）
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

  // Python 的 int(value)
  function pyInt(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw PyValueError("cannot convert float " + pyNumRepr(value) + " to integer");
      }
      return Math.trunc(value);
    }
    if (typeof value !== "string") {
      throw PyTypeError("int() argument must be a string or a number");
    }
    var s = pyStrip(value);
    var sign = 1;
    if (s.charAt(0) === "+") s = s.slice(1);
    else if (s.charAt(0) === "-") {
      sign = -1;
      s = s.slice(1);
    }
    if (s === "" || /^_|_$|__/.test(s)) {
      throw PyValueError("invalid literal for int() with base 10: " + pyStrRepr(value));
    }
    var body = s.replace(/_/g, "");
    if (!/^[0-9]+$/.test(body)) {
      throw PyValueError("invalid literal for int() with base 10: " + pyStrRepr(value));
    }
    return sign * Number(body);
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
      if (p.length > 1 && p.charAt(0) === "0") return false; // Python 3.9.5+ 拒绝前导零
      if (Number(p) > 255) return false;
    }
    return true;
  }

  // ipaddress.IPv6Address 的近似实现（支持内嵌 IPv4 与 %zone）。
  // 说明：这是本文件唯一没有逐位复刻的 Python 行为（ipaddress 的完整文法），
  // 只影响 href 里出现方括号 IPv6 字面量的输入。
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
          if (i !== groups.length - 1) return -1; // 内嵌 IPv4 只能是最后一段
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
    // 找 \u2100 这类在 NFKC 下会展开成 'a/c' 的字符
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

  function urlHostname(result) {
    var hostname = urlHostinfo(result.netloc === null ? "" : result.netloc)[0];
    if (!hostname) return null;
    var percent = hostname.indexOf("%");
    if (percent >= 0) {
      return pyLower(hostname.slice(0, percent)) + "%" + hostname.slice(percent + 1);
    }
    return pyLower(hostname);
  }

  // ================= Python 的排序语义（元组比较 + 稳定性） ==============

  function pyCodePointLess(a, b) {
    var i = 0;
    var j = 0;
    while (i < a.length && j < b.length) {
      var ca = a.codePointAt(i);
      var cb = b.codePointAt(j);
      if (ca !== cb) return ca < cb;
      i += ca > 0xffff ? 2 : 1;
      j += cb > 0xffff ? 2 : 1;
    }
    return a.length - i < b.length - j;
  }

  // Python 的 a < b（数字）；字符串按码点比较
  function pyLess(a, b) {
    if (typeof a === "number" && typeof b === "number") return a < b;
    return pyCodePointLess(String(a), String(b));
  }

  // Python 的 a == b（数字；NaN != NaN）
  function pyEq(a, b) {
    if (typeof a === "number" && typeof b === "number") return a === b;
    return String(a) === String(b);
  }

  // Python 的元组比较：找到第一个不相等的位置，再看是否小于
  function tupleLess(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      if (pyLess(a[i], b[i])) return true;
      if (!pyEq(a[i], b[i])) return false;
    }
    return a.length < b.length;
  }

  // ============ Python 的 list.sort(key=...) 等价实现 ============
  // 为什么不直接用 Array#sort：
  //   ① 比较语义要对齐 Python 的元组比较（第一个不相等的位置决定大小；
  //      长度不等时短的在前；NaN 参与时"既不小于也不等于任何值"）。
  //   ② V8 的 Array#sort 在比较器不是全序时（key 含 NaN）会因调用历史给出
  //      不同顺序，同一份输入都可能漂移；自己写稳定归并才有确定性。
  // 说明：key 全是"全序"时（真实 elements.json 都是），稳定排序的结果唯一，
  // 与 CPython 的 timsort 完全一致。只有 bbox 解析出 NaN（只能来自手写的
  // "nan" 字符串）时，CPython 的落点由 timsort 内部细节和浮点对象的身份
  // 决定，属于未定义行为，本实现只保证"元素集合一致、顺序确定"。
  function pySortByKey(items, keyFn) {
    var keys = [];
    for (var i = 0; i < items.length; i++) keys.push(keyFn(items[i]));
    var values = items.slice();
    if (values.length > 1) mergeSortStable(keys, values);
    return values;
  }

  // 稳定归并（对全序 key 与 Python 的 timsort 结果相同）
  function mergeSortStable(keys, values) {
    var n = keys.length;
    var bufKeys = new Array(n);
    var bufValues = new Array(n);
    for (var width = 1; width < n; width *= 2) {
      for (var lo = 0; lo < n; lo += 2 * width) {
        var mid = Math.min(lo + width, n);
        var hi = Math.min(lo + 2 * width, n);
        var i = lo;
        var j = mid;
        var k = lo;
        while (i < mid && j < hi) {
          if (tupleLess(keys[j], keys[i])) {
            bufKeys[k] = keys[j];
            bufValues[k] = values[j];
            j++;
          } else {
            bufKeys[k] = keys[i];
            bufValues[k] = values[i];
            i++;
          }
          k++;
        }
        while (i < mid) {
          bufKeys[k] = keys[i];
          bufValues[k] = values[i];
          i++;
          k++;
        }
        while (j < hi) {
          bufKeys[k] = keys[j];
          bufValues[k] = values[j];
          j++;
          k++;
        }
      }
      for (var t = 0; t < n; t++) {
        keys[t] = bufKeys[t];
        values[t] = bufValues[t];
      }
    }
  }

  // ======================================================================
  // 二、digest.py 的移植
  // ======================================================================

  var TYPE_NAMES = new Map([
    ["link", "链接"],
    ["button", "按钮"],
    ["input", "输入框"],
    ["textarea", "多行输入"],
    ["select", "下拉框"],
    ["radio", "单选"],
    ["checkbox", "多选"],
    ["form", "表单"],
    ["heading", "标题"],
    ["text", "文字"],
    ["table", "表格"],
    ["image", "图片"],
    ["nav", "导航"]
  ]);

  var GROUP_KIND_NAMES = new Map([
    ["form", "表单"],
    ["nav", "导航"],
    ["header", "页头区块"],
    ["footer", "页脚区块（通常是噪声）"],
    ["table", "表格"],
    ["list", "列表"],
    ["group", "区块"]
  ]);

  // 中文之间被排版插进去的空格（「登 录」），只在标题里还原。
  // Python: r"(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])"，无 IGNORECASE。
  var CJK_SPACE = /(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff])/g;

  var LABEL_FIRST_KINDS = new Set(["input", "textarea", "select", "radio", "checkbox"]);
  var CONTAINER_KINDS = new Set(["nav"]);
  var FOOTER_MARKERS = ["版权", "©", "ICP", "备案", "公安", "友情链接", "网站地图", "无障碍", "手机版"];

  var TEXT_FIELDS_DEFAULT = ["text", "label", "aria_label", "placeholder", "value"];
  var TEXT_FIELDS_CONTROL = ["label", "aria_label", "placeholder", "text", "value"];

  var MAX_TEXT_CHARS = 60;
  var MAX_PATH_CHARS = 40;
  var DEFAULT_MAX_ROWS = 160;

  var ELLIPSIS = "\u2026";

  function isMapping(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  // def _clean(value): return " ".join(str(value if value is not None else "").split()).strip()
  function clean(value) {
    var s = value === null || value === undefined ? "" : pyStr(value);
    return pySplitWs(s).join(" ");
  }

  function textOf(element) {
    var kind = clean(element.type);
    var order = LABEL_FIRST_KINDS.has(kind) ? TEXT_FIELDS_CONTROL : TEXT_FIELDS_DEFAULT;
    for (var i = 0; i < order.length; i++) {
      var raw = clean(element[order[i]]);
      if (raw) return [order[i], raw];
    }
    return ["", ""];
  }

  function shortPath(href) {
    var raw = clean(href);
    if (!raw) return "";
    var prefixes = ["javascript:", "tel:", "mailto:", "#"];
    for (var i = 0; i < prefixes.length; i++) {
      if (raw.slice(0, prefixes[i].length) === prefixes[i]) return "";
    }
    var parts;
    try {
      parts = pyUrlSplit(raw);
    } catch (e) {
      if (isPyError(e)) return "";
      throw e;
    }
    var path = pyTruthy(parts.path) ? parts.path : "/";
    if (pyLen(path) > MAX_PATH_CHARS) path = pySlice(path, 0, MAX_PATH_CHARS - 1) + ELLIPSIS;
    return path;
  }

  function optionsOf(element) {
    var options = element.options;
    if (!Array.isArray(options)) return "";
    var labels = [];
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var label = isMapping(option)
        ? clean(pyTruthy(option.label) ? option.label : option.value)
        : clean(option);
      if (label) labels.push(label);
    }
    if (!labels.length) return "";
    var joined = labels.join("/");
    if (pyLen(joined) > MAX_TEXT_CHARS) joined = pySlice(joined, 0, MAX_TEXT_CHARS - 1) + ELLIPSIS;
    return joined;
  }

  function bboxOf(element) {
    var bbox = element.bbox;
    if (isMapping(bbox)) {
      try {
        var y = pyFloat(pyTruthy(bbox.y) ? bbox.y : 0.0);
        var h = pyFloat(pyTruthy(bbox.height) ? bbox.height : 0.0);
        return [y, y + h];
      } catch (e) {
        if (isPyError(e)) return [0.0, 0.0];
        throw e;
      }
    }
    return [0.0, 0.0];
  }

  function yTop(element) {
    return bboxOf(element)[0];
  }

  function yBottom(element) {
    return bboxOf(element)[1];
  }

  function looksLikeFooter(element) {
    var parts = [];
    for (var i = 0; i < TEXT_FIELDS_DEFAULT.length; i++) {
      parts.push(clean(element[TEXT_FIELDS_DEFAULT[i]]));
    }
    var text = parts.join(" ");
    for (var j = 0; j < FOOTER_MARKERS.length; j++) {
      if (text.indexOf(FOOTER_MARKERS[j]) >= 0) return true;
    }
    return false;
  }

  function orderOf(element) {
    // 对齐 digest.py 的 _order_of()：畸形 order 不该让整页炸掉，解析失败按 0
    try {
      return pyInt(element.order === undefined ? null : element.order);
    } catch (e) {
      if (isPyError(e)) return 0;
      throw e;
    }
  }

  function row(element) {
    var eid = clean(element.id) || "?";
    var kindRaw = clean(element.type);
    var kind = TYPE_NAMES.has(kindRaw) ? TYPE_NAMES.get(kindRaw) : (kindRaw || "元素");
    var found = textOf(element);
    var field = found[0];
    var text = found[1];

    var body;
    if (field && text) {
      if (pyLen(text) > MAX_TEXT_CHARS) text = pySlice(text, 0, MAX_TEXT_CHARS - 1) + ELLIPSIS;
      body = field + "=" + text;
    } else {
      body = "(无文字)";
    }

    var extras = [];
    if (LABEL_FIRST_KINDS.has(kindRaw) && field !== "placeholder") {
      var hint = clean(element.placeholder);
      if (hint && hint !== text) {
        if (pyLen(hint) > MAX_TEXT_CHARS) hint = pySlice(hint, 0, MAX_TEXT_CHARS - 1) + ELLIPSIS;
        extras.push("提示：" + hint);
      }
    }
    if (element.required === true) extras.push("必填");
    if (element.disabled === true) extras.push("禁用");
    if (element.visible === false) extras.push("隐藏");
    var options = optionsOf(element);
    if (options) extras.push("选项：" + options);
    var path = shortPath(element.href);
    if (path) extras.push("\u2192 " + path);

    var tail = extras.length ? "  " + extras.join(" ") : "";
    return "[" + eid + "] " + kind + " " + body + tail;
  }

  function importance(element) {
    var kind = clean(element.type);
    if (kind === "form") return 0;
    if (kind === "input" || kind === "textarea" || kind === "select" ||
        kind === "radio" || kind === "checkbox") return 1;
    if (kind === "button") return 2;
    if (kind === "link") return 3;
    if (kind === "heading") return 4;
    if (kind === "table" || kind === "image") return 6;
    return 5;
  }

  function containerElementId(group) {
    var gid = clean(group.id);
    if (gid.indexOf("_") < 0) return "";
    return "el_" + gid.slice(gid.lastIndexOf("_") + 1);
  }

  function claimedTexts(members) {
    var exact = new Set();
    var prefixes = [];
    for (var i = 0; i < members.length; i++) {
      var element = members[i];
      var kind = clean(element.type);
      if (LABEL_FIRST_KINDS.has(kind)) {
        var fields = ["label", "placeholder"];
        for (var f = 0; f < fields.length; f++) {
          var value = clean(element[fields[f]]);
          if (value) exact.add(value);
        }
        var options = element.options;
        if (Array.isArray(options)) {
          for (var o = 0; o < options.length; o++) {
            var option = options[o];
            var label = isMapping(option) ? option.label : option;
            var text = clean(label);
            if (text) exact.add(text);
          }
        }
      } else if (kind === "link" || kind === "button") {
        var v = clean(element.text);
        if (v) {
          exact.add(v);
          if (pyLen(v) >= 6) prefixes.push(v);
        }
      }
    }
    return [exact, prefixes];
  }

  function dedupeSection(members) {
    var claimed = claimedTexts(members);
    var exact = claimed[0];
    var prefixes = claimed[1];
    if (exact.size === 0 && prefixes.length === 0) return members;

    function duplicated(value) {
      if (!value) return false;
      if (exact.has(value)) return true;
      for (var i = 0; i < prefixes.length; i++) {
        if (value.slice(0, prefixes[i].length) === prefixes[i]) return true;
      }
      return false;
    }

    var out = [];
    for (var j = 0; j < members.length; j++) {
      var element = members[j];
      if (!(clean(element.type) === "text" && duplicated(clean(element.text)))) out.push(element);
    }
    return out;
  }

  function tidyLabel(value) {
    return pyStrip(value.replace(CJK_SPACE, ""));
  }

  function groupTitle(group, members, container) {
    var gtype = clean(group.type) || "group";
    var base = GROUP_KIND_NAMES.has(gtype) ? GROUP_KIND_NAMES.get(gtype) : gtype;
    var label = tidyLabel(clean(group.label));

    if (!label && container !== null && container !== undefined) {
      var candidate = tidyLabel(clean(container.text));
      if (candidate && pyLen(candidate) <= 10) label = candidate;
    }

    if (!label) {
      for (var i = 0; i < members.length; i++) {
        if (LABEL_FIRST_KINDS.has(clean(members[i].type))) {
          var c1 = tidyLabel(clean(members[i].label));
          if (c1) {
            label = pySlice(c1, 0, 16);
            break;
          }
        }
      }
    }

    if (!label) {
      for (var j = 0; j < members.length; j++) {
        if (clean(members[j].type) === "form") {
          label = pySlice(tidyLabel(clean(members[j].text)), 0, 16);
          if (label) break;
        }
      }
    }

    if (label) {
      var sep = base.slice(-1) === "\uff1a" ? "" : "\uff1a";
      return base + sep + label;
    }
    return base;
  }

  function mergeSections(sections) {
    var merged = new Map();
    var order = [];
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      var key = section.title;
      if (merged.has(key)) {
        var existing = merged.get(key);
        existing.elements = existing.elements.concat(section.elements);
      } else {
        var copy = {};
        var names = Object.keys(section);
        for (var k = 0; k < names.length; k++) copy[names[k]] = section[names[k]];
        copy.elements = section.elements.slice();
        merged.set(key, copy);
        order.push(key);
      }
    }
    var result = [];
    for (var o = 0; o < order.length; o++) {
      var item = merged.get(order[o]);
      item.elements = pySortByKey(item.elements, function (e) {
        return [yTop(e), orderOf(e)];
      });
      result.push(item);
    }
    return result;
  }

  function pyMax(values, dflt) {
    if (!values.length) return dflt;
    var best = values[0];
    for (var i = 1; i < values.length; i++) {
      if (values[i] > best) best = values[i];
    }
    return best;
  }

  function pyMin(values, dflt) {
    if (!values.length) return dflt;
    var best = values[0];
    for (var i = 1; i < values.length; i++) {
      if (values[i] < best) best = values[i];
    }
    return best;
  }

  function applyBudget(sections, maxRows) {
    var total = 0;
    for (var i = 0; i < sections.length; i++) total += sections[i].elements.length;
    if (total <= maxRows) return [sections, 0];

    var scored = [];
    for (var s = 0; s < sections.length; s++) {
      var section = sections[s];
      var penalty = section.kind === "band_\u5c3e" ? 10 : 0;
      for (var e = 0; e < section.elements.length; e++) {
        var element = section.elements[e];
        scored.push([importance(element) + penalty, yTop(element), element]);
      }
    }
    scored = pySortByKey(scored, function (item) { return [item[0], item[1]]; });

    // Python: scored[:max_rows]（负数下标从尾部数）
    var take = maxRows < 0 ? Math.max(0, scored.length + maxRows) : Math.min(maxRows, scored.length);
    var keep = new Set();
    for (var k = 0; k < take; k++) keep.add(scored[k][2]);
    var dropped = total - keep.size;

    var trimmed = [];
    for (var t = 0; t < sections.length; t++) {
      var sec = sections[t];
      var members = [];
      for (var m = 0; m < sec.elements.length; m++) {
        if (keep.has(sec.elements[m])) members.push(sec.elements[m]);
      }
      if (members.length) {
        var copy = {};
        var names = Object.keys(sec);
        for (var n = 0; n < names.length; n++) copy[names[n]] = sec[names[n]];
        copy.elements = members;
        trimmed.push(copy);
      }
    }
    return [trimmed, dropped];
  }

  function buildSections(data, options) {
    var maxRows = options && options.maxRows !== undefined ? options.maxRows : DEFAULT_MAX_ROWS;

    var allElements = [];
    var rawElements = pyIterateOrEmpty(data.elements);
    for (var i = 0; i < rawElements.length; i++) {
      if (isMapping(rawElements[i])) allElements.push(rawElements[i]);
    }
    var groups = [];
    var rawGroups = pyIterateOrEmpty(data.groups);
    for (var g = 0; g < rawGroups.length; g++) {
      if (isMapping(rawGroups[g])) groups.push(rawGroups[g]);
    }

    var byId = new Map();
    for (var b = 0; b < allElements.length; b++) {
      var key0 = clean(allElements[b].id);
      if (key0) byId.set(key0, allElements[b]);
    }

    var pageBottom = pyMax(allElements.map(yBottom), 0.0);
    pageBottom = pyTruthy(pageBottom) ? pageBottom : 1.0;

    var inGroup = new Map();
    for (var gi = 0; gi < groups.length; gi++) {
      var groupIds0 = pyIterateOrEmpty(groups[gi].element_ids);
      for (var ii = 0; ii < groupIds0.length; ii++) {
        var k0 = clean(groupIds0[ii]);
        if (k0 && byId.has(k0)) inGroup.set(k0, groups[gi]);
      }
    }

    var sections = [];
    var consumed = new Set();

    for (var index = 0; index < groups.length; index++) {
      var group = groups[index];
      var gtype = clean(group.type) || "group";
      var groupIds = pyIterateOrEmpty(group.element_ids);

      // 表格分组不单独成区：整表已在表格元素的 text 里
      if (gtype === "table") {
        for (var t = 0; t < groupIds.length; t++) {
          var tk = clean(groupIds[t]);
          if (tk) consumed.add(tk);
        }
        continue;
      }

      var members = [];
      for (var mi = 0; mi < groupIds.length; mi++) {
        var mk = clean(groupIds[mi]);
        if (byId.has(mk)) members.push(byId.get(mk));
      }
      if (!members.length) continue;
      members = dedupeSection(members);
      members = pySortByKey(members, function (e) {
        return [yTop(e), orderOf(e)];
      });
      for (var c = 0; c < members.length; c++) consumed.add(clean(members[c].id));
      // 容器元素（表单/导航本身）与它的分组是同一件事：既用它取名，也不重复显示
      var containerId = containerElementId(group);
      var container = containerId && byId.has(containerId) ? byId.get(containerId) : null;
      if (containerId) consumed.add(containerId);

      sections.push({
        title: groupTitle(group, members, container),
        kind: gtype,
        elements: members,
        y: pyMin(members.map(yTop), pageBottom),
        seq: index
      });
    }

    // 没有进入任何分组的元素，按可见位置分带
    var loose = [];
    for (var li = 0; li < allElements.length; li++) {
      var le = allElements[li];
      var lid = clean(le.id);
      if (inGroup.has(lid)) continue;
      if (consumed.has(lid)) continue;
      if (CONTAINER_KINDS.has(clean(le.type))) continue;
      loose.push(le);
    }

    var BAND_HEAD = "\u5934";
    var BAND_BODY = "\u4e3b\u4f53";
    var BAND_TAIL = "\u5c3e";
    var bands = {};
    bands[BAND_HEAD] = [];
    bands[BAND_BODY] = [];
    bands[BAND_TAIL] = [];
    for (var bi = 0; bi < loose.length; bi++) {
      var element = loose[bi];
      if (looksLikeFooter(element) || yTop(element) >= pageBottom * 0.85) {
        bands[BAND_TAIL].push(element);
      } else if (yTop(element) < pageBottom * 0.10) {
        bands[BAND_HEAD].push(element);
      } else {
        bands[BAND_BODY].push(element);
      }
    }

    var bandTitles = {};
    bandTitles[BAND_HEAD] = "页面顶部（站点标识、快捷入口）";
    bandTitles[BAND_BODY] = "主体内容";
    bandTitles[BAND_TAIL] = "页面底部（页脚 / 版权，通常是噪声）";
    var bandY = {};
    bandY[BAND_HEAD] = 0.0;
    bandY[BAND_BODY] = pageBottom * 0.20;
    bandY[BAND_TAIL] = pageBottom * 0.90;

    var bandOrder = [BAND_HEAD, BAND_BODY, BAND_TAIL];
    for (var bn = 0; bn < bandOrder.length; bn++) {
      var band = bandOrder[bn];
      var bandMembers = bands[band];
      if (!bandMembers.length) continue;
      bandMembers = dedupeSection(bandMembers);
      if (!bandMembers.length) continue;
      bandMembers = pySortByKey(bandMembers, function (e) {
        return [yTop(e), orderOf(e)];
      });
      sections.push({
        title: bandTitles[band],
        kind: "band_" + band,
        elements: bandMembers,
        y: bandY[band],
        seq: 900
      });
    }

    sections = pySortByKey(sections, function (s) {
      return [s.y, s.seq];
    });
    return applyBudget(mergeSections(sections), maxRows);
  }

  function siteOf(data) {
    var keys = ["page_url", "final_url"];
    for (var i = 0; i < keys.length; i++) {
      var raw = clean(data[keys[i]]);
      if (!raw) continue;
      var parts;
      try {
        parts = pyUrlSplit(raw);
      } catch (e) {
        if (isPyError(e)) continue;
        throw e;
      }
      var host = urlHostname(parts);
      if (host) return host;
      if (parts.scheme && parts.scheme !== "http" && parts.scheme !== "https") {
        return parts.scheme + "://" + (pyTruthy(parts.netloc) ? parts.netloc : parts.path);
      }
    }
    return "(未知)";
  }

  // 把 elements.json（对象或 JSON 文本）渲染成页面说明书
  function build(data, options) {
    if (typeof data === "string") data = JSON.parse(data);
    var result = buildSections(data, options);
    var sections = result[0];
    var dropped = result[1];

    var title = clean(data.page_title) || "(无标题)";
    var source = clean(data.source) || "unknown";
    var stats = isMapping(data.stats) ? data.stats : {};
    var total = pyTruthy(stats.total) ? stats.total : pyLenOrEmpty(data.elements);
    var visible = stats.visible;

    var head = [
      "站点：" + siteOf(data),
      "页面：" + title,
      "来源：" + source + "｜采集元素 " + total + " 个" +
        (visible !== null && visible !== undefined ? "，其中可见 " + visible + " 个" : "")
    ];
    if (clean(data.fallback_reason)) head.push("降级原因：" + clean(data.fallback_reason));
    head = head.concat([
      "",
      "下面是这张页面按可见位置切成的区块。每行格式：[元素ID] 类型 字段=原文。",
      "引用证据时请使用元素ID和字段名；原文若被截断，绑定时会自动补全。",
      "链接后的 \u2192 只是路径提示，不要写进给老人看的文案。"
    ]);

    var lines = head.slice();
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i];
      lines.push("");
      lines.push("\u2501\u2501 " + section.title + "（" + section.elements.length + " 项）\u2501\u2501");
      for (var e = 0; e < section.elements.length; e++) {
        lines.push(row(section.elements[e]));
      }
    }

    if (dropped) {
      lines.push("");
      lines.push("（为控制长度省略了 " + dropped + " 项次要元素，多为重复文字或页脚）");
    }

    return lines.join("\n");
  }

  globalThis.EasyViewDigest = {
    build: build,
    // 调试用：与 Python 的 build_sections() 对应，返回 [分区, 丢弃数]
    buildSections: buildSections,
    // 常量，便于调用方与测试对齐
    TYPE_NAMES: TYPE_NAMES,
    GROUP_KIND_NAMES: GROUP_KIND_NAMES,
    MAX_TEXT_CHARS: MAX_TEXT_CHARS,
    MAX_PATH_CHARS: MAX_PATH_CHARS,
    DEFAULT_MAX_ROWS: DEFAULT_MAX_ROWS
  };
})();
