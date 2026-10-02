(function () {
  "use strict";

  const weatherHost = "www.weather.com.cn";
  const cityPath = /\/(?:weather1d|weather2d|weather|weathern|weather1dn)\/(\d{9})\.shtml/;
  const officialWarningPage = "https://www.weather.com.cn/alarm/";

  function textOf(node) {
    return (node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function temperature(node) {
    const match = textOf(node).match(/-?\d{1,2}/);
    return match ? Number(match[0]) : null;
  }

  function getCity() {
    const match = window.location.pathname.match(cityPath);
    if (!match) return null;
    const title = document.title.match(/^(.{1,14}?)(?:今天天气|天气预报|天气)/);
    return { id: match[1], name: title?.[1]?.trim() || "当前城市" };
  }

  async function getPage(path) {
    if (window.location.pathname === path) return document;
    try {
      const response = await fetch(`https://${weatherHost}${path}`, { credentials: "omit" });
      if (!response.ok) return null;
      const html = await response.text();
      return new DOMParser().parseFromString(html, "text/html");
    } catch (_) {
      return null;
    }
  }

  function readToday(doc, week) {
    const periods = [...(doc?.querySelectorAll("#today .t > ul > li") || [])].slice(0, 2);
    const day = periods[0];
    const night = periods[1];
    const live = temperature(doc?.querySelector("#today .sk .tem"));
    const high = temperature(day?.querySelector(".tem span")) ?? week[0]?.high ?? null;
    const low = temperature(night?.querySelector(".tem span")) ?? week[0]?.low ?? null;
    const description = [textOf(day?.querySelector(".wea")), textOf(night?.querySelector(".wea"))]
      .filter(Boolean).join("转") || week[0]?.weather || "";
    const windText = textOf(day?.querySelector(".win span"));
    return {
      live,
      high,
      low,
      dayWeather: textOf(day?.querySelector(".wea")) || week[0]?.weather?.split("转")[0] || "",
      nightWeather: textOf(night?.querySelector(".wea")) || week[0]?.weather?.split("转")[1] || "",
      wind: /<3级|微风/.test(windText) ? "微风" : windText,
      description
    };
  }

  function readWeek(doc) {
    return [...(doc?.querySelectorAll("[id='7d'] ul.t > li") || [])].slice(0, 7).map((item) => ({
      label: textOf(item.querySelector("h1")),
      weather: textOf(item.querySelector(".wea")),
      high: temperature(item.querySelector(".tem span")),
      low: temperature(item.querySelector(".tem i"))
    })).filter((day) => day.label && day.weather);
  }

  function readLifestyle(doc) {
    const wanted = ["感冒指数", "穿衣指数", "运动指数", "花粉过敏指数", "紫外线指数"];
    const items = [...(doc?.querySelectorAll(".livezs ul.clearfix > li") || [])];
    return wanted.map((name) => {
      const node = items.find((item) => textOf(item.querySelector("em")) === name);
      if (!node) return null;
      const level = textOf(node.querySelector("span"));
      const detail = textOf(node.querySelector("p"));
      let advice = detail;
      if (name === "感冒指数" && /易发|较易发|易感/.test(level)) {
        advice = "今天容易感冒，出门注意保暖。";
      }
      return { name, level, advice: advice || `${name}：${level}` };
    }).filter(Boolean);
  }

  function readLocalWarning(cityName) {
    if (!cityName || cityName === "当前城市") return null;
    const candidates = document.querySelectorAll(
      ".alarm a, .warning a, .warn a, [id*='alarm'] a, [id*='warn'] a, a[href*='/alarm/']"
    );
    for (const link of candidates) {
      const headline = textOf(link);
      if (!headline.includes(cityName) || !/(暴雨|寒潮|大风|高温|雷电|暴雪|台风|沙尘|大雾|道路结冰|冰雹).{0,12}预警/.test(headline)) continue;
      try {
        const url = new URL(link.href, window.location.href);
        if (url.hostname !== weatherHost) continue;
        url.protocol = "https:";
        return { headline, url: url.href };
      } catch (_) {
        // Ignore malformed links from the original page.
      }
    }
    return null;
  }

  function weekSummary(week) {
    for (let i = 1; i < week.length; i += 1) {
      const yesterday = week[i - 1].high;
      const today = week[i].high;
      if (yesterday !== null && today !== null && yesterday - today >= 5) {
        return `${week[i].label}降温${yesterday - today}℃，出门添衣。`;
      }
    }
    const wet = week.slice(1, 4).find((day) => /雨|雪/.test(day.weather));
    if (wet) return `${wet.label}可能有${wet.weather}，出门前看看是否要带伞。`;
    return "查看未来一周天气，提前准备衣物。";
  }

  async function getSnapshot() {
    const city = getCity();
    if (!city) return { city: null, today: null, week: [], lifestyle: [], warning: null };
    const [todayDoc, weekDoc] = await Promise.all([
      getPage(`/weather1d/${city.id}.shtml`),
      getPage(`/weather/${city.id}.shtml`)
    ]);
    const week = readWeek(weekDoc);
    return {
      city,
      today: readToday(todayDoc, week),
      week,
      weekSummary: weekSummary(week),
      lifestyle: readLifestyle(todayDoc || weekDoc),
      warning: readLocalWarning(city.name)
    };
  }

  function searchCity(query) {
    const city = String(query).trim();
    if (!city || city.length > 20) return { ok: false, reason: "请输入要查询的城市名称。" };
    const input = document.querySelector("#txtZip");
    if (!(input instanceof HTMLInputElement)) {
      return { ok: false, reason: "暂时找不到中国天气网的城市搜索框，请退出敬老版在原页面搜索。" };
    }
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, city);
    else input.value = city;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: city.slice(-1), bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const exact = [...document.querySelectorAll(".city-box a, #show a")]
      .find((link) => textOf(link) === city || link.getAttribute("title") === city);
    if (exact) {
      try {
        const url = new URL(exact.href, window.location.href);
        if (url.hostname === weatherHost && cityPath.test(url.pathname)) {
          url.protocol = "https:";
          window.location.assign(url.href);
          return { ok: true, navigated: true };
        }
      } catch (_) {
        // Fall back to the original search suggestions.
      }
    }
    return { ok: true, navigated: false, target: input };
  }

  function openWarningPage() {
    window.location.assign(officialWarningPage);
  }

  window.EasyViewWeather = { getSnapshot, searchCity, openWarningPage };
})();
