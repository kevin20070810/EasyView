"use strict";

const DEFAULT_TITLE = "为当前网页生成敬老版";
const DEFAULT_ENDPOINT = "https://ev.jvda.online";
const ANALYZE_TIMEOUT_MS = 120000;
const PAGE_ZOOM_PREFIX = "easyview.pageZoom.";
let speechOwner = null;
let pendingSpeech = null;
let speechRequest = 0;

function speechEvent(owner, state, extra = {}) {
  chrome.tabs.sendMessage(owner.tabId, {
    type: "easyview:speech-event",
    sessionId: owner.sessionId,
    state,
    index: owner.index,
    label: owner.segments[owner.index]?.label || "",
    ...extra
  }).catch(() => {});
}

function stopSpeech(owner = speechOwner) {
  if (!owner || speechOwner !== owner) return;
  speechOwner = null;
  speechRequest += 1;
  chrome.tts.stop();
  speechEvent(owner, "stopped");
}

async function playSpeechSegment(owner) {
  if (speechOwner !== owner) return false;
  const segment = owner.segments[owner.index];
  if (!segment) {
    speechOwner = null;
    speechEvent(owner, "ended");
    return true;
  }
  try {
    const segmentIndex = owner.index;
    await chrome.tts.speak(segment.text, {
      lang: "zh-CN",
      voiceName: owner.voiceName,
      rate: owner.rate,
      onEvent(event) {
        if (speechOwner !== owner) return;
        if (event.type === "start") speechEvent(owner, "speaking");
        else if (event.type === "end") {
          owner.index += 1;
          playSpeechSegment(owner);
        } else if (event.type === "error") {
          speechOwner = null;
          speechEvent(owner, "error", { error: "朗读失败，请检查设备的中文语音设置" });
        }
      }
    });
    if (speechOwner === owner && owner.index === segmentIndex) speechEvent(owner, "speaking");
    return true;
  } catch (_) {
    if (speechOwner === owner) {
      speechOwner = null;
      speechEvent(owner, "error", { error: "朗读失败，请检查设备的中文语音设置" });
    }
    return false;
  }
}

async function startSpeech(message, sender) {
  const tabId = sender.tab?.id;
  if (sender.frameId !== 0 || typeof tabId !== "number") {
    return { ok: false, error: "无法在当前页面朗读" };
  }
  const segments = Array.isArray(message.segments) ? message.segments.slice(0, 9)
    .map((item) => ({
      label: String(item?.label || "").slice(0, 40),
      text: String(item?.text || "")
        .replace(/https?:\/\/\S+|www\.\S+/gi, "")
        .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "")
        .replace(/\s+/g, " ").trim().slice(0, 240)
    })).filter((item) => item.text) : [];
  if (!segments.length || !message.sessionId || segments.some((item) => /\b(?:\d[ -]?){11,24}\b/.test(item.text))) {
    return { ok: false, error: "没有可安全朗读的内容" };
  }
  stopSpeech();
  const request = ++speechRequest;
  pendingSpeech = { tabId, sessionId: String(message.sessionId).slice(0, 80), request };
  let voices;
  try {
    voices = await chrome.tts.getVoices();
  } catch (_) {
    if (pendingSpeech?.request === request) pendingSpeech = null;
    return { ok: false, error: "无法读取设备语音，请检查浏览器设置" };
  }
  if (request !== speechRequest) return { ok: false, error: "朗读已取消" };
  pendingSpeech = null;
  const systemVoice = (item) => item.remote !== true && !item.extensionId;
  const voice = voices.find((item) => /^zh[-_]cn$/i.test(item.lang || "") && systemVoice(item))
    || voices.find((item) => /^zh(?:[-_]|$)/i.test(item.lang || "") && systemVoice(item));
  if (!voice) {
    return { ok: false, error: "设备缺少可用的系统中文语音，请在语音设置中安装" };
  }
  const owner = {
    tabId,
    sessionId: String(message.sessionId).slice(0, 80),
    segments,
    index: 0,
    rate: [0.8, 1, 1.2].includes(message.rate) ? message.rate : 0.8,
    voiceName: voice.voiceName
  };
  speechOwner = owner;
  const started = await playSpeechSegment(owner);
  return started ? { ok: true } : { ok: false, error: "朗读没有启动，请检查设备语音设置" };
}

