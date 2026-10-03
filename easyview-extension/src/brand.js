/* EasyView 品牌令牌：从任意网页提取主色、文字色、字体、圆角与 Logo，
 * 供所有站点复用。专用站点覆盖层和通用覆盖层都调用同一套接口。
 *
 * 接口（挂在 globalThis.EasyViewBrand）：
 *   extract(options)            -> theme      读当前页面，产出可用的令牌
 *   apply(theme, target)        -> void       把令牌写成 CSS 变量（ShadowRoot 或元素）
 *   logoElement(theme)          -> img | null
 *   mountLogo(container, theme) -> node       把 Logo 或文字标识放进容器
 *
 * 只读取样式，不改动原页面，也不读取用户填写的内容。
 * 提取不到的字段一律回退到 options.fallback，再回退到内置中性值，
 * 因此任何站点、任何情况下都能得到一套可渲染的令牌。
 */
(function () {
  "use strict";

  var MAX_SAMPLES = 320;
  var LOGO_HINT = /logo|brand|branding|标识|标志/i;
  /* 加载图、占位图、1x1 像素常混在页头里，看着像 Logo 其实不是。 */
  var NOT_A_LOGO = /(?:^|[/_.-])(?:loading|loader|spinner|placeholder|pixel|blank|empty|transparent|ajax|throbber|1x1)(?:$|[/_.-])/i;

  /* 站点常把品牌色放在这些自定义属性里，命中时优先采用。 */
  var CSS_VARIABLE_NAMES = [
    "--primary", "--primary-color", "--color-primary", "--color-primary-500",
    "--brand", "--brand-color", "--brand-primary", "--main-color", "--main",
    "--theme-color", "--theme-primary", "--accent-color", "--link-color",
    "--primaryColor", "--brandColor", "--mainColor"
  ];

  /* 变量名带这些词才当品牌色候选。哔哩哔哩用的是 --brand_blue / --brand_pink，
     固定名单列不全，所以额外按名字扫一遍。 */
  var CSS_VARIABLE_HINT = /brand|primary|theme|main|accent/i;

  /* 浏览器给未访问/已访问链接的默认色。页面上几十个没设颜色的 <a> 会带出
     一大片 #0000ee，按权重累加能盖过真正的品牌变量 —— 必须排除。 */
  var UA_DEFAULT_COLORS = { "#0000ee": true, "#0000ff": true, "#551a8b": true };

  /* ---------- 颜色基础运算 ---------- */

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function clamp255(value) {
    return clamp(Math.round(value), 0, 255);
  }

  function parseColor(value) {
    if (typeof value !== "string") return null;
    var text = value.trim().toLowerCase();
    if (!text || text === "transparent" || text === "inherit" ||
        text === "currentcolor" || text === "initial" || text === "unset") {
      return null;
    }

    var rgb = text.match(/^rgba?\(([^)]+)\)$/);
    if (rgb) {
      var parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      var channel = function (raw) {
        var number = parseFloat(raw);
        if (!isFinite(number)) return NaN;
        return raw.indexOf("%") >= 0 ? (number / 100) * 255 : number;
      };
      var r = channel(parts[0]);
      var g = channel(parts[1]);
      var b = channel(parts[2]);
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return null;
      var alpha = 1;
      if (parts.length > 3) {
        var rawAlpha = parts[3];
        var parsedAlpha = parseFloat(rawAlpha);
        alpha = rawAlpha.indexOf("%") >= 0 ? parsedAlpha / 100 : parsedAlpha;
      }
      return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: isFinite(alpha) ? clamp(alpha, 0, 1) : 1 };
    }

    var hex = text.match(/^#([0-9a-f]{3,8})$/);
    if (hex) {
      var digits = hex[1];
      if (digits.length === 3 || digits.length === 4) {
        return {
          r: parseInt(digits[0] + digits[0], 16),
          g: parseInt(digits[1] + digits[1], 16),
          b: parseInt(digits[2] + digits[2], 16),
          a: digits.length === 4 ? parseInt(digits[3] + digits[3], 16) / 255 : 1
        };
      }
      if (digits.length === 6 || digits.length === 8) {
        return {
          r: parseInt(digits.slice(0, 2), 16),
          g: parseInt(digits.slice(2, 4), 16),
          b: parseInt(digits.slice(4, 6), 16),
          a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1
        };
      }
    }
    return null;
  }

  function toHex(color) {
    if (!color) return null;
    var hex = function (value) {
      return clamp255(value).toString(16).padStart(2, "0");
    };
    return "#" + hex(color.r) + hex(color.g) + hex(color.b);
  }

  function isOpaque(color) {
    return Boolean(color) && color.a >= 0.5;
  }

  function luminance(color) {
    var channel = function (value) {
      var v = value / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    var light = Math.max(la, lb);
    var dark = Math.min(la, lb);
    return (light + 0.05) / (dark + 0.05);
  }

  function rgbToHsl(color) {
    var r = color.r / 255;
    var g = color.g / 255;
    var b = color.b / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var d = max - min;
    var h = 0;
    var s = 0;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  function hslToRgb(hsl) {
    var h = ((hsl.h % 360) + 360) % 360;
    var s = clamp(hsl.s, 0, 1);
    var l = clamp(hsl.l, 0, 1);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var rgb = [0, 0, 0];
    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    var m = l - c / 2;
    return { r: clamp255((rgb[0] + m) * 255), g: clamp255((rgb[1] + m) * 255), b: clamp255((rgb[2] + m) * 255), a: 1 };
  }

  function withLightness(color, lightness) {
    return hslToRgb(Object.assign(rgbToHsl(color), { l: clamp(lightness, 0, 1) }));
  }

  function withSaturation(color, saturation) {
    return hslToRgb(Object.assign(rgbToHsl(color), { s: clamp(saturation, 0, 1) }));
  }

  /** t = 0 返回 a，t = 1 返回 b。 */
  function mix(a, b, t) {
    var amount = clamp(t, 0, 1);
    return {
      r: clamp255(a.r + (b.r - a.r) * amount),
      g: clamp255(a.g + (b.g - a.g) * amount),
      b: clamp255(a.b + (b.b - a.b) * amount),
      a: 1
    };
  }

  /** 在保持色相的前提下调整明度，直到与背景的对比度达标。 */
  function ensureContrast(foreground, background, minimum) {
    if (contrast(foreground, background) >= minimum) return foreground;
    var hsl = rgbToHsl(foreground);
    var goDark = luminance(background) > 0.35;
    var best = foreground;
    for (var step = 1; step <= 25; step += 1) {
      var lightness = goDark ? hsl.l - step * 0.03 : hsl.l + step * 0.03;
      if (lightness < 0 || lightness > 1) break;
      var candidate = hslToRgb(Object.assign({}, hsl, { l: lightness }));
      best = candidate;
      if (contrast(candidate, background) >= minimum) return candidate;
    }
    return goDark ? { r: 8, g: 12, b: 16, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
  }

  var WHITE = { r: 255, g: 255, b: 255, a: 1 };
  var BLACK = { r: 17, g: 20, b: 24, a: 1 };

  /* ---------- 页面采样 ---------- */

  function styleOf(node) {
    try {
      return getComputedStyle(node);
    } catch (_) {
      return null;
    }
  }

  function isRendered(node, style) {
    if (!node || !node.isConnected || !style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (Number(style.opacity) === 0) return false;
    var rect = node.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  }

  function readCssVariables() {
    var found = [];
    var root = document.documentElement;
    if (!root) return found;
    var style = styleOf(root);
    if (!style) return found;
    var push = function (raw) {
      var color = parseColor(raw);
      if (isOpaque(color)) found.push(color);
    };
    // Chrome 的 computedStyle 能枚举出自定义属性，按名字模糊匹配，
    // 这样 --brand_blue 这类叫法也能抓到，不必维护完整名单。
    for (var i = 0; i < style.length; i += 1) {
      var name = style[i];
      if (!name || name.indexOf("--") !== 0 || !CSS_VARIABLE_HINT.test(name)) continue;
      push(style.getPropertyValue(name));
    }
    for (var j = 0; j < CSS_VARIABLE_NAMES.length; j += 1) push(style.getPropertyValue(CSS_VARIABLE_NAMES[j]));
    return found;
  }

  function queryNodes(selector, limit) {
    var nodes = [];
    try {
      nodes = document.querySelectorAll(selector);
    } catch (_) {
      return [];
    }
    return Array.prototype.slice.call(nodes, 0, limit || 60);
  }

  function collectSamples() {
    var samples = [];
    var seen = new Set();
    var add = function (node, weight) {
      if (!node || seen.has(node) || samples.length >= MAX_SAMPLES) return;
      seen.add(node);
      var style = styleOf(node);
      if (!isRendered(node, style)) return;
      var background = parseColor(style.backgroundColor);
      if (isOpaque(background)) samples.push({ color: background, weight: weight });
      var foreground = parseColor(style.color);
      if (isOpaque(foreground)) samples.push({ color: foreground, weight: weight * 0.45 });
    };

    var variables = readCssVariables();
    for (var i = 0; i < variables.length; i += 1) samples.push({ color: variables[i], weight: 26 });

    var headerSelectors = "header, [role='banner'], #header, .header, .site-header, .navbar, .top-bar, .masthead";
    queryNodes(headerSelectors, 8).forEach(function (node) { add(node, 12); });
    queryNodes("nav, [role='navigation']", 6).forEach(function (node) { add(node, 9); });
    queryNodes("button, [role='button'], .btn, [class*='btn-'], [class*='button'], input[type='submit'], input[type='button']", 45)
      .forEach(function (node) { add(node, 18); });
    // 链接数量多、单个信号弱：权重给低一点，别让几十个默认色盖过品牌变量。
    queryNodes("a", 30).forEach(function (node) { add(node, 3); });
    return samples;
  }

  function isBrandLike(color) {
    if (UA_DEFAULT_COLORS[toHex(color)]) return false;
    var hsl = rgbToHsl(color);
    if (hsl.s < 0.22) return false;
    if (hsl.l < 0.10 || hsl.l > 0.82) return false;
    return true;
  }

  function bucketKey(color) {
    return (color.r >> 4) + "-" + (color.g >> 4) + "-" + (color.b >> 4);
  }

  /**
   * 把近似颜色合并成一个桶，桶内保留权重最高的那个真实颜色。
   *
   * 排序不只看累加权重，还看这个颜色在多少个元素上重复出现：品牌色通常
   * 铺在页头、导航、多个按钮上；而页面里一个孤零零的促销按钮（橙/红）
   * 权重再高，也不该盖过真正贯穿全站的主色。12306 就是这种情况 ——
   * 单个 .btn 的橙色 18 分，蓝色分散在 6 个元素上 17.4 分。
   */
  function rankColors(samples, filter) {
    var buckets = new Map();
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
      if (filter && !filter(sample.color)) continue;
      var key = bucketKey(sample.color);
      var entry = buckets.get(key);
      if (!entry) buckets.set(key, { color: sample.color, weight: sample.weight, best: sample.weight, count: 1 });
      else {
        entry.weight += sample.weight;
        entry.count += 1;
        if (sample.weight > entry.best) {
          entry.best = sample.weight;
          entry.color = sample.color;
        }
      }
    }
    var score = function (entry) {
      return entry.weight * (1 + Math.min(entry.count, 8) * 0.05);
    };
    return Array.from(buckets.values()).sort(function (a, b) { return score(b) - score(a); });
  }

  /* ---------- Logo ---------- */

  function absolutize(raw) {
    if (!raw) return null;
    var value = String(raw).trim();
    if (!value || value === "none" || value.indexOf("data:") === 0) return value || null;
    try {
      return new URL(value, document.baseURI || location.href).href;
    } catch (_) {
      return null;
    }
  }

  function imageUrlFromBackground(value) {
    if (!value || value === "none") return null;
    var pattern = /url\((['"]?)([^'")]+)\1\)/g;
    var matches = [];
    var match;
    while ((match = pattern.exec(value)) !== null) matches.push(match[2]);
    if (!matches.length) return null;
    // image-set(...) 里靠后的通常是 2x 高清图，优先用它。
    return absolutize(matches[matches.length - 1]);
  }

  function findLogo() {
    var candidates = [];
    var push = function (url, score) {
      if (!url) return;
      if (url.indexOf("data:") === 0 && !/^data:image\//i.test(url)) return;
      if (NOT_A_LOGO.test(url)) return;
      candidates.push({ url: url, score: score });
    };

    var images = queryNodes(
      "header img, nav img, [role='banner'] img, [class*='logo'] img, [id*='logo'] img, " +
      "img[class*='logo'], img[id*='logo'], img[alt*='logo' i], img[alt*='标志'], img[alt*='品牌']",
      60
    );
    if (!images.length) images = queryNodes("img", 200);

    images.forEach(function (img, index) {
      if (!img.isConnected) return;
      var style = styleOf(img);
      if (style && (style.display === "none" || style.visibility === "hidden")) return;
      var rect = img.getBoundingClientRect();
      var width = rect.width || img.naturalWidth || img.width || 0;
      var height = rect.height || img.naturalHeight || img.height || 0;
      if (width < 20 || height < 12) return;
      var signature = [img.className, img.id, img.alt, img.getAttribute("src")].join(" ");
      // 没有 logo/brand 线索的图片一律不当 Logo —— 页头里的大图通常是广告横幅。
      if (!LOGO_HINT.test(signature)) return;
      var score = 60;
      if (rect.top < Math.max(260, (window.innerHeight || 800) * 0.3)) score += 20;
      if (width >= 60 && width <= 420 && height >= 20 && height <= 140) score += 20;
      score += Math.min(18, width / 20) - index * 0.1;
      push(img.currentSrc || img.src, score);
    });

    var backgroundNodes = queryNodes(
      "[class*='logo'], [id*='logo'], [class*='brand'], [id*='brand'], " +
      "[class*='logo'] a, [id*='logo'] a, [class*='brand'] a, [id*='brand'] a, " +
      "header a, header i, header span, h1 a, [class*='header'] a",
      90
    );
    backgroundNodes.forEach(function (node) {
      var style = styleOf(node);
      if (!isRendered(node, style)) return;
      var url = imageUrlFromBackground(style.backgroundImage);
      if (!url) return;
      var rect = node.getBoundingClientRect();
      var own = (node.className || "") + " " + (node.id || "");
      var parent = node.parentElement ? (node.parentElement.className || "") + " " + (node.parentElement.id || "") : "";
      var hinted = LOGO_HINT.test(own + " " + parent);
      var inHeader = !hinted && Boolean(node.closest("header, [role='banner'], [class*='header'], [class*='top-']"));
      // 只认“页面自己标了 logo/brand 的背景图”，或页头里的链接/图标。
      if (!hinted && !(inHeader && (node.tagName === "A" || node.tagName === "I"))) return;
      if (rect.width < (hinted ? 30 : 44) || rect.height < 16) return;
      // 页面自己在 “logo” 容器里画的背景图，就是最可靠的 Logo 信号。
      push(url, (hinted ? 80 : 55) + Math.min(15, rect.width / 20));
    });

    // 兜底：apple-touch-icon 通常是 180px 见方的清晰图标；og:image 多是宣传图，不作数。
    var touchIcon = document.querySelector("link[rel='apple-touch-icon'], link[rel='apple-touch-icon-precomposed']");
    if (touchIcon && touchIcon.href) push(touchIcon.href, 30);

    candidates.sort(function (a, b) { return b.score - a.score; });
    var seen = new Set();
    for (var i = 0; i < candidates.length; i += 1) {
      if (seen.has(candidates[i].url)) continue;
      return candidates[i].url;
    }
    return null;
  }

  function siteName() {
    var meta = document.querySelector("meta[property='og:site_name'], meta[name='application-name']");
    var raw = (meta && (meta.content || meta.getAttribute("content"))) || document.title || "";
    return String(raw).replace(/\s+/g, " ").trim().slice(0, 40);
  }

  function fallbackLogoText(name, brand) {
    if (name) {
      var cleaned = name
        .replace(/[（(][^）)]*[）)]/g, "")
        .replace(/(网站|官网|首页|官方|门户|平台)$/g, "")
        .replace(/[-_|·—].*$/, "")
        .trim();
      if (cleaned) return truncateName(cleaned, 8);
    }
    if (location && location.hostname) {
      var host = location.hostname.replace(/^www\./, "");
      var label = host.split(".")[0];
      if (label) return label.slice(0, 8);
    }
    return brand || "敬老版";
  }

  /** 截断站点名，但不把一个数字串（比如 12306）从中间切开。 */
  function truncateName(text, limit) {
    if (text.length <= limit) return text;
    var cut = text.slice(0, limit);
    var rest = text.slice(limit);
    if (/\d$/.test(cut) && /^\d/.test(rest)) {
      var run = rest.match(/^\d+/);
      if (run) cut += run[0];
    }
    return cut;
  }

  /* ---------- 字体与圆角 ---------- */

  function fontFamily() {
    var style = styleOf(document.body || document.documentElement);
    var raw = style && style.fontFamily;
    if (!raw) return null;
    var families = raw.split(",").map(function (part) { return part.trim(); }).filter(Boolean);
    // 原站字体未必带中文字形，末尾补一层中文字体兜底，缺字时才有机会命中。
    return families.slice(0, 3).join(", ") + ", \"Microsoft YaHei\", \"Noto Sans CJK SC\", sans-serif";
  }

  function radius() {
    var nodes = queryNodes("button, .btn, [class*='card'], input[type='submit'], a[class*='btn']", 40);
    for (var i = 0; i < nodes.length; i += 1) {
      var style = styleOf(nodes[i]);
      if (!isRendered(nodes[i], style)) continue;
      var match = String(style.borderRadius || "").match(/^([\d.]+)px/);
      if (!match) continue;
      var value = parseFloat(match[1]);
      if (value >= 2) return clamp(Math.round(value), 4, 20);
    }
    return null;
  }

  /* ---------- 对外接口 ---------- */

  var DEFAULT_THEME = Object.freeze({
    name: "",
    logoUrl: null,
    logoText: "敬老版",
    brand: "#0756a5",
    brandDeep: "#06417c",
    accent: "#efad00",
    text: "#16283a",
    muted: "#4a5b6c",
    surface: "#ffffff",
    line: "#d3dfe9",
    focus: "#b8791b",
    fontFamily: "\"Microsoft YaHei\", \"Noto Sans CJK SC\", sans-serif",
    radius: 14
  });

  function pickSurface() {
    var body = document.body;
    var style = body && styleOf(body);
    var background = style && parseColor(style.backgroundColor);
    if (!isOpaque(background)) {
      var html = styleOf(document.documentElement);
      background = html && parseColor(html.backgroundColor);
    }
    return isOpaque(background) ? background : WHITE;
  }

  function buildTheme(options) {
    var fallback = Object.assign({}, DEFAULT_THEME, (options && options.fallback) || {});
    var pageSurface = pickSurface();
    var dark = luminance(pageSurface) < 0.35;

    var samples = collectSamples();
    var ranked = rankColors(samples, isBrandLike);
    var brand = ranked.length ? ranked[0].color : parseColor(fallback.brand) || parseColor(DEFAULT_THEME.brand);

    // 第二主色只在色相确实不同时才当强调色，否则强调色留给焦点圈。
    var brandHue = rgbToHsl(brand).h;
    var accent = null;
    for (var i = 1; i < ranked.length; i += 1) {
      var hue = rgbToHsl(ranked[i].color).h;
      var distance = Math.abs(hue - brandHue);
      if (Math.min(distance, 360 - distance) >= 40) { accent = ranked[i].color; break; }
    }

    var surface = dark ? mix(pageSurface, WHITE, 0.06) : WHITE;
    var ink = dark ? { r: 240, g: 244, b: 248, a: 1 } : { r: 22, g: 32, b: 44, a: 1 };

    // 按钮底色要能压住白字；标题色要在面板底色上读得清。
    var buttonBrand = ensureContrast(brand, WHITE, 4.5);
    var brandDeep = ensureContrast(withLightness(buttonBrand, Math.max(0.10, rgbToHsl(buttonBrand).l - 0.13)), surface, 4.6);
    var text = ensureContrast(ink, surface, 8);
    var muted = ensureContrast(mix(text, surface, 0.34), surface, 4.6);
    var line = dark ? mix(surface, WHITE, 0.22) : mix(surface, buttonBrand, 0.22);

    var focusCandidate = accent ? ensureContrast(accent, surface, 3) : null;
    if (!focusCandidate || contrast(focusCandidate, surface) < 3) {
      focusCandidate = contrast(DEFAULT_THEME.focus, surface) >= 3
        ? parseColor(DEFAULT_THEME.focus)
        : ensureContrast(DEFAULT_THEME.focus, surface, 3);
    }

    var name = siteName();
    var logoUrl = null;
    try {
      logoUrl = findLogo();
    } catch (_) {
      logoUrl = null;
    }

    var font = null;
    try {
      font = fontFamily();
    } catch (_) {
      font = null;
    }
    var corner = null;
    try {
      corner = radius();
    } catch (_) {
      corner = null;
    }

    return {
      name: name || fallback.name || "",
      logoUrl: logoUrl || fallback.logoUrl || null,
      logoText: name ? fallbackLogoText(name, null) : (fallback.logoText || DEFAULT_THEME.logoText),
      brand: toHex(buttonBrand),
      brandDeep: toHex(brandDeep),
      accent: toHex(accent ? ensureContrast(accent, surface, 3) : parseColor(fallback.accent) || parseColor(DEFAULT_THEME.accent)),
      text: toHex(text),
      muted: toHex(muted),
      surface: toHex(surface),
      line: toHex(line),
      focus: toHex(focusCandidate),
      fontFamily: font || fallback.fontFamily,
      radius: corner || fallback.radius,
      dark: dark
    };
  }

  function extract(options) {
    var fallback = Object.assign({}, DEFAULT_THEME, (options && options.fallback) || {});
    if (typeof document === "undefined" || !document.documentElement) return fallback;
    try {
      return buildTheme(options);
    } catch (error) {
      if (typeof console !== "undefined") console.warn("[EasyView] 品牌提取失败，使用回退配色：", error);
      return fallback;
    }
  }

  function resolveStyleTarget(target) {
    if (!target) return null;
    if (typeof ShadowRoot !== "undefined" && target instanceof ShadowRoot) {
      return target.host ? target.host.style : null;
    }
    return target.style || null;
  }

  /** 令牌 -> CSS 变量。变量挂在宿主元素上，靠继承进入 Shadow DOM。 */
  function apply(theme, target) {
    var style = resolveStyleTarget(target);
    if (!style || !theme) return;
    var surface = parseColor(theme.surface) || WHITE;
    var brand = parseColor(theme.brand) || parseColor(DEFAULT_THEME.brand);
    var variables = {
      "--ev-brand": theme.brand,
      "--ev-brand-deep": theme.brandDeep,
      "--ev-brand-soft": toHex(mix(surface, brand, 0.06)),
      "--ev-brand-tint": toHex(mix(surface, brand, 0.13)),
      "--ev-brand-line": toHex(mix(surface, brand, 0.30)),
      "--ev-accent": theme.accent,
      "--ev-text": theme.text,
      "--ev-muted": theme.muted,
      "--ev-surface": theme.surface,
      "--ev-line": theme.line,
      "--ev-focus": theme.focus,
      "--ev-radius": theme.radius + "px",
      "--ev-font": theme.fontFamily
    };
    Object.keys(variables).forEach(function (name) {
      var value = variables[name];
      if (value) style.setProperty(name, String(value));
    });
    if (theme.dark) style.setProperty("--ev-scheme", "dark");
    else style.removeProperty("--ev-scheme");
  }

  function logoElement(theme) {
    if (!theme || !theme.logoUrl) return null;
    var img = document.createElement("img");
    img.className = "ev-logo";
    img.src = theme.logoUrl;
    img.alt = theme.logoText || theme.name || "";
    img.decoding = "async";
    img.loading = "eager";
    return img;
  }

  /**
   * 放 Logo。图片加载失败时默认换成文字标识，绝不会留下空白块；
   * 传 { textFallback: false } 则直接移除（用于旁边已有标题的页头）。
   */
  function mountLogo(container, theme, options) {
    if (!container || !theme) return null;
    var textFallback = !(options && options.textFallback === false);
    var node = logoElement(theme);
    if (node) {
      var fallbackText = theme.logoText || "敬老版";
      node.addEventListener("error", function () {
        if (textFallback) node.replaceWith(fallbackBadge(fallbackText));
        else {
          container.hidden = true;
          node.remove();
        }
      });
      container.append(node);
      return node;
    }
    if (!textFallback) return null;
    var badge = fallbackBadge(theme.logoText || "敬老版");
    container.append(badge);
    return badge;
  }

  function fallbackBadge(text) {
    var badge = document.createElement("span");
    badge.className = "ev-logo ev-logo-text";
    badge.setAttribute("aria-hidden", "true");
    badge.textContent = text;
    return badge;
  }

  /**
   * 原站 Logo 常常自带站名（12306、中国移动都是 wordmark）。
   * 这种情况下覆盖层里再显示一遍同名标题就是纯重复，视觉上很糙。
   * 判据取保守方向：只有页面标题确实包含这句标题时才算重复 ——
   * 天气网的标题是「您好，这里是天气查询服务」，不含站名，不会被误伤。
   */
  function logoRepeatsHeading(theme, heading) {
    if (!theme || !theme.logoUrl || !heading) return false;
    var normalize = function (text) {
      return String(text || "").replace(/\s+/g, "").toLowerCase();
    };
    var target = normalize(heading);
    if (!target) return false;
    return normalize(theme.name).indexOf(target) !== -1 || normalize(theme.logoText) === target;
  }

  globalThis.EasyViewBrand = {
    extract: extract,
    apply: apply,
    logoElement: logoElement,
    mountLogo: mountLogo,
    logoRepeatsHeading: logoRepeatsHeading,
    defaults: DEFAULT_THEME,
    // 纯函数导出，方便在 Node 里单测颜色运算，不必启动浏览器。
    _color: {
      parseColor: parseColor,
      toHex: toHex,
      luminance: luminance,
      contrast: contrast,
      mix: mix,
      withLightness: withLightness,
      ensureContrast: ensureContrast,
      rgbToHsl: rgbToHsl,
      hslToRgb: hslToRgb
    }
  };
})();
