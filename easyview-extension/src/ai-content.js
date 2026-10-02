/* EasyView 通用网页敬老版：页面内提取 -> 分析服务理解 -> 渲染 ui_schema 0.3
 *
 * 流程：
 *   1. EasyViewExtract.run()  在当前页面内读出 elements.json 和 id->元素 映射
 *   2. 交给 background 代发到分析服务（content script 绕不过 CORS）
 *   3. 按 0.3 渲染：大字卡片、风险提示、敏感操作先确认
 *
 * 服务不可用时提供一个「用本地规则版」的出口，退回 generic-content.js。
 */
(() => {
  "use strict";

  if (globalThis.EasyViewAI) {
    globalThis.EasyViewAI.open();
    return;
  }

  const ROOT_ID = "easyview-ai-root";

  // 0.3 的 16 个冻结图标名 -> 字形
  const ICONS = {
    home: "⌂", calendar: "▦", document: "▤", payment: "¥",
    phone: "☎", user: "♙", search: "⌕", location: "⌖",
    bus: "🚌", train: "🚆", hospital: "✚", government: "▥",
    warning: "!", info: "i", help: "?", back: "←"
  };

  const RISK_NOTE = {
    blocked: "这项需要您自己在原网页办理",
    sensitive: "打开前会先跟您确认"
  };

  let host = null;
  let shadow = null;
  let panel = null;
  let previousFocus = null;
  let resolveElement = null;
  let currentUi = null;
  let busy = false;

  /* ---------- 小工具 ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, onClick, primary) {
    const node = el("button", `ev-button ${primary ? "ev-button-primary" : "ev-button-secondary"}`, label);
    node.type = "button";
    node.addEventListener("click", onClick);
    return node;
  }

  /* ---------- 挂载 ---------- */

  function ensureMount() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = ROOT_ID;
    shadow = host.attachShadow({ mode: "open" });

    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("src/styles.css");
    shadow.appendChild(link);

    // AI 版独有的几处样式，避免改动公共 styles.css
    const extra = document.createElement("style");
    extra.textContent = `
      .ev-ai-banner { margin: 0 0 12px; padding: 10px 14px; border-radius: 8px;
        background: #fff6e5; color: #7a5200; font-size: 17px; line-height: 1.5; }
      .ev-ai-note { display: block; margin-top: 4px; font-size: 15px; color: #8a6d3b; }
      .ev-ai-risk-blocked .ev-card-copy > span { color: #8a6d3b; }
      .ev-ai-confirm { margin-top: 14px; padding: 16px; border: 2px solid #0b5cad;
        border-radius: 10px; background: #f2f7fd; }
      .ev-ai-confirm p { margin: 0 0 14px; font-size: 20px; line-height: 1.6; }
      .ev-ai-confirm .ev-actions { display: flex; gap: 12px; }
      .ev-ai-actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
      .ev-ai-stats { margin-top: 18px; font-size: 14px; color: #5c6b7a; line-height: 1.7; }
    `;
    shadow.appendChild(extra);

    const overlay = el("div", "ev-overlay ev-generic");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "EasyView 适老视图");
    overlay.addEventListener("keydown", onKeydown);

    panel = el("main", "ev-panel");
    panel.tabIndex = -1;
    overlay.appendChild(panel);
    shadow.appendChild(overlay);
    (document.documentElement || document.body).appendChild(host);
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...shadow.querySelectorAll("button:not(:disabled)")].filter(
      (node) => node.getClientRects().length
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (shadow.activeElement === first || shadow.activeElement === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && shadow.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function header(title, summary) {
    panel.replaceChildren();
    const bar = el("header", "ev-header");
    const copy = el("div");
    copy.append(el("h1", "", title));
    if (summary) copy.append(el("p", "", summary));
    const exit = el("button", "ev-exit", "退出敬老版");
    exit.type = "button";
    exit.addEventListener("click", close);
    bar.append(copy, exit);
    panel.appendChild(bar);
    const body = el("div", "ev-content");
    panel.appendChild(body);
    panel.focus({ preventScroll: true });
    return body;
  }

  /* ---------- 各状态 ---------- */

  function showLoading(text) {
    const body = header("正在为您整理页面…", "请稍等，马上就好。");
    body.appendChild(el("p", "ev-message", text));
  }

  function showError(message, endpoint) {
    const body = header("这次没能帮上忙", "您可以继续使用原来的网页。");
    body.appendChild(el("p", "ev-message ev-error", message));
    pretty(body, "分析服务地址", endpoint || "未知");
    const actions = el("div", "ev-ai-actions");
    actions.append(
      button("再试一次", () => open(), true),
      button("用本地规则版", useLocalRules),
      button("退出", close)
    );
    body.appendChild(actions);
  }

  function pretty(body, label, value) {
    const box = el("div", "ev-ai-stats");
    box.appendChild(el("div", "", `${label}：${value}`));
    body.appendChild(box);
    return box;
  }

  function renderResult(ui) {
    const page = ui.page || {};
    const cards = Array.isArray(ui.cards) ? ui.cards : [];
    const body = header(page.greeting || "您想先办哪件事？", page.summary || "");

    // 如实说明这份结果是怎么来的
    const banners = [];
    if (ui.generator && ui.generator.mode === "rules") {
      banners.push("本次由本地规则生成（没能用上语义理解）。");
    }
    if (ui.generator && ui.generator.fallback_reason) {
      banners.push(`原因：${ui.generator.fallback_reason}。`);
    }
    if (ui.source === "fallback") {
      banners.push("这不是您刚才浏览的真实网页，页面内容来自降级快照。");
    }
    if (banners.length) {
      body.appendChild(el("p", "ev-ai-banner", banners.join(" ")));
    }

    if (ui.state === "empty" || !cards.length) {
      body.appendChild(el("p", "ev-message", "这个页面上暂时没找到能替您整理的事情。"));
      const actions = el("div", "ev-ai-actions");
      actions.append(button("退出敬老版", close, true));
      body.appendChild(actions);
      return;
    }

    const list = el("div", "ev-actions");
    for (const card of cards) list.appendChild(renderCard(card));
    body.appendChild(list);

    const stats = el("div", "ev-ai-stats");
    const s = ui.stats || {};
    stats.appendChild(el("div", "", `从 ${s.input_elements || "?"} 个页面元素里整理了 ${cards.length} 件事。`));
    body.appendChild(stats);
  }

  function renderCard(card) {
    const risk = (card.risk && card.risk.level) || "normal";
    const node = el("button", `ev-card${risk === "blocked" ? " ev-ai-risk-blocked" : ""}`);
    node.type = "button";

    const iconName = card.icon || "info";
    node.dataset.icon = iconName;
    const icon = el("span", "ev-card-icon", ICONS[iconName] || ICONS.info);
    icon.setAttribute("aria-hidden", "true");

    const copy = el("span", "ev-card-copy");
    copy.appendChild(el("strong", "", card.title || "未命名"));
    if (card.subtitle) copy.appendChild(el("span", "", card.subtitle));
    if (RISK_NOTE[risk]) copy.appendChild(el("span", "ev-ai-note", RISK_NOTE[risk]));

    node.append(icon, copy);
    node.addEventListener("click", () => performAction(card));
    return node;
  }

  /* ---------- 二次确认 ---------- */

  function showConfirm(card, confirmation, onConfirm) {
    const body = header(card.title || "请确认", "");
    const box = el("div", "ev-ai-confirm");
    box.appendChild(el("p", "", confirmation.message || "确定要继续吗？"));

    const actions = el("div", "ev-actions");
    const confirm = button(confirmation.confirm_label || "继续", () => onConfirm(), true);
    const cancel = button(confirmation.cancel_label || "先不打开", () => {
      renderResult(currentUi);
    });
    actions.append(confirm, cancel);
    box.appendChild(actions);
    body.appendChild(box);
    confirm.focus({ preventScroll: true });
  }

  /* ---------- 执行动作 ---------- */

  function performAction(card) {
    const action = (card && card.action) || {};
    if (action.confirmation) {
      showConfirm(card, action.confirmation, () => activate(action));
      return;
    }
    activate(action);
  }

  function activate(action) {
    const id = action.target_element_id;
    const element = id && resolveElement ? resolveElement(id) : null;

    if (action.kind === "external" || action.kind === "navigate") {
      const href = action.href;
      if (!href) {
        showError("这个入口没有可打开的地址。", null);
        return;
      }
      if (href.startsWith("tel:")) {
        close();
        location.href = href;
        return;
      }
      close();
      if (action.kind === "navigate") location.assign(href);
      else window.open(href, "_blank", "noopener,noreferrer");
      return;
    }

    // scroll / form：只定位，不替他点
    if (!element) {
      showError("页面上找不到这个位置了，页面可能刚刚变过。请退出后重试。", null);
      return;
    }
    close();
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    if (typeof element.focus === "function") {
      if (action.kind === "form" && !element.hasAttribute("tabindex")) {
        element.setAttribute("tabindex", "-1");
        element.addEventListener("blur", () => element.removeAttribute("tabindex"), { once: true });
      }
      element.focus({ preventScroll: true });
    }
  }

  /* ---------- 本地规则兜底 ---------- */

  async function useLocalRules() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "easyview:fallback-generic" });
      if (!reply || !reply.ok) showError("本地规则版也没能打开。请刷新网页后重试。", null);
    } catch (error) {
      showError(`本地规则版没能打开：${error && error.message ? error.message : error}`, null);
    }
  }

  /* ---------- 生命周期 ---------- */

  function close() {
    if (host) host.remove();
    host = null;
    shadow = null;
    panel = null;
    busy = false;
    if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
  }

  async function open() {
    if (busy) return;
    busy = true;
    ensureMount();
    if (!previousFocus) previousFocus = document.activeElement;
    showLoading("正在读取这个页面…");

    if (!globalThis.EasyViewExtract || typeof globalThis.EasyViewExtract.run !== "function") {
      showError("页面提取模块没有加载成功。", null);
      busy = false;
      return;
    }

    let extracted;
    try {
      extracted = globalThis.EasyViewExtract.run();
      resolveElement = extracted.resolve;
    } catch (error) {
      showError(`读取页面失败：${error && error.message ? error.message : error}`, null);
      busy = false;
      return;
    }

    const total = (extracted.elements && extracted.elements.stats && extracted.elements.stats.total) || 0;
    showLoading(`读到了 ${total} 个页面元素，正在判断哪些对您最有用…`);

    let reply;
    try {
      reply = await chrome.runtime.sendMessage({ type: "easyview:analyze", elements: extracted.elements });
    } catch (error) {
      reply = { ok: false, error: `扩展内部通信失败：${error && error.message ? error.message : error}` };
    }

    busy = false;
    if (!reply || !reply.ok) {
      showError((reply && reply.error) || "分析服务没有返回结果。", reply && reply.endpoint);
      return;
    }

    currentUi = reply.data;
    renderResult(currentUi);
  }

  globalThis.EasyViewAI = { open };
  open();
})();
