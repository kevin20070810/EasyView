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

  // 0.3 的 16 个冻结图标名 -> 统一的线性图标。图形均为本地静态内容。
  const ICONS = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 21v-7h6v7"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
    document: '<path d="M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5M8 13h8m-8 4h8"/>',
    payment: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20m-15 5h4"/>',
    phone: '<path d="M6 3h3l1.3 4-2 1.7a16 16 0 0 0 7 7l1.7-2L21 15v3a3 3 0 0 1-3 3C9.7 21 3 14.3 3 6a3 3 0 0 1 3-3z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
    location: '<path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0z"/><circle cx="12" cy="10" r="2.5"/>',
    bus: '<rect x="4" y="3" width="16" height="15" rx="3"/><path d="M4 11h16M7 18v3m10-3v3M8 7h3m2 0h3"/>',
    train: '<rect x="5" y="2" width="14" height="17" rx="3"/><path d="M5 11h14M8 6h8M8 19l-2 3m10-3 2 3M8 15h.01M16 15h.01"/>',
    hospital: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M12 8v8m-4-4h8M7 21v-3h10v3"/>',
    government: '<path d="m2 9 10-6 10 6M3 21h18M5 10v9m5-9v9m4-9v9m5-9v9"/>',
    warning: '<path d="m12 3 10 18H2L12 3z"/><path d="M12 9v5m0 3h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 11v6m0-10h.01"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01"/>',
    back: '<path d="m14 5-7 7 7 7M8 12h13"/>'
  };

  const RISK_NOTE = {
    blocked: "原网页办理",
    sensitive: "打开前确认"
  };

  function iconMarkup(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
  }

  // 会被脱敏的文本字段（结构字段如 selector/href 不动，否则绑定会坏）
  // 注意：这些字段只在 buildPayload 的兜底分支里用到；
  // digest.js 就位后发送的是说明书文本，脱敏由 privacy.redactText 统一处理。

  let host = null;
  let shadow = null;
  let panel = null;
  let previousFocus = null;
  let resolveElement = null;
  let currentUi = null;
  let pendingElements = null;
  let lastPayload = null;
  let lastDropped = [];
  let lastElementsJson = null;
  let busy = false;
  let brandLogoBitmapPromise = null;

  /* ---------- 小工具 ---------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function brandLogoBitmap() {
    if (!brandLogoBitmapPromise) {
      brandLogoBitmapPromise = new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "easyview:brand-logo" }, (reply) => {
          if (chrome.runtime.lastError || !reply?.ok || !reply.base64) {
            reject(new Error(chrome.runtime.lastError?.message || reply?.error || "Logo unavailable"));
            return;
          }
          try {
            const binary = atob(reply.base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
              bytes[index] = binary.charCodeAt(index);
            }
            resolve(createImageBitmap(new Blob([bytes], { type: "image/png" })));
          } catch (error) {
            reject(error);
          }
        });
      }).catch((error) => {
        brandLogoBitmapPromise = null;
        throw error;
      });
    }
    return brandLogoBitmapPromise;
  }

  async function paintBrandLogo(canvas, fallback) {
    try {
      const bitmap = await brandLogoBitmap();
      if (!canvas.isConnected) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      fallback.hidden = true;
    } catch (_) {
      fallback.hidden = false;
    }
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
      kind: "网页文字",
      text,
      chars: text.length,
      redactions: priv ? priv.describe() : null,
      full: false,
      note: "只包含这页的部分文字，不包含您填写的内容和密码。"
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

    const overlay = el("div", "ev-overlay ev-generic ev-ai");
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

  function siteName() {
    const title = String(pendingElements?.page_title || "").trim();
    return title.split(/[|｜_—–]/)[0].trim().slice(0, 18);
  }

  function header(title, summary) {
    panel.replaceChildren();
    const bar = el("header", "ev-header");
    const top = el("div", "ev-ai-topline");
    const brand = el("div", "ev-ai-brand");
    brand.setAttribute("role", "img");
    brand.setAttribute("aria-label", "EasyView 标志");
    const logo = el("canvas", "ev-ai-brand-image");
    logo.width = 256;
    logo.height = 256;
    logo.setAttribute("aria-hidden", "true");
    const fallback = el("span", "ev-ai-brand-fallback", "EasyView");
    fallback.setAttribute("aria-hidden", "true");
    brand.append(logo, fallback);
    paintBrandLogo(logo, fallback);
    const exit = el("button", "ev-exit", "返回原网页");
    exit.type = "button";
    exit.addEventListener("click", close);
    const copy = el("div", "ev-ai-heading");
    const site = siteName();
    if (site) copy.append(el("span", "ev-ai-site", `当前网页 · ${site}`));
    copy.append(el("h1", "", title));
    if (summary) copy.append(el("p", "", summary));
    top.append(brand, copy, exit);
    bar.appendChild(top);
    panel.appendChild(bar);
    const body = el("div", "ev-content");
    panel.appendChild(body);
    panel.focus({ preventScroll: true });
    return body;
  }

  /* ---------- 同意界面 ---------- */

  function showConsent(payload, onAgree) {
    const body = header("先确认一件事", "您可以先看看会发送什么。");

    body.appendChild(el("p", "ev-message",
      "为整理这页的服务入口，需要把部分网页文字发送到 EasyView 的分析服务。"));
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
    const body = header("正在整理这页内容…", "请稍等，我们正在查找有用的入口。");
    body.appendChild(el("p", "ev-message", text));
  }

  function showError(message, endpoint) {
    const body = header("暂时没整理好", "您仍可以使用原网页。");
    body.appendChild(el("p", "ev-message ev-error", message));
    if (endpoint) {
      const details = el("details", "ev-ai-details");
      details.append(el("summary", "", "查看技术信息"), el("p", "", `分析服务地址：${endpoint}`));
      body.appendChild(details);
    }
    const actions = el("div", "ev-ai-actions");
    actions.append(
      button("再试一次", () => requestAnalysis(), true),
      button("查看基础版", useLocalRules),
      button("返回原网页", close)
    );
    body.appendChild(actions);
  }

  function renderResult(ui) {
    const cards = Array.isArray(ui.cards) ? ui.cards : [];
    const body = header("请选择事项", "选一项，我们带您找到原网页的入口。");

    const banners = [];
    if (ui.generator && ui.generator.mode === "rules") {
      banners.push("目前显示的是简化版入口。\u00a0");
    }
    if (ui.generator && ui.generator.fallback_reason) {
      banners.push("部分入口可能需要您在原网页寻找。\u00a0");
    }
    if (ui.source === "fallback") {
      banners.push("这不是您刚才浏览的真实网页，页面内容来自降级快照。");
    }
    if (banners.length) body.appendChild(el("p", "ev-ai-banner", banners.join(" ")));

    if (ui.state === "empty" || !cards.length) {
      body.appendChild(el("p", "ev-message", "这个页面上暂时没找到能替您整理的事情。"));
      const actions = el("div", "ev-ai-actions");
      actions.append(button("返回原网页", close, true));
      body.appendChild(actions);
      appendDataFoot(body);
      return;
    }

    const section = el("div", "ev-ai-section-head");
    section.append(el("h2", "", "为您找到的入口"), el("span", "", `${cards.length} 项`));
    body.appendChild(section);
    const list = el("div", "ev-actions");
    cards.forEach((card, index) => list.appendChild(renderCard(card, index)));
    body.appendChild(list);
    appendDataFoot(body);
  }

  /** 如实告诉用户这次发出去了什么，并允许再看一遍原文。 */
  function appendDataFoot(body) {
    if (!lastPayload) return;
    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "这些入口来自当前网页，具体办理仍在原网页完成。"));
    const line = `本次发送：${lastPayload.kind}，约 ${kb(lastPayload.chars)}。`;
    foot.appendChild(el("div", "ev-ai-foot-meta", line + (lastPayload.redactions ? lastPayload.redactions.summary + "。" : "")));
    foot.appendChild(button("查看发送的内容", () => showPayloadReview()));
    // 版本号写在界面上：改了代码有没有生效，一眼就能看出来，
    // 不用去 chrome://extensions 对照加载的路径和版本。
    try {
      foot.appendChild(el("div", "ev-ai-foot-meta",
        `EasyView v${chrome.runtime.getManifest().version}`));
    } catch (_) { /* 拿不到就算了，不能因为一行版本号让整个结果渲染不出来 */ }
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

  function renderCard(card, index) {
    const risk = (card.risk && card.risk.level) || "normal";
    const node = el("button", `ev-card${index === 0 ? " ev-ai-featured" : ""}${risk === "blocked" ? " ev-ai-risk-blocked" : ""}`);
    node.type = "button";

    const iconName = card.icon || "info";
    node.dataset.icon = iconName;
    const icon = el("span", "ev-card-icon");
    icon.innerHTML = iconMarkup(iconName);
    icon.setAttribute("aria-hidden", "true");

    const copy = el("span", "ev-card-copy");
    const heading = el("span", "ev-ai-card-heading");
    heading.appendChild(el("strong", "", card.title || "未命名"));
    if (RISK_NOTE[risk]) heading.appendChild(el("span", "ev-ai-note", RISK_NOTE[risk]));
    copy.appendChild(heading);
    if (card.subtitle) copy.appendChild(el("span", "", card.subtitle));

    const arrow = el("span", "ev-ai-card-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    node.append(icon, copy, arrow);
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
      showConfirm(card, action.confirmation, () => activate(action, card));
      return;
    }
    activate(action, card);
  }

  function activate(action, card) {
    const id = action.target_element_id;
    const element = id && resolveElement ? resolveElement(id) : null;

    // 先看要不要分步引导：如果这张卡的来源元素里有本页的表单控件
    // （12306 的「我要买火车票」就带着出发地/到达地/出发日期），
    // 就在当前页面一步步带他填，比直接跳走有用得多。
    //
    // 这一步必须在 navigate/external 之前 —— 否则卡片一导航就走了，
    // 步骤引导永远轮不到。来源里凑不出两个表单控件时会返回 false，
    // 正常走下面的导航逻辑。
    if (startSteps(card)) return;

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

  /* ---------- 去掉同名的隐藏副本 ----------
   *
   * 12306 上 #fromStationText（可见）和 #fromStationFanText（隐藏）的 label 完全一样，
   * 是给不同版式准备的副本。模型若挑中隐藏那个，"滚动+高亮"就是白做 —— 用户看不见。
   *
   * 规则保守：**只有当存在同名同类型且可见的元素时，才丢掉隐藏的那个**。
   * 隐藏元素本身不丢 —— 弹窗、折叠面板里的表单常常只有隐藏的一份。
   */
  function stripHiddenDuplicates(doc) {
    const elements = doc.elements || [];
    const visibleKeys = new Set();
    for (const e of elements) {
      if (!e.visible) continue;
      const label = (e.label || e.placeholder || e.text || "").trim();
      if (label) visibleKeys.add(`${e.type}::${label}`);
    }
    const removed = new Set();
    const kept = elements.filter((e) => {
      if (e.visible) return true;
      const label = (e.label || e.placeholder || e.text || "").trim();
      if (label && visibleKeys.has(`${e.type}::${label}`)) {
        removed.add(e.id);
        return false;
      }
      return true;
    });
    if (!removed.size) return doc;
    const stats = { ...(doc.stats || {}) };
    stats.total = kept.length;
    stats.visible = kept.filter((e) => e.visible).length;
    const groups = (doc.groups || [])
      .map((g) => ({ ...g, element_ids: (g.element_ids || []).filter((id) => !removed.has(id)) }))
      .filter((g) => g.element_ids.length);
    return { ...doc, elements: kept, groups, stats };
  }

  /* ---------- 步骤引导 ----------
   *
   * 探针结论见 tools/probe_12306_flow.py：
   *   识别 ✅  12306 的出发地 #fromStationText、到达地 #toStationText、
   *           出发日期 #train_date 都能靠 label 精确定位，而且都可见
   *   代填 ❌  通用执行器填了值 12306 不认 —— 站码是点自动补全建议项时才写进去的，
   *           那是站点的内部逻辑，只有专门为它写的模块才处理得了
   *
   * 所以**只做高亮提示，不代填**：告诉老人下一步该点哪，并指给他看。
   * 老人自己输、自己选、自己点 —— 既有掌控感，也不越界。
   */

  const STEP_TYPES = new Set(["input", "select", "textarea", "button"]);

  /** 从一组元素 ID 里挑出可见的表单控件，按位置排序。
   *
   * 用卡片自己的 provenance.source_element_ids —— 模型在 also_cite 里已经
   * 指明了支撑这张卡的元素。12306 的「我要买火车票」正是这种情况：它的目标
   * 是一个 javascript: 链接（点不动），但 also_cite 里带着出发地/到达地/
   * 出发日期三个真正的表单字段。
   * 早先只看目标周围的邻居，结果把站点搜索框当成了第 1 步。
   */
  function stepsFromIds(ids, doc) {
    const wanted = new Set((ids || []).filter(Boolean));
    const group = (doc.elements || []).filter((e) => {
      if (!wanted.has(e.id) || !e.visible || !e.bbox) return false;
      if (!STEP_TYPES.has(e.type)) return false;
      return Boolean((e.label || e.text || e.placeholder || "").trim());
    });
    group.sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
    return group;
  }

  let stepHost = null;
  let stepHighlighted = null;

  function clearStepBar() {
    if (stepHighlighted && stepHighlighted.isConnected) {
      stepHighlighted.style.outline = "";
      stepHighlighted.style.outlineOffset = "";
      stepHighlighted.style.backgroundColor = "";
      stepHighlighted.style.scrollMarginTop = "";
      stepHighlighted.style.scrollMarginBottom = "";
    }
    stepHighlighted = null;
    if (stepHost) stepHost.remove();
    stepHost = null;
  }

  function highlightStep(element) {
    if (!element) return;
    if (stepHighlighted && stepHighlighted !== element && stepHighlighted.isConnected) {
      stepHighlighted.style.outline = "";
      stepHighlighted.style.outlineOffset = "";
      stepHighlighted.style.backgroundColor = "";
      stepHighlighted.style.scrollMarginTop = "";
      stepHighlighted.style.scrollMarginBottom = "";
    }
    // 底部有步骤条，滚动时给下面留出空间，别让目标被压住
    element.style.scrollMarginTop = "24px";
    element.style.scrollMarginBottom = "120px";
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.style.outline = "4px solid #0b5cad";
    element.style.outlineOffset = "3px";
    element.style.backgroundColor = "#eaf3ff";
    stepHighlighted = element;
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
  }

  function showStepBar(steps, index) {
    if (!stepHost) {
      stepHost = document.createElement("div");
      stepHost.id = "easyview-step-host";
      const shadow = stepHost.attachShadow({ mode: "open" });
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("src/styles.css");
      shadow.appendChild(link);
      const extra = document.createElement("style");
      extra.textContent = `
        /* 底部、单行、收窄、圆角。
           两版教训：顶部通栏会盖住页面顶部；即使移到底部，
           一旦换行堆成三四行（实测高 273px）照样挡掉三成屏幕。
           所以这里禁止换行，文字超长省略，整体压到一行 ~60px。 */
        .ev-stepbar { position: fixed; left: 50%; bottom: 20px;
          transform: translateX(-50%);
          z-index: 2147483600;
          max-width: min(920px, calc(100vw - 32px));
          box-sizing: border-box;
          background: #0b5cad; color: #fff; padding: 10px 14px;
          border-radius: 12px;
          display: flex; align-items: center; gap: 12px;
          flex-wrap: nowrap;
          font: 17px/1.4 "Microsoft YaHei", system-ui, sans-serif;
          box-shadow: 0 6px 26px rgba(0,0,0,.32); }
        .ev-stepbar .ev-step-count { font-size: 18px; font-weight: 700; white-space: nowrap; }
        .ev-stepbar .ev-step-text { flex: 1 1 auto; min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ev-stepbar button { flex: 0 0 auto;
          font: 17px/1 "Microsoft YaHei", system-ui, sans-serif;
          padding: 9px 14px; border: 0; border-radius: 8px; cursor: pointer;
          background: rgba(255,255,255,.18); color: #fff; }
        .ev-stepbar button:hover { background: rgba(255,255,255,.32); }
        .ev-stepbar button:disabled { opacity: .4; cursor: default; }
        .ev-stepbar button.ev-step-exit { background: rgba(0,0,0,.25); }
      `;
      shadow.appendChild(extra);
      const bar = el("div", "ev-stepbar");
      shadow.appendChild(bar);
      (document.documentElement || document.body).appendChild(stepHost);
      stepHost.__bar = bar;
    }

    const bar = stepHost.__bar;
    bar.replaceChildren();

    const current = steps[index];
    const label = (current.label || current.text || current.placeholder || "").trim();
    const kindName = current.type === "button" ? "按钮" : "输入框";

    bar.appendChild(el("span", "ev-step-count", `第 ${index + 1} 步 / 共 ${steps.length} 步`));
    bar.appendChild(el("span", "ev-step-text", `请在「${label}」这个${kindName}里填写`));

    const prev = button("上一步", () => {
      if (index > 0) showStepBar(steps, index - 1);
    });
    prev.disabled = index === 0;

    const next = button(index === steps.length - 1 ? "完成" : "下一步", () => {
      if (index === steps.length - 1) { clearStepBar(); return; }
      showStepBar(steps, index + 1);
    });

    const exit = button("退出", () => clearStepBar());
    exit.className = "ev-step-exit";

    bar.append(prev, next, exit);

    highlightStep(resolveElement ? resolveElement(current.id) : null);
  }

  /** 目标元素视觉邻域里的可见表单控件 —— 来源里凑不出步骤时的兜底。 */
  function stepsNearTarget(targetId, doc, windowPx) {
    const elements = doc.elements || [];
    const target = elements.find((e) => e.id === targetId);
    if (!target || !target.bbox) return [];
    const center = target.bbox.y + (target.bbox.height || 0) / 2;
    const group = elements.filter((e) => {
      if (!wanted_ok(e) || !e.visible || !e.bbox) return false;
      const y = e.bbox.y + (e.bbox.height || 0) / 2;
      return Math.abs(y - center) <= windowPx;
    });
    group.sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
    return group;
    function wanted_ok(e) {
      if (!STEP_TYPES.has(e.type)) return false;
      return Boolean((e.label || e.text || e.placeholder || "").trim());
    }
  }

  /** 进入步骤引导。凑不出两个表单控件就返回 false，交回单次定位。
   *
   * 两级策略：
   *   1. 先用卡片自己的 provenance.source_element_ids —— 精确。
   *      12306 的「我要买火车票」就是这么找到出发地/到达地/出发日期的。
   *   2. 来源里凑不出两步时，退一步看目标元素附近有没有表单控件。
   *      没有这一层，这个功能就只在查票/办事这类页面上出现，
   *      别的网站点了卡片什么都不发生，看起来像坏了。
   */
  function startSteps(card) {
    if (!pendingElements) return false;
    const action = card.action || {};
    const provenance = card.provenance || {};
    const ids = [action.target_element_id, ...(provenance.source_element_ids || [])];

    let steps = stepsFromIds(ids, pendingElements);
    if (steps.length < 2) {
      steps = stepsNearTarget(action.target_element_id, pendingElements, 140);
    }
    if (steps.length < 2) return false;

    close();
    showStepBar(steps, 0);
    return true;
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
      // 去掉同名的隐藏副本：模型可能挑中隐藏那份，"滚动+高亮"就白做了
      pendingElements = stripHiddenDuplicates(extracted.elements);
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
