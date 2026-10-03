/* 原网页阅读辅助：只控制当前标签页的浏览器缩放，不复制或改写站点表单。 */
(() => {
  "use strict";

  if (globalThis.EasyViewPageAssist) {
    globalThis.EasyViewPageAssist.refresh();
    return;
  }

  let host = null;
  let status = null;
  let panelHidden = false;
  let revision = 0;

  function makeButton(label, title, onClick) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    node.setAttribute("aria-label", title);
    node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  function mount() {
    if (!host) {
      host = document.createElement("div");
      host.id = "easyview-page-assist";
      host.style.setProperty("position", "fixed", "important");
      host.style.setProperty("left", "18px", "important");
      host.style.setProperty("bottom", "18px", "important");
      host.style.setProperty("z-index", "2147483646", "important");
      const shadow = host.attachShadow({ mode: "open" });
      // 缩放控制属于扩展自身；不要把点击交给原站的图片预览等代理事件。
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
        shadow.addEventListener(type, (event) => event.stopPropagation());
      }
      if (globalThis.EasyViewBrand) {
        try {
          const theme = globalThis.EasyViewBrand.extract();
          globalThis.EasyViewBrand.apply(theme, shadow);
        } catch (_) { /* 提取站点颜色失败时继续使用默认配色。 */ }
      }
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        .ev-page-zoom { display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 36px);
          box-sizing: border-box; padding: 9px; border: 2px solid var(--ev-brand, #07566c); border-radius: 18px;
          background: #fffdf8; box-shadow: 0 7px 24px rgba(0, 28, 36, .25);
          color: #173f49; font: 700 18px/1.25 "Microsoft YaHei", system-ui, sans-serif; }
        .ev-page-zoom span { min-width: 112px; padding: 0 7px; white-space: nowrap; }
        .ev-page-zoom button { min-width: 52px; min-height: 52px; padding: 7px 12px;
          border: 1px solid #a9cbd1; border-radius: 12px; background: #edf6f4;
          color: var(--ev-brand-deep, #07566c); cursor: pointer; font: 800 20px/1 "Microsoft YaHei", system-ui, sans-serif; }
        .ev-page-zoom button:hover { background: #dceeea; }
        .ev-page-zoom button:focus-visible { outline: 4px solid #e88736; outline-offset: 2px; }
        .ev-page-zoom button:last-child { font-size: 17px; }
        @media (max-width: 520px) {
          .ev-page-zoom { gap: 4px; padding: 6px; }
          .ev-page-zoom span { min-width: 94px; padding: 0 3px; font-size: 16px; }
          .ev-page-zoom button { min-width: 44px; min-height: 48px; padding: 6px; }
        }
      `;
      const bar = document.createElement("div");
      bar.className = "ev-page-zoom";
      bar.setAttribute("role", "group");
      bar.setAttribute("aria-label", "原网页放大控制");
      status = document.createElement("span");
      status.setAttribute("role", "status");
      bar.append(
        status,
        makeButton("－", "缩小原网页", () => change("step", -1)),
        makeButton("＋", "放大原网页", () => change("step", 1)),
        makeButton("还原", "还原原网页大小并关闭放大控制", () => change("reset"))
      );
      shadow.append(style, bar);
    }
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }

  function render(state) {
    if (!state || panelHidden) {
      host?.remove();
      return;
    }
    mount();
    status.textContent = `原网页 ${Math.round(state.factor * 100)}%`;
  }

  async function request(operation, direction) {
    try {
      return await chrome.runtime.sendMessage({ type: "easyview:page-zoom", operation, direction });
    } catch (_) {
      return { ok: false, error: "放大原网页失败" };
    }
  }

  async function change(operation, direction) {
    const currentRevision = ++revision;
    const result = await request(operation, direction);
    if (currentRevision !== revision) return Boolean(result?.ok);
    if (result?.ok) render(result.state);
    else if (status) status.textContent = result?.error || "放大失败";
    return Boolean(result?.ok);
  }

  async function refresh() {
    const currentRevision = ++revision;
    const result = await request("get");
    if (currentRevision === revision && result?.ok) render(result.state);
  }

  function hide() {
    panelHidden = true;
    host?.remove();
  }

  function show() {
    panelHidden = false;
    return refresh();
  }

  async function activate() {
    panelHidden = false;
    return change("activate");
  }

  globalThis.EasyViewPageAssist = { activate, show, hide, refresh };
  refresh();
})();
