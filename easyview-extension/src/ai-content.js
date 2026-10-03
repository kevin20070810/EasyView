/* EasyView 通用网页敬老版：页面内提取 -> 分析服务理解 -> 渲染 ui_schema 0.3
 *
 * 流程：
 *   1. EasyViewExtract.run()  在当前页面内读出元素（纯本地，不联网）
 *   2. 构造要发送的载荷，并做本地脱敏
 *   3. 首次使用先征得同意，用户可以看到将要发送的原文
 *   4. 交给 background 代发到分析服务（content script 绕不过 CORS）
 *   5. 按 0.3 渲染：大字卡片、风险提示、敏感操作先确认
 *
 * 隐私立场
 * --------
 * 页面上可能本来就显示着**别人的**隐私（医生开着病人列表、客服开着客户资料）。
 * 所以：出浏览器的每个字符都先过 privacy.js，而且首次发送前必须让用户
 * 亲眼看到将发送的内容。
 */
(() => {
  "use strict";

  if (globalThis.EasyViewAI) {
    globalThis.EasyViewAI.open();
    return;
  }

  const ROOT_ID = "easyview-ai-root";
  const CONSENT_KEY = "easyview.consent";
  // 隐私政策有实质变化时改这个值，会重新征求同意
  const CONSENT_VERSION = "2026-10-local-v1";

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

  // 会被脱敏的文本字段（结构字段如 selector/href 不动，否则绑定会坏）
  // 注意：这些字段只在 buildPayload 的兜底分支里用到；
  // digest.js 就位后发送的是说明书文本，脱敏由 privacy.redactText 统一处理。

  let host = null;
  let shadow = null;
  let panel = null;
  let brandTheme = null;
  let previousFocus = null;
  let resolveElement = null;
  let currentUi = null;
  let pendingElements = null;
  let lastPayload = null;
  let lastDropped = [];
  let lastElementsJson = null;
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

  function privacy() {
    return globalThis.EasyViewPrivacy || null;
  }

  function kb(chars) {
    return chars >= 1024 ? `${Math.round(chars / 1024)} KB` : `${chars} 字符`;
  }

  /* ---------- 同意 ---------- */

  async function consentGranted() {
    try {
      const stored = await chrome.storage.local.get({ [CONSENT_KEY]: null });
      const value = stored[CONSENT_KEY];
      return Boolean(value && value.granted && value.version === CONSENT_VERSION);
    } catch (_) {
      return false;
    }
  }

  async function grantConsent() {
    try {
      await chrome.storage.local.set({
        [CONSENT_KEY]: { granted: true, version: CONSENT_VERSION, at: new Date().toISOString() }
      });
    } catch (_) { /* 存不上也让他继续用，只是下次还会问 */ }
  }

  /* ---------- 载荷构造 ---------- */

  /**
   * 构造要发送的内容，并在本地做完脱敏。
   *
   * 说明书在扩展里生成，所以发出去的只有**精选过的文字**：
   * 没有 DOM 选择器、没有坐标、没有完整链接（查询串常带会话令牌），
   * 也没有用户填过的内容。定位和风险策略都在本地跑（binder.js）。
   */
  function buildPayload(elements) {
    const priv = privacy();
    const digest = globalThis.EasyViewDigest;

    if (!digest || typeof digest.build !== "function") {
      // 说明书模块没起来就不发任何东西 —— 宁可不能用，也不退回发送整页结构
      return {
        kind: null,
        text: "",
        chars: 0,
        redactions: null,
        unusable: true,
        note: "页面说明书模块没有加载成功，为避免泄露页面内容，本次不发送任何数据。"
      };
    }

    if (priv) priv.begin();
    const raw = digest.build(elements);
    const text = priv ? priv.redactText(raw) : raw;
    return {
      kind: "页面说明书",
      text,
      chars: text.length,
      redactions: priv ? priv.describe() : null,
      full: false,
      note: "只包含这台页面的文字说明。不含选择器、坐标、完整链接，也不含您填过的内容。"
    };
  }

  /** elements.json 的 SHA-256，写进 ui_schema 的 input_snapshot。
   *  crypto.subtle 只在安全上下文可用（HTTPS / localhost），
   *  普通 HTTP 页面上要请 background 代算 —— 那是扩展内部通信，不出浏览器。 */
  async function sha256Of(text) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle) {
      try {
        const hash = await subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
      } catch (_) { /* 落到下面的回退 */ }
    }
    try {
      const reply = await chrome.runtime.sendMessage({ type: "easyview:sha256", text });
      if (reply && reply.ok) return reply.sha256;
    } catch (_) { /* 继续落到占位值 */ }
    // 拿不到就如实填 64 个 0，不编造一个看起来像哈希的东西
    return "0".repeat(64);
  }

  function payloadSummary(payload) {
    const lines = [
      `${payload.kind}，约 ${kb(payload.chars)}`,
      payload.note
    ];
    if (payload.redactions) lines.push(payload.redactions.summary);
    return lines;
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
      .ev-ai-consent { margin-top: 14px; padding: 14px 16px; border: 2px solid #0b5cad;
        border-radius: 10px; background: #f2f7fd; }
      .ev-ai-consent ul { margin: 8px 0 0; padding-left: 22px; font-size: 17px; line-height: 1.8; }
      .ev-ai-preview { margin-top: 12px; max-height: 260px; overflow: auto; padding: 12px;
        border: 1px solid #c3ccd6; border-radius: 8px; background: #fff;
        font-family: Consolas, Menlo, monospace; font-size: 13px; line-height: 1.6;
        white-space: pre-wrap; word-break: break-all; }
      .ev-ai-foot { margin-top: 18px; padding-top: 12px; border-top: 1px solid #dde3ea;
        font-size: 14px; color: #5c6b7a; line-height: 1.8; }
      .ev-ai-foot button { margin-top: 8px; font-size: 14px; padding: 6px 12px; }
    `;
    shadow.appendChild(extra);

    // 通用网页也复用同一套品牌提取：变量写在宿主元素上，继承进 Shadow DOM。
    try {
      if (window.EasyViewBrand) {
        brandTheme = window.EasyViewBrand.extract();
        window.EasyViewBrand.apply(brandTheme, host);
      }
    } catch (error) {
      brandTheme = null;
      console.warn("[EasyView] Brand tokens unavailable, using defaults.", error);
    }

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
    const brand = el("div", "ev-brandline");
    // 通用层的标题是问候语（不是站名），所以这里只加 Logo，不做标题隐藏。
    if (brandTheme && brandTheme.logoUrl && window.EasyViewBrand) {
      const slot = el("div", "ev-logoslot");
      window.EasyViewBrand.mountLogo(slot, brandTheme, { textFallback: false });
      if (slot.childNodes.length) brand.append(slot);
    }
    const copy = el("div", "ev-brandcopy");
    copy.append(el("h1", "", title));
    if (summary) copy.append(el("p", "", summary));
    brand.append(copy);
    const exit = el("button", "ev-exit", "退出敬老版");
    exit.type = "button";
    exit.addEventListener("click", close);
    bar.append(brand, exit);
    panel.appendChild(bar);
    const body = el("div", "ev-content");
    panel.appendChild(body);
    panel.focus({ preventScroll: true });
    return body;
  }

  /* ---------- 同意界面 ---------- */

  function showConsent(payload, onAgree) {
    const body = header("开始之前，先说清楚一件事", "看完再决定用不用。");

    body.appendChild(el("p", "ev-message",
      "要帮您把这个页面整理成大字版，需要把页面上的文字发到分析服务去理解。"));
    body.appendChild(el("p", "ev-message",
      "只读页面上的文字。不会读您填进去的内容，也不会读密码。"));

    const box = el("div", "ev-ai-consent");
    box.appendChild(el("div", "", "这次将会发送："));
    const list = el("ul");
    for (const line of payloadSummary(payload)) list.appendChild(el("li", "", line));
    box.appendChild(list);

    const preview = el("div", "ev-ai-preview");
    preview.hidden = true;
    const shown = payload.text.length > 6000
      ? payload.text.slice(0, 6000) + "\n…（后面还有 " + kb(payload.text.length - 6000) + "，未展开）"
      : payload.text;
    preview.textContent = shown;

    const toggle = button("查看将发送的内容", () => {
      preview.hidden = !preview.hidden;
      toggle.textContent = preview.hidden ? "查看将发送的内容" : "收起";
    });
    box.append(toggle, preview);
    body.appendChild(box);

    const actions = el("div", "ev-ai-actions");
    actions.append(
      button("同意并继续", () => onAgree(), true),
      button("不用了", close)
    );
    body.appendChild(actions);
    actions.querySelector("button").focus({ preventScroll: true });
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
      button("再试一次", () => requestAnalysis(), true),
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
    if (banners.length) body.appendChild(el("p", "ev-ai-banner", banners.join(" ")));

    if (ui.state === "empty" || !cards.length) {
      body.appendChild(el("p", "ev-message", "这个页面上暂时没找到能替您整理的事情。"));
      const actions = el("div", "ev-ai-actions");
      actions.append(button("退出敬老版", close, true));
      body.appendChild(actions);
      appendDataFoot(body);
      return;
    }

    const list = el("div", "ev-actions");
    for (const card of cards) list.appendChild(renderCard(card));
    body.appendChild(list);

    const stats = el("div", "ev-ai-stats");
    const s = ui.stats || {};
    stats.appendChild(el("div", "", `从 ${s.input_elements || "?"} 个页面元素里整理了 ${cards.length} 件事。`));
    body.appendChild(stats);
    appendDataFoot(body);
  }

  /** 如实告诉用户这次发出去了什么，并允许再看一遍原文。 */
  function appendDataFoot(body) {
    if (!lastPayload) return;
    const foot = el("div", "ev-ai-foot");
    const line = `本次发送：${lastPayload.kind}，约 ${kb(lastPayload.chars)}。`;
    foot.appendChild(el("div", "", line + (lastPayload.redactions ? lastPayload.redactions.summary + "。" : "")));
    foot.appendChild(button("查看发送的内容", () => showPayloadReview()));
    body.appendChild(foot);
  }

  function showPayloadReview() {
    const body = header("这次发送的内容", "您可以在这里看全部的原文。");
    const box = el("div", "ev-ai-consent");
    const list = el("ul");
    for (const line of payloadSummary(lastPayload)) list.appendChild(el("li", "", line));
    box.appendChild(list);
    const preview = el("div", "ev-ai-preview");
    preview.textContent = lastPayload.text.length > 6000
      ? lastPayload.text.slice(0, 6000) + "\n…（后面还有 " + kb(lastPayload.text.length - 6000) + "）"
      : lastPayload.text;
    box.appendChild(preview);
    body.appendChild(box);
    const actions = el("div", "ev-ai-actions");
    actions.append(button("知道了", () => (currentUi ? renderResult(currentUi) : close()), true));
    body.appendChild(actions);
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
    actions.append(
      confirm,
      button(confirmation.cancel_label || "先不打开", () => renderResult(currentUi))
    );
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

  async function requestAnalysis() {
    if (busy || !lastPayload) return;
    if (lastPayload.unusable) {
      showError(lastPayload.note, null);
      return;
    }
    busy = true;
    showLoading(`读到了 ${pendingElements.stats ? pendingElements.stats.total : "?"} 个页面元素，正在判断哪些对您最有用…`);

    let reply;
    try {
      // 发送的就是用户刚才在预览里看到的那个字符串，一字不差
      reply = await chrome.runtime.sendMessage({
        type: "easyview:analyze",
        body: lastPayload.text,
        kind: "digest"
      });
    } catch (error) {
      busy = false;
      showError(`扩展内部通信失败：${error && error.message ? error.message : error}`, null);
      return;
    }

    if (!reply || !reply.ok) {
      busy = false;
      showError((reply && reply.error) || "分析服务没有返回结果。", reply && reply.endpoint);
      return;
    }

    // 绑定在本地做：定位字段从 elements 里逐字抄，风险策略在 binder 里判定。
    // 服务器只回了「任务 + 元素 ID + 文案」，它没有、也不需要定位信息。
    let ui;
    try {
      const binder = globalThis.EasyViewBinder;
      if (!binder || typeof binder.bind !== "function") {
        throw new Error("绑定模块没有加载成功");
      }
      const dropped = [];
      // input_snapshot.sha256 锚定在这一个序列化上：JSON.stringify(elements)。
      // 换一种序列化（Python 的 json.dumps、加缩进、改键序）算出来就不是同一个值，
      // 所以这一行和下面的 sha256Of 必须用同一个字符串。
      const elementsJson = JSON.stringify(pendingElements);
      ui = binder.bind(reply.draft, pendingElements, {
        generatedAt: new Date().toISOString(),
        sha256: await sha256Of(elementsJson),
        generator: { mode: "model", prompt_version: reply.promptVersion || null, fallback_reason: null },
        droppedReport: dropped
      });
      lastDropped = dropped;
      lastElementsJson = elementsJson;
    } catch (error) {
      busy = false;
      showError(`整理结果时出错：${error && error.message ? error.message : error}`, null);
      return;
    }

    busy = false;
    currentUi = ui;
    // 供端到端测试与排查读取。这是页面内的全局变量，不出浏览器。
    globalThis.__easyviewLastRun = {
      ui,
      elements: pendingElements,
      elementsJson: lastElementsJson,
      payload: lastPayload.text,
      dropped: lastDropped,
      meta: reply.meta || null
    };
    renderResult(ui);
  }

  async function open() {
    if (busy) return;
    busy = true;
    ensureMount();
    if (!previousFocus) previousFocus = document.activeElement;
    showLoading("正在读取这个页面…");

    if (!globalThis.EasyViewExtract || typeof globalThis.EasyViewExtract.run !== "function") {
      busy = false;
      showError("页面提取模块没有加载成功。", null);
      return;
    }

    let extracted;
    try {
      extracted = globalThis.EasyViewExtract.run();
      resolveElement = extracted.resolve;
      pendingElements = extracted.elements;
    } catch (error) {
      busy = false;
      showError(`读取页面失败：${error && error.message ? error.message : error}`, null);
      return;
    }

    // 载荷在本地构造并脱敏，之后无论是否发送都不会再变
    lastPayload = buildPayload(pendingElements);

    busy = false;
    if (await consentGranted()) {
      requestAnalysis();
      return;
    }
    showConsent(lastPayload, async () => {
      await grantConsent();
      requestAnalysis();
    });
  }

  globalThis.EasyViewAI = { open };
  open();
})();
