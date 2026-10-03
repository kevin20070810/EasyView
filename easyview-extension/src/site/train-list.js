/* EasyView · 12306 车次列表解析
 *
 * 为什么要有这个文件：
 *   tools/probe_train_list.py 实测过，查票结果页的结构是稳定的 ——
 *     #queryLeftTable tr[id^="ticket_"]   110 行，每趟车一行
 *     .number                             车次号（G531）
 *     行内 13 个单元格                     出发站/到达站/发车/到达/历时
 *     无障碍文本                          "G531次列车，二等座票价525元，余票有"
 *
 *   而通用 AI 路径在这一页上给出的是「我要退票 / 我要改签 / 查正晚点」——
 *   首页级别的任务。模型不知道"车次列表"是什么，而且 400 元素触顶截断后
 *   说明书里大半是导航和页脚。所以这一步必须专门读，不是"让 AI 再努力一点"。
 *
 *   好消息是这里的"AI 理解"本来就不必要：车次列表是结构化数据，
 *   直接读比让模型猜更准、更快、更便宜。
 *
 * 数据源优先级：无障碍文本 > 单元格位置。
 *   12306 自己输出的 aria 文本里带着车次、席别、票价、余票，是四个字段一次到位，
 *   比按第几个 td 去取稳妥得多（列的增删我们控制不了）。
 */
(function () {
  "use strict";

  const PRICE_RE = /(商务座|一等座|二等座|无座|软卧|硬卧|软座|硬座)票价(\d+(?:\.\d+)?)元，余票(.+?)$/;

  function textOf(node) {
    return node ? (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  /** 从一行里读出席别 → {price, left} 的映射（数据来自 12306 自己的 aria 文本）。 */
  function seatInfo(row) {
    const seats = {};
    // aria-label 或者带 title 的节点上都可能出现这句描述
    const nodes = row.querySelectorAll("[aria-label], [title]");
    for (const node of nodes) {
      const raw = node.getAttribute("aria-label") || node.getAttribute("title") || "";
      const m = PRICE_RE.exec(raw.trim());
      if (!m) continue;
      const [, cls, price, left] = m;
      if (!seats[cls]) seats[cls] = { price: Number(price), left };
    }
    return seats;
  }

  /** 读一趟车。取不到的字段留空，不要编。 */
  function readRow(row) {
    const numberNode = row.querySelector(".number");
    const code = textOf(numberNode);
    if (!code) return null;

    const cells = [...row.querySelectorAll("td")].map(textOf);

    // 第一个单元格把车次、车站、时刻、历时全塞在一起（实测结构）：
    //   "G531 复静 北京南 上海虹桥 06:08 12:04 05:56 当日到达"
    // 中间的"复静"之类是标记，可能有也可能没有，所以站名取"时刻之前最后两个词"，
    // 不去猜固定下标。后面 12 个单元格只有余票和"预订"。
    let from = "", to = "", depart = "", arrive = "", duration = "";
    const head = cells[0] || "";
    const times = head.match(/\d{1,2}:\d{2}/g) || [];
    const before = head.split(/\d{1,2}:\d{2}/)[0].trim().split(/\s+/).filter(Boolean);
    if (times.length >= 2) {
      depart = times[0];
      arrive = times[1];
      if (times.length >= 3) duration = times[2];
      if (before.length >= 2) {
        from = before[before.length - 2];
        to = before[before.length - 1];
      }
    }
    // 历时可能写成 "5小时56分" 而不是 "05:56"，那就从末尾再捞一次
    if (!duration) {
      const dur = head.match(/(\d+\s*小时\s*\d+\s*分)/);
      if (dur) duration = dur[1].replace(/\s+/g, "");
    }

    const seats = seatInfo(row);
    const second = seats["二等座"] || null;
    const anySeat = second
      || seats["一等座"] || seats["商务座"] || seats["硬座"] || seats["软座"] || null;

    return {
      code,
      from,
      to,
      depart,
      arrive,
      duration,
      seats,
      price: anySeat ? anySeat.price : null,
      priceClass: second ? "二等座" : (anySeat ? Object.keys(seats).find((k) => seats[k] === anySeat) : null),
      left: anySeat ? anySeat.left : "",
      // "预订"按钮就在这一行里，点了才进下单流程
      bookButton: row.querySelector("a[id^='btn'], a[class*='btn']") || row.querySelector("a"),
    };
  }

  function read() {
    let rows = [];
    try {
      rows = [...document.querySelectorAll('#queryLeftTable tr[id^="ticket_"]')];
      if (!rows.length) rows = [...document.querySelectorAll('#queryLeftTable tr')];
    } catch (_) {
      return [];
    }
    const trains = [];
    for (const row of rows) {
      const t = readRow(row);
      if (t && t.code) trains.push(t);
    }
    return trains;
  }

  globalThis.EasyViewTrainList = { read, readRow };
})();
