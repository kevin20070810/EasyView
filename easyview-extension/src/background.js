"use strict";

const DEFAULT_TITLE = "为当前网页生成敬老版";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8787";
const ANALYZE_TIMEOUT_MS = 120000;

/* 注入顺序即依赖顺序：
 *   privacy → digest / binder / extract → ai-content
 * 后三者挂接口，ai-content 最后跑并开始编排。
 * 定义成常量并挂到 globalThis，是为了让端到端测试能读同一份 ——
 * 测试里再硬编码一份，加了文件忘了改测试，就会静默失效。 */
const CONTENT_FILES = [
  "src/privacy.js",
  "src/digest.js",
  "src/binder.js",
  "src/extract.js",
  "src/ai-content.js"
];
globalThis.__easyviewContentFiles = CONTENT_FILES;

let brandLogoBase64Promise = null;

function brandLogoBase64() {
  if (!brandLogoBase64Promise) {
    brandLogoBase64Promise = (async () => {
      const response = await fetch(chrome.runtime.getURL("assets/easyview-logo-v2.png"));
      if (!response.ok) throw new Error(`Logo resource HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      return btoa(binary);
    })().catch((error) => {
      brandLogoBase64Promise = null;
      throw error;
    });
  }
  return brandLogoBase64Promise;
}

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
  if (!shadow) return "missing";
  // 「已经开着」和「这次刚打开」要能分开 —— 调用方据此决定再点一次要不要切到 AI 版
  if (shadow.querySelector(".ev-overlay")) return "already";
  const launcher = shadow.querySelector(".ev-launcher");
  if (!launcher || launcher.hidden) return "missing";
  launcher.click();
  return shadow.querySelector(".ev-overlay") ? "opened" : "missing";
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
  const isDraft = kind === "digest";
  // digest 走 /draft：服务器只做「文字进、模型出、JSON 回」，
  // 定位字段和风险策略都在扩展里，服务器看不到。
  // elements 是旧路径（服务端绑定），保留给离线评测用。
  const route = isDraft ? "draft" : "analyze";
  const url = `${endpoint}/${route}?debug=1${!isDraft && useAi ? "&ai=1" : ""}`;
  const requestBody = isDraft ? JSON.stringify({ digest: bodyText }) : bodyText;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
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
      const detail = (payload && payload.error && payload.error.message) || `HTTP ${response.status}`;
      return { ok: false, error: detail, endpoint };
    }
    if (isDraft) {
      return {
        ok: true,
        draft: payload.draft,
        promptVersion: payload.prompt_version || null,
        meta: payload.meta || null,
        endpoint
      };
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

  // 关掉当前标签页。车次结果页是新标签页、history 只有一条，
  // history.back() 在那种情况下什么都不会发生，所以回去只能靠关页。
  if (message.type === "easyview:close-tab") {
    if (sender && sender.tab && sender.tab.id != null) {
      chrome.tabs.remove(sender.tab.id).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "easyview:brand-logo") {
    brandLogoBase64()
      .then((base64) => sendResponse({ ok: true, base64 }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

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

  // content script 在普通 HTTP 页面上没有 crypto.subtle（非安全上下文），
  // 由扩展的 service worker 代算。这是扩展内部通信，不出浏览器。
  if (message.type === "easyview:sha256") {
    (async () => {
      try {
        const bytes = new TextEncoder().encode(String(message.text || ""));
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
        sendResponse({ ok: true, sha256: hex });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
      }
    })();
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

/* 抽成具名函数并挂到 globalThis，是为了让端到端测试能调【和用户点图标完全同一条】
 * 代码路径。之前测试直接调 chrome.scripting.executeScript 注入，绕过了
 * 这里的专用站点分支，于是"测试全过、用户看不到"—— 这个坑踩过一次了。 */
async function handleActionClick(tab) {
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
    // 图标点击一律打开 AI 通用版，专用站点也不例外。
    //
    // 专用站点的手写敬老版并没有被删掉 —— 它是 content_scripts 注册的，
    // 仍然会在 12306 / 10086 / 天气 / 邮政 页面上挂自己的「敬老版」悬浮入口，
    // 需要它那套深度操作（真正替你填表）时点那个就行。
    //
    // 之前这里是「先开专用版、成功就 return」，结果是：在 12306 上点图标
    // 永远看到的是手写版，AI 版和步骤引导完全不可达。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_FILES
    });
  } catch (error) {
    console.warn("[EasyView] Could not open the current page:", error);
    await showFailure(tabId, "无法打开此页面的敬老版，请刷新网页后重试");
  }
}

chrome.action.onClicked.addListener(handleActionClick);
globalThis.__easyviewHandleClick = handleActionClick;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearStatus(tabId).catch(() => {});
});
