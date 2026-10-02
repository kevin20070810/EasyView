(function () {
  "use strict";

  const rootId = "easyview-weather-root";

  function create() {
    let host = document.getElementById(rootId);
    if (host) return host;
    host = document.createElement("div");
    host.id = rootId;
    document.documentElement.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("src/styles.css");
    shadow.append(stylesheet);
    const launcher = document.createElement("button");
    launcher.className = "ev-launcher ev-weather-launcher";
    launcher.type = "button";
    launcher.textContent = "👴 敬老版";
    launcher.setAttribute("aria-label", "打开中国天气网敬老版");
    launcher.addEventListener("click", () => show(shadow));
    shadow.append(launcher);
    return host;
  }

  function show(shadow) {
    if (shadow.querySelector(".ev-overlay")) return;
    const launcher = shadow.querySelector(".ev-launcher");
    launcher.hidden = true;
    const overlay = document.createElement("section");
    overlay.className = "ev-overlay ev-weather";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "中国天气网敬老版");
    const panel = document.createElement("div");
    panel.className = "ev-panel";
    const header = document.createElement("header");
    header.className = "ev-header";
    const brand = document.createElement("div");
    const title = document.createElement("h1");
    title.textContent = "您好，这里是天气查询服务";
    const summary = document.createElement("p");
    summary.textContent = "可以查今天和未来一周的天气、穿衣提醒，也可以看看别的城市";
    brand.append(title, summary);
    const exit = makeButton("退出敬老版", () => {
      overlay.remove();
      launcher.hidden = false;
      launcher.focus();
    }, true);
    exit.className = "ev-exit";
    header.append(brand, exit);
    const content = document.createElement("main");
    content.className = "ev-content";
    panel.append(header, content);
    overlay.append(panel);
    shadow.append(overlay);
    let snapshot = null;

    function notice(message) {
      content.querySelector(".ev-notice")?.remove();
      const node = document.createElement("p");
      node.className = "ev-message ev-error ev-notice";
      node.setAttribute("role", "alert");
      node.textContent = message;
      content.prepend(node);
    }

    function scrollTo(section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
      section.querySelector("h2")?.focus({ preventScroll: true });
    }

    function makeSection(titleText) {
      const section = document.createElement("section");
      section.className = "ev-weather-section";
      const heading = document.createElement("h2");
      heading.textContent = titleText;
      heading.tabIndex = -1;
      section.append(heading);
      return section;
    }

    function paragraph(text) {
      const node = document.createElement("p");
      node.className = "ev-message";
      node.textContent = text;
      return node;
    }

    function renderHome() {
      content.replaceChildren();
      const place = document.createElement("p");
      place.className = "ev-weather-city";
      place.textContent = snapshot.city ? `当前城市：${snapshot.city.name}` : "还没有选定城市，请先查查别的城市";
      const weekSection = makeSection("未来一周天气");
      const warningSection = makeSection("天气预警");
      const healthSection = makeSection("穿衣与健康");
      const cards = document.createElement("div");
      cards.className = "ev-actions";

      const today = snapshot.today;
      const temperature = today?.live ?? today?.high;
      const todaySubtitle = snapshot.city && temperature !== null && temperature !== undefined
        ? `${today.live !== null ? "当前" : "今日最高"} ${temperature}°C · 白天${today.dayWeather || "暂无"}，夜间${today.nightWeather || "暂无"}${today.wind ? `，${today.wind}` : ""}`
        : snapshot.city ? "暂时没有读到气温，点开查看详情" : "先选择城市，再看白天和夜间天气";
      const todayCard = makeCard("info", "ℹ", "今天天气", todaySubtitle, renderTodayDetail);
      todayCard.classList.add("ev-weather-today-card");
      if (temperature !== null && temperature !== undefined) {
        const big = document.createElement("span");
        big.className = "ev-weather-temperature";
        big.textContent = `${temperature}°`;
        todayCard.querySelector(".ev-card-copy").append(big);
      }

      const warning = makeCard("warning", "!", "天气预警",
        snapshot.warning?.headline || "查看中国天气网官方预警", () => scrollTo(warningSection));
      if (snapshot.warning) warning.classList.add("ev-weather-active-warning");
      if (snapshot.warning) cards.append(warning);
      cards.append(todayCard,
        makeCard("calendar", "▦", "未来一周天气",
          snapshot.city ? (snapshot.week.length ? snapshot.weekSummary : "暂时没有读到七天预报") : "先选择城市，再看七天预报",
          () => snapshot.city ? scrollTo(weekSection) : renderCitySearch("未来一周天气")));
      if (!snapshot.warning) cards.append(warning);
      const healthAdvice = snapshot.lifestyle.find((item) => item.name === "穿衣指数")?.advice ||
        snapshot.lifestyle.find((item) => item.name === "感冒指数")?.advice ||
        (snapshot.city ? "暂时没有读到生活指数" : "先选择城市，再看穿衣和健康提醒");
      cards.append(
        makeCard("user", "♧", "穿衣与健康", healthAdvice,
          () => snapshot.city ? scrollTo(healthSection) : renderCitySearch("穿衣与健康")),
        makeCard("search", "⌕", "查查别的城市", "看看孩子那边天气怎么样", renderCitySearch),
        makeCard("phone", "☎", "打电话问天气", "拨 12121 听天气预报", renderPhoneDetail)
      );

      if (snapshot.week.length) {
        const list = document.createElement("ul");
        list.className = "ev-weather-days";
        for (const day of snapshot.week) {
          const item = document.createElement("li");
          item.textContent = `${day.label}：${day.weather}，${day.high ?? "--"} / ${day.low ?? "--"}°C`;
          list.append(item);
        }
        weekSection.append(paragraph(snapshot.weekSummary), list);
      } else weekSection.append(paragraph("暂时无法读取七天预报，请到原页面查看。"));

      if (snapshot.warning) {
        warningSection.append(paragraph(snapshot.warning.headline));
        const link = makeLink("查看原页面预警详情", snapshot.warning.url);
        warningSection.append(link);
      } else {
        warningSection.append(paragraph("当前页面未显示可确认的本地预警。最新信息请查看中国天气网官方预警页面。"));
      }
      warningSection.append(makeButton("打开官方预警页面", () => window.EasyViewWeather.openWarningPage(), true));

      if (snapshot.lifestyle.length) {
        const list = document.createElement("ul");
        list.className = "ev-weather-advice";
        for (const item of snapshot.lifestyle) {
          const entry = document.createElement("li");
          const name = document.createElement("strong");
          name.textContent = `${item.name}：${item.level}`;
          const advice = document.createElement("span");
          advice.textContent = item.advice;
          entry.append(name, advice);
          list.append(entry);
        }
        healthSection.append(list);
      } else healthSection.append(paragraph("当前页面没有可读取的生活指数，请到原页面查看。"));

      const refresh = makeButton("刷新天气信息", refreshSnapshot, true);
      refresh.classList.add("ev-weather-refresh");
      content.append(place, cards, refresh, weekSection, warningSection, healthSection);
      overlay.scrollTop = 0;
    }

    function renderTodayDetail() {
      if (!snapshot.city) return renderCitySearch();
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = `${snapshot.city.name}今天天气`;
      const today = snapshot.today;
      const value = today?.live ?? today?.high;
      if (value !== null && value !== undefined) {
        const temp = document.createElement("p");
        temp.className = "ev-weather-detail-temperature";
        temp.textContent = `${value}°C`;
        content.append(title, paragraph(today.live !== null ? "当前气温" : "今日最高气温"), temp);
      } else {
        content.append(title, paragraph("当前页面没有可读取的今日气温，请查看原页面。"));
      }
      if (today) {
        content.append(paragraph(`白天：${today.dayWeather || "暂无天气描述"}，${today.high ?? "--"}°C。`));
        content.append(paragraph(`夜间：${today.nightWeather || "暂无天气描述"}，${today.low ?? "--"}°C。`));
        if (/雨|雪/.test(today.dayWeather || "")) content.append(paragraph("白天可能有降水，出门前记得看看是否要带伞。"));
      }
      content.append(makeButton("返回业务选择", renderHome, true));
      overlay.scrollTop = 0;
      title.tabIndex = -1;
      title.focus();
    }

    function renderPhoneDetail() {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = "打电话问天气";
      title.tabIndex = -1;
      const number = document.createElement("p");
      number.className = "ev-weather-detail-temperature ev-weather-phone-number";
      number.textContent = "12121";
      content.append(title, paragraph("请用手机或座机拨打下面的号码，按语音提示查询天气。"), number,
        makeLink("用此设备拨打 12121", "tel:12121"),
        makeButton("返回业务选择", renderHome, true));
      overlay.scrollTop = 0;
      title.focus();
    }

    function renderCitySearch(topic) {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = typeof topic === "string" ? `先选城市，查看${topic}` : "查查别的城市";
      const intro = paragraph("输入城市后，会使用中国天气网原有的城市搜索入口。打开城市天气页后，再点“敬老版”查看天气信息。");
      const form = document.createElement("form");
      form.className = "ev-flow-body";
      const field = document.createElement("label");
      field.className = "ev-field";
      const caption = document.createElement("span");
      caption.textContent = "想看哪个城市";
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "例如：上海";
      input.required = true;
      input.maxLength = 20;
      field.append(caption, input);
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "ev-button ev-button-primary";
      submit.textContent = "查这个城市";
      form.append(field, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
          const result = window.EasyViewWeather.searchCity(input.value);
          if (!result.ok) return notice(result.reason);
          if (result.navigated) return;
          exit.click();
          result.target.scrollIntoView({ behavior: "smooth", block: "center" });
          result.target.focus({ preventScroll: true });
        } catch (_) {
          notice("暂时无法使用城市搜索，请退出敬老版在原页面查找。");
        }
      });
      content.append(title, intro, form, makeButton("返回业务选择", renderHome, true));
      title.tabIndex = -1;
      title.focus();
      input.focus();
    }

    async function refreshSnapshot() {
      content.replaceChildren(paragraph("正在读取中国天气网当前页面的天气信息……"));
      try {
        snapshot = await window.EasyViewWeather.getSnapshot();
      } catch (_) {
        snapshot = { city: null, today: null, week: [], lifestyle: [], warning: null };
      }
      if (overlay.isConnected) renderHome();
    }

    refreshSnapshot();
  }

  function makeButton(text, onClick, secondary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = secondary ? "ev-button ev-button-secondary" : "ev-button ev-button-primary";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function makeLink(text, href) {
    const link = document.createElement("a");
    link.className = "ev-button ev-button-secondary ev-weather-link";
    link.href = href;
    link.textContent = text;
    return link;
  }

  function makeCard(iconName, symbol, title, subtitle, onClick, href) {
    const card = href ? document.createElement("a") : document.createElement("button");
    if (href) card.href = href;
    else {
      card.type = "button";
      card.addEventListener("click", onClick);
    }
    card.className = "ev-card";
    card.dataset.icon = iconName;
    const icon = document.createElement("span");
    icon.className = "ev-card-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = symbol;
    const copy = document.createElement("span");
    copy.className = "ev-card-copy";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const description = document.createElement("span");
    description.textContent = subtitle;
    copy.append(heading, description);
    card.append(icon, copy);
    return card;
  }

  window.EasyViewWeatherOverlay = { create };
})();
