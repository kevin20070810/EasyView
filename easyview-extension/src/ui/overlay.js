(function () {
  "use strict";

  const rootId = "easyview-root";

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
    launcher.className = "ev-launcher";
    launcher.type = "button";
    launcher.textContent = "👴 敬老版";
    launcher.setAttribute("aria-label", "打开12306敬老版");
    launcher.addEventListener("click", () => show(shadow));
    shadow.append(launcher);
    return host;
  }

  function show(shadow) {
    if (shadow.querySelector(".ev-overlay")) return;
    const launcher = shadow.querySelector(".ev-launcher");
    launcher.hidden = true;
    const overlay = document.createElement("section");
    overlay.className = "ev-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "中国铁路12306敬老版");
    const panel = document.createElement("div");
    panel.className = "ev-panel";
    const header = document.createElement("header");
    header.className = "ev-header";
    const brand = document.createElement("div");
    const h1 = document.createElement("h1");
    h1.textContent = "中国铁路12306";
    const subtitle = document.createElement("p");
    subtitle.textContent = "请选择您要办理的业务";
    brand.append(h1, subtitle);
    const exit = document.createElement("button");
    exit.className = "ev-exit";
    exit.type = "button";
    exit.textContent = "退出敬老版";
    exit.addEventListener("click", () => {
      overlay.remove();
      launcher.hidden = false;
      launcher.focus();
    });
    header.append(brand, exit);
    const content = document.createElement("main");
    content.className = "ev-content";
    panel.append(header, content);
    overlay.append(panel);
    shadow.append(overlay);

    function renderHome() {
      content.replaceChildren();
      const login = makeButton("登录或注册12306", renderLoginGuide, true);
      login.classList.add("ev-login-entry");
      const grid = document.createElement("div");
      grid.className = "ev-actions";
      const buy = makeCard("train", "🚆", "我要买票", "查车次、买火车票", () => window.EasyViewTicketFlow.render(content, {
        onHome: renderHome,
        onFilters: renderTicketFilters,
        onTransfer: renderTransferGuide,
        onViewResults: () => exit.click()
      }));
      buy.classList.add("ev-buy");
      const faq = document.createElement("section");
      faq.className = "ev-faq";
      faq.id = "ev-faq";
      const faqTitle = document.createElement("h2");
      faqTitle.textContent = "常见问题";
      faqTitle.tabIndex = -1;
      const question = document.createElement("h3");
      question.textContent = "没赶上火车怎么办？";
      const answer = document.createElement("p");
      answer.textContent = "请到12306官方订单页查看这张车票是否可以改签。具体办理时间和规则以12306页面提示为准。";
      faq.append(faqTitle, question, answer, makeButton("查看改签 / 退票指引", renderChangeRefundGuide, true));
      grid.append(buy,
        makeCard("document", "📄", "查看我的车票", "查看本人已购的车票", () => openPage("myTickets")),
        makeCard("calendar", "📅", "改签 / 退票", "行程变了怎么办", renderChangeRefundGuide),
        makeCard("user", "♿", "重点旅客预约", "轮椅、搀扶等进出站帮助", () => openPage("specialPassenger")),
        makeCard("phone", "☎", "拨打铁路客服", "12306", null, "tel:12306"),
        makeCard("help", "?", "常见问题", "没赶上火车怎么办", () => {
          faq.scrollIntoView({ behavior: "smooth", block: "start" });
          faqTitle.focus({ preventScroll: true });
        }));
      const more = makeButton("其他服务：余票筛选、换乘、候补、老年权益", renderMoreServices, true);
      more.classList.add("ev-more-entry");
      content.append(login, grid, more, faq);
      overlay.scrollTop = 0;
    }

    function renderMoreServices() {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = "其他服务";
      const actions = document.createElement("div");
      actions.className = "ev-guide-actions";
      actions.append(
        makeButton("筛选可预订车次", renderTicketFilters),
        makeButton("查询中转换乘", renderTransferGuide),
        makeButton("候补购票", renderWaitlistGuide),
        makeButton("老年出行优惠与服务", renderSeniorGuide),
        makeButton("查看火车票订单", () => openPage("orders")),
        makeButton("返回业务选择", renderHome, true)
      );
      content.append(title, actions);
      title.tabIndex = -1;
      title.focus();
    }

    function renderGuide(titleText, introText, steps, actions) {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = titleText;
      const intro = document.createElement("p");
      intro.className = "ev-guide-intro";
      intro.textContent = introText;
      const list = document.createElement("ol");
      list.className = "ev-guide-steps";
      for (const step of steps) {
        const item = document.createElement("li");
        item.textContent = step;
        list.append(item);
      }
      const buttons = document.createElement("div");
      buttons.className = "ev-guide-actions";
      for (const action of actions) {
        buttons.append(makeButton(action.label, () => openPage(action.page)));
      }
      buttons.append(makeButton("返回业务选择", renderHome, true));
      content.append(title, intro, list, buttons);
      title.setAttribute("tabindex", "-1");
      title.focus();
    }

    function openPage(page) {
      try {
        const result = window.EasyView12306.openOfficialPage(page);
        if (!result.ok) showNotice(content, result.reason);
      } catch (_) {
        showNotice(content, "暂时无法打开12306页面，请退出敬老版从原页面进入。");
      }
    }

    function renderLoginGuide() {
      renderGuide(
        "登录或注册12306",
        "登录和身份核验由12306原网站完成。请在官方页面输入账号信息。",
        [
          "已有账号：打开官方登录页，选择账号登录或使用铁路12306 App扫码登录。",
          "按12306页面提示完成验证码及身份核验，再办理订单、退票或候补。",
          "没有账号：进入12306官方注册页，按页面提示完成实名注册。"
        ],
        [
          { label: "打开12306登录页", page: "login" },
          { label: "打开12306注册页", page: "register" }
        ]
      );
    }

    function renderTicketFilters() {
      content.replaceChildren();
      const title = document.createElement("h2");
      title.textContent = "筛选可预订车次";
      const intro = document.createElement("p");
      intro.className = "ev-guide-intro";
      intro.textContent = "先在12306查询车票，再用原页面的筛选控件缩小结果。车次和余票仍由12306显示。";
      const controls = document.createElement("div");
      controls.className = "ev-guide-actions";
      const state = window.EasyView12306.getTicketFilterState();
      content.append(title, intro, controls);
      if (state.ok) {
        const toggle = makeButton("", () => {
          const current = window.EasyView12306.getTicketFilterState();
          const result = window.EasyView12306.setOnlyBookable(!current.onlyBookable);
          if (!result.ok) return showNotice(content, result.reason);
          toggle.textContent = `仅看可预订车次：${result.onlyBookable ? "开启" : "关闭"}`;
        });
        toggle.textContent = `仅看可预订车次：${state.onlyBookable ? "开启" : "关闭"}`;
        const label = document.createElement("label");
        label.className = "ev-filter-label";
        label.textContent = "发车时段";
        const select = document.createElement("select");
        select.className = "ev-filter-select";
        for (const [value, text] of [
          ["00002400", "全天"],
          ["00000600", "凌晨 00:00—06:00"],
          ["06001200", "上午 06:00—12:00"],
          ["12001800", "下午 12:00—18:00"],
          ["18002400", "晚上 18:00—24:00"]
        ]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = text;
          select.append(option);
        }
        select.value = state.departureTime;
        select.addEventListener("change", () => {
          const result = window.EasyView12306.setDepartureTimeRange(select.value);
          if (!result.ok) showNotice(content, result.reason);
        });
        label.append(select);
        controls.append(toggle, label, makeButton("查看12306筛选结果", () => exit.click(), true));
      } else {
        const note = document.createElement("p");
        note.className = "ev-message";
        note.textContent = state.reason;
        controls.append(note, makeButton("打开12306车票查询", () => openPage("tickets")));
      }
      controls.append(makeButton("返回业务选择", renderHome, true));
      title.setAttribute("tabindex", "-1");
      title.focus();
    }

    function renderTransferGuide() {
      renderGuide(
        "查询中转换乘",
        "换乘方案和每段余票由12306计算。请在官方页面核对换乘车站、时间和两段车票。",
        [
          "打开12306中转换乘页面；如需登录，按官方页面提示完成。",
          "输入出发地、目的地和出发日期，让12306查询换乘方案。",
          "选择方案前，核对两段列车的余票和换乘时间。"
        ],
        [
          { label: "打开12306中转换乘", page: "transfer" },
          { label: "先去登录", page: "login" }
        ]
      );
    }

    function renderChangeRefundGuide() {
      renderGuide(
        "改签 / 退票",
        "请在12306原页面办理。最终操作前，核对车票、办理条件和页面显示的费用。",
        [
          "先登录12306，打开“我的12306”中的火车票订单。",
          "找到要办理的车票，按官方页面提供的改签或退票入口操作。",
          "改签时核对新车次和差价；退票时核对手续费和退款金额，再由您自己确认。"
        ],
        [
          { label: "打开火车票订单", page: "orders" },
          { label: "先去登录", page: "login" }
        ]
      );
    }

    function renderWaitlistGuide() {
      renderGuide(
        "候补购票",
        "候补需求和付款由12306原页面处理；候补不保证一定兑现。",
        [
          "先登录12306，并按官方要求完成人证一致性核验。",
          "查询车票；如所需车次和席别显示“候补”，在原页面选择并提交需求。",
          "按12306提示完成预付款，之后可在“候补订单”查看状态。"
        ],
        [
          { label: "打开车票查询", page: "tickets" },
          { label: "查看候补订单", page: "waitlistOrders" },
          { label: "先去登录", page: "login" }
        ]
      );
    }

    function renderSeniorGuide() {
      renderGuide(
        "老年出行优惠与服务",
        "优惠资格和票价以12306当前车次及订单页面显示为准，不是所有车次都有统一老年票价折扣。",
        [
          "年满60周岁的铁路畅行常旅客会员，符合条件的乘车可获票面金额15倍积分；积分可按12306规则兑换车票或升席。",
          "购买卧铺时，12306会优先为年满60周岁的旅客分配下铺；实际铺位以出票结果为准。",
          "登录后可在“我的12306”里查看会员和积分；如需人工帮助，可拨打铁路客服12306。"
        ],
        [
          { label: "打开12306登录页", page: "login" },
          { label: "查询当前车次票价", page: "tickets" }
        ]
      );
    }

    renderHome();
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

  function makeButton(text, onClick, secondary = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = secondary ? "ev-button ev-button-secondary" : "ev-button ev-button-primary";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function showNotice(content, text) {
    content.querySelector(".ev-notice")?.remove();
    const notice = document.createElement("p");
    notice.className = "ev-message ev-error ev-notice";
    notice.setAttribute("role", "alert");
    notice.textContent = text;
    content.append(notice);
  }

  window.EasyViewOverlay = { create };
})();
