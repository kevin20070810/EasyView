/* EasyView 隐私层：任何要离开浏览器的文字和链接，都先经过这里。
 *
 * 为什么需要这一层
 * ----------------
 * 最大的风险不是"用户自己的信息"，而是**页面上本来就显示着别人的隐私**：
 * 医生打开病人列表、客服打开客户资料、财务打开工资表 —— 扩展如果把这些文字
 * 原样发给服务器，我们就"获取了他人的隐私信息"。
 *
 * 即使用户只是在办自己的事，页面上也可能显示着他本人的身份证号、手机号、
 * 账户余额。
 *
 * 所以这里的立场是：**宁可多隐去，不可漏出去**。看错一次只是少一条线索，
 * 漏出去一次就是一次隐私事故。
 *
 * 三件事
 * ------
 *   1. redactText  把文本里像个人信息的部分换成占位符
 *   2. safeUrl     链接只保留来源和路径，去掉查询串和片段
 *      （查询串里常有会话令牌、工单号、身份证号）
 *   3. describe    如实汇报这次隐去了多少处，供界面告知用户
 */
(() => {
  "use strict";

  const PLACEHOLDER = "〔已隐去〕";

  // 顺序重要：先长后短。占位符里没有数字，所以后面的规则不会重复命中。
  const PATTERNS = [
    { name: "身份证", re: /\d{17}[\dXx]|\d{15}(?!\d)/g },
    { name: "银行卡", re: /\d{16,19}/g },
    { name: "手机号", re: /1[3-9]\d{9}/g },
    { name: "座机", re: /0\d{2,3}[- ]?\d{7,8}/g },
    { name: "邮箱", re: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
    // 兜底：11 位以上连续数字（账号、工单号、卡号）
    { name: "长数字", re: /\d{11,}/g },
  ];

  const URL_RE = /\bhttps?:\/\/[^\s)）】」"'<>，。；]+/gi;

  let tally = null;

  function freshTally() {
    return { total: 0, byKind: {}, urls: 0, charsSaved: 0 };
  }

  function bump(kind, count) {
    if (!tally) return;
    tally.total += count;
    tally.byKind[kind] = (tally.byKind[kind] || 0) + count;
  }

  /** 链接只保留来源和路径；查询串与片段一律丢弃。 */
  function safeUrl(href, base) {
    const raw = String(href == null ? "" : href).trim();
    if (!raw) return null;
    try {
      const url = new URL(raw, base || (typeof location !== "undefined" ? location.href : undefined));
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.origin + url.pathname;
    } catch (_) {
      return null;
    }
  }

  /**
   * 脱敏一段文字。
   * @param {string} text
   * @param {{base?: string, skipUrls?: boolean}} [options]
   * @returns {string}
   */
  function redactText(text, options) {
    const opts = options || {};
    if (text == null) return "";
    let out = String(text);
    const before = out.length;

    if (!opts.skipUrls) {
      out = out.replace(URL_RE, (match) => {
        const shortened = safeUrl(match, opts.base);
        if (!shortened) {
          bump("链接", 1);
          return PLACEHOLDER;
        }
        if (shortened !== match) bump("链接参数", 1);
        return shortened;
      });
    }

    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      out = out.replace(re, () => {
        bump(name, 1);
        return PLACEHOLDER;
      });
    }

    if (tally) tally.charsSaved += Math.max(0, before - out.length);
    return out;
  }

  /** 只检查不改写，用于界面预览"将要发送的内容里有哪些敏感项"。 */
  function scan(text) {
    if (text == null) return [];
    const source = String(text);
    const found = [];
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      const match = source.match(re);
      if (match && match.length) found.push({ kind: name, count: match.length });
    }
    URL_RE.lastIndex = 0;
    const urls = source.match(URL_RE);
    if (urls && urls.some((u) => /[?#]/.test(u))) found.push({ kind: "链接参数", count: 1 });
    return found;
  }

  /** 开始一次统计。retract/scan 期间的命中都会累计进来。 */
  function begin() {
    tally = freshTally();
    return tally;
  }

  function describe() {
    const current = tally || freshTally();
    const parts = Object.entries(current.byKind).map(([kind, count]) => `${kind} ${count} 处`);
    return {
      total: current.total,
      urls: current.urls,
      byKind: { ...current.byKind },
      summary: current.total ? `已隐去 ${parts.join("、")}` : "没有发现需要隐去的个人信息",
    };
  }

  globalThis.EasyViewPrivacy = {
    PLACEHOLDER,
    redactText,
    safeUrl,
    scan,
    begin,
    describe,
  };
})();
