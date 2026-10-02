"use strict";

const DEFAULT_TITLE = "为当前网页生成敬老版";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const ANALYZE_TIMEOUT_MS = 120000;

/* ---------- 专用站点 ---------- */

function dedicatedRootFor(url) {
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".12306.cn")) return "easyview-root";
  if (host === "www.10086.cn" || host === "shop.10086.cn") return "easyview-mobile-root";
  if (host === "www.weather.com.cn") return "easyview-weather-root";
  if (host === "11185.cn" || host === "www.11185.cn") return "easyview-postal-root";
  return null;
}

async function clearStatus(tabId) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text: "" }),
    chrome.action.setTitle({ tabId, title: DEFAULT_TITLE })
  ]);
}

async function showFailure(tabId, message) {
  await Promise.all([
    chrome.action.setBadgeBackgroundColor({ tabId, color: "#b4232c" }),
    chrome.action.setBadgeText({ tabId, text: "!" }),
    chrome.action.setTitle({ tabId, title: message })
  ]);
}

async function openDedicatedOverlay(rootId) {
  let root = document.getElementById(rootId);
  if (!root) {
    root = await new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const found = document.getElementById(rootId);
        if (found) finish(found);
      });
      const finish = (found) => {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(found);
      };
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timeout = setTimeout(() => finish(null), 2500);
    });
  }
  const shadow = root?.shadowRoot;
  if (!shadow) return false;
  if (shadow.querySelector(".ev-overlay")) return true;
  const launcher = shadow.querySelector(".ev-launcher");
  if (!launcher || launcher.hidden) return false;
  launcher.click();
  return Boolean(shadow.querySelector(".ev-overlay"));
}

/* ---------- 分析服务 ---------- */
/*
 * content script 不能绕过 CORS，而且从公网页面直接请求 127.0.0.1 还会被
 * Chrome 的 Private Network Access 拦下。所以请求统一由这里代发 ——
 * service worker 拥有 host_permissions，不受这两个限制。
 */

async function aiEndpoint() {
  try {
    const stored = await chrome.storage.local.get({ "easyview.aiEndpoint": "" });
    const value = String(stored["easyview.aiEndpoint"] || "").trim();
    return (value || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  } catch (_) {
    return DEFAULT_ENDPOINT;
  }
}

async function analyzeViaService(bodyText, kind, useAi) {
  const endpoint = await aiEndpoint();
  // elements 直接交给 /analyze；digest 走 /draft（服务器只做"文字进、JSON 出"）
  const route = kind === "digest" ? "draft" : "analyze";
  const url = `${endpoint}/${route}?debug=1${useAi ? "&ai=1" : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyText,
      signal: controller.signal
    });
    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: `分析服务返回的不是 JSON（HTTP ${response.status}）` };
    }
    if (!response.ok || payload.ok === false) {
      const detail = payload?.error?.message || `HTTP ${response.status}`;
      return { ok: false, error: detail };
    }
    return { ok: true, data: payload.data, meta: payload.meta || null, endpoint };
  } catch (error) {
    if (error && error.name === "AbortError") {
      return { ok: false, error: `分析超时（${Math.round(ANALYZE_TIMEOUT_MS / 1000)} 秒）`, endpoint };
    }
    return {
      ok: false,
      error: `连不上分析服务 ${endpoint}。请先启动：cd ai-service && python app.py`,
      endpoint
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  if (message.type === "easyview:analyze") {
    if (typeof message.body !== "string" || !message.body) {
      sendResponse({ ok: false, error: "没有可发送的内容" });
      return true;
    }
    analyzeViaService(message.body, message.kind, message.ai !== false)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true; // 异步回复，保持通道打开
  }

  if (message.type === "easyview:endpoint") {
    aiEndpoint().then((endpoint) => sendResponse({ ok: true, endpoint }));
    return true;
  }

  // 分析服务不可用时，退回扩展内置的本地规则版（generic-content.js）
  if (message.type === "easyview:fallback-generic") {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") {
      sendResponse({ ok: false, error: "找不到标签页" });
      return undefined;
    }
    chrome.scripting
      .executeScript({ target: { tabId }, files: ["src/generic-content.js"] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return undefined;
});

/* ---------- 点击图标 ---------- */

chrome.action.onClicked.addListener(async (tab) => {
  if (typeof tab.id !== "number") return;
  const tabId = tab.id;
  await clearStatus(tabId);

  let url;
  try {
    url = new URL(tab.url || tab.pendingUrl || "");
  } catch (_) {
    await showFailure(tabId, "无法读取当前网页地址，请打开普通网页后重试");
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    await showFailure(tabId, "此页面不支持敬老版，请打开普通网页后重试");
    return;
  }

  try {
    const rootId = dedicatedRootFor(url);
    if (rootId) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: openDedicatedOverlay,
        args: [rootId]
      });
      if (results.some(({ result }) => result === true)) return;
      await showFailure(tabId, "专用敬老版尚未加载，请等网页加载完成后重试");
      return;
    }

    // 通用网页：纯本地提取 -> 本地脱敏 -> 用户同意 -> 分析服务理解 -> 渲染
    // 顺序重要：privacy 必须比 ai-content 先挂上，extract 同理
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/privacy.js", "src/extract.js", "src/ai-content.js"]
    });
  } catch (error) {
    console.warn("[EasyView] Could not open the current page:", error);
    await showFailure(tabId, "无法打开此页面的敬老版，请刷新网页后重试");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearStatus(tabId).catch(() => {});
});
