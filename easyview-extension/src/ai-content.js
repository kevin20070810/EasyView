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

  /** 目标是不是"点得动"的东西 —— 决定我们能不能替用户点。
   *  只在风险为 normal 时使用；高风险卡片一律不代点。 */
  function looksClickable(element) {
    if (!element || !element.isConnected) return false;
    const tag = element.tagName;
    if (tag === "BUTTON" || tag === "A") return true;
    if (tag === "INPUT") {
      const t = (element.getAttribute("type") || "text").toLowerCase();
      return t === "button" || t === "submit" || t === "image" || t === "reset";
    }
    if (element.getAttribute("role") === "button" || element.getAttribute("role") === "link") return true;
    return typeof element.onclick === "function";
  }

  /** 这张卡是不是"一组要填的字段"（而不是"带我去某个入口"）。
   *
   * 【只卡片自己的证据元素】，不看目标周围有什么。
   *
   * 这里曾经有一层"目标附近 140px 内找表单控件"的兜底（v0.10.1 加的，
   * 本意是让分步引导在更多页面上能触发）。结果在 12306 上出了大问题：
   * 购物表单就在首页顶部导航旁边，于是「我要退改签」「查车次时刻」这些
   * 跟填表毫无关系的卡片，全都撞见购票表单、全都被判成填表任务 ——
   * 用户点任何一张卡，弹出的都是购票三步引导。
   *
   * 模型在 also_cite 里已经给出了支撑这张卡的元素，够用了；
   * 用邻居去猜，猜错的代价比漏判大得多。
   */
  function hasFormGroup(card) {
    if (!pendingElements) return false;
    const action = card.action || {};
    const provenance = card.provenance || {};
    const ids = [action.target_element_id, ...(provenance.source_element_ids || [])];
    return stepsFromIds(ids, pendingElements).length >= 2;
  }

  /** 元素在页面上是否真的看得见（不是 display:none / visibility:hidden / 零尺寸）。 */
  function elementIsVisible(element) {
    if (!element || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (Number(style.opacity) === 0) return false;
    return true;
  }

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

    // 先看是不是"一组要填的字段"（12306 的「我要买火车票」带着
    // 出发地/到达地/出发日期）→ 把购票流程铺成卡片，点哪步指哪格。
    //
    // 必须在 navigate/external 之前：否则卡片一导航就走了，永远轮不到。
    // 来源里凑不出两个表单字段时返回 false，正常走下面的导航逻辑。
    if (hasFormGroup(card)) {
      const act = card.action || {};
      const prov = card.provenance || {};
      const ids = [act.target_element_id, ...(prov.source_element_ids || [])];
      const group = stepsFromIds(ids, pendingElements);
      if (group.length >= 2) {
        renderBookingSteps(group);
        return;
      }
    }

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

    // scroll / form：分三种情况，顺序不能换
    if (!element) {
      showError("页面上找不到这个位置了，页面可能刚刚变过。请退出后重试。", null);
      return;
    }
    // 情况一已经在 activate 开头处理过了（要在导航分支之前），这里只剩两种。
    const risk = (card && card.risk && card.risk.level) || "normal";

    // 情况二：这是"带我去某个入口"的卡，目标是个链接/按钮。
    //
    // 12306 首页那些「退票 / 改签 / 查正晚点 / 查车次时刻」全是
    // <a href="javascript:;">，这种链接只有被点击才生效 —— 滚动和高亮都不会让它
    // 跳转。只做"定位 + 让他自己点"，用户看到的就是"面板关了，没反应"。
    //
    // 所以替它点一下。风险不是 normal 的（涉钱、涉病、涉身份）不代点，
    // 仍旧只定位、由用户自己在原网页操作 —— 这是我们的底线。
    if (risk === "normal" && looksClickable(element)) {
      close();
      try {
        element.click();
      } catch (_) {
        showError("这一项没能打开，请刷新网页后重试。", null);
      }
      return;
    }

    // 情况三：其它（高风险的、或目标不是可点控件的）→ 聚光灯框出来，用户自己操作。
    if (startSteps(card)) return;

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
      const bbox = e.bbox || {};
      const w = Number(bbox.width) || 0;
      const h = Number(bbox.height) || 0;
      // 零尺寸的隐藏元素是模板壳子，用户永远点不到。
      //
      // 12306 首页的「退票 / 改签」未登录时就是这个样子：
      //   <li class="nav_ref item"><a href="javascript:;">退票</a></li>
      // rect 全是 0，没有 onclick，点了没有任何反应。
      // 模型只看得到文字，就给它生成卡片 —— 这就是"退票/改签点了没反应"的根因。
      // 真入口在登录后才会出现，那时它是可见的，自然会被收进来。
      if (w < 2 || h < 2) {
        removed.add(e.id);
        return false;
      }
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
    window.removeEventListener("scroll", onStepViewportChange, true);
    window.removeEventListener("resize", onStepViewportChange);
    if (stepLayoutTimer) { clearTimeout(stepLayoutTimer); stepLayoutTimer = null; }
    if (stepHost && stepHost.__observer) stepHost.__observer.disconnect();
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
    // 高亮交给聚光灯的黄圈（.ev-spot-ring）—— 那里不受页面自身样式影响。
    // 不再往元素上写 outline / backgroundColor：一是可能被站点样式覆盖，
    // 二是改了站点自己的元素外观，收尾还要还原，容易留残留。
    stepHighlighted = element;
    if (typeof element.focus === "function") element.focus({ preventScroll: true });
  }

  /** 把聚光灯的四块挡板、高亮圈和批注气泡摆到目标元素周围。
   *
   * 四块挡板拼出一个"洞"，而不是一整层蒙版挖圆角：
   * 洞里的元素**照常能点**（那是老人要操作的东西），
   * 洞外的点击被挡板接住，防止误点别处。
   */
  /** 页面上其它"还要填的控件"当前的真实位置（视口坐标）。
   *
   * 用实时 DOM 量，不用 elements.json 里的 bbox —— 那是提取那一刻的坐标，
   * 页面滚动过就对不上了。
   */
  function otherControlRects(excludeElement) {
    const out = [];
    if (!pendingElements || !resolveElement) return out;
    const vh = window.innerHeight;
    for (const item of pendingElements.elements || []) {
      if (!item.visible) continue;
      if (!STEP_TYPES.has(item.type) && item.type !== "link") continue;
      const node = resolveElement(item.id);
      if (!node || !node.isConnected || node === excludeElement) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > vh) continue;      // 不在视口里就不用管
      out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return out;
  }

  function overlapArea(box, rect) {
    const w = Math.min(box.right, rect.right) - Math.max(box.left, rect.left);
    const h = Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  /** 给批注气泡挑一个"不挡还要填的东西"的落点。
   *
   * 之前固定贴在洞口下方 —— 在 12306 上正好盖住下面的「到达地」和「出发日期」，
   * 老人看不见自己要填的下一格。这里改成：四个方位各试一遍，
   * 算出各自和"其它控件"的重叠面积，取最小的那个。
   */
  function pickBubbleSpot(rect, bw, bh) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 12;
    const others = otherControlRects(stepHost && stepHost.__current);
    const clamp = (v, lo, hi) => Math.min(Math.max(lo, v), Math.max(lo, hi));

    const raw = [
      { name: "below", left: rect.left, top: rect.bottom + gap },
      { name: "above", left: rect.left, top: rect.top - bh - gap },
      { name: "right", left: rect.right + gap, top: rect.top },
      { name: "left", left: rect.left - bw - gap, top: rect.top },
    ];
    // 轻微偏好阅读顺序：能放下面就放下面，其次上面，再次左右
    const bias = { below: 0, above: 300, right: 700, left: 900 };

    let best = null;
    for (const c of raw) {
      const left = clamp(c.left, 8, vw - bw - 8);
      const top = clamp(c.top, 8, vh - bh - 8);
      const box = { left, top, right: left + bw, bottom: top + bh };
      let covered = 0;
      for (const o of others) covered += overlapArea(box, o);
      const score = covered + bias[c.name];
      if (!best || score < best.score) best = { left, top, score, covered };
    }
    return best || { left: 8, top: 8 };
  }

  /** 找目标下方紧邻的浮层 —— 站点的自动补全候选、日期选择器之类。
   *
   * 只认"绝对/固定定位、出现在目标正下方、够大"的盒子，而且只扫一层，
   * 不做递归。够用就行：漏判最多是候选框还被暗着（仍能点），
   * 误判最多是洞开大一点，都不会让人填不了表。
   */
  function popupRectNear(element, baseRect) {
    let best = null;
    const nodes = document.querySelectorAll("ul, ol, div, section, table");
    for (const node of nodes) {
      if (stepHost && stepHost.contains(node)) continue;
      const style = window.getComputedStyle(node);
      if (style.position !== "absolute" && style.position !== "fixed") continue;
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
      const r = node.getBoundingClientRect();
      if (r.width < 80 || r.height < 36) continue;
      // 必须紧贴在目标下方，且横向有重叠
      if (r.top < baseRect.bottom - 10 || r.top > baseRect.bottom + 80) continue;
      if (r.right < baseRect.left - 60 || r.left > baseRect.right + 60) continue;
      if (!best || r.height > best.height) best = r;
    }
    return best;
  }

  /** 这一组控件合起来的外接矩形。整个框就是"该填的地方"。 */
  function groupRect() {
    const nodes = (stepHost && stepHost.__nodes) || [];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const node of nodes) {
      if (!node || !node.isConnected) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      left = Math.min(left, r.left); top = Math.min(top, r.top);
      right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom);
    }
    if (left === Infinity) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function layoutSpotlight() {
    if (!stepHost) return;
    const rect = groupRect();
    if (!rect) return;
    const pad = 8;
    const top = Math.max(0, rect.top - pad);
    const left = Math.max(0, rect.left - pad);
    let bottom = Math.min(window.innerHeight, rect.bottom + pad);
    let right = Math.min(window.innerWidth, rect.right + pad);

    // 候选框/日期选择器一起照亮 —— 否则它是暗的，看着像禁用了
    const anchor = stepHost.__nodes && stepHost.__nodes[0];
    const popup = anchor ? popupRectNear(anchor, rect) : null;
    if (popup) {
      bottom = Math.min(window.innerHeight, Math.max(bottom, popup.bottom + pad));
      right = Math.min(window.innerWidth, Math.max(right, popup.right + pad));
    }
    const bandH = Math.max(0, bottom - top);

    stepHost.__panelTop.style.cssText = `top:0;left:0;right:0;height:${top}px`;
    stepHost.__panelBottom.style.cssText = `top:${bottom}px;left:0;right:0;bottom:0`;
    stepHost.__panelLeft.style.cssText = `top:${top}px;left:0;width:${left}px;height:${bandH}px`;
    stepHost.__panelRight.style.cssText = `top:${top}px;left:${right}px;right:0;height:${bandH}px`;

    const ring = stepHost.__ring;
    ring.style.cssText =
      `top:${top}px;left:${left}px;width:${Math.max(0, right - left)}px;height:${bandH}px`;

    const bubble = stepHost.__bubble;
    const bw = bubble.offsetWidth || 340;
    const bh = bubble.offsetHeight || 130;
    const avoid = popup
      ? { left, top, right, bottom, width: right - left, height: bandH }
      : rect;
    const spot = pickBubbleSpot(avoid, bw, bh);
    bubble.style.top = `${spot.top}px`;
    bubble.style.left = `${spot.left}px`;
  }

  let stepLayoutTimer = null;

  /** 重新摆位。节流到约 8fps —— DOM 变化监听会触发得非常频繁。 */
  function onStepViewportChange() {
    if (stepLayoutTimer) return;
    stepLayoutTimer = setTimeout(() => {
      stepLayoutTimer = null;
      layoutSpotlight();
    }, 120);
  }

  function showGroupGuide(elements, index) {
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
        /* 聚光灯：页面压暗，只在目标位置留一个洞。
           早先两版都是"一条横条"—— 顶部通栏挡住页面顶部，移到底部又因为
           换行堆到 273px。横条这个形态本身就和"指引"冲突：它总得占一块地方。
           改成挖洞之后，被指的元素自己就是最亮的地方，不需要额外占位。 */
        /* 挡板只负责"暗"，不负责"挡"。
           早先给挡板加了 pointer-events: auto 想防误点，结果把站点的自动补全
           候选框也挡住了 —— 12306 输入地点会弹出站点候选，那东西在洞口外面，
           点不到就等于填不了表。所以挡板一律 pointer-events: none，
           页面上该点的东西永远点得到；引导靠"亮/暗"来表达，不靠拦截。
           真正需要点击的只有批注气泡，它自己保留 auto。 */
        .ev-spot-panel { position: fixed; background: rgba(15,23,42,.68);
          z-index: 2147483600; pointer-events: none; }
        .ev-spot-ring { position: fixed; z-index: 2147483601; pointer-events: none;
          border: 3px solid #ffb020; border-radius: 10px;
          box-shadow: 0 0 0 4px rgba(255,176,32,.28), 0 0 26px rgba(255,176,32,.6); }
        .ev-spot-bubble { position: fixed; z-index: 2147483602; pointer-events: auto;
          max-width: min(340px, calc(100vw - 32px)); box-sizing: border-box;
          background: #0b5cad; color: #fff; padding: 11px 13px;
          border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.45);
          font: 16px/1.45 "Microsoft YaHei", system-ui, sans-serif; }
        .ev-spot-bubble .ev-step-count { font-size: 17px; font-weight: 700; margin-bottom: 3px; }
        .ev-spot-bubble .ev-step-text { margin-bottom: 9px; }
        .ev-spot-bubble .ev-step-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .ev-spot-bubble button { font: 16px/1 "Microsoft YaHei", system-ui, sans-serif;
          padding: 8px 13px; border: 0; border-radius: 8px; cursor: pointer;
          background: rgba(255,255,255,.2); color: #fff; }
        .ev-spot-bubble button:hover { background: rgba(255,255,255,.34); }
        .ev-spot-bubble button:disabled { opacity: .4; cursor: default; }
        .ev-spot-bubble button.ev-step-exit { background: rgba(0,0,0,.25); }
      `;
      shadow.appendChild(extra);

      stepHost.__panelTop = el("div", "ev-spot-panel");
      stepHost.__panelBottom = el("div", "ev-spot-panel");
      stepHost.__panelLeft = el("div", "ev-spot-panel");
      stepHost.__panelRight = el("div", "ev-spot-panel");
      stepHost.__ring = el("div", "ev-spot-ring");
      stepHost.__bubble = el("div", "ev-spot-bubble");
      shadow.append(stepHost.__panelTop, stepHost.__panelBottom,
                    stepHost.__panelLeft, stepHost.__panelRight,
                    stepHost.__ring, stepHost.__bubble);
      (document.documentElement || document.body).appendChild(stepHost);

      // 滚动、改窗口大小、以及"候选框弹出来"都要重新摆位。
      // 候选框是用户一打字才出现的，光靠 scroll/resize 抓不到它。
      window.addEventListener("scroll", onStepViewportChange, true);
      window.addEventListener("resize", onStepViewportChange);
      stepHost.__observer = new MutationObserver(onStepViewportChange);
      stepHost.__observer.observe(document.body || document.documentElement,
        { childList: true, subtree: true });
    }

    // 一步步来：一次只亮一格。
    //
    // v0.13.0 曾经把整组框成一个大框（"就在这个框里填写"），理由是逐步引导
    // 有三个毛病。但其中两个已经另行修好了：
    //   - 候选框盖住下一格 → 挡板不再拦点击，且候选框会被吸进洞口
    //   - 老人要在按钮和页面间来回看 → 这是逐步模式的本性，接受
    // 合成大框的代价是"没有先后感"：字段多的时候老人不知道从哪开始。
    // 所以回到分步，但保留 v0.13.0 的排版重构（旋转到当前这一步的元素）。
    const total = elements.length;
    const current = elements[Math.min(index, total - 1)] || elements[0];
    // 取 DOM 节点：先用扩展自己的 id → 节点映射，失败再按提取时记下的选择器找。
    //
    // 只靠 resolveElement 不够：12306 首页的导航链接有一堆是 javascript:，
    // 页面 JS 会替换/重建这些节点，映射就失效了。失效时 showGroupGuide 会走到
    // clearStepBar()，表现是"面板关了、什么提示都没有" —— 正是用户报的
    // "其他功能点了没反应"。选择器是提取那一刻记下来的，能兜住这种情况。
    // 只框【当前这一步】那一格。
    // 早先这里 map 的是整组 elements，结果三步每次框出来的都是同一个大框
    // （覆盖三个输入格），"一步步来"就没有意义了。
    const nodes = [current]
      .map((e) => {
        let node = resolveElement ? resolveElement(e.id) : null;
        if ((!node || !node.isConnected) && e.selector) {
          try {
            node = document.querySelector(e.selector);
          } catch (_) {
            node = null;
          }
        }
        return node;
      })
      .filter((n) => n && n.isConnected);
    if (!nodes.length) { clearStepBar(); return; }

    const label = (current.label || current.text || current.placeholder || "").trim();
    // 链接也要说"点一下"，不能因为不是 input 就说"填写"
    const clicky = current.type === "button" || current.type === "submit" || current.type === "link";
    const verb = clicky ? "点一下" : "填写";

    const bubble = stepHost.__bubble;
    bubble.replaceChildren();
    if (total === 1) {
      // 只有一个目标时不必报"第 1 步 / 共 1 步"，那是废话
      bubble.appendChild(el("div", "ev-step-count", "请点下面亮起来的这一行"));
    } else {
      bubble.appendChild(el("div", "ev-step-count", `第 ${index + 1} 步 / 共 ${total} 步`));
    }
    bubble.appendChild(el("div", "ev-step-text", label ? `「${label}」${verb}` : "就在这里操作"));

    const actions = el("div", "ev-step-actions");
    const prev = button("上一步", () => {
      if (index > 0) showGroupGuide(elements, index - 1);
    });
    prev.disabled = index === 0;
    const next = button(index === total - 1 ? "完成" : "下一步", () => {
      if (index === total - 1) { clearStepBar(); return; }
      showGroupGuide(elements, index + 1);
    });
    const exit = button("退出", () => clearStepBar());
    exit.className = "ev-step-exit";
    if (total === 1) actions.append(exit);
    else actions.append(prev, next, exit);
    bubble.appendChild(actions);

    stepHost.__nodes = nodes;
    stepHost.__current = nodes[0];

    window.requestAnimationFrame(() => {
      const rect = groupRect();
      if (!rect) return;
      if (rect.height > window.innerHeight * 0.8) {
        nodes[0].scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        window.scrollBy({
          top: (rect.top + rect.bottom) / 2 - window.innerHeight / 2,
          behavior: "smooth"
        });
      }
      layoutSpotlight();
      requestAnimationFrame(layoutSpotlight);
      setTimeout(layoutSpotlight, 350);
    });
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
    // 这里不再有"看目标周围有什么"的兜底 —— 理由见 hasFormGroup 的注释：
    // 那层兜底会让不相干的卡片劫持购票表单。
    //
    // 凑不成一组时，至少把目标本身框出来。
    //
    // 这一步是关键：12306 首页 210 个链接里 167 个是 javascript:，
    // 这种链接只有被【真正点击】才跳转。而 scroll 降级只做了
    // scrollIntoView + focus —— 没有高亮、没有提示，用户看到的是
    // "面板关了，然后什么都没发生"。
    if (!steps.length) {
      const own = (pendingElements.elements || []).find((e) => e.id === action.target_element_id);
      if (own && own.visible) steps = [own];
    }
    if (!steps.length) return false;

    close();
    showGroupGuide(steps, 0);
    return true;
  }

  /* ---------- 车次卡片（12306 查票结果页）----------
   *
   * 为什么不走模型：车次列表是结构化数据，直接读比让模型猜准得多。
   * 实测通用路径在结果页上给的是「我要退票 / 我要改签 / 查正晚点」——
   * 首页级别的任务，对着一屏 110 趟车毫无用处。
   *
   * 视觉：冰蓝→白渐变、毛玻璃、大圆角悬浮、大字号。
   * 设计稿里还有「座位 12车05A / 检票口 6A / 站台 3」—— 这三项在查票页面
   * 上还不存在（要下单后才有），所以没有硬塞，留到乘车人那一步再上。
   */
  const TRAIN_CSS = `
    /* 车次视图专用：面板加宽到 1240px。默认是 820px，
       一排两张卡时每张只剩 390px，字就大不起来。 */
    .ev-ai .ev-panel { width: min(100%, 1240px); }
    /* 一排两个。 */
    .ev-trains { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    @media (max-width: 900px) { .ev-trains { grid-template-columns: 1fr; } }
    .ev-train {
      position: relative; overflow: hidden; box-sizing: border-box;
      display: grid; gap: 12px; width: 100%; text-align: left;
      padding: 26px 28px 22px; border: 0; cursor: pointer; border-radius: 26px;
      background:
        radial-gradient(120% 90% at 8% 0%, #ffffff 0%, rgba(255,255,255,0) 60%),
        linear-gradient(160deg, #eaf5ff 0%, #f8fcff 48%, #ffffff 100%);
      box-shadow: 0 12px 30px rgba(23,72,124,.14), 0 2px 6px rgba(23,72,124,.07),
                  inset 0 1px 0 rgba(255,255,255,.92);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      color: #10314f;
      font: 20px/1.45 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .ev-train:hover { transform: translateY(-2px);
      box-shadow: 0 18px 38px rgba(23,72,124,.2), 0 3px 8px rgba(23,72,124,.09),
                  inset 0 1px 0 rgba(255,255,255,.95); }
    .ev-train-code { font-size: 56px; font-weight: 800; line-height: 1;
      letter-spacing: .01em; color: #0b4f86; }
    .ev-train-route { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      font-size: 32px; font-weight: 700; }
    .ev-train-route .ev-arrow { color: #6fa8d6; font-weight: 500; }
    .ev-train-times { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      font-size: 36px; font-weight: 800; color: #0b4f86; font-variant-numeric: tabular-nums; }
    .ev-train-times small { font-size: 19px; font-weight: 600; color: #5b7f9e; }
    .ev-train-meta { display: flex; gap: 10px 16px; flex-wrap: wrap; align-items: center;
      font-size: 20px; color: #43617c; }
    .ev-train-price { font-size: 32px; font-weight: 800; color: #b3521a; }
    .ev-train-left { padding: 5px 14px; border-radius: 999px; font-size: 19px; font-weight: 700;
      background: #e2f3e6; color: #1c6b39; }
    .ev-train-left.ev-tight { background: #fdecd8; color: #8a4a12; }
    .ev-train-rule { height: 1px;
      background: linear-gradient(90deg, rgba(23,72,124,.16), rgba(23,72,124,0)); }
    .ev-train-cta { display: flex; justify-content: space-between; align-items: center;
      font-size: 22px; font-weight: 700; color: #0b5cad; }

    /* 筛选：只用大按钮，不用下拉框、不用输入框 ——
       老人不该为了筛个车还得打字或者展开菜单。
       两行、各带标签：车型 / 出发时段，两个维度独立叠加。 */
    .ev-trainfilters { display: grid; gap: 10px; margin: 0 0 20px; }
    .ev-trainfilter { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .ev-filterlabel { flex: 0 0 96px; font-size: 20px; font-weight: 700; color: #3d6a92; }
    .ev-trainfilter button {
      font: 21px/1 "Microsoft YaHei", system-ui, sans-serif;
      padding: 14px 22px; border: 2px solid #bcd7ee; border-radius: 999px;
      background: #fff; color: #14507f; cursor: pointer; font-weight: 700; }
    .ev-trainfilter button:hover { border-color: #7fb2dd; background: #f2f9ff; }
    .ev-trainfilter button.ev-on { background: #0b5cad; border-color: #0b5cad; color: #fff; }
    .ev-traincount { justify-self: end; font-size: 20px; color: #4a7ba6; font-weight: 700; }
  `;

  function renderTrainCards(trains) {
    ensureMount();
    const body = header("选一趟车", `这趟车有 ${trains.length} 个车次，点一下就是它。`);

    const style = document.createElement("style");
    style.textContent = TRAIN_CSS;
    body.appendChild(style);

    // ---- 筛选：只用大按钮。老人不该为了筛个车还得打字或展开菜单 ----
    // 两维独立叠加：车型 × 出发时段。每行各自有一个「全部」。
    const pairs = [];
    const state = { kind: "all", time: "all" };

    const KINDS = [
      { key: "all", label: "全部" },
      { key: "gaotie", label: "高铁" },
      { key: "dongche", label: "动车" },
      { key: "putong", label: "火车" },
    ];
    const TIMES = [
      { key: "all", label: "全部" },
      { key: "morning", label: "上午出发" },
      { key: "afternoon", label: "下午出发" },
      { key: "evening", label: "晚上出发" },
    ];

    /** 车次首字母就是车型：G 高铁、D 动车、C 城际（也算动车组），其余是普速。 */
    function kindOf(code) {
      const head = String(code || "").trim().charAt(0).toUpperCase();
      if (head === "G") return "gaotie";
      if (head === "D" || head === "C") return "dongche";
      return "putong";
    }

    function timeOk(train, key) {
      if (key === "all") return true;
      const hour = Number(String(train.depart || "00:00").split(":")[0]);
      if (Number.isNaN(hour)) return true;
      if (key === "morning") return hour < 12;
      if (key === "afternoon") return hour >= 12 && hour < 18;
      return hour >= 18;
    }

    const count = el("span", "ev-traincount", "");

    function applyFilter() {
      let shown = 0;
      for (const pair of pairs) {
        const ok = (state.kind === "all" || kindOf(pair.train.code) === state.kind)
          && timeOk(pair.train, state.time);
        pair.node.style.display = ok ? "" : "none";
        if (ok) shown += 1;
      }
      count.textContent = shown ? `现在显示 ${shown} 趟` : "这个条件下没有车次";
    }

    function makeRow(label, options, dim) {
      const row = el("div", "ev-trainfilter");
      row.appendChild(el("span", "ev-filterlabel", label));
      for (const opt of options) {
        const b = button(opt.label, () => {
          state[dim] = opt.key;
          for (const other of row.querySelectorAll("button")) {
            other.classList.toggle("ev-on", other.dataset.key === opt.key);
          }
          applyFilter();
        });
        b.dataset.key = opt.key;
        if (opt.key === "all") b.classList.add("ev-on");
        row.appendChild(b);
      }
      return row;
    }

    const bars = el("div", "ev-trainfilters");
    bars.appendChild(makeRow("车型", KINDS, "kind"));
    bars.appendChild(makeRow("出发时段", TIMES, "time"));
    bars.appendChild(count);
    body.appendChild(bars);

    const wrap = el("div", "ev-trains");
    for (const t of trains) {
      const card = el("button", "ev-train");
      card.type = "button";

      card.appendChild(el("div", "ev-train-code", t.code));

      const route = el("div", "ev-train-route");
      route.append(t.from, el("span", "ev-arrow", "→"), t.to);
      card.appendChild(route);

      const times = el("div", "ev-train-times");
      times.append(t.depart, el("small", "", "发车"), el("span", "ev-arrow", "→"),
                   t.arrive, el("small", "", "到达"));
      if (t.duration) times.appendChild(el("small", "", `历时 ${t.duration}`));
      card.appendChild(times);

      card.appendChild(el("div", "ev-train-rule"));

      const meta = el("div", "ev-train-meta");
      if (t.price) {
        meta.append(el("span", "ev-train-price", `${t.priceClass || "二等座"} ${t.price} 元`));
      }
      if (t.left) {
        const tight = /无|候补/.test(t.left);
        meta.appendChild(el("span", `ev-train-left${tight ? " ev-tight" : ""}`,
          `余票 ${t.left}`));
      }
      card.appendChild(meta);

      const cta = el("div", "ev-train-cta");
      cta.append(el("span", "", "选这一趟"), el("span", "", "→"));
      card.appendChild(cta);

      card.addEventListener("click", () => {
        const target = t.bookButton;
        if (target && target.isConnected) {
          close();
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.style.outline = "4px solid #ffb020";
          target.style.outlineOffset = "3px";
          target.focus({ preventScroll: true });
        } else {
          showError("这一趟的「预订」按钮找不到了，页面可能刚刷新过。", null);
        }
      });
      wrap.appendChild(card);
      pairs.push({ train: t, node: card });
    }

    // 注意别用 .ev-ai-consent 当容器 —— 那是同意页的类名，
    // 复用它会让"有没有弹同意页"的检测误报（踩过一次）。
    const box = el("div", "ev-ai-trainbox");
    box.appendChild(wrap);
    body.appendChild(box);
    applyFilter();

    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "看好了就点那一趟，我们会带您到原网页的「预订」。"));
    foot.appendChild(el("div", "ev-ai-foot-meta",
      `车次来自当前网页，没有发给任何服务器。EasyView v${chrome.runtime.getManifest().version}`));
    body.appendChild(foot);
  }

  /* ---------- 购票流程卡片化 ----------
   *
   * 点「我要买火车票」不再直接钻进聚光灯，而是先把流程铺成一张张
   * "下一步该做什么"的卡片，用老人问得出口的话：
   *
   *     第 1 步  您要从哪里出发？
   *     第 2 步  您要去哪里？
   *     第 3 步  哪天走？
   *     最后     填好了，点这里查车次
   *
   * 点其中一张 → 收起面板、聚光灯框出对应输入框。
   * 这样老人随时能看到"一共几步、我走到哪了"，而不是被丢进一个只有
   * "第 1 步 / 共 3 步"的聚光灯里、看不到全貌。
   */
  const BOOKSTEP_CSS = `
    .ev-booksteps { display: grid; gap: 14px; }
    .ev-bookstep {
      display: grid; grid-template-columns: 92px 1fr auto; align-items: center;
      gap: 16px; width: 100%; text-align: left; box-sizing: border-box;
      padding: 22px 24px; border: 0; border-radius: 20px; cursor: pointer;
      background: linear-gradient(160deg, #f2f9ff 0%, #ffffff 100%);
      box-shadow: 0 8px 22px rgba(23,72,124,.12), inset 0 1px 0 rgba(255,255,255,.9);
      color: #10314f;
      font: 20px/1.45 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .ev-bookstep:hover { transform: translateY(-2px);
      box-shadow: 0 14px 30px rgba(23,72,124,.18), inset 0 1px 0 rgba(255,255,255,.95); }
    .ev-bookstep-no { font-size: 19px; font-weight: 800; color: #0b5cad;
      background: #e3f0fb; border-radius: 999px; padding: 8px 0; text-align: center; }
    .ev-bookstep-q { font-size: 30px; font-weight: 800; line-height: 1.25; }
    .ev-bookstep-hint { grid-column: 2; font-size: 18px; color: #5b7f9e; margin-top: 2px; }
    .ev-bookstep-arrow { grid-row: 1 / span 2; font-size: 30px; color: #6fa8d6; }
  `;

  /** 把字段翻成老人问得出口的话。 */
  function questionFor(element) {
    const label = (element.label || element.text || element.placeholder || "").trim();
    // 日期要排在「出发」前面判断：否则「出发日期」会被 /出发/ 先截走，
    // 第 3 步会写成"您要从哪里出发？"（踩过一次）。
    if (/日期|出发日|乘车日|哪天/.test(label)) return "哪天走？";
    if (/出发地|出发站|出发/.test(label)) return "您要从哪里出发？";
    if (/到达地|到达站|目的地|到达/.test(label)) return "您要去哪里？";
    if (/查询|搜索|查找/.test(label)) return "填好了，点这里查车次";
    return label ? `填一下「${label}」` : "在这里填一下";
  }

  function renderBookingSteps(elements) {
    const body = header("买火车票，就三步", "点哪一步，我就指给您看在哪填。");
    const style = document.createElement("style");
    style.textContent = BOOKSTEP_CSS;
    body.appendChild(style);

    const list = el("div", "ev-booksteps");
    elements.forEach((element, index) => {
      const node = el("button", "ev-bookstep");
      node.type = "button";

      const isLast = index === elements.length - 1;
      node.appendChild(el("span", "ev-bookstep-no", isLast ? "最后" : `第 ${index + 1} 步`));
      node.appendChild(el("span", "ev-bookstep-q", questionFor(element)));
      node.appendChild(el("span", "ev-bookstep-arrow", "→"));

      const hint = el("span", "ev-bookstep-hint");
      const name = (element.label || element.text || element.placeholder || "").trim();
      hint.textContent = name ? `点这里，我指给您看「${name}」` : "点这里，我指给您看";
      node.appendChild(hint);

      node.addEventListener("click", () => {
        close();
        showGroupGuide(elements, index);
      });
      list.appendChild(node);
    });

    const box = el("div", "ev-ai-bookbox");
    box.appendChild(list);
    body.appendChild(box);

    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "填好之后，原网页上的「查询」按钮就是最后一步。"));
    foot.appendChild(el("div", "ev-ai-foot-meta",
      `这一步全在本机完成，没有把网页内容发出去。EasyView v${chrome.runtime.getManifest().version}`));
    body.appendChild(foot);
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

      // 12306 查票结果页：车次列表是结构化数据，直接读，不调模型也不用同意。
      // 实测通用路径在这一页上给的是「我要退票 / 我要改签」这类首页任务，
      // 对着一屏 55~110 趟车毫无用处。这不算绕过隐私检查 ——
      // 车次信息本来就在当前页面上，本地解析不发送任何东西。
      if (globalThis.EasyViewTrainList) {
        let trains = [];
        try {
          trains = globalThis.EasyViewTrainList.read();
        } catch (_) {
          trains = [];
        }
        if (trains.length >= 3) {
          lastPayload = null;
          busy = false;
          renderTrainCards(trains);
          return;
        }
      }
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
