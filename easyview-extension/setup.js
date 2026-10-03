"use strict";

const SERVICE_URL = "https://ev.jvda.online";
const form = document.getElementById("setup-form");
const input = document.getElementById("access-code");
const status = document.getElementById("status");
const button = document.getElementById("save-button");

function showStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

chrome.storage.local.get({ "easyview.accessToken": "" }).then((stored) => {
  if (stored["easyview.accessToken"]) {
    input.placeholder = "已保存体验码；输入新码可更换";
    showStatus("这台浏览器已保存体验码。");
  }
}).catch(() => showStatus("暂时无法读取设置，请刷新此页重试。", true));

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const accessCode = input.value.trim();
  if (!accessCode) {
    showStatus("请先粘贴体验码。", true);
    input.focus();
    return;
  }
  button.disabled = true;
  showStatus("正在检查连接……");
  try {
    const response = await fetch(`${SERVICE_URL}/access/check`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessCode}`
      },
      cache: "no-store"
    });
    if (response.status === 401) {
      showStatus("体验码不正确，请核对后重试。", true);
      return;
    }
    if (response.status !== 204) {
      showStatus(`服务返回 HTTP ${response.status}，请联系 EasyView 团队。`, true);
      return;
    }
    await chrome.storage.local.set({ "easyview.accessToken": accessCode });
    await chrome.storage.local.remove("easyview.aiEndpoint");
    input.value = "";
    input.placeholder = "已保存体验码；输入新码可更换";
    showStatus("连接成功！现在可以打开网页，点击「敬老版」。");
  } catch (_) {
    showStatus("暂时连不上服务。请检查网络后重试。", true);
  } finally {
    button.disabled = false;
  }
});
