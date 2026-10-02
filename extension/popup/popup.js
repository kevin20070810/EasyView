(function () {
  "use strict";

  var toggle = document.getElementById("pop-toggle");
  var statusText = document.getElementById("pop-status");
  var schemaSelect = document.getElementById("pop-schema");
  var contrast = document.getElementById("pop-contrast");
  var privacy = document.getElementById("pop-privacy");
  var privacyAccept = document.getElementById("pop-privacy-accept");
  var privacyDecline = document.getElementById("pop-privacy-decline");
  var hint = document.getElementById("pop-hint");
  var demoButton = document.getElementById("pop-demo");

  var prefs = { consent: false, enabled: false, contrast: false, schemaKey: "hospital" };
  var tabId = null;
  var pageStatus = null;
  var pendingAfterConsent = null;

  function setHint(message) {
    hint.textContent = message || "";
    hint.hidden = !message;
  }

  function activeTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      callback(tabs && tabs[0]);
    });
  }

  function send(message, callback) {
    if (tabId == null) {
      callback(null);
      return;
    }
    chrome.tabs.sendMessage(tabId, message, function (response) {
      if (chrome.runtime.lastError) callback(null);
      else callback(response);
    });
  }

  function injectContentScript(callback) {
    chrome.scripting.executeScript(
      {
        target: { tabId: tabId },
        files: ["src/icons.js", "src/renderer.js", "data/schemas.js", "content/content.js"]
      },
      function () {
        callback(!chrome.runtime.lastError);
      }
    );
  }

  function savePrefs(patch, force) {
    if (!prefs.consent && !force) return;
    prefs = Object.assign({}, prefs, patch);
    chrome.storage.local.set({ "easyview.prefs": prefs });
  }

  function withConsent(action) {
    if (prefs.consent) {
      action();
      return;
    }
    pendingAfterConsent = action;
    privacy.hidden = false;
  }

  function paint() {
    toggle.textContent = prefs.enabled ? "退出适老模式" : "进入适老模式";
    toggle.setAttribute("aria-pressed", prefs.enabled ? "true" : "false");
    contrast.checked = !!prefs.contrast;
    schemaSelect.value = prefs.schemaKey || "hospital";
    schemaSelect.disabled = !prefs.consent;
    contrast.disabled = !prefs.consent;

    if (!pageStatus) {
      statusText.textContent = "当前页面无法注入（浏览器内置页面或商店页不支持）。";
      return;
    }
    var parts = [pageStatus.allowed ? "当前网站在适老名单内" : "当前网站不在适老名单内"];
    parts.push(prefs.enabled ? "适老模式已开启" : "适老模式已关闭");
    statusText.textContent = parts.join(" · ");
  }

  function setEnabled(enabled) {
    if (enabled && !prefs.consent) {
      withConsent(function () {
        setEnabled(true);
      });
      return;
    }
    send({ type: "easyview:toggle", enabled: enabled }, function (response) {
      if (!response) {
        injectContentScript(function (ok) {
          if (!ok) {
            setHint("当前页面不支持适老模式。");
            return;
          }
          send({ type: "easyview:toggle", enabled: enabled }, function (retry) {
            if (retry) {
              savePrefs({ enabled: enabled });
              pageStatus = retry.status || pageStatus;
            }
            paint();
          });
        });
        return;
      }
      savePrefs({ enabled: enabled });
      if (response.status) pageStatus = response.status;
      else pageStatus.enabled = enabled;
      paint();
    });
  }

  function load() {
    activeTab(function (tab) {
      if (!tab || tab.id == null) {
        paint();
        return;
      }
      tabId = tab.id;
      chrome.storage.local.get({ "easyview.prefs": null }, function (data) {
        prefs = Object.assign(prefs, (data && data["easyview.prefs"]) || {});
        privacy.hidden = !!prefs.consent;
        send({ type: "easyview:status" }, function (response) {
          pageStatus = response && response.status ? response.status : null;
          if (pageStatus) prefs.enabled = pageStatus.enabled;
          paint();
        });
      });
    });
  }

  toggle.addEventListener("click", function () {
    setEnabled(!prefs.enabled);
  });

  schemaSelect.addEventListener("change", function () {
    var key = schemaSelect.value;
    withConsent(function () {
      send({ type: "easyview:setSchema", key: key }, function (response) {
        savePrefs({ schemaKey: key });
        if (!response) setHint("切换后将保存在偏好中，重新打开页面生效。");
        else pageStatus = response.status || pageStatus;
        paint();
      });
    });
  });

  contrast.addEventListener("change", function () {
    var checked = contrast.checked;
    withConsent(function () {
      send({ type: "easyview:setContrast", value: checked }, function () {
        savePrefs({ contrast: checked });
      });
    });
  });

  privacyAccept.addEventListener("click", function () {
    prefs.consent = true;
    savePrefs({ consent: true }, true);
    send({ type: "easyview:setConsent", value: true }, function () {});
    privacy.hidden = true;
    schemaSelect.disabled = false;
    contrast.disabled = false;
    var action = pendingAfterConsent;
    pendingAfterConsent = null;
    if (action) action();
    paint();
  });

  privacyDecline.addEventListener("click", function () {
    privacy.hidden = true;
    pendingAfterConsent = null;
    setHint("已取消。未同意前不会保存任何偏好。");
  });

  demoButton.addEventListener("click", function () {
    chrome.tabs.create({ url: chrome.runtime.getURL("demo/index.html") });
  });

  load();
})();
