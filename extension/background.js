"use strict";

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === "easyview:openDemo") {
    chrome.tabs.create({ url: chrome.runtime.getURL("demo/index.html") });
    sendResponse({ ok: true });
  }
  return true;
});
