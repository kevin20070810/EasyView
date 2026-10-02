(function () {
  "use strict";

  var samples = window.EASYVIEW_SAMPLES || {};
  var root = document.getElementById("app");
  var elderToggle = document.getElementById("elder-toggle");
  var assistantToggle = document.getElementById("assistant-toggle");
  var assistantPanel = document.getElementById("assistant-panel");
  var assistantClose = document.getElementById("assistant-close");
  var assistantMessages = document.getElementById("assistant-messages");
  var assistantPrompts = document.getElementById("assistant-prompts");
  var assistantForm = document.getElementById("assistant-form");
  var assistantInput = document.getElementById("assistant-input");
  var modalOverlay = document.getElementById("modal-overlay");
  var privacyModal = document.getElementById("privacy-modal");
  var confirmModal = document.getElementById("confirm-modal");
  var confirmMessage = document.getElementById("confirm-message");
  var confirmOk = document.getElementById("confirm-ok");
  var confirmCancel = document.getElementById("confirm-cancel");
  var privacyAccept = document.getElementById("privacy-accept");
  var privacyDecline = document.getElementById("privacy-decline");
  var toast = document.getElementById("toast");

  var state = {
    demo: "hospital",
    schema: null,
    currentStep: 0,
    answers: {},
    done: false,
    elder: false,
    highContrast: false,
    readingSize: 22,
    reading: false,
    paused: false,
    consent: false,
    assistantOpen: false
  };

  var pendingAfterConsent = null;
  var confirmCallback = null;
  var utterance = null;
  var toastTimer = null;

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // 存储不可用时保持本次会话内的设置。
    }
  }

  function loadPreferences() {
    var raw = readStorage("easyview.prefs");
    state.consent = readStorage("easyview.consent") === "1";
    if (!raw) return;
    try {
      var prefs = JSON.parse(raw);
      state.elder = !!prefs.elder;
      state.highContrast = !!prefs.highContrast || !!prefs.elder;
      state.readingSize = prefs.readingSize || 22;
    } catch (error) {
      // 忽略损坏的偏好数据。
    }
  }

  function savePreferences() {
    if (!state.consent) return;
    writeStorage(
      "easyview.prefs",
      JSON.stringify({
        elder: state.elder,
        highContrast: state.highContrast,
        readingSize: state.readingSize
      })
    );
    writeStorage("easyview.consent", "1");
  }

  function applyVisualPreferences() {
    document.body.classList.toggle("elder", state.elder);
    document.body.classList.toggle("high-contrast", state.highContrast);
    document.documentElement.style.setProperty("--reading-size", state.readingSize + "px");
    elderToggle.setAttribute("aria-pressed", state.elder ? "true" : "false");
    elderToggle.textContent = state.elder ? "退出适老" : "适老模式";
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toast.hidden = true;
    }, 2400);
  }

  function hideModals() {
    modalOverlay.hidden = true;
    privacyModal.hidden = true;
    confirmModal.hidden = true;
  }

  function openPrivacy() {
    privacyModal.hidden = false;
    confirmModal.hidden = true;
    modalOverlay.hidden = false;
  }

  function openConfirm(message, callback) {
    confirmMessage.textContent = message;
    confirmCallback = callback;
    confirmModal.hidden = false;
    privacyModal.hidden = true;
    modalOverlay.hidden = false;
  }

  function withConsent(action) {
    if (state.consent) {
      action();
      return;
    }
    pendingAfterConsent = action;
    openPrivacy();
  }

  function setElder(enabled) {
    state.elder = enabled;
    state.highContrast = enabled;
    applyVisualPreferences();
    savePreferences();
    showToast(enabled ? "已进入适老模式" : "已退出适老模式");
  }

  function changeReadingSize(delta) {
    var next = Math.max(18, Math.min(36, state.readingSize + delta));
    state.readingSize = next;
    applyVisualPreferences();
    savePreferences();
    showToast("正文字号已调整");
  }

  function setHighContrast(enabled, button) {
    state.highContrast = enabled;
    applyVisualPreferences();
    savePreferences();
    if (button) button.setAttribute("aria-pressed", enabled ? "true" : "false");
    showToast(enabled ? "已开启高对比" : "已关闭高对比");
  }

  function getChineseVoice() {
    if (!window.speechSynthesis) return null;
    var voices = window.speechSynthesis.getVoices();
    var zh = voices.filter(function (voice) {
      return /^zh/i.test(voice.lang || "");
    });
    return (
      zh.find(function (voice) {
        return /zh-CN/i.test(voice.lang || "");
      }) ||
      zh[0] ||
      null
    );
  }

  function speak(text, onEnd) {
    if (!("speechSynthesis" in window) || !window.speechSynthesis) {
      showToast("当前浏览器不支持语音朗读");
      return;
    }
    window.speechSynthesis.cancel();
    utterance = null;
    var next = new SpeechSynthesisUtterance(String(text || ""));
    next.lang = "zh-CN";
    next.rate = 0.92;
    var voice = getChineseVoice();
    if (voice) next.voice = voice;
    next.onend = function () {
      if (utterance === next) {
        utterance = null;
        state.reading = false;
        state.paused = false;
        syncReadingButton();
        if (onEnd) onEnd();
      }
    };
    utterance = next;
    window.speechSynthesis.speak(next);
  }

  function syncReadingButton() {
    var readButton = document.querySelector(".reading-toolbar button[aria-label='朗读']");
    if (!readButton) return;
    readButton.textContent = state.paused ? "继续" : state.reading ? "暂停" : "朗读";
    readButton.setAttribute("aria-pressed", state.reading ? "true" : "false");
  }

  function stopReading() {
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    utterance = null;
    state.reading = false;
    state.paused = false;
    syncReadingButton();
  }

  function pauseReading() {
    if (window.speechSynthesis) window.speechSynthesis.pause();
    state.paused = true;
  }

  function resumeReading() {
    if (window.speechSynthesis) window.speechSynthesis.resume();
    state.paused = false;
  }

  function articleText() {
    var parts = [];
    if (state.schema && state.schema.title) parts.push(state.schema.title + "。");
    if (state.schema && state.schema.summary) parts.push(state.schema.summary);
    parts.push(window.EasyViewAgent.extractArticleText(state.schema));
    return parts.join("\n");
  }

  function toggleReading(button) {
    if (!("speechSynthesis" in window) || !window.speechSynthesis) {
      showToast("当前浏览器不支持语音朗读");
      return;
    }
    if (state.reading && !state.paused) {
      pauseReading();
      button.textContent = "继续";
      button.setAttribute("aria-pressed", "true");
      return;
    }
    if (state.reading && state.paused) {
      resumeReading();
      button.textContent = "暂停";
      button.setAttribute("aria-pressed", "true");
      return;
    }
    state.reading = true;
    button.textContent = "暂停";
    button.setAttribute("aria-pressed", "true");
    speak(articleText());
  }

  function operationViewState() {
    return {
      currentStep: state.currentStep,
      answers: state.answers,
      done: state.done,
      highContrast: state.highContrast,
      reading: state.reading
    };
  }

  function instructionForStep(step) {
    return window.EasyViewAgent.currentInstruction(state.schema, operationViewState());
  }

  function askConfirm(step, option) {
    var message = "您选择的是「" + option.label + "」。确认后进入下一步，可以吗？";
    openConfirm(message, function () {
      state.answers[step.id] = option.value || option.label;
      state.currentStep += 1;
      renderPage();
    });
  }

  function summaryText() {
    var steps = window.EasyViewAgent.getFlow(state.schema);
    var parts = steps
      .filter(function (step) {
        return !step.isFinal && state.answers[step.id];
      })
      .map(function (step) {
        var label = step.title.replace("选择", "").replace("确认", "");
        return label + "：" + state.answers[step.id];
      });
    return parts.join("，");
  }

  function askFinalConfirm() {
    var message = "请确认预约信息：" + summaryText() + "。确认完成挂号吗？";
    openConfirm(message, function () {
      state.done = true;
      renderPage();
      speak("挂号成功。您的预约信息是：" + summaryText() + "，请按预约时间到院就诊。");
    });
  }

  function goBack() {
    if (state.currentStep <= 0) return;
    state.currentStep -= 1;
    renderPage();
  }

  function resetFlow() {
    state.currentStep = 0;
    state.answers = {};
    state.done = false;
  }

  function renderPage() {
    if (!state.schema) return;
    stopReading();
    var viewState =
      window.EasyViewAgent.classify(state.schema) === "article"
        ? { highContrast: state.highContrast, reading: state.reading }
        : operationViewState();
    window.EasyViewRenderer.render(state.schema, root, viewState, {
      onSelect: askConfirm,
      onFinish: askFinalConfirm,
      onBack: goBack,
      onRestart: function () {
        resetFlow();
        renderPage();
      },
      onReplay: function (step) {
        speak(instructionForStep(step));
      },
      changeFont: function (delta) {
        withConsent(function () {
          changeReadingSize(delta);
        });
      },
      toggleContrast: function (button) {
        withConsent(function () {
          setHighContrast(!state.highContrast, button);
        });
      },
      toggleRead: toggleReading,
      stopRead: stopReading
    });

    if (window.EasyViewAgent.classify(state.schema) === "operation" && !state.done) {
      window.setTimeout(function () {
        if (state.demo === "hospital" && !state.done) {
          speak(instructionForStep());
        }
      }, 250);
    }
    updateAssistantPrompts();
  }

  function loadDemo(name) {
    state.demo = name;
    state.schema = samples[name] || samples.hospital || {};
    resetFlow();
    document.querySelectorAll(".demo-tab").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.demo === name);
    });
    renderPage();
  }

  function updateAssistantPrompts() {
    assistantPrompts.innerHTML = "";
    var isArticle = window.EasyViewAgent.classify(state.schema) === "article";
    var prompts = isArticle
      ? ["这份通知讲了什么？", "什么时候截止？", "办理需要什么材料？", "怎么缴费？"]
      : ["下一步该怎么做？", "我该选哪个科室？", "请再讲一遍"];
    prompts.forEach(function (prompt) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "prompt-chip";
      chip.textContent = prompt;
      chip.addEventListener("click", function () {
        assistantInput.value = prompt;
        askAssistant(prompt);
      });
      assistantPrompts.appendChild(chip);
    });
  }

  function addAssistantMessage(text, role, source) {
    var message = document.createElement("div");
    message.className = "message " + role + (source === "规则引擎" ? " is-rule" : "");
    message.textContent = text;
    if (source) {
      var meta = document.createElement("span");
      meta.className = "message-source";
      meta.textContent = source;
      message.appendChild(meta);
    }
    assistantMessages.appendChild(message);
    assistantMessages.scrollTop = assistantMessages.scrollHeight;
    return message;
  }

  function askAssistant(question) {
    var text = String(question || "").trim();
    if (!text) return;
    addAssistantMessage(text, "user");
    var pending = addAssistantMessage("正在整理回答…", "agent");
    window.EasyViewAgent.answer(text, state.schema, operationViewState()).then(function (result) {
      pending.textContent = result.text;
      var meta = document.createElement("span");
      meta.className = "message-source";
      meta.textContent = result.source || "规则引擎";
      pending.appendChild(meta);
      pending.classList.toggle("is-rule", result.source === "规则引擎");
      assistantMessages.scrollTop = assistantMessages.scrollHeight;
    });
  }

  function openAssistant() {
    state.assistantOpen = true;
    assistantPanel.hidden = false;
    assistantToggle.textContent = "×";
    if (!assistantMessages.childElementCount) {
      addAssistantMessage("您好，我可以帮您理解当前页面，也可以告诉您下一步怎么操作。", "agent", "本地助手");
    }
    updateAssistantPrompts();
    assistantInput.focus();
  }

  function closeAssistant() {
    state.assistantOpen = false;
    assistantPanel.hidden = true;
    assistantToggle.textContent = "AI";
  }

  function initTabs() {
    document.querySelectorAll(".demo-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        loadDemo(btn.dataset.demo);
      });
    });
  }

  function initControls() {
    elderToggle.addEventListener("click", function () {
      withConsent(function () {
        setElder(!state.elder);
      });
    });

    assistantToggle.addEventListener("click", function () {
      if (state.assistantOpen) closeAssistant();
      else openAssistant();
    });

    assistantClose.addEventListener("click", closeAssistant);

    assistantForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = assistantInput.value;
      assistantInput.value = "";
      askAssistant(value);
    });

    confirmOk.addEventListener("click", function () {
      hideModals();
      if (confirmCallback) {
        var callback = confirmCallback;
        confirmCallback = null;
        callback();
      }
    });

    confirmCancel.addEventListener("click", function () {
      hideModals();
      confirmCallback = null;
    });

    privacyAccept.addEventListener("click", function () {
      state.consent = true;
      writeStorage("easyview.consent", "1");
      hideModals();
      var action = pendingAfterConsent;
      pendingAfterConsent = null;
      if (action) action();
      savePreferences();
      showToast("隐私设置已保存");
    });

    privacyDecline.addEventListener("click", function () {
      hideModals();
      pendingAfterConsent = null;
      showToast("已取消，本次设置不会保存");
    });
  }

  function init() {
    loadPreferences();
    applyVisualPreferences();
    initTabs();
    initControls();

    if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === "function") {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener("voiceschanged", function () {
        getChineseVoice();
      });
    }

    fetch("ui_schema.json")
      .then(function (res) {
        if (!res.ok) throw new Error("no schema");
        return res.json();
      })
      .then(function (schema) {
        samples.hospital = schema;
        loadDemo("hospital");
      })
      .catch(function () {
        loadDemo("hospital");
      });
  }

  init();
})();
