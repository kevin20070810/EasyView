(function () {
  "use strict";

  if (window.__easyviewContentLoaded) return;
  window.__easyviewContentLoaded = true;

  var HOST_ID = "easyview-host";
  var DEFAULT_KEY = "hospital";

  // “针对某些网站”——只有名单内的站点会自动出现适老入口；
  // 其他页面可通过 popup 的“在当前页面启用”手动唤醒。
  var TARGET_SITES = ["demo.easyview.local", "127.0.0.1", "localhost"];

  var host = null;
  var shadow = null;
  var launcher = null;
  var overlay = null;
  var renderTarget = null;
  var renderApi = null;

  var state = {
    enabled: false,
    contrast: false,
    schemaKey: DEFAULT_KEY,
    consent: false,
    forced: false
  };

  function isAllowedHost() {
    var name = location.hostname;
    return TARGET_SITES.some(function (site) {
      return name === site || name.endsWith("." + site);
    });
  }

  function schemas() {
    return window.EASYVIEW_SCHEMAS || {};
  }

  function readPrefs(callback) {
    chrome.storage.local.get({ "easyview.prefs": null }, function (data) {
      callback((data && data["easyview.prefs"]) || {});
    });
  }

  function writePrefs(patch) {
    if (!state.consent) return;
    chrome.storage.local.get({ "easyview.prefs": {} }, function (data) {
      var prefs = Object.assign({}, data["easyview.prefs"] || {}, patch);
      chrome.storage.local.set({ "easyview.prefs": prefs });
    });
  }

  function ensureMount() {
    if (host && host.isConnected) return;
    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });

    ["src/styles.css", "src/shell.css"].forEach(function (path) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL(path);
      shadow.appendChild(link);
    });

    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "ev-launcher";
    launcher.textContent = "适老";
    launcher.setAttribute("aria-label", "一键进入适老模式");
    launcher.addEventListener("click", function () {
      setEnabled(true, true);
    });
    shadow.appendChild(launcher);

    overlay = document.createElement("div");
    overlay.className = "ev-shell";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "EasyView 适老视图");
    overlay.hidden = true;

    var bar = document.createElement("div");
    bar.className = "ev-shell-bar";
    var brand = document.createElement("span");
    brand.className = "ev-shell-brand";
    brand.textContent = "EasyView 适老模式";
    var exit = document.createElement("button");
    exit.type = "button";
    exit.className = "ev-shell-exit";
    exit.textContent = "退出适老模式";
    exit.addEventListener("click", function () {
      setEnabled(false, true);
    });
    bar.appendChild(brand);
    bar.appendChild(exit);

    var body = document.createElement("div");
    body.className = "ev-shell-body";
    renderTarget = document.createElement("div");
    renderTarget.className = "ev-shell-stage";
    body.appendChild(renderTarget);

    overlay.appendChild(bar);
    overlay.appendChild(body);
    shadow.appendChild(overlay);

    document.documentElement.appendChild(host);
  }

  function renderOverlay() {
    if (!renderTarget) return;
    var key = state.schemaKey;
    var schema = schemas()[key] || schemas().hospital;
    if (!schema) {
      renderTarget.textContent = "没有可用的 ui_schema.json 数据。";
      return;
    }
    renderApi = window.EasyViewRenderer.render(schema, renderTarget, {
      searchRoot: document,
      onAction: function (card, action) {
        if (action.kind === "external" && String(action.href || "").indexOf("tel:") === 0) {
          return true;
        }
        return false;
      }
    });
    applyContrast();
  }

  function applyContrast() {
    var root = renderTarget.querySelector(".ev-root");
    if (root) root.classList.toggle("ev-contrast", !!state.contrast);
  }

  function setEnabled(enabled, persist) {
    ensureMount();
    state.enabled = !!enabled;
    overlay.hidden = !state.enabled;
    launcher.hidden = state.enabled;
    document.documentElement.style.overflow = state.enabled ? "hidden" : "";
    if (state.enabled) renderOverlay();
    if (persist) writePrefs({ enabled: state.enabled, schemaKey: state.schemaKey });
    return state.enabled;
  }

  function setSchemaKey(key) {
    if (!key || !schemas()[key]) return false;
    state.schemaKey = key;
    writePrefs({ schemaKey: key });
    if (state.enabled) renderOverlay();
    return true;
  }

  function setContrast(value) {
    state.contrast = !!value;
    writePrefs({ contrast: state.contrast });
    applyContrast();
    return state.contrast;
  }

  function status() {
    return {
      enabled: state.enabled,
      contrast: state.contrast,
      schemaKey: state.schemaKey,
      consent: state.consent,
      allowed: isAllowedHost(),
      url: location.href
    };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return;
    if (message.type === "easyview:toggle") {
      sendResponse({ ok: true, enabled: setEnabled(!!message.enabled, true) });
    } else if (message.type === "easyview:setSchema") {
      sendResponse({ ok: setSchemaKey(message.key), status: status() });
    } else if (message.type === "easyview:setContrast") {
      sendResponse({ ok: true, contrast: setContrast(message.value) });
    } else if (message.type === "easyview:setConsent") {
      state.consent = !!message.value;
      sendResponse({ ok: true, consent: state.consent });
    } else if (message.type === "easyview:status") {
      sendResponse({ ok: true, status: status() });
    }
    return true;
  });

  readPrefs(function (prefs) {
    state.schemaKey = prefs.schemaKey || DEFAULT_KEY;
    state.contrast = !!prefs.contrast;
    state.consent = !!prefs.consent;
    state.enabled = !!prefs.enabled;
    var allowed = isAllowedHost();
    if (state.enabled || allowed) {
      setEnabled(state.enabled, false);
      if (!state.enabled) {
        // 名单内站点默认只露出入口按钮，由用户决定是否进入。
        ensureMount();
      }
    }
  });
})();
