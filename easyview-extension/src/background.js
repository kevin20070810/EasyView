"use strict";

const DEFAULT_TITLE = "为当前网页生成敬老版";

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

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["src/generic-content.js"]
    });
  } catch (error) {
    console.warn("[EasyView] Could not open the current page:", error);
    await showFailure(tabId, "无法打开此页面的敬老版，请刷新网页后重试");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearStatus(tabId).catch(() => {});
});
