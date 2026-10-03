/* 所有普通网页上的轻量入口。只观察占位以选择位置，点击后才启动页面分析。 */
(() => {
  "use strict";

  if (globalThis.EasyViewQuickLauncher) return;

  const host = document.createElement("div");
  host.id = "easyview-quick-launcher";
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("z-index", "2147483540", "important");
  host.style.setProperty("display", "block", "important");
  host.style.setProperty("visibility", "hidden", "important");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .ev-shortcuts { display: flex; align-items: stretch; gap: 5px; padding: 5px;
      width: max-content; max-width: calc(100vw - 24px); box-sizing: border-box;
      border: 1px solid #b6ced0; border-radius: 17px; background: #fffdf8;
      box-shadow: 0 5px 18px rgba(12, 50, 58, .24);
      font-family: "Microsoft YaHei", system-ui, sans-serif; }
    button { min-height: 54px; box-sizing: border-box; border: 0; border-radius: 12px;
      padding: 8px 13px; cursor: pointer; font: 700 18px/1.25 "Microsoft YaHei", system-ui, sans-serif; }
    .ev-open { display: flex; align-items: center; gap: 9px; color: #fff;
      background: #075f70; white-space: nowrap; }
    .ev-open .ev-mark { display: grid; place-items: center; width: 38px; height: 38px;
      border-radius: 8px; background-color: #fff; background-position: center;
      background-repeat: no-repeat; background-size: contain;
      color: #075f70; font-size: 19px; overflow: hidden; }
    .ev-zoom { border: 1px solid #a9cbd1; color: #07566c; background: #f3f8f5;
      white-space: nowrap; }
    button:hover { filter: brightness(.94); }
    button:focus-visible { outline: 4px solid #ef913c; outline-offset: 3px; }
    button:disabled { cursor: wait; opacity: .75; }
    .ev-status { position: absolute; right: 0; bottom: calc(100% + 7px); width: max-content;
      max-width: min(290px, calc(100vw - 24px)); padding: 8px 11px;
      border: 1px solid #b6ced0; border-radius: 10px; background: #fffdf8;
      color: #173f49; box-shadow: 0 4px 14px rgba(12, 50, 58, .16);
      font: 600 15px/1.4 "Microsoft YaHei", system-ui, sans-serif; }
    .ev-status[hidden] { display: none; }
    @media (max-width: 440px) {
      button { min-height: 50px; padding: 7px 10px; font-size: 16px; }
      .ev-open .ev-mark { width: 34px; height: 34px; font-size: 17px; }
    }
  `;

  const dock = document.createElement("div");
  dock.className = "ev-shortcuts";
  dock.setAttribute("role", "group");
  dock.setAttribute("aria-label", "简界网页快捷方式");
  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "ev-open";
  openButton.setAttribute("aria-label", "打开当前网页的敬老版");
  const mark = document.createElement("span");
  mark.className = "ev-mark";
  mark.setAttribute("aria-hidden", "true");
  // 直接作为 CSS 背景加载，页面中不创建图片节点（包括未挂载的 Image）。
  // 有些站点会把图片节点接管到自己的预览器，导致点击放大时弹出巨幅项目 Logo。
  mark.style.backgroundImage = `url("${chrome.runtime.getURL("assets/easyview-logo-v2.png")}")`;
  const label = document.createElement("span");
  label.textContent = "敬老版";
  openButton.append(mark, label);
  const zoomButton = document.createElement("button");
  zoomButton.type = "button";
  zoomButton.className = "ev-zoom";
  zoomButton.textContent = "放大";
  zoomButton.setAttribute("aria-label", "放大原网页并显示缩放控制");
  const status = document.createElement("div");
  status.className = "ev-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.hidden = true;
  dock.append(openButton, zoomButton, status);
  shadow.append(style, dock);
  for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
    shadow.addEventListener(type, (event) => event.stopPropagation());
  }

  let hidden = false;
  let placementTimer = null;
  let statusTimer = null;

  function say(message) {
    status.textContent = message;
    status.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { status.hidden = true; }, 5000);
  }

  function occupiedAt(x, y) {
    let score = 0;
    for (const element of document.elementsFromPoint(x, y)) {
      if (element === host || host.contains(element)) continue;
      if (element === document.documentElement || element === document.body) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const css = getComputedStyle(element);
      if (css.visibility === "hidden" || css.display === "none") continue;
      if (css.position === "fixed" || css.position === "sticky") score += 12;
      if (element.matches("button, a, input, select, textarea, [role='button'], [contenteditable='true']")) score += 12;
      else if (element.matches("p, li, h1, h2, h3, h4, h5, h6, label, span, img, video, iframe")) score += 3;
      if (score >= 18) break;
    }
    return score;
  }

  function place() {
    if (hidden || !host.isConnected) return;
    host.style.setProperty("visibility", "hidden", "important");
    const width = host.getBoundingClientRect().width || 225;
    const height = host.getBoundingClientRect().height || 64;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const gap = 16;
    const xRight = Math.max(gap, viewportWidth - width - gap);
    const xLeft = gap;
    const yBottom = Math.max(gap, viewportHeight - height - gap);
    const yTop = gap;
    const yMiddle = Math.max(gap, Math.round((viewportHeight - height) / 2));
    const candidates = [
      [xRight, yBottom], [xLeft, yBottom],
      [xRight, yMiddle], [xLeft, yMiddle],
      [xRight, yTop], [xLeft, yTop]
    ];
    let chosen = candidates[0];
    let best = Infinity;
    candidates.forEach(([x, y], index) => {
      let score = index * 1.5;
      for (const dx of [0.2, 0.5, 0.8]) {
        for (const dy of [0.25, 0.75]) {
          score += occupiedAt(x + width * dx, y + height * dy);
        }
      }
      if (score < best) { best = score; chosen = [x, y]; }
    });
    host.style.setProperty("left", `${Math.round(chosen[0])}px`, "important");
    host.style.setProperty("top", `${Math.round(chosen[1])}px`, "important");
    host.style.removeProperty("right");
    host.style.removeProperty("bottom");
    host.style.setProperty("visibility", "visible", "important");
  }

  function schedulePlacement(delay = 0) {
    clearTimeout(placementTimer);
    placementTimer = setTimeout(place, delay);
  }

  function hide() {
    hidden = true;
    host.style.setProperty("display", "none", "important");
  }

  function show() {
    hidden = false;
    host.style.setProperty("display", "block", "important");
    schedulePlacement();
  }

  openButton.addEventListener("click", async () => {
    if (openButton.disabled) return;
    openButton.disabled = true;
    say("正在打开敬老版…");
    try {
      const reply = await chrome.runtime.sendMessage({ type: "easyview:open-from-page" });
      if (!reply?.ok) say(reply?.error || "没有打开，请刷新网页后重试");
      else status.hidden = true;
    } catch (_) {
      say("没有打开，请刷新网页后重试");
    } finally {
      openButton.disabled = false;
    }
  });

  zoomButton.addEventListener("click", async () => {
    if (zoomButton.disabled) return;
    zoomButton.disabled = true;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "easyview:quick-zoom" });
      if (!reply?.ok) say(reply?.error || "放大失败，请刷新网页后重试");
      else say("已放大，左下角可调整或还原");
    } catch (_) {
      say("放大失败，请刷新网页后重试");
    } finally {
      zoomButton.disabled = false;
    }
  });

  globalThis.EasyViewQuickLauncher = { show, hide, place };
  (document.documentElement || document.body).appendChild(host);
  schedulePlacement();
  setTimeout(() => schedulePlacement(), 1200);
  setTimeout(() => schedulePlacement(), 3500);
  window.addEventListener("resize", () => schedulePlacement(150), { passive: true });
})();
