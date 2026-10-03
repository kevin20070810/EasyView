/* EasyView · 支付页识别与金额提取
 *
 * 这是整个产品里【风险最高】的一块：别的功能指错了，老人最多白跑一趟；
 * 这一块指错了，是钱没了。
 *
 * 所以判据是保守的、可解释的：
 *   detect() 只有在【同时读到一个像样的金额 和 一个像样的支付按钮】时才返回结果；
 *   任何一条读不到就返回 null —— 宁可不引导，也不能在没看清金额的情况下
 *   把老人往"确认支付"上引。
 *
 * 绝不代点。这个模块只负责"认出这一页"和"把金额收款方读出来"，
 * 点击永远由用户自己完成（由 ai-content.js 的聚光灯批注来实现）。
 */
(function () {
  "use strict";

  // 支付按钮的文字。宁可窄一点：漏判的代价是"没有引导"，
  // 误判的代价是"把老人引到一个不该点的按钮上"。
  const PAY_BUTTON = /^(确认支付|立即支付|去支付|马上支付|确认付款|立即付款|确认充值|立即充值|去充值|确认下单|提交订单|确认购买|立即购买)$/;

  // 金额附近的标签，命中说明这个数字更可能是"应付金额"而不是商品数量
  const AMOUNT_LABEL = /(应付|实付|需付|支付金额|订单金额|合计|总计|小计|充值金额|付款金额|金额)/;

  const AMOUNT_RE = /(?:¥|￥|\bRMB\b|\bCNY\b)?\s*(\d{1,7}(?:\.\d{1,2})?)\s*(?:元|块)?/;

  function textOf(node) {
    return node ? (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function visible(node) {
    if (!node || !node.isConnected) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const st = getComputedStyle(node);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) !== 0;
  }

  /** 找一个可见的、文字匹配支付按钮谓词的控件。 */
  function findPayButton() {
    const nodes = [...document.querySelectorAll("button, a, input[type='submit'], [role='button']")];
    for (const n of nodes) {
      if (!visible(n)) continue;
      const label = (n.innerText || n.value || "").replace(/\s+/g, "").trim();
      if (PAY_BUTTON.test(label)) return { node: n, label };
    }
    return null;
  }

  /** 读金额。优先"带标签的数字"，其次 ¥ 开头的数字，最后不猜。 */
  function findAmount() {
    // ① 标签附近：应付/实付/合计…
    const labeled = [...document.querySelectorAll("span, div, p, td, th, dt, dd, label, strong, b")];
    for (const n of labeled) {
      if (!visible(n)) continue;
      const t = textOf(n);
      if (!t || t.length > 60) continue;
      if (!AMOUNT_LABEL.test(t)) continue;
      const m = t.match(/(\d{1,7}(?:\.\d{1,2})?)/);
      if (m) {
        // 排除"数量 1"这类：带 ¥/元 或者带小数才当金额
        if (/[¥￥]|元|\.\d/.test(t) || Number(m[1]) >= 1) {
          return { value: m[1], source: t.slice(0, 40) };
        }
      }
    }
    // ② ¥ / ￥ 前缀
    const whole = textOf(document.body);
    const withSymbol = whole.match(/[¥￥]\s*(\d{1,7}(?:\.\d{1,2})?)/);
    if (withSymbol) return { value: withSymbol[1], source: "¥" + withSymbol[1] };
    // ③ 读不到就不猜 —— 这是刻意保守的一条
    return null;
  }

  /** 收款方：优先"收款方/商户"标签，其次页面标题里的站名。 */
  function findPayee() {
    const labeled = [...document.querySelectorAll("span, div, p, td, th, dt, dd, label")];
    for (const n of labeled) {
      if (!visible(n)) continue;
      const t = textOf(n);
      if (!t || t.length > 60) continue;
      const m = t.match(/(?:收款方|收款单位|商户|商家|收款账户)[：:\s]*([^\s，,。]{2,20})/);
      if (m) return m[1];
    }
    const title = (document.title || "").split(/[-|_—]/)[0].trim();
    return title && title.length <= 20 ? title : "";
  }

  /**
   * 判断当前页是不是"一个等着付款的页面"。
   * 返回 null 表示【不是】或者【看不准】——调用方据此不做任何引导。
   */
  function detect() {
    let pay;
    try {
      pay = findPayButton();
    } catch (_) {
      return null;
    }
    if (!pay) return null;                       // 没有明确的支付按钮 → 不引导

    let amount = null;
    try {
      amount = findAmount();
    } catch (_) {
      amount = null;
    }
    if (!amount || !amount.value) return null;   // 读不到金额 → 不引导（核心保守规则）

    let payee = "";
    try {
      payee = findPayee();
    } catch (_) {
      payee = "";
    }

    return {
      amount: amount.value,
      amountSource: amount.source,
      payee,
      button: pay.node,
      buttonLabel: pay.label
    };
  }

  globalThis.EasyViewPayPage = { detect };
})();