function controlSpeech(message, sender) {
  const owner = speechOwner;
  if (message.action === "stop" && pendingSpeech?.tabId === sender.tab?.id &&
      pendingSpeech.sessionId === message.sessionId) {
    speechRequest += 1;
    pendingSpeech = null;
    return { ok: true };
  }
  if (message.action === "stop" && !owner && typeof sender.tab?.id === "number") {
    chrome.tts.stop();
    return { ok: true };
  }
  if (!owner || owner.tabId !== sender.tab?.id || owner.sessionId !== message.sessionId) {
    return { ok: false, error: "当前没有正在朗读的内容" };
  }
  if (message.action === "stop") stopSpeech(owner);
  else if (message.action === "pause") {
    chrome.tts.pause();
    speechEvent(owner, "paused");
  } else if (message.action === "resume") {
    chrome.tts.resume();
    speechEvent(owner, "speaking");
  } else if (message.action === "rate") {
    if (![0.8, 1, 1.2].includes(message.rate)) return { ok: false, error: "不支持的语速" };
    owner.rate = message.rate;
  } else return { ok: false, error: "不支持的朗读操作" };
  return { ok: true };
}

function pageZoomKey(tabId) {
  return `${PAGE_ZOOM_PREFIX}${tabId}`;
}

async function pageZoomState(tabId) {
  const key = pageZoomKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

function senderOrigin(sender) {
  try {
    const url = new URL(sender.url || sender.tab?.url || "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch (_) {
    return null;
  }
}

async function handlePageZoom(message, sender) {
  const tabId = sender.tab?.id;
  const origin = senderOrigin(sender);
  if (typeof tabId !== "number" || !origin) {
    return { ok: false, error: "当前页面不能放大" };
  }

  let state = await pageZoomState(tabId);
  if (state && state.origin !== origin) {
    await chrome.storage.session.remove(pageZoomKey(tabId));
    state = null;
  }
  if (message.operation === "get") return { ok: true, state };
  if (!["activate", "step", "reset"].includes(message.operation)) {
    return { ok: false, error: "不支持的放大操作" };
  }
  if (!state && message.operation !== "activate") {
    return { ok: true, state: null };
  }

  if (message.operation === "activate" && !state) {
    const baseline = await chrome.tabs.getZoom(tabId);
    const settings = await chrome.tabs.getZoomSettings(tabId);
    if (settings.mode && settings.mode !== "automatic") {
      return { ok: false, error: "当前网页的缩放由浏览器或其他扩展控制" };
    }
    state = {
      origin,
      baseline,
      factor: Math.max(1.25, baseline),
      originalScope: settings.scope === "per-tab" ? "per-tab" : "per-origin"
    };
  } else if (message.operation === "step") {
    const direction = message.direction === 1 ? 1 : message.direction === -1 ? -1 : 0;
    if (!direction) return { ok: false, error: "不支持的放大方向" };
    state.factor = Math.min(Math.max(2, state.baseline),
      Math.max(state.baseline, Math.round((state.factor + direction * 0.25) * 100) / 100));
  }

  // per-tab 只放大当前标签页，不改用户在这个网站的全局浏览器缩放设置。
  await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
  await chrome.tabs.setZoom(tabId,
    message.operation === "reset" ? state.baseline : state.factor);
  if (message.operation === "reset") {
    await chrome.tabs.setZoomSettings(tabId, {
      mode: "automatic", scope: state.originalScope || "per-origin"
    });
    await chrome.storage.session.remove(pageZoomKey(tabId));
    return { ok: true, state: null };
  }
  await chrome.storage.session.set({ [pageZoomKey(tabId)]: state });
  return { ok: true, state };
}

/* 注入顺序即依赖顺序：
 *   brand → privacy → digest / binder / extract → ai-content
 * brand 只挂全局接口，谁先谁都行，但要在覆盖层渲染前就位。
 * 后三者挂接口，ai-content 最后跑并开始编排。
 * 定义成常量并挂到 globalThis，是为了让端到端测试能读同一份 ——
 * 测试里再硬编码一份，加了文件忘了改测试，就会静默失效。 */
const CONTENT_FILES = [
  "src/brand.js",
  "src/site/pay-page.js",
  "src/privacy.js",
  "src/digest.js",
  "src/binder.js",
  "src/extract.js",
  "src/page-assist.js",
  "src/speech-controls.js",
  "src/ai-content.js"
];
globalThis.__easyviewContentFiles = CONTENT_FILES;

/* ---------- 专用站点 ---------- */

function dedicatedRootFor(url) {
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host === "12306.cn" || host.endsWith(".12306.cn")) return "easyview-root";
  if (host === "10086.cn" || host.endsWith(".10086.cn")) return "easyview-mobile-root";
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

async function aiAccessToken() {
  try {
    const stored = await chrome.storage.local.get({ "easyview.accessToken": "" });
    return String(stored["easyview.accessToken"] || "").trim();
  } catch (_) {
    return "";
  }
}

async function analyzeViaService(bodyText, kind, useAi) {
  const endpoint = await aiEndpoint();
  const accessToken = await aiAccessToken();
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
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { "Authorization": `Bearer ${accessToken}` } : {})
      },
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

  if (message.type === "easyview:speech-play") {
    startSpeech(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "朗读没有启动" }));
    return true;
  }

  if (message.type === "easyview:speech-control") {
    sendResponse(controlSpeech(message, sender));
    return false;
  }

  if (message.type === "easyview:open-from-page") {
    if (sender.frameId !== 0 || typeof sender.tab?.id !== "number") {
      sendResponse({ ok: false, error: "找不到当前网页" });
      return false;
    }
    handleActionClick(sender.tab)
      .then((ok) => sendResponse({ ok, error: ok ? undefined : "没有打开，请刷新网页后重试" }))
      .catch(() => sendResponse({ ok: false, error: "没有打开，请刷新网页后重试" }));
    return true;
  }

  if (message.type === "easyview:quick-zoom") {
    const tabId = sender.frameId === 0 ? sender.tab?.id : null;
    if (typeof tabId !== "number" || !senderOrigin(sender)) {
      sendResponse({ ok: false, error: "当前网页不能放大" });
      return false;
    }
    (async () => {
      await chrome.scripting.executeScript({
        target: { tabId }, files: ["src/brand.js", "src/page-assist.js"]
      });
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.EasyViewPageAssist?.activate() || false
      });
      return { ok: Boolean(result[0]?.result), error: "放大原网页失败" };
    })()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "放大原网页失败" }));
    return true;
  }

  if (message.type === "easyview:page-zoom") {
    handlePageZoom(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "放大原网页失败，请用浏览器的缩放功能" }));
    return true;
  }

  // 关掉当前标签页。车次结果页是新标签页、history 只有一条，
  // history.back() 在那种情况下什么都不会发生，所以回去只能靠关页。
  if (message.type === "easyview:close-tab") {
    if (sender && sender.tab && sender.tab.id != null) {
      chrome.tabs.remove(sender.tab.id).catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
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
      .executeScript({ target: { tabId }, files: ["src/speech-controls.js", "src/generic-content.js"] })
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
  if (typeof tab?.id !== "number") return false;
  const tabId = tab.id;
  await clearStatus(tabId);

  let url;
  try {
    url = new URL(tab.url || tab.pendingUrl || "");
  } catch (_) {
    await showFailure(tabId, "无法读取当前网页地址，请打开普通网页后重试");
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    await showFailure(tabId, "此页面不支持敬老版，请打开普通网页后重试");
    return false;
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
    return true;
  } catch (error) {
    console.warn("[EasyView] Could not open the current page:", error);
    await showFailure(tabId, "无法打开此页面的敬老版，请刷新网页后重试");
    return false;
  }
}

chrome.action.onClicked.addListener(handleActionClick);
globalThis.__easyviewHandleClick = handleActionClick;

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && speechOwner?.tabId === tabId) stopSpeech();
  if (changeInfo.status === "loading" && pendingSpeech?.tabId === tabId) {
    speechRequest += 1;
    pendingSpeech = null;
  }
  if (changeInfo.status === "loading") clearStatus(tabId).catch(() => {});
  if (changeInfo.status !== "complete") return;
  (async () => {
    const state = await pageZoomState(tabId);
    if (!state) return;
    const tab = await chrome.tabs.get(tabId);
    const origin = senderOrigin({ url: tab.url });
    if (!origin) return;
    if (origin !== state.origin) {
      await chrome.storage.session.remove(pageZoomKey(tabId));
      return;
    }
    await chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" });
    await chrome.tabs.setZoom(tabId, state.factor);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/page-assist.js"]
    });
  })().catch(() => {
    // 页面可能已关闭或失去注入权限；原网页始终保持可用。
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (speechOwner?.tabId === tabId) stopSpeech();
  if (pendingSpeech?.tabId === tabId) {
    speechRequest += 1;
    pendingSpeech = null;
  }
  chrome.storage.session.remove(pageZoomKey(tabId)).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (speechOwner && speechOwner.tabId !== tabId) stopSpeech();
  if (pendingSpeech && pendingSpeech.tabId !== tabId) {
    speechRequest += 1;
    pendingSpeech = null;
  }
});
