(() => {
  "use strict";

  if (globalThis.EasyViewGeneric) {
    globalThis.EasyViewGeneric.open();
    return;
  }

  const ROOT_ID = "easyview-generic-root";
  const MAX_CANDIDATES = 10;
  const MAX_CARDS = 6;
  const unsafeWords = /登录|注册|密码|验证码|支付|付款|下单|购买|结算|充值|退订|注销|删除|确认|提交|转账|汇款|银行卡|身份证|实名|login|sign.?in|register|password|checkout|payment|delete|logout|unsubscribe|submit/i;
  const noiseWords = /^(更多|查看更多|了解更多|详情|查看详情|点击查看|进入|打开|返回|首页|上一页|下一页|[>›→])$/i;
  const taskWords = /查询|搜索|查找|预约|办理|服务|网点|帮助|联系|客服|邮寄|订单|天气|路线|票|医疗|挂号|账单|费用|价格|余额|进度|政策|指南|search|find|help|contact|service|order|booking|support/i;
  const icons = [
    [/搜索|查询|查找|search|find/i, ["search", "⌕"]],
    [/时间|日期|预约|日历|预报|calendar|booking/i, ["calendar", "▦"]],
    [/电话|联系|客服|contact|support|phone/i, ["phone", "☎"]],
    [/地点|地址|网点|地图|附近|location|map/i, ["location", "⌖"]],
    [/火车|铁路|车票|train/i, ["train", "🚆"]],
    [/公交|巴士|bus/i, ["bus", "🚌"]],
    [/医院|医疗|挂号|hospital/i, ["hospital", "+"]],
    [/政策|政务|政府|government/i, ["government", "▤"]],
    [/费用|价格|账单|支付|payment|price/i, ["payment", "¥"]],
    [/帮助|指南|常见问题|help|faq/i, ["help", "?"]],
    [/个人|账户|我的|user|account/i, ["user", "♙"]],
    [/警告|提醒|预警|warning/i, ["warning", "!"]],
    [/文件|资料|订单|报刊|document/i, ["document", "▤"]]
  ];

  const host = document.createElement("div");
  host.id = ROOT_ID;
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("src/styles.css");
  const overlay = document.createElement("div");
  overlay.className = "ev-overlay ev-generic";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "当前网页敬老版候选");
  overlay.hidden = true;
  const panel = document.createElement("main");
  panel.className = "ev-panel";
  panel.tabIndex = -1;
  overlay.append(panel);
  shadow.append(stylesheet, overlay);
  (document.documentElement || document.body).append(host);

  const state = { candidates: [], selected: new Set(), sourceUrl: "", scanId: 0, previousFocus: null };
  overlay.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      const focusable = [...shadow.querySelectorAll("button:not(:disabled), input:not(:disabled)")].filter(visible);
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
  });

  function clean(text, limit = 48) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function visible(node) {
    if (!(node instanceof Element) || !node.isConnected || !node.getClientRects().length) return false;
    for (let parent = node; parent && parent instanceof Element; parent = parent.parentElement) {
      if (parent.hidden || parent.inert || parent.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  }

  function excluded(node) {
    return !!node.closest("footer, [role='contentinfo'], [role='dialog'], [aria-modal='true'], [class*='advert'], [class*='-ad-'], [id*='advert'], [id*='cookie'], [class*='cookie']");
  }

  function labelOf(node) {
    return clean(node.getAttribute("aria-label") || node.innerText || node.getAttribute("title") || "");
  }

  function safeUrl(raw) {
    if (!raw || raw.trim() === "#") return null;
    try {
      const url = new URL(raw, location.href);
      if (!/^https?:$/.test(url.protocol) || url.origin !== location.origin || url.username || url.password) return null;
      if (url.href === location.href || /\/(logout|delete|remove|payment|pay|checkout)(?:[/?#]|$)/i.test(url.pathname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function iconFor(title) {
    for (const [pattern, icon] of icons) if (pattern.test(title)) return icon;
    return ["info", "i"];
  }

  function goodTitle(title) {
    return title.length >= 2 && title.length <= 36 && !noiseWords.test(title) && !unsafeWords.test(title);
  }

  function addCandidate(list, entry) {
    if (!goodTitle(entry.title)) return;
    const rect = entry.node.getBoundingClientRect();
    const main = !!entry.node.closest("main, [role='main']");
    const nav = !!entry.node.closest("nav, [role='navigation']");
    const task = taskWords.test(entry.title);
    entry.score = (main ? 40 : nav ? 25 : 10) + (task ? 25 : 0) +
      (entry.kind === "form" ? 20 : entry.kind === "link" ? 15 : 0) +
      (entry.title.length >= 4 && entry.title.length <= 16 ? 10 : 0) - Math.min(30, Math.max(0, rect.top) / 180);
    entry.order = list.length;
    list.push(entry);
  }

  function formTitle(form) {
    const labelledBy = form.getAttribute("aria-labelledby");
    const labelled = labelledBy && document.getElementById(labelledBy);
    const heading = form.querySelector("legend, h1, h2, h3, h4");
    const nearbyHeading = form.previousElementSibling?.matches("h1, h2, h3, h4") ? form.previousElementSibling : null;
    const submit = form.querySelector("button[type='submit'], button:not([type])");
    const submitText = submit && visible(submit) ? labelOf(submit) : "";
    return clean(form.getAttribute("aria-label") || labelled?.innerText || heading?.innerText || nearbyHeading?.innerText || submitText || "");
  }

  function fieldLabel(field) {
    const idLabel = field.id ? document.querySelector(`label[for="${CSS.escape(field.id)}"]`) : null;
    return clean(field.labels?.[0]?.innerText || idLabel?.innerText || field.getAttribute("aria-label") || field.getAttribute("placeholder") || "", 24);
  }

  function collect() {
    const found = [];
    const scope = document.body || document.documentElement;
    if (!scope) return found;

    for (const form of scope.querySelectorAll("form")) {
      if (!visible(form) || excluded(form)) continue;
      if (form.querySelector("input[type='password']") || unsafeWords.test(form.getAttribute("action") || "")) continue;
      const controls = [...form.querySelectorAll("input, select, textarea")].filter(field =>
        visible(field) && !field.disabled && !["hidden", "password", "file", "submit", "button", "reset"].includes(field.type));
      if (!controls.length || controls.length > 8) continue;
      const labels = controls.map(fieldLabel).filter(Boolean).slice(0, 3);
      const title = formTitle(form);
      const formText = clean(`${title} ${labels.join(" ")}`, 160);
      if (!title || unsafeWords.test(formText) || controls.some(field => /password|email|tel/.test(field.type))) continue;
      addCandidate(found, { kind: "form", title, node: form, target: controls[0], detail: labels.length ? `回到原网页填写：${labels.join("、")}` : "回到原网页填写表单" });
    }

    for (const anchor of scope.querySelectorAll("a[href]")) {
      if (!visible(anchor) || excluded(anchor) || anchor.hasAttribute("download")) continue;
      const href = safeUrl(anchor.getAttribute("href"));
      const title = labelOf(anchor);
      if (!href || !title || unsafeWords.test(anchor.getAttribute("href"))) continue;
      const destination = new URL(href);
      addCandidate(found, { kind: "link", title, node: anchor, href, detail: `打开当前网站：${clean(destination.pathname + destination.hash, 80)}` });
    }

    const main = scope.querySelector("main, [role='main']");
    if (main) for (const heading of main.querySelectorAll("h2, h3")) {
      if (!visible(heading) || excluded(heading)) continue;
      const title = clean(heading.innerText, 48);
      if (!title || heading.closest("form")) continue;
      addCandidate(found, { kind: "section", title, node: heading, detail: "定位到当前网页的这一段" });
    }

    found.sort((a, b) => b.score - a.score || a.order - b.order);
    const seen = new Set();
    return found.filter(item => {
      const titleKey = item.title.toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
      const key = `${item.kind}:${item.href || titleKey}`;
      if (seen.has(key) || seen.has(`title:${titleKey}`)) return false;
      seen.add(key);
      seen.add(`title:${titleKey}`);
      return true;
    }).slice(0, MAX_CANDIDATES).map((item, index) => ({ ...item, id: index }));
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function button(title, action, primary = false) {
    const node = element("button", `ev-button ${primary ? "ev-button-primary" : "ev-button-secondary"}`, title);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }

  function pageHeader(summary, speechSegments = null) {
    globalThis.EasyViewSpeech?.detach();
    panel.replaceChildren();
    const header = element("header", "ev-header");
    const copy = element("div");
    copy.append(element("h1", "", "当前网页敬老版"), element("p", "", summary));
    const exit = element("button", "ev-exit", "退出敬老版");
    exit.type = "button";
    exit.addEventListener("click", close);
    const actions = element("div", "ev-header-actions");
    actions.append(exit);
    header.append(copy, actions);
    panel.append(header);
    if (speechSegments) globalThis.EasyViewSpeech?.attach(actions, panel, speechSegments);
    const content = element("div", "ev-content");
    panel.append(content);
    panel.focus({ preventScroll: true });
    return content;
  }

  function notice(content, message, error = false) {
    content.prepend(element("p", `ev-message ${error ? "ev-error" : ""}`, message));
  }

  function renderPreview(message = "") {
    const candidatesToRead = state.candidates.slice(0, MAX_CARDS);
    const content = pageHeader(`从 ${location.hostname} 当前页面找到的入口，请先选择。`, [
      { label: "页面说明", text: "请选择要显示的事项。点选之后，再按生成敬老版。" },
      ...candidatesToRead.map((item, index) => ({
        label: item.title,
        text: `第 ${index + 1} 项，${item.title}。`
      }))
    ]);
    content.append(element("p", "ev-message ev-generic-intro", "候选卡只来自这张网页的可见内容。打开入口后，业务仍在原网页办理。"));
    if (message) notice(content, message, true);
    if (!state.candidates.length) {
      content.append(element("p", "ev-message ev-error", "当前页面没有找到可靠的导航或表单入口。可以等页面加载完成后重试，也可以直接使用原网页。"));
    } else {
      const list = element("div", "ev-generic-options");
      for (const item of state.candidates) {
        const row = element("label", "ev-generic-option");
        const check = element("input");
        check.type = "checkbox";
        check.checked = state.selected.has(item.id);
        check.addEventListener("change", () => {
          if (check.checked && state.selected.size >= MAX_CARDS) {
            check.checked = false;
            limitMessage.textContent = `最多选择 ${MAX_CARDS} 项，请先取消一项。`;
            return;
          }
          limitMessage.textContent = "";
          if (check.checked) state.selected.add(item.id);
          else state.selected.delete(item.id);
          generate.disabled = !state.selected.size;
          count.textContent = `已选择 ${state.selected.size} 项，最多选择 ${MAX_CARDS} 项`;
        });
        const copy = element("span", "ev-generic-option-copy");
        copy.append(element("strong", "", item.title), element("small", "", item.detail));
        row.append(check, copy);
        list.append(row);
      }
      content.append(list);
    }
    const count = element("p", "ev-message ev-generic-count", `已选择 ${state.selected.size} 项，最多选择 ${MAX_CARDS} 项`);
    const limitMessage = element("p", "ev-message ev-generic-limit", "");
    limitMessage.setAttribute("role", "status");
    content.append(count, limitMessage);
    const actions = element("div", "ev-generic-controls");
    const generate = button("生成敬老版", () => renderCards(), true);
    generate.disabled = !state.selected.size;
    actions.append(generate, button("重新读取当前页", scan));
    content.append(actions);
    content.querySelector(".ev-generic-option input")?.focus({ preventScroll: true });
  }

  function renderCards(message = "") {
    const selected = state.candidates.filter(item => state.selected.has(item.id)).slice(0, MAX_CARDS);
    const speechSegments = [
      { label: "页面说明", text: "以下是为您找到的入口。点击卡片后，请在原网页核对并完成业务。" },
      ...selected.map((item, index) => ({
        label: item.title,
        text: `第 ${index + 1} 项，${item.title}。${item.kind === "form" ? "回到原网页填写。" : item.kind === "section" ? "找到原网页的这一段。" : "打开原网页的对应页面。"}`
      }))
    ];
    const content = pageHeader(`当前网页：${clean(document.title || location.hostname, 42)}`, speechSegments);
    content.append(element("p", "ev-message ev-generic-intro", "点击卡片会打开当前站点的页面，或返回原网页定位。请在原网页核对并完成业务。"));
    if (message) notice(content, message, true);
    const list = element("div", "ev-actions");
    for (const [index, item] of selected.entries()) {
      const card = element("button", "ev-card");
      card.type = "button";
      const [name, symbol] = iconFor(item.title);
      card.dataset.icon = name;
      const icon = element("span", "ev-card-icon", symbol);
      icon.setAttribute("aria-hidden", "true");
      const copy = element("span", "ev-card-copy");
      copy.append(element("strong", "", item.title), element("span", "", item.detail));
      card.append(icon, copy);
      card.addEventListener("click", () => activate(item));
      const listen = globalThis.EasyViewSpeech?.cardButton(speechSegments[index + 1]);
      if (listen) {
        const wrapper = element("div", "ev-card-with-listen");
        wrapper.append(card, listen);
        list.append(wrapper);
      } else list.append(card);
    }
    content.append(list);
    const controls = element("div", "ev-generic-controls");
    controls.append(button("重新选择卡片", () => renderPreview()), button("重新读取当前页", scan));
    content.append(controls);
  }

  function activate(item) {
    if (state.sourceUrl !== location.href || !item.node.isConnected || !visible(item.node)) {
      renderCards("原网页内容已变化，请重新读取当前页。");
      return;
    }
    if (item.kind === "link") {
      const currentHref = safeUrl(item.node.getAttribute("href"));
      if (currentHref !== item.href) {
        renderCards("网页入口已经变化，请重新读取当前页。");
        return;
      }
      close();
      location.assign(item.href);
      return;
    }
    if (item.kind === "form" && (!item.target.isConnected || !visible(item.target))) {
      renderCards("原网页表单已经变化，请重新读取当前页。");
      return;
    }
    close();
    const target = item.kind === "form" ? item.target : item.node;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (item.kind === "form") target.focus({ preventScroll: true });
    else {
      if (!target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
        target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
      }
      target.focus({ preventScroll: true });
    }
  }

  function close() {
    globalThis.EasyViewSpeech?.detach();
    overlay.hidden = true;
    if (state.previousFocus?.isConnected) state.previousFocus.focus({ preventScroll: true });
  }

  function waitForStablePage() {
    return new Promise(resolve => {
      if (!document.body) return resolve();
      let quietTimer;
      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 450);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const maxTimer = setTimeout(finish, 2200);
      quietTimer = setTimeout(finish, 450);
    });
  }

  async function scan() {
    const scanId = ++state.scanId;
    overlay.hidden = false;
    const content = pageHeader("正在读取当前网页的可见入口…");
    content.append(element("p", "ev-message", "页面加载完成后会显示可选卡片。"));
    await waitForStablePage();
    if (scanId !== state.scanId || overlay.hidden) return;
    state.sourceUrl = location.href;
    state.candidates = collect();
    state.selected = new Set(state.candidates.slice(0, MAX_CARDS).map(item => item.id));
    renderPreview();
  }

  function open() {
    if (!host.isConnected) (document.documentElement || document.body).append(host);
    if (overlay.hidden) state.previousFocus = document.activeElement;
    overlay.hidden = false;
    scan();
  }

  globalThis.EasyViewGeneric = { open };
  open();
})();
