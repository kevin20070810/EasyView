(function () {
  "use strict";

  const inputSelectors = {
    departure: [
      "#fromStationText",
      'input[name="fromStationText"]',
      'input[placeholder*="出发"]',
      'input[aria-label*="出发"]'
    ],
    arrival: [
      "#toStationText",
      'input[name="toStationText"]',
      'input[placeholder*="到达"]',
      'input[aria-label*="到达"]'
    ],
    date: [
      "#train_date",
      'input[name="train_date"]',
      'input[placeholder*="日期"]',
      'input[aria-label*="日期"]'
    ]
  };

  function firstMatch(selectors) {
    for (const selector of selectors) {
      try {
        const element = document.querySelector(selector);
        if (element && element.isConnected) return element;
      } catch (_) {
        // A selector may be unsupported by an older page implementation.
      }
    }
    return null;
  }

  function byNearbyLabel(words, selector) {
    const labels = [...document.querySelectorAll("label, span, div, dt")];
    for (const label of labels) {
      const text = (label.textContent || "").trim();
      if (!text || text.length > 30 || !words.some((word) => text.includes(word))) continue;
      const container = label.closest("label, li, .item, .input-box, .form-item") || label.parentElement;
      const input = container && container.querySelector(selector);
      if (input) return input;
    }
    return null;
  }

  function findInput(kind) {
    return firstMatch(inputSelectors[kind]) ||
      (kind === "departure" ? byNearbyLabel(["出发地", "出发"], "input") : null) ||
      (kind === "arrival" ? byNearbyLabel(["到达地", "目的地", "到达"], "input") : null) ||
      (kind === "date" ? byNearbyLabel(["出发日期", "乘车日期"], 'input[type="text"], input[type="date"]') : null);
  }

  function findDepartureInput() { return findInput("departure"); }
  function findArrivalInput() { return findInput("arrival"); }
  function findDateInput() { return findInput("date"); }

  function findSearchButton() {
    const direct = firstMatch([
      "#search_one",
      "#search_ticket",
      'button[type="submit"]',
      'input[type="submit"]'
    ]);
    if (direct) return direct;
    return [...document.querySelectorAll("button, a, input[type='button']")]
      .find((element) => /查询|搜索/.test((element.innerText || element.value || "").trim())) || null;
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function stationCodeField(kind) {
    const ids = kind === "departure" ? ["fromStation", "fromStationCode"] : ["toStation", "toStationCode"];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) return node;
    }
    const name = kind === "departure" ? "fromStation" : "toStation";
    return document.querySelector(`input[name="${name}"]`);
  }

  function suggestionFor(city) {
    return [...document.querySelectorAll("li, a, [role='option'], .city-item, .autocomplete-suggestion")]
      .find((node) => node.isVisible !== false && (node.innerText || node.textContent || "").trim() === city) || null;
  }

  async function setCity(kind, city) {
    const input = kind === "departure" ? findDepartureInput() : findArrivalInput();
    if (!input) return { ok: false, reason: `暂时无法定位12306${kind === "departure" ? "出发地" : "到达地"}输入框。` };

    const codeField = stationCodeField(kind);
    const oldCode = codeField?.value || "";
    const oldName = (input.value || "").trim();
    input.focus();
    input.click();
    if (input.readOnly) {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    }
    setNativeValue(input, city);
    const option = suggestionFor(city);
    if (option) option.click();
    input.dispatchEvent(new Event("blur", { bubbles: true }));

    const matchedText = (input.value || "").trim().includes(city);
    const codeChanged = Boolean(codeField?.value && codeField.value !== oldCode);
    const alreadyConfirmed = Boolean(codeField?.value && oldName === city);
    if (!matchedText || (codeField && !codeChanged && !alreadyConfirmed)) {
      return {
        ok: false,
        reason: `12306尚未确认${kind === "departure" ? "出发地" : "到达地"}“${city}”。请检查页面候选项后退出敬老版，在原页面完成选择。`
      };
    }
    return { ok: true };
  }

  function setDate(date) {
    const input = findDateInput();
    if (!input) return { ok: false, reason: "暂时无法定位12306出发日期输入框。" };
    input.focus();
    setNativeValue(input, date);
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    const normalized = (input.value || "").trim();
    const accepted = normalized === date || normalized === date.replaceAll("-", "/");
    return accepted
      ? { ok: true }
      : { ok: false, reason: "12306没有接受所选日期，请退出敬老版并在原页面选择日期。" };
  }

  function submitSearch() {
    const button = findSearchButton();
    if (!button) return { ok: false, reason: "暂时无法定位12306车票查询按钮。请退出敬老版使用原页面。" };
    button.click();
    return { ok: true };
  }

  function findEntry(terms) {
    return [...document.querySelectorAll("a, button, [role='button']")]
      .find((element) => {
        const text = (element.innerText || element.textContent || "").trim();
        return text && text.length < 60 && terms.some((term) => text.includes(term));
      }) || null;
  }

  function activateEntry(terms) {
    const entry = findEntry(terms);
    if (!entry) return { ok: false };
    entry.scrollIntoView({ behavior: "smooth", block: "center" });
    entry.focus?.({ preventScroll: true });
    entry.click();
    return { ok: true };
  }

  // These destinations are public 12306 pages. Personal data and final actions
  // remain on the railway website, not in the extension.
  const officialPages = Object.freeze({
    login: "https://kyfw.12306.cn/otn/resources/login.html",
    register: "https://kyfw.12306.cn/otn/regist/init",
    orders: "https://kyfw.12306.cn/otn/view/train_order.html",
    myTickets: "https://kyfw.12306.cn/otn/view/personal_travel.html",
    specialPassenger: "https://kyfw.12306.cn/otn/view/icentre_qxyyInfo.html",
    tickets: "https://kyfw.12306.cn/otn/leftTicket/init",
    transfer: "https://kyfw.12306.cn/otn/lcQuery/init",
    waitlistOrders: "https://kyfw.12306.cn/otn/view/lineUp_order.html"
  });

  const departureTimes = ["00002400", "00000600", "06001200", "12001800", "18002400"];

  function getTicketFilterState() {
    if (window.location.pathname !== "/otn/leftTicket/init") {
      return { ok: false, reason: "请先打开12306车票查询页，查询后再筛选结果。" };
    }
    const bookable = document.querySelector("#avail_ticket");
    const time = document.querySelector("#cc_start_time");
    if (!(bookable instanceof HTMLInputElement) || !(time instanceof HTMLSelectElement)) {
      return { ok: false, reason: "暂时无法定位12306余票筛选控件，请在原页面筛选。" };
    }
    return { ok: true, onlyBookable: bookable.checked, departureTime: time.value };
  }

  function setOnlyBookable(enabled) {
    const state = getTicketFilterState();
    if (!state.ok) return state;
    const checkbox = document.querySelector("#avail_ticket");
    if (checkbox.checked !== enabled) checkbox.click();
    return checkbox.checked === enabled
      ? { ok: true, onlyBookable: checkbox.checked }
      : { ok: false, reason: "12306未接受可预订车次筛选，请在原页面操作。" };
  }

  function setDepartureTimeRange(value) {
    const state = getTicketFilterState();
    if (!state.ok) return state;
    if (!departureTimes.includes(value)) return { ok: false, reason: "请选择有效的发车时段。" };
    const select = document.querySelector("#cc_start_time");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return select.value === value
      ? { ok: true, departureTime: select.value }
      : { ok: false, reason: "12306未接受发车时段筛选，请在原页面操作。" };
  }

  function openOfficialPage(page) {
    const url = officialPages[page];
    if (!url) return { ok: false, reason: "暂时无法打开该12306服务。" };
    window.location.assign(url);
    return { ok: true };
  }

  window.EasyView12306 = {
    findDepartureInput,
    findArrivalInput,
    findDateInput,
    findSearchButton,
    setDeparture: (value) => setCity("departure", value),
    setArrival: (value) => setCity("arrival", value),
    setDate,
    submitSearch,
    findOrderEntry: () => findEntry(["订单", "未完成订单", "本人车票"]),
    findAccessibilityEntry: () => findEntry(["重点旅客", "无障碍", "爱心服务"]),
    findCustomerServiceEntry: () => findEntry(["客服", "联系方式", "联系我们"]),
    activateEntry,
    openOfficialPage,
    getTicketFilterState,
    setOnlyBookable,
    setDepartureTimeRange
  };
})();
