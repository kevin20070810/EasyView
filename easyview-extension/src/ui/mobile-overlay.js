(function () {
  "use strict";

  const rootId = "easyview-mobile-root";

  /** 读一次原站品牌令牌写进 Shadow DOM；与 12306 覆盖层共用同一套接口。 */
  function themeShadow(shadow) {
    const api = window.EasyViewBrand;
    if (!api || typeof api.extract !== "function") return null;
    const theme = api.extract();
    api.apply(theme, shadow);
    return theme;
  }

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
    themeShadow(shadow);
    const launcher = document.createElement("button");
    launcher.className = "ev-launcher ev-mobile-launcher";
    launcher.type = "button";
    launcher.textContent = "👴 敬老版";
    launcher.setAttribute("aria-label", "打开中国移动敬老版");
    launcher.addEventListener("click", () => show(shadow));
    shadow.append(launcher);
    if (window.location.hash === "#easyview-recharge") show(shadow, "recharge");
    return host;
  }

  function show(shadow, firstScreen) {
    if (shadow.querySelector(".ev-overlay")) return;
    const theme = themeShadow(shadow);
    const launcher = shadow.querySelector(".ev-launcher");
    launcher.hidden = true;
    const overlay = document.createElement("section");
    overlay.className = "ev-overlay ev-mobile";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "中国移动敬老版");
    const panel = document.createElement("div");
    panel.className = "ev-panel";
    const header = document.createElement("header");
    header.className = "ev-header";
    const brand = document.createElement("div");
    brand.className = "ev-brandline";
    if (theme && theme.logoUrl && window.EasyViewBrand) {
      const logoSlot = document.createElement("div");
      logoSlot.className = "ev-logoslot";
      window.EasyViewBrand.mountLogo(logoSlot, theme, { textFallback: false });
      if (logoSlot.childNodes.length) brand.append(logoSlot);
    }
    const title = document.createElement("h1");
    title.textContent = "中国移动";
    if (theme && window.EasyViewBrand
        && window.EasyViewBrand.logoRepeatsHeading(theme, title.textContent)) {
      title.className = "ev-sr-only";
    }
    const brandCopy = document.createElement("div");
    brandCopy.className = "ev-brandcopy";
    const subtitle = document.createElement("p");
    subtitle.textContent = "请选择您要办理的业务";
    brandCopy.append(title, subtitle);
    brand.append(brandCopy);
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

    function openPage(page) {
      try {
        const result = window.EasyView10086.openOfficialPage(page);
        if (!result.ok) notice(result.reason);
      } catch (_) {
        notice("暂时无法打开中国移动官方页面，请退出敬老版在原页面办理。");
      }
    }

    function notice(message) {
      content.querySelector(".ev-notice")?.remove();
      const node = document.createElement("p");
      node.className = "ev-message ev-error ev-notice";
      node.setAttribute("role", "alert");
      node.textContent = message;
      content.prepend(node);
    }

    function renderHome() {
      content.replaceChildren();
      const cards = document.createElement("div");
      cards.className = "ev-actions";
      const balance = makeCard("search", "⌕", "查话费余额", "看看手机里还有多少钱", renderBalance);
      balance.classList.add("ev-buy");
      cards.append(
        balance,
        makeCard("payment", "¥", "充话费", "给手机充钱", renderRecharge),
        makeCard("info", "ℹ", "查剩余流量", "看看套餐还有多少流量", () => openPage("data")),
        makeCard("warning", "!", "查扣费业务", "看看有没有多扣钱的服务，可查看退订", () => openPage("services")),
        makeCard("location", "⌖", "找附近营业厅", "去现场办，有人教", () => openPage("stores")),
        makeCard("phone", "☎", "拨打人工客服", "10086", null, "tel:10086")
      );
      content.append(cards);
      overlay.scrollTop = 0;
    }

    function renderBalance() {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = "查话费余额";
      const intro = document.createElement("p");
      intro.className = "ev-guide-intro";
      intro.textContent = "余额需要登录后查看。手机号和短信验证码请在中国移动官方页面输入。";
      const steps = document.createElement("ol");
      steps.className = "ev-guide-steps";
      for (const text of ["打开中国移动官方关怀版。", "按官方页面提示登录并完成短信验证。", "登录后查看话费余额。"]) {
        const item = document.createElement("li");
        item.textContent = text;
        steps.append(item);
      }
      const actions = document.createElement("div");
      actions.className = "ev-guide-actions";
      actions.append(makeButton("打开中国移动余额查询", () => openPage("balance")), makeButton("返回业务选择", renderHome, true));
      content.append(title, intro, steps, actions);
      title.tabIndex = -1;
      title.focus();
    }

    function renderRecharge() {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = "充话费";
      const intro = document.createElement("p");
      intro.className = "ev-guide-intro";
      intro.textContent = "先核对手机号和金额。敬老版只会填写中国移动原页面，不会提交付款。";
      content.append(title, intro);
      if (!window.EasyView10086.canSyncRecharge()) {
        const note = document.createElement("p");
        note.className = "ev-message";
        note.textContent = "请先进入中国移动官方商城充值页，再填写手机号和金额。";
        content.append(note, makeButton("打开官方充值页", () => {
          try {
            window.EasyView10086.openRechargeForm();
          } catch (_) {
            notice("暂时无法打开中国移动官方充值页，请退出敬老版在原页面办理。");
          }
        }), makeButton("返回业务选择", renderHome, true));
        title.tabIndex = -1;
        title.focus();
        return;
      }
      const form = document.createElement("form");
      form.className = "ev-flow-body";
      const phone = field("充值手机号", "tel", "请输入11位手机号");
      phone.input.autocomplete = "tel";
      phone.input.inputMode = "tel";
      phone.input.maxLength = 11;
      const amount = field("充值金额（元）", "number", "50、100、300或500");
      amount.input.min = "50";
      amount.input.max = "500";
      amount.input.value = "100";
      const help = document.createElement("p");
      help.className = "ev-message";
      help.textContent = "当前官方首页提供50、100、300、500元。最终付款请在原页面核对并由您自己确认。";
      const submit = makeButton("填写到中国移动原页面", () => {
        try {
          const result = window.EasyView10086.syncRecharge(phone.input.value, amount.input.value);
          if (!result.ok) return notice(result.reason);
          exit.click();
          result.target.scrollIntoView({ behavior: "smooth", block: "center" });
          result.target.focus({ preventScroll: true });
        } catch (_) {
          notice("暂时无法填写中国移动原页面，请退出敬老版后在原页面办理。");
        }
      });
      form.addEventListener("submit", (event) => { event.preventDefault(); submit.click(); });
      form.append(phone.wrapper, amount.wrapper, help, submit);
      content.append(form, makeButton("返回业务选择", renderHome, true));
      title.tabIndex = -1;
      title.focus();
    }

    if (firstScreen === "recharge") renderRecharge();
    else renderHome();
  }

  function field(label, type, placeholder) {
    const wrapper = document.createElement("label");
    wrapper.className = "ev-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.placeholder = placeholder;
    input.required = true;
    wrapper.append(caption, input);
    return { wrapper, input };
  }

  function makeButton(text, onClick, secondary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = secondary ? "ev-button ev-button-secondary" : "ev-button ev-button-primary";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
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

  window.EasyViewMobileOverlay = { create };
})();
