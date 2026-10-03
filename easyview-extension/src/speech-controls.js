/* 敬老版朗读控件：只朗读调用方提供的可见文案，不读取表单值或原网页正文。 */
(() => {
  "use strict";

  if (globalThis.EasyViewSpeech) return;

  let current = null;
  let serial = 0;
  let playbackSerial = 0;
  let rate = 0.8;
  const rates = [0.8, 1, 1.2];

  function safeText(value) {
    return String(value || "")
      .replace(/https?:\/\/\S+|www\.\S+/gi, "")
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "")
      .replace(/\b(?:\d[ -]?){11,24}\b/g, "相关编号")
      .replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function makeButton(text, action, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", action);
    return button;
  }

  function stop() {
    const session = current;
    if (!session) return;
    session.row.hidden = true;
    session.play.textContent = "听这页";
    session.pause.textContent = "暂停";
    session.pause.disabled = true;
    session.stopButton.disabled = true;
    session.activeButton?.setAttribute("aria-pressed", "false");
    session.activeButton = null;
    session.playing = false;
    const sessionId = session.sessionId;
    session.sessionId = null;
    if (!sessionId) return;
    chrome.runtime.sendMessage({
      type: "easyview:speech-control",
      action: "stop",
      sessionId
    }).catch(() => {});
  }

  function detach() {
    stop();
    current = null;
  }

  function attach(actions, panel, inputSegments) {
    detach();
    const segments = (Array.isArray(inputSegments) ? inputSegments : [])
      .map((item) => ({
        label: safeText(item?.label).slice(0, 40),
        text: safeText(item?.text)
      })).filter((item) => item.text).slice(0, 9);
    if (!segments.length) return;

    const viewId = `${Date.now()}-${++serial}`;
    const row = document.createElement("div");
    row.className = "ev-speech-row";
    row.hidden = true;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "朗读控制");
    const status = document.createElement("span");
    status.className = "ev-speech-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    async function speak(utterances, sourceButton = null) {
      if (current?.viewId !== viewId || sourceButton?.disabled) return;
      stop();
      const sessionId = `${viewId}-${++playbackSerial}`;
      current.sessionId = sessionId;
      current.activeButton = sourceButton;
      current.playing = true;
      sourceButton?.setAttribute("aria-pressed", "true");
      const trigger = sourceButton || play;
      trigger.disabled = true;
      row.hidden = false;
      status.textContent = "正在准备朗读…";
      pause.disabled = true;
      stopButton.disabled = false;
      try {
        const reply = await chrome.runtime.sendMessage({
          type: "easyview:speech-play", sessionId, segments: utterances, rate
        });
        if (current?.sessionId !== sessionId) return;
        if (!reply?.ok) {
          status.textContent = reply?.error || "朗读没有启动";
          pause.disabled = true;
          stopButton.disabled = true;
          current.activeButton?.setAttribute("aria-pressed", "false");
          current.activeButton = null;
          current.playing = false;
          current.sessionId = null;
        }
      } catch (_) {
        if (current?.sessionId === sessionId) {
          status.textContent = "朗读没有启动，请检查扩展状态";
          current.activeButton?.setAttribute("aria-pressed", "false");
          current.activeButton = null;
          current.playing = false;
          current.sessionId = null;
          pause.disabled = true;
          stopButton.disabled = true;
        }
      } finally {
        trigger.disabled = false;
      }
    }
    const play = makeButton("听这页", () => speak(segments), "ev-speech-start");
    const pause = makeButton("暂停", async () => {
      const action = pause.textContent === "继续" ? "resume" : "pause";
      const reply = await chrome.runtime.sendMessage({
        type: "easyview:speech-control", action, sessionId: current?.sessionId
      }).catch(() => null);
      if (!reply?.ok && current?.viewId === viewId) status.textContent = reply?.error || "暂时无法控制朗读";
    }, "ev-speech-control");
    const stopButton = makeButton("停止", () => stop(), "ev-speech-control");
    const speed = makeButton("0.8 倍", async () => {
      rate = rates[(rates.indexOf(rate) + 1) % rates.length];
      speed.textContent = `${rate.toFixed(1)} 倍`;
      speed.title = "播放中调整语速，从下一项开始生效";
      await chrome.runtime.sendMessage({
        type: "easyview:speech-control", action: "rate", sessionId: current?.sessionId, rate
      }).catch(() => {});
    }, "ev-speech-control ev-speech-speed");
    speed.title = "调整语速";
    pause.disabled = true;
    stopButton.disabled = true;
    row.append(status, pause, stopButton, speed);
    actions.prepend(play);
    panel.insertBefore(row, actions.closest("header")?.nextSibling || null);
    current = { viewId, sessionId: null, row, play, pause, stopButton, status,
      activeButton: null, playing: false, speak };
  }

  function cardButton(inputSegment) {
    const segment = {
      label: safeText(inputSegment?.label).slice(0, 40),
      text: safeText(inputSegment?.text)
    };
    if (!current || !segment.text) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ev-card-listen";
    button.setAttribute("aria-label", `朗读：${segment.label || "这一项"}`);
    button.setAttribute("aria-pressed", "false");
    button.title = "朗读这一项";
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/></svg>';
    button.addEventListener("click", () => {
      if (current?.activeButton === button && current.playing) {
        stop();
        return;
      }
      current?.speak([segment], button);
    });
    return button;
  }

  chrome.runtime.onMessage.addListener((message) => {
    const session = current;
    if (message?.type !== "easyview:speech-event" || !session || message.sessionId !== session.sessionId) return;
    if (message.state === "speaking" || message.state === "paused") {
      session.row.hidden = false;
      session.play.textContent = session.activeButton ? "听这页" : "重听";
      session.status.textContent = `${message.state === "paused" ? "已暂停" : "正在读"}：${message.label || "当前内容"}`;
      session.pause.textContent = message.state === "paused" ? "继续" : "暂停";
      session.pause.disabled = false;
      session.stopButton.disabled = false;
    } else if (message.state === "ended" || message.state === "stopped") {
      session.row.hidden = true;
      session.play.textContent = session.activeButton ? "听这页" : "再听一遍";
      session.activeButton?.setAttribute("aria-pressed", "false");
      session.activeButton = null;
      session.playing = false;
      session.sessionId = null;
    } else if (message.state === "error") {
      session.row.hidden = false;
      session.status.textContent = message.error || "朗读失败";
      session.pause.disabled = true;
      session.stopButton.disabled = true;
      session.activeButton?.setAttribute("aria-pressed", "false");
      session.activeButton = null;
      session.playing = false;
      session.sessionId = null;
    }
  });

  window.addEventListener("pagehide", detach);
  globalThis.EasyViewSpeech = { attach, cardButton, stop, detach };
})();
