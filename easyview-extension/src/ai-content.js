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
  let brandTheme = null;
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
    // 取节点时优先走 nodeForElement —— 它会用上"升到可见祖先"的地址。
    // 直接用 resolveElement 会拿回那个零尺寸的隐藏节点，等于点了个看不见的东西。
    const elementEntry = (pendingElements && pendingElements.elements
      ? pendingElements.elements.find((x) => x.id === id) : null);
    const element = elementEntry
      ? nodeForElement(elementEntry)
      : (id && resolveElement ? resolveElement(id) : null);

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
        // 用户要的是在卡片里直接填，不是聚光灯。所以这里走表单卡片，
        // 不再调用 renderBookingSteps（那套会收起面板去高亮页面）。
        // 用 showView 压栈，这样表单顶部会出现「← 返回上一步」回到卡片列表。
        showView(renderBookingForm);
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

    // 建两张表：id → 节点，节点 → 元素。用于把隐藏条目"升"到可见祖先。
    const nodeById = new Map();
    const elementByNode = new Map();
    for (const e of elements) {
      const node = resolveElement ? resolveElement(e.id) : null;
      if (node) {
        nodeById.set(e.id, node);
        if (!elementByNode.has(node)) elementByNode.set(node, e);
      }
    }

    /** 沿 DOM 往上找第一个"在元素表里且可见"的祖先。找不到返回 null。 */
    function visibleAncestorElement(id) {
      let node = nodeById.get(id);
      let hops = 0;
      while (node && hops < 12) {
        node = node.parentElement;
        hops += 1;
        if (!node) break;
        const candidate = elementByNode.get(node);
        if (candidate && candidate.visible && candidate.id !== id) return candidate;
      }
      return null;
    }

    const visibleKeys = new Set();
    for (const e of elements) {
      if (!e.visible) continue;
      const label = (e.label || e.placeholder || e.text || "").trim();
      if (label) visibleKeys.add(`${e.type}::${label}`);
    }

    const removed = new Set();
    const kept = [];
    for (const e of elements) {
      if (e.visible) { kept.push(e); continue; }

      const bbox = e.bbox || {};
      const w = Number(bbox.width) || 0;
      const h = Number(bbox.height) || 0;
      const label = (e.label || e.placeholder || e.text || "").trim();

      if (w < 2 || h < 2) {
        // 零尺寸 = 用户点不到。但**不要直接扔掉**。
        //
        // 零点：12306 首页未登录时的「退票 / 改签」是
        //   <li class="nav_ref item"><a href="javascript:;">退票</a></li>
        // rect 全 0、没有 onclick，连祖先也没有 —— 这种是死壳子，必须剔。
        //
        // 但北京公交的「乘车须知」也是零尺寸隐藏：它藏在悬浮菜单里，
        // 直接剔掉就等于把老人真要办的事丢了（实测卡片从 5~6 张掉到 3 张）。
        // 所以先试着沿 DOM 往上找一个【在元素表里且可见】的祖先 ——
        // 那个祖先通常就是"展开这个菜单"的可见入口，卡片指向它既看得见也点得到。
        const up = visibleAncestorElement(e.id);
        if (up) {
          // 保留条目，但把定位【覆盖】成可见祖先。
          // 不能新增字段（target_selector 之类）：0.3 schema 不允许额外属性，
          // 加了会让校验报 "schema additionalProperties"（实测 26 项错误）。
          // 所以只改已有字段，由 nodeForElement 负责"优先取看得见的那个节点"。
          kept.push({ ...e, visible: true,
                      selector: up.selector || e.selector,
                      bbox: up.bbox || e.bbox });
        } else {
          removed.add(e.id);
        }
        continue;
      }

      if (label && visibleKeys.has(`${e.type}::${label}`)) {
        removed.add(e.id);
        continue;
      }
      kept.push(e);
    }

    if (!removed.size && kept.length === elements.length) return doc;
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

  /** 取元素对应的真实节点，**优先要看得见的那个**。
   *
   * 零尺寸隐藏条目被"升到可见祖先"时，只覆盖了 selector 字段（不能加新字段，
   * schema 不允许），它的 id 仍然映射到那个隐藏节点。所以这里必须先试选择器、
   * 或者先确认 id 映射出来的节点是可见的 —— 否则会拿回那个看不见的节点，
   * 等于点了个不存在的东西。
   */
  function nodeForElement(e) {
    if (!e) return null;
    const mapped = resolveElement ? resolveElement(e.id) : null;
    if (mapped && mapped.isConnected && elementIsVisible(mapped)) return mapped;
    if (e.selector) {
      try {
        const bySelector = document.querySelector(e.selector);
        if (bySelector && bySelector.isConnected) return bySelector;
      } catch (_) { /* 选择器不合法就退回 id 映射 */ }
    }
    return mapped && mapped.isConnected ? mapped : null;
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
      .map((e) => nodeForElement(e))
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

  /** 直接照亮一个 DOM 节点（不经过元素表）。
   *
   * 用途：核对无误之后，把用户送回原网页，并把该点的那个按钮框出来批注。
   * 那个按钮不在 elements.json 里（它属于下一页），所以走不了元素表那条路。
   */
  function spotlightNode(node, headText, bodyText) {
    if (!node || !node.isConnected) return false;
    close();
    // 复用同一套壳：四块挡板 + 黄圈 + 批注气泡
    showGroupGuide([{ id: "__spot__", label: bodyText || "", type: "button" }], 0);
    if (!stepHost) return false;
    stepHost.__nodes = [node];
    stepHost.__current = node;
    const bubble = stepHost.__bubble;
    bubble.replaceChildren();
    bubble.appendChild(el("div", "ev-step-count", headText || "就在这里"));
    if (bodyText) bubble.appendChild(el("div", "ev-step-text", bodyText));
    const actions = el("div", "ev-step-actions");
    const exit = button("知道了", () => clearStepBar());
    exit.className = "ev-step-exit";
    actions.append(exit);
    bubble.appendChild(actions);
    // 这段提示是在原网页上操作的，位置以真实节点为准
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    layoutSpotlight();
    requestAnimationFrame(layoutSpotlight);
    setTimeout(layoutSpotlight, 350);
    return true;
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
    const body = backBar(header("选一趟车", `这趟车有 ${trains.length} 个车次，点一下就是它。`));

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

      // 点车次 → 在面板里给一张确认卡（带大号「预订这趟车」）。
      // 不再只是"滚到原网页的预订按钮描个框" —— 那样用户看不出自己选了哪一趟，
      // 提示也太弱（用户反馈）。
      card.addEventListener("click", () => showView(renderTrainConfirm, t));
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

  /** 两个字符串的最长公共子串长度。标题和标签都是短句，O(n*m) 足矣。 */
  function longestCommonRun(a, b) {
    let best = 0;
    for (let i = 0; i < a.length; i += 1) {
      for (let j = 0; j < b.length; j += 1) {
        let k = 0;
        while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k += 1;
        if (k > best) best = k;
      }
    }
    return best;
  }

  /** 卡片标题和它指向的元素对不上时，改指向文字更像的那个。
   *
   * 实测过模型张冠李戴：卡片写「重点旅客预约」，目标却指到「遗失物品查找」。
   * 这类页面上元素的文字往往就是卡片标题本身，所以能机械校回来，
   * 不依赖模型输出稳定。
   *
   * 判据是【最长公共子串 >= 3 个字】，不是"标题前三个字"：
   *   「找遗失物品」 vs 「遗失物品查找」   公共"遗失物品" 4 字 → 同一个东西，不动
   *   「重点旅客预约」vs 「遗失物品查找」   公共 0 字          → 对不上，才去纠
   * 早先用"标题前三个字"，会把上面第一种误判成错配，然后把本来正确的卡改坏 ——
   * 一个"修复"比原问题更危险。
   *
   * 找不到明显更像的元素就保持原样。宁可不改，也不能瞎改。
   */
  function fixMismatchedTargets(ui, doc) {
    const elements = doc.elements || [];
    const norm = (x) => String(x || "").replace(/[\s我要的了吗？?！!，,。]/g, "");
    // 取"给人看的短标签"。
    // 不能拿 text 直接比：容器元素的 text 是整页文字，里面什么都有 ——
    // 拿它比对，公共子串永远 >= 3，校验会把任何绑定都判成"对得上"而永不修正。
    // （实测：目标指到 el_00000001 整页正文，标题「退改签」被判为匹配。）
    const labelOf = (e) => {
      if (!e) return "";
      const short = norm(e.label || e.placeholder);
      if (short) return short;
      const text = norm(e.text);
      return text.length <= 20 ? text : "";
    };

    for (const card of ui.cards || []) {
      const action = card.action || {};
      const title = norm(card.title);
      if (title.length < 2 || !action.target_element_id) continue;
      const target = elements.find((e) => e.id === action.target_element_id);
      if (!target) continue;
      const targetLabel = labelOf(target);
      // 目标本身就没个像样标签（容器），不能据它判断，直接去找更合适的
      if (targetLabel && longestCommonRun(title, targetLabel) >= 3) continue;
      let best = null;
      let bestRun = 2;                                          // 至少 3 个字才算数
      for (const e of elements) {
        if (!e.visible || e.id === action.target_element_id) continue;
        const label = labelOf(e);
        if (!label) continue;
        const run = longestCommonRun(title, label);
        if (run > bestRun) { bestRun = run; best = e; }
      }
      if (best) action.target_element_id = best.id;
    }
    return ui;
  }

  /* ---------- 选中一趟车之后的确认卡 ----------
   *
   * 用户反馈：点了车次卡片只是"滚到原网页的预订按钮并描个框"，提示太弱，
   * 而且看不出自己选的是哪一趟。所以改成在面板里给一张确认卡 + 大号预订按钮：
   *
   *     您选的这趟车
   *     G531
   *     北京南 06:08 → 上海虹桥 12:04
   *     历时 05:56   二等座 525 元
   *     [      预订这趟车      ]
   *
   * 点「预订这趟车」才去点原网页上那一行的「预订」。是否真的下单仍由用户
   * 在原网页上完成 —— 我们只把他送到门口。
   */
  const TRAINCONFIRM_CSS = `
    .ev-confirm-card { display: grid; gap: 14px; padding: 30px 32px 28px;
      border-radius: 26px;
      background: linear-gradient(160deg, #eaf5ff 0%, #ffffff 62%);
      box-shadow: 0 14px 34px rgba(23,72,124,.16), inset 0 1px 0 rgba(255,255,255,.92); }
    .ev-confirm-code { font-size: 64px; font-weight: 800; line-height: 1; color: #0b4f86; }
    .ev-confirm-route { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      font-size: 34px; font-weight: 700; color: #10314f; }
    .ev-confirm-times { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      font-size: 38px; font-weight: 800; color: #0b4f86; font-variant-numeric: tabular-nums; }
    .ev-confirm-times small { font-size: 20px; font-weight: 600; color: #5b7f9e; }
    .ev-confirm-meta { display: flex; gap: 10px 18px; flex-wrap: wrap; align-items: center;
      font-size: 22px; color: #43617c; }
    .ev-confirm-price { font-size: 34px; font-weight: 800; color: #b3521a; }
    .ev-confirm-rule { height: 1px;
      background: linear-gradient(90deg, rgba(23,72,124,.18), rgba(23,72,124,0)); }
    .ev-confirm-go { min-height: 92px; border: 0; border-radius: 20px; cursor: pointer;
      background: #0b5cad; color: #fff; font: 34px/1 "Microsoft YaHei", system-ui, sans-serif;
      font-weight: 800; box-shadow: 0 12px 28px rgba(11,92,173,.3); }
    .ev-confirm-go:hover { background: #0a4e93; }
    .ev-confirm-msg { font-size: 20px; font-weight: 700; color: #8a4a12; min-height: 24px; }
    /* 核对屏：和车次卡片同一套设计语言 */
    .ev-order { display: grid; gap: 0; padding: 0; overflow: hidden;
      border-radius: 26px;
      background:
        radial-gradient(120% 90% at 8% 0%, #ffffff 0%, rgba(255,255,255,0) 60%),
        linear-gradient(160deg, #eaf5ff 0%, #f8fcff 48%, #ffffff 100%);
      box-shadow: 0 14px 34px rgba(23,72,124,.16), 0 2px 6px rgba(23,72,124,.07),
                  inset 0 1px 0 rgba(255,255,255,.92);
      backdrop-filter: blur(14px) saturate(140%);
      -webkit-backdrop-filter: blur(14px) saturate(140%);
      color: #10314f;
      font: 20px/1.45 "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
    .ev-order-sec { display: grid; gap: 8px; padding: 22px 28px;
      border-bottom: 1px solid rgba(23,72,124,.1); }
    .ev-order-sec.ev-order-inline { grid-template-columns: 1fr auto; align-items: end; }
    .ev-order-label { font-size: 17px; font-weight: 700; letter-spacing: .08em; color: #6b93b5; }
    .ev-order-code { font-size: 60px; font-weight: 800; line-height: 1; color: #0b4f86; }
    .ev-order-route { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      font-size: 32px; font-weight: 700; }
    .ev-order-times { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      font-size: 34px; font-weight: 800; color: #0b4f86; font-variant-numeric: tabular-nums; }
    .ev-order-times small { font-size: 19px; font-weight: 600; color: #5b7f9e; }
    .ev-order-times .ev-order-dur { margin-left: 6px; }
    .ev-order-arrow { color: #6fa8d6; font-weight: 500; }
    .ev-order-seat { font-size: 32px; font-weight: 800; color: #10314f; }
    .ev-order-right { text-align: right; }
    .ev-order-price { font-size: 32px; font-weight: 800; color: #b3521a;
      font-variant-numeric: tabular-nums; }
    .ev-order-people { display: flex; gap: 12px; flex-wrap: wrap; }
    /* 乘车人卡片：和 renderPassengerCards 同尺寸（62px 头像 / 32px 名字），
       和车次卡片同质感（渐变 + 圆角 + 阴影 + 悬浮）。 */
    .ev-order-people { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px; }
    @media (max-width: 900px) { .ev-order-people { grid-template-columns: 1fr; } }
    .ev-order-pcard { display: flex; align-items: center; gap: 16px; width: 100%;
      box-sizing: border-box; padding: 18px 20px; cursor: pointer; text-align: left;
      border: 3px solid transparent; border-radius: 20px;
      background: linear-gradient(160deg, #f2f9ff 0%, #ffffff 100%);
      box-shadow: 0 8px 20px rgba(23,72,124,.11), inset 0 1px 0 rgba(255,255,255,.9);
      color: #10314f; font: 20px/1.4 "Microsoft YaHei", system-ui, sans-serif;
      transition: transform .12s ease, box-shadow .12s ease; }
    .ev-order-pcard:hover { transform: translateY(-2px);
      box-shadow: 0 14px 28px rgba(23,72,124,.17), inset 0 1px 0 rgba(255,255,255,.95); }
    .ev-order-pcard.ev-on { border-color: #0b5cad; background: #dcecfb; }
    .ev-order-pface { flex: 0 0 auto; width: 62px; height: 62px; border-radius: 50%;
      display: grid; place-items: center; background: #cfe4f7; color: #0b5cad;
      font-size: 30px; font-weight: 800; }
    .ev-order-pcard.ev-on .ev-order-pface { background: #0b5cad; color: #fff; }
    .ev-order-pname { font-size: 32px; font-weight: 800; }
    .ev-order-ptick { margin-left: auto; font-size: 30px; color: #0b5cad; font-weight: 800; }
    .ev-order-fields { display: grid; grid-template-columns: 1fr 1.4fr; gap: 12px; }
    @media (max-width: 760px) { .ev-order-fields { grid-template-columns: 1fr; } }
    .ev-order-input { box-sizing: border-box; width: 100%; min-height: 68px;
      padding: 12px 18px; border: 2px solid #b8d5ec; border-radius: 14px;
      background: #fff; color: #10314f;
      font: 26px/1.2 "Microsoft YaHei", system-ui, sans-serif; }
    .ev-order-input:focus { outline: none; border-color: #0b5cad;
      box-shadow: 0 0 0 4px rgba(11,92,173,.16); }
    .ev-order-note { font-size: 17px; color: #5b7f9e; }
    .ev-order-total { display: flex; align-items: baseline; justify-content: space-between;
      gap: 16px; padding: 22px 28px; background: rgba(11,92,173,.07); }
    .ev-order-total-label { font-size: 24px; font-weight: 700; color: #14507f; }
    .ev-order-total-price { font-size: 44px; font-weight: 800; color: #b3521a;
      font-variant-numeric: tabular-nums; }
  `;

  function renderTrainConfirm(train) {
    const body = backBar(header("您选的这趟车", "看好了就点下面的按钮，这是您自己确认的。"));
    const style = document.createElement("style");
    style.textContent = TRAINCONFIRM_CSS;
    body.appendChild(style);

    const card = el("div", "ev-confirm-card");
    card.appendChild(el("div", "ev-confirm-code", train.code));

    const route = el("div", "ev-confirm-route");
    route.append(train.from, el("span", "ev-arrow", "→"), train.to);
    card.appendChild(route);

    const times = el("div", "ev-confirm-times");
    times.append(train.depart, el("small", "", "发车"), el("span", "ev-arrow", "→"),
                 train.arrive, el("small", "", "到达"));
    if (train.duration) times.appendChild(el("small", "", `历时 ${train.duration}`));
    card.appendChild(times);

    card.appendChild(el("div", "ev-confirm-rule"));

    const meta = el("div", "ev-confirm-meta");
    if (train.price) {
      meta.append(el("span", "ev-confirm-price", `${train.priceClass || "二等座"} ${train.price} 元`));
    }
    if (train.left) meta.appendChild(el("span", "", `余票 ${train.left}`));
    card.appendChild(meta);

    const msg = el("div", "ev-confirm-msg", "");
    const go = el("button", "ev-confirm-go", "预订这趟车");
    go.type = "button";
    card.append(msg, go);

    const box = el("div", "ev-ai-confbox");
    box.appendChild(card);
    body.appendChild(box);

    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "接下来在原网页上选乘车人、确认付款，都由您自己完成。"));
    foot.appendChild(el("div", "ev-ai-foot-meta",
      `EasyView v${chrome.runtime.getManifest().version}`));
    body.appendChild(foot);

    go.addEventListener("click", async () => {
      // 【点击时重新找】这一趟的「预订」按钮，不用渲染列表时抓下的那个引用。
      //
      // 用户报的现象：第一次点没反应，第二次才弹登录框。
      // 原因是 12306 的「预订」长这样：
      //   <a href="javascript:" onclick="checkG1234('T4Zj9OCe...', '06:08', ...)" class="btn72">
      // 第一个参数是跟当次搜索会话绑定的加密令牌。结果页会定时刷新车次表，
      // 刷新后旧引用指向的行已被替换，带着【过期令牌】—— checkG1234 静默失败，
      // 表现就是"点了没反应"；等页面再刷一次，第二次点用的令牌是新的，就弹框了。
      //
      // 所以每一趟都按车次号回页面里重新定位。
      function findBookLink() {
        if (train.code) {
          const rows = [...document.querySelectorAll('tr[id^="ticket_"]')];
          const row = rows.find((r) => {
            const n = r.querySelector(".number");
            return n && n.innerText.trim() === train.code;
          });
          if (row) {
            const link = [...row.querySelectorAll("a")]
              .find((a) => /预订/.test((a.innerText || "").trim()));
            if (link) return link;
          }
        }
        // 回不到就退回渲染时的引用，至少不比原来差
        return train.bookButton && train.bookButton.isConnected ? train.bookButton : null;
      }

      const target = findBookLink();
      if (!target) {
        msg.textContent = "这一趟的「预订」按钮找不到了，请返回重新选一趟。";
        return;
      }
      try {
        // 【必须先 await 存好再点】。点「预订」会导航，内容脚本随即被销毁，
        // 没写完的存储操作会一起丢掉（实测踩过）。
        await savePendingTrain(train);
        // 12306 的「预订」是 javascript: 链接，点它就进下单流程
        target.click();
        close();
      } catch (_) {
        msg.textContent = "没能打开这一趟，请刷新网页后重试。";
      }
    });
  }

  /* ---------- 提交订单前的大字核对 ----------
   *
   * 用户同意不做"支付页”，而是在【提交订单之前】给一屏大字核对 ——
   * 车次、日期、席别、乘车人、金额，这是老人最容易搞错的一屏，
   * 而它完全不碰支付。
   *
   * 关键决定：车次信息【不靠爬下单页】，而是用我们自己手上的数据。
   * 用户选的那趟车是我们在结果页解析出来的，本来就是权威来源；
   * 去猜一个没见过的下单页的 DOM 只会引入新的不确定性。
   * 跨页面用 chrome.storage.session 带过去（点「预订」那一刻存）。
   */
  const PENDING_TRAIN_KEY = "easyview.pendingTrain";

  // 用 storage.local，不用 storage.session。
  // storage.session 默认 accessLevel 只给扩展页面和后台，【内容脚本读不到写不进】，
  // 而且是静默失败 —— 实测点了「预订」之后 session 里什么都没有。
  // 配合下面 30 分钟的过期判断，落在 local 里也不会长期残留。
  async function savePendingTrain(train) {
    try {
      await chrome.storage.local.set({
        [PENDING_TRAIN_KEY]: {
          code: train.code, from: train.from, to: train.to,
          depart: train.depart, arrive: train.arrive, duration: train.duration,
          price: train.price, priceClass: train.priceClass, left: train.left,
          savedAt: Date.now()
        }
      });
    } catch (_) { /* 存不下就算了，核对页会退回普通卡片列表 */ }
  }

  async function loadPendingTrain() {
    try {
      const got = await chrome.storage.local.get(PENDING_TRAIN_KEY);
      const t = got && got[PENDING_TRAIN_KEY];
      if (!t) return null;
      // 超过 30 分钟就不认了，免得下次打开还挂着上一次的车次
      if (Date.now() - (t.savedAt || 0) > 30 * 60 * 1000) return null;
      return t;
    } catch (_) {
      return null;
    }
  }

  function renderOrderConfirm(train, passengers) {
    const body = backBar(header("请核对一下", "这是您要买的车票，看清楚了再提交。"));

    // 【必须注入样式】。
    // 这一屏用的 .ev-order-* 规则都写在 TRAINCONFIRM_CSS 里，而那段样式原先
    // 只在 renderTrainConfirm 里 append 过 —— 核对屏从来没注入，所以它一直是
    // 无样式的裸文字：车次号该 60px 实际 20px，乘车人卡该 62px 头像实际是一行
    // 13px 的字。用户说"设计太差"，根因就是这个漏掉的一行。
    // 靠 tools/preview_views.py 量出字号不对才发现，肉眼审代码看不出来。
    const style = document.createElement("style");
    style.textContent = TRAINCONFIRM_CSS;
    body.appendChild(style);

    const card = el("div", "ev-order");

    // ---- 车次区（和车次卡片同一套：大号车次号 + 线路 + 时刻）----
    const sec1 = el("div", "ev-order-sec");
    sec1.appendChild(el("div", "ev-order-label", "车次"));
    sec1.appendChild(el("div", "ev-order-code", train.code));
    const route = el("div", "ev-order-route");
    route.append(train.from, el("span", "ev-order-arrow", "→"), train.to);
    sec1.appendChild(route);
    const times = el("div", "ev-order-times");
    times.append(train.depart, el("small", "", "开"), el("span", "ev-order-arrow", "→"),
                 train.arrive, el("small", "", "到"));
    if (train.duration) times.appendChild(el("small", "ev-order-dur", `历时 ${train.duration}`));
    sec1.appendChild(times);
    card.appendChild(sec1);

    // ---- 席别 ----（不写单价，价钱只在最后合计那一处出现，少一处让人对不上）
    const sec2 = el("div", "ev-order-sec");
    sec2.appendChild(el("div", "ev-order-label", "座位"));
    sec2.appendChild(el("div", "ev-order-seat", train.priceClass || "二等座"));
    card.appendChild(sec2);

    // ---- 乘车人 ----
    // 用户反馈核对屏"设计太差"，要求乘车人这里和乘车人卡片一致。
    // 原来是 44px 头像 + 26px 名字的小胶囊，现在是 62px 圆头像 + 32px 名字的
    // 大卡，两列排 —— 和 renderPassengerCards 同一套尺寸，也和车次卡片同一套
    // 渐变/圆角/阴影/悬浮。
    const picked = new Set((passengers || []).filter((p) => p.checked).map((p) => p.name));
    const sec3 = el("div", "ev-order-sec");
    sec3.appendChild(el("div", "ev-order-label", "乘车人（点一下选中）"));
    const people = el("div", "ev-order-people");
    if ((passengers || []).length) {
      for (const person of passengers) {
        const card = el("button", `ev-order-pcard${person.checked ? " ev-on" : ""}`);
        card.type = "button";
        card.appendChild(el("span", "ev-order-pface", person.name.slice(0, 1)));
        card.appendChild(el("span", "ev-order-pname", person.name));
        card.appendChild(el("span", "ev-order-ptick", person.checked ? "✓" : ""));
        card.addEventListener("click", () => {
          const result = globalThis.EasyViewPassengers
            ? globalThis.EasyViewPassengers.select(person) : { ok: false };
          if (!result.ok) return;
          const now = Boolean(person.node && person.node.checked);
          person.checked = now;
          card.classList.toggle("ev-on", now);
          card.querySelector(".ev-order-ptick").textContent = now ? "✓" : "";
          if (now) picked.add(person.name); else picked.delete(person.name);
          refreshTotal();
        });
        people.appendChild(card);
      }
    } else {
      people.appendChild(el("span", "ev-order-warn", "原网页上还没勾乘车人"));
    }
    sec3.appendChild(people);
    card.appendChild(sec3);

    // ---- 乘车人信息填写（新增一位）。只在本机用，不发送。----
    const sec4 = el("div", "ev-order-sec");
    sec4.appendChild(el("div", "ev-order-label", "要新增一位乘车人？在这里填"));
    const row = el("div", "ev-order-fields");
    const nameInput = el("input", "ev-order-input");
    nameInput.type = "text";
    nameInput.placeholder = "姓名";
    const idInput = el("input", "ev-order-input");
    idInput.type = "text";
    idInput.placeholder = "身份证号";
    row.append(nameInput, idInput);
    sec4.appendChild(row);
    sec4.appendChild(el("div", "ev-order-note",
      "填在这里的内容不会发到任何服务器，只在您这台电脑上用。"));
    card.appendChild(sec4);

    // ---- 合计：单独一块，全屏最大 ----
    const total = el("div", "ev-order-total");
    const totalLabel = el("span", "ev-order-total-label", "");
    const totalPrice = el("span", "ev-order-total-price", "");
    total.append(totalLabel, totalPrice);
    card.appendChild(total);

    function refreshTotal() {
      const n = picked.size;
      totalLabel.textContent = n ? `共 ${n} 位` : "还没选乘车人";
      totalPrice.textContent = (train.price && n) ? `${train.price * n} 元` : "—";
    }
    refreshTotal();

    const msg = el("div", "ev-confirm-msg", "");
    const go = el("button", "ev-confirm-go", "核对无误，去原网页预定");
    go.type = "button";
    card.append(msg, go);

    const box = el("div", "ev-ai-orderbox");
    box.appendChild(card);
    body.appendChild(box);

    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "点下面的按钮不会替您下单，只会把原网页上该按的地方指给您。"));
    foot.appendChild(el("div", "ev-ai-foot-meta",
      `EasyView v${chrome.runtime.getManifest().version}`));
    body.appendChild(foot);

    go.addEventListener("click", async () => {
      const extraName = nameInput.value.trim();
      const extraId = idInput.value.trim();
      if (!picked.size && !extraName) {
        msg.textContent = "先选一位乘车人，或者把姓名填上。";
        return;
      }
      if (extraName && !extraId) {
        msg.textContent = "新增乘车人需要填身份证号。";
        return;
      }

      // 原网页上可能是"提交订单"，也可能是"下一步"，都试
      const candidates = [...document.querySelectorAll("a, button, input[type='submit']")];
      const submit = candidates.find((n) => {
        const t = (n.innerText || n.value || "").replace(/\s+/g, "");
        return /提交订单|确认订单|提交|下一步|确认/.test(t) && elementIsVisible(n);
      });

      const tip = extraName
        ? `原网页上请在「${extraName}」那一行点一下，然后按下面的按钮。`
        : "请在原网页上确认订单。";

      if (submit) {
        // 用户要的效果：背景变暗 + 高亮批注，把人送回原页面自己按。
        spotlightNode(submit, "最后一步，在原网页上按这里", tip);
        return;
      }
      msg.textContent = "没找到原网页上的提交按钮，请自己找一下。";
    });
  }

  /* ---------- 乘车人卡片（12306 乘车人页）----------
   *
   * 这一页要登录态，我的自动化浏览器进不去，所以没有实测数据 ——
   * 解析器写成"读不到就返回空、上层如实说明"，不假装成功。
   */
  const PASSENGER_CSS = `
    .ev-passengers { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; }
    @media (max-width: 900px) { .ev-passengers { grid-template-columns: 1fr; } }
    .ev-passenger { display: flex; align-items: center; gap: 16px; width: 100%;
      text-align: left; box-sizing: border-box; padding: 24px 26px; border: 3px solid transparent;
      border-radius: 22px; cursor: pointer;
      background: linear-gradient(160deg, #eef7ff 0%, #ffffff 100%);
      box-shadow: 0 10px 26px rgba(23,72,124,.13), inset 0 1px 0 rgba(255,255,255,.9);
      color: #10314f; font: 20px/1.4 "Microsoft YaHei", system-ui, sans-serif; }
    .ev-passenger:hover { transform: translateY(-2px); }
    .ev-passenger.ev-picked { border-color: #0b5cad; background: #dcecfb; }
    .ev-passenger-face { flex: 0 0 auto; width: 62px; height: 62px; border-radius: 50%;
      display: grid; place-items: center; background: #cfe4f7; color: #0b5cad;
      font-size: 30px; font-weight: 800; }
    .ev-passenger-name { font-size: 32px; font-weight: 800; }
    .ev-passenger-tick { margin-left: auto; font-size: 30px; color: #0b5cad; font-weight: 800; }
  `;

  function renderPassengerCards(passengers) {
    const body = backBar(header("这是给谁买票？", "点一下名字就是选他了，可以选多位。"));
    const style = document.createElement("style");
    style.textContent = PASSENGER_CSS;
    body.appendChild(style);

    const wrap = el("div", "ev-passengers");
    const cards = new Map();

    for (const p of passengers) {
      const card = el("button", `ev-passenger${p.checked ? " ev-picked" : ""}`);
      card.type = "button";
      card.appendChild(el("span", "ev-passenger-face", p.name.slice(0, 1)));
      card.appendChild(el("span", "ev-passenger-name", p.name));
      const tick = el("span", "ev-passenger-tick", p.checked ? "✓" : "");
      card.appendChild(tick);

      card.addEventListener("click", () => {
        const result = globalThis.EasyViewPassengers
          ? globalThis.EasyViewPassengers.select(p)
          : { ok: false };
        if (!result.ok) {
          showError("这一位没能选上，页面可能刚变过。请在原网页上自己勾一下。", null);
          return;
        }
        const nowChecked = Boolean(p.node && p.node.checked);
        p.checked = nowChecked;
        card.classList.toggle("ev-picked", nowChecked);
        tick.textContent = nowChecked ? "✓" : "";
      });

      wrap.appendChild(card);
      cards.set(p.name, card);
    }

    const box = el("div", "ev-ai-passbox");
    box.appendChild(wrap);
    body.appendChild(box);

    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "选好之后，后面的提交和付款仍然在原网页上由您自己确认。"));
    foot.appendChild(el("div", "ev-ai-foot-meta",
      `乘车人来自当前网页，没有发出去。EasyView v${chrome.runtime.getManifest().version}`));
    body.appendChild(foot);
  }

  /* ---------- 视图栈：每一步都能退回去 ----------
   *
   * 面板内的几个视图（卡片列表 → 购票表单）压成一个栈，
   * 深度大于 1 时每个视图顶部出现「← 返回上一步」。
   * 另外提供一个「返回上一个网页」，走浏览器历史。
   *
   * 这两件事必须分开：栈退的是"我在面板里走到哪了"，
   * 历史退的是"我从哪个网页过来的"，混在一起会让人莫名跳走。
   */
  const viewStack = [];

  function showView(render, ...args) {
    viewStack.push({ render, args });
    render(...args);
  }

  function goBackView() {
    if (viewStack.length <= 1) return false;
    viewStack.pop();
    const top = viewStack[viewStack.length - 1];
    top.render(...top.args);
    return true;
  }

  /** 给一个视图装返回条。没有可退的就不显示，不留空条。 */
  function backBar(body) {
    const bar = el("div", "ev-backbar");
    if (viewStack.length > 1) {
      bar.appendChild(button("← 返回上一步", () => goBackView()));
    }
    if (window.history.length > 1) {
      const back = button("← 返回上一个网页", () => {
        try { window.history.back(); } catch (_) { /* 退不了就算了，不弹错 */ }
      });
      bar.appendChild(back);
    } else {
      // 新标签页里 history 只有一条，history.back() 不会发生任何事 ——
      // 用户反馈"车次界面回不去"就是这个原因：按钮根本不出现。
      // 改成请后台把这页关掉，关掉自然就回到原来那个标签页。
      bar.appendChild(button("← 关上这页，回去", () => {
        try {
          chrome.runtime.sendMessage({ type: "easyview:close-tab" });
        } catch (_) { /* 发不出去就算了，用户还能自己关标签页 */ }
      }));
    }
    if (bar.childElementCount) body.insertBefore(bar, body.firstChild);
    return body;
  }

  /* ---------- 购票表单卡片 ----------
   *
   * 用户要的是"在卡片里直接填"，不是聚光灯指来指去。所以这里不再高亮页面，
   * 而是把出发地/到达地/日期做成卡片里的输入框，填完点一下直接查车次。
   *
   * 为什么能真正驱动 12306：站点的站名不能直接写值（实测过，站码不会写入），
   * 必须设置后再去点自动补全的候选。那套逻辑在 site/12306.js 里，
   * 而它和本文件在【同一个隔离世界】（实测 EasyView12306 可见），所以直接调。
   */
  const BOOKFORM_CSS = `
    .ev-bookform { display: grid; gap: 22px; padding: 26px 28px 24px;
      border-radius: 26px;
      background: linear-gradient(160deg, #eef7ff 0%, #ffffff 62%);
      box-shadow: 0 12px 30px rgba(23,72,124,.14), inset 0 1px 0 rgba(255,255,255,.92); }
    .ev-bf-field { display: grid; gap: 10px; }
    .ev-bf-q { font-size: 28px; font-weight: 800; color: #10314f; }
    .ev-bf-input { width: 100%; box-sizing: border-box; min-height: 76px;
      padding: 14px 20px; border: 2px solid #b8d5ec; border-radius: 16px;
      background: #fff; color: #10314f; font: 30px/1.2 "Microsoft YaHei", system-ui, sans-serif;
      font-variant-numeric: tabular-nums; }
    .ev-bf-input:focus { outline: none; border-color: #0b5cad;
      box-shadow: 0 0 0 4px rgba(11,92,173,.16); }
    .ev-bf-quick { display: flex; gap: 10px; flex-wrap: wrap; }
    .ev-bf-quick button { font: 19px/1 "Microsoft YaHei", system-ui, sans-serif;
      padding: 12px 18px; border: 2px solid #b8d5ec; border-radius: 999px;
      background: #fff; color: #14507f; cursor: pointer; font-weight: 700; }
    .ev-bf-quick button:hover { background: #f0f8ff; border-color: #7fb2dd; }
    .ev-bf-go { min-height: 84px; border: 0; border-radius: 18px; cursor: pointer;
      background: #0b5cad; color: #fff; font: 30px/1 "Microsoft YaHei", system-ui, sans-serif;
      font-weight: 800; box-shadow: 0 10px 24px rgba(11,92,173,.28); }
    .ev-bf-go:hover { background: #0a4e93; }
    .ev-bf-go:disabled { opacity: .55; cursor: default; box-shadow: none; }
    .ev-bf-msg { font-size: 20px; font-weight: 700; color: #8a4a12; min-height: 26px; }
    .ev-backbar { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 18px; }
    .ev-backbar button { font: 20px/1 "Microsoft YaHei", system-ui, sans-serif;
      padding: 14px 22px; border: 2px solid #bcd7ee; border-radius: 999px;
      background: #fff; color: #14507f; cursor: pointer; font-weight: 700; }
    .ev-backbar button:hover { background: #f2f9ff; border-color: #7fb2dd; }
  `;

  function dateValue(daysAhead) {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function renderBookingForm() {
    const site = globalThis.EasyView12306;
    const body = backBar(header("买火车票", "在这几格里填好，点下面的按钮就能查车次。"));
    const style = document.createElement("style");
    style.textContent = BOOKFORM_CSS;
    body.appendChild(style);

    const box = el("div", "ev-bookform");

    function field(question) {
      const wrap = el("div", "ev-bf-field");
      wrap.appendChild(el("div", "ev-bf-q", question));
      const input = el("input", "ev-bf-input");
      input.type = "text";
      wrap.appendChild(input);
      return { wrap, input };
    }

    const from = field("您要从哪里出发？");
    const to = field("您要去哪里？");
    const when = field("哪天走？");

    // 用页面上已有的值预填，省得重填一遍
    const page = (selector) => {
      const n = document.querySelector(selector);
      return n && n.value ? String(n.value).trim() : "";
    };
    const pageFrom = page("#fromStationText");
    const pageTo = page("#toStationText");
    const pageDate = page("#train_date");
    if (pageFrom && !/简拼|全拼|汉字/.test(pageFrom)) from.input.value = pageFrom;
    if (pageTo && !/简拼|全拼|汉字/.test(pageTo)) to.input.value = pageTo;
    when.input.value = /^\d{4}-\d{2}-\d{2}$/.test(pageDate) ? pageDate : dateValue(1);

    const quick = el("div", "ev-bf-quick");
    for (const [label, days] of [["今天", 0], ["明天", 1], ["后天", 2]]) {
      quick.appendChild(button(label, () => { when.input.value = dateValue(days); }));
    }
    when.wrap.appendChild(quick);

    box.append(from.wrap, to.wrap, when.wrap);

    const msg = el("div", "ev-bf-msg", "");
    const go = el("button", "ev-bf-go", "查车次");
    go.type = "button";
    box.append(msg, go);
    body.appendChild(box);

    const foot = el("div", "ev-ai-foot");
    foot.appendChild(el("div", "", "填的内容不会发到任何服务器，只在您这台电脑上用。"));
    foot.appendChild(el("div", "ev-ai-foot-meta", `EasyView v${chrome.runtime.getManifest().version}`));
    body.appendChild(foot);

    go.addEventListener("click", async () => {
      const dep = from.input.value.trim();
      const arr = to.input.value.trim();
      const date = when.input.value.trim();
      if (!dep || !arr) { msg.textContent = "出发地和目的地都要填上。"; return; }
      if (!site || typeof site.setDeparture !== "function") {
        msg.textContent = "这个页面暂时填不了，请刷新后重试。";
        return;
      }
      go.disabled = true;
      msg.textContent = "正在填，稍等…";
      try {
        const a = await site.setDeparture(dep);
        const b = await site.setArrival(arr);
        const c = await site.setDate(date);
        if (!a || !a.ok) { msg.textContent = `「${dep}」这个站名没填进去，换个写法试试（比如"北京南"）。`; go.disabled = false; return; }
        if (!b || !b.ok) { msg.textContent = `「${arr}」这个站名没填进去，换个写法试试。`; go.disabled = false; return; }
        if (!c || !c.ok) { msg.textContent = "日期没填进去，换个日期试试。"; go.disabled = false; return; }
        msg.textContent = "填好了，正在查车次…";
        await site.submitSearch();
        close();
      } catch (error) {
        msg.textContent = "没能填进去，请刷新网页后重试。";
        go.disabled = false;
      }
    });

    from.input.focus();
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
      // 绑定之后校验一次：卡片标题和它指向的元素是否真的对得上
      fixMismatchedTargets(ui, pendingElements);
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
    // 卡片列表是视图栈的栈底 —— 早先直接调 renderResult，栈里没有它，
    // 于是购票表单里的「返回上一步」永远不出现（栈深只有 1）。
    viewStack.length = 0;
    showView(renderResult, ui);
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

      // 12306 乘车人页：乘车人也是结构化数据，本地读，不调模型不用同意。
      // 这一页要登录，自动化测试进不去，所以解析器允许读不到 ——
      // 读不到就落到下面的通用路径，不硬撑。
      if (globalThis.EasyViewPassengers) {
        let people = [];
        try {
          people = globalThis.EasyViewPassengers.read();
        } catch (_) {
          people = [];
        }
        if (people.length) {
          lastPayload = null;
          busy = false;
          viewStack.length = 0;
          // 有刚选好的车次 → 先给一屏大字核对（车次+乘车人+金额），
          // 这是老人最容易搞错的一屏，而且完全不碰支付。
          const pending = await loadPendingTrain();
          if (pending && pending.code) {
            showView(renderOrderConfirm, pending, people);
          } else {
            showView(renderPassengerCards, people);
          }
          return;
        }
      }

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
          // 同上：车次列表是根视图，必须进栈，否则点车次之后退不回来。
          viewStack.length = 0;
          showView(renderTrainCards, trains);
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

  globalThis.EasyViewAI = {
    open,
    // 测试钩子：让端到端测试能【确定性地】验证绑定校验，
    // 而不是干等那个间歇性错配自己出现。
          fixMismatchedTargets,
      // 预览钩子：核对屏只在登录后的乘车人页出现，我没法走到那儿。
      // 有了它，本地一个测试页就能把这几屏渲染出来量尺寸、查溢出。
    preview: {
      order: (train, passengers) => renderOrderConfirm(train, passengers),
      passengers: (people) => renderPassengerCards(people),
      booking: () => renderBookingForm(),
      trains: (trains) => renderTrainCards(trains)
    }
  };
  open();
})();
