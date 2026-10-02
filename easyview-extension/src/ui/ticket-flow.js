(function () {
  "use strict";

  const adapter = () => window.EasyView12306;

  function formatDate(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function makeDate(offset) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    return date;
  }

  function render(container, handlers) {
    const { onHome, onFilters, onTransfer, onViewResults } = handlers;
    const state = { step: 1, departure: "", arrival: "", date: makeDate(1), custom: false };
    const title = document.createElement("h2");
    const body = document.createElement("div");
    body.className = "ev-flow-body";
    container.replaceChildren(title, body);

    function field(label, placeholder, value = "") {
      const wrapper = document.createElement("label");
      wrapper.className = "ev-field";
      const caption = document.createElement("span");
      caption.textContent = label;
      const input = document.createElement("input");
      input.type = "text";
      input.autocomplete = "off";
      input.placeholder = placeholder;
      input.value = value;
      input.setAttribute("aria-label", label);
      wrapper.append(caption, input);
      return { wrapper, input };
    }

    function action(text, handler, secondary = false) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = secondary ? "ev-button ev-button-secondary" : "ev-button ev-button-primary";
      button.textContent = text;
      button.addEventListener("click", handler);
      return button;
    }

    function message(text, error = false) {
      const node = document.createElement("p");
      node.className = error ? "ev-message ev-error" : "ev-message";
      node.setAttribute("role", error ? "alert" : "status");
      node.textContent = text;
      return node;
    }

    function showError(text) {
      const prior = body.querySelector('[role="alert"]');
      if (prior) prior.remove();
      body.prepend(message(text, true));
    }

    function renderStep() {
      body.replaceChildren();
      if (state.step === 1 || state.step === 2) {
        const departureStep = state.step === 1;
        title.textContent = departureStep ? "您从哪里出发？" : "您要去哪里？";
        const control = field(departureStep ? "出发地" : "到达地", departureStep ? "例如：南京" : "例如：杭州", departureStep ? state.departure : state.arrival);
        body.append(control.wrapper, message("请输入城市名称。提交前会尝试同步到12306原页面。"));
        body.append(action("下一步", () => {
          const value = control.input.value.trim();
          if (!value) return showError("请先填写城市名称。");
          if (departureStep) state.departure = value;
          else state.arrival = value;
          state.step += 1;
          renderStep();
          body.querySelector("input")?.focus();
        }));
      } else if (state.step === 3) {
        title.textContent = "哪一天出发？";
        const dates = [0, 1, 2].map((offset) => {
          const date = makeDate(offset);
          return action(["今天", "明天", "后天"][offset] + `（${formatDate(date)}）`, () => {
            state.date = date;
            state.custom = false;
            state.step = 4;
            renderStep();
          }, state.date.toDateString() !== date.toDateString());
        });
        const other = action("选择其他日期", () => {
          state.custom = true;
          renderStep();
        }, true);
        body.append(...dates, other);
        if (state.custom) {
          const dateInput = document.createElement("input");
          dateInput.type = "date";
          dateInput.className = "ev-date-input";
          dateInput.min = makeDate(0).toISOString().slice(0, 10);
          dateInput.max = makeDate(15).toISOString().slice(0, 10);
          dateInput.value = state.date.toISOString().slice(0, 10);
          dateInput.setAttribute("aria-label", "选择出发日期");
          dateInput.addEventListener("change", () => {
            if (!dateInput.value) return;
            state.date = new Date(`${dateInput.value}T12:00:00`);
          });
          body.append(dateInput, action("确认日期", () => {
            if (!dateInput.value) return showError("请选择出发日期。");
            state.date = new Date(`${dateInput.value}T12:00:00`);
            state.step = 4;
            renderStep();
          }));
        }
      } else {
        title.textContent = "请确认出行信息";
        const summary = document.createElement("div");
        summary.className = "ev-trip-summary";
        summary.innerHTML = "<span></span><b aria-hidden='true'>↓</b><span></span><strong></strong>";
        summary.children[0].textContent = state.departure;
        summary.children[2].textContent = state.arrival;
        summary.children[3].textContent = formatDate(state.date);
        body.append(summary, message("点击查询后，将由12306原页面执行查询。乘车人姓名和证件请在官方登录及购票页面填写。"));
        body.append(action("查询车票", async () => {
          const search = body.querySelector(".ev-button-primary");
          search.disabled = true;
          try {
            const api = adapter();
            const date = `${state.date.getFullYear()}-${String(state.date.getMonth() + 1).padStart(2, "0")}-${String(state.date.getDate()).padStart(2, "0")}`;
            const results = [await api.setDeparture(state.departure), await api.setArrival(state.arrival), api.setDate(date)];
            const failure = results.find((result) => !result.ok);
            if (failure) return showError(failure.reason);
            const submitted = api.submitSearch();
            if (!submitted.ok) return showError(submitted.reason);
            body.replaceChildren(
              message("已将查询操作交给12306原页面。您可以继续筛选、查询换乘或查看原页面结果。"),
              action("筛选可预订车次", onFilters),
              action("查询中转换乘", onTransfer, true),
              action("查看12306结果", onViewResults, true)
            );
          } catch (error) {
            showError(`无法操作12306页面：${error?.message || "未知错误"}。请退出敬老版使用原页面。`);
          } finally {
            search.disabled = false;
          }
        }));
      }
      const nav = document.createElement("div");
      nav.className = "ev-flow-nav";
      if (state.step > 1) nav.append(action("上一步", () => { state.step -= 1; renderStep(); }, true));
      nav.append(action("返回首页", onHome, true));
      body.append(nav);
    }

    renderStep();
  }

  window.EasyViewTicketFlow = { render };
})();
