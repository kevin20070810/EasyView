(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  // 冻结图标集 v1.0.0，共 16 个。每个图标是一组 24x24 视图下的路径。
  // 与 docs/ui.schema.json 的 icon 字段一一对应，新增图标必须先改协议。
  var PATHS = {
    home: ["M3 11.5 12 4l9 7.5", "M5.5 10.5V20h13v-9.5"],
    calendar: ["M3.5 5.5h17v15h-17z", "M3.5 9.5h17", "M8 3.5v4", "M16 3.5v4"],
    document: ["M6.5 3h8l3 3v15h-11z", "M14.5 3v3.5H18", "M9 12h6", "M9 16h6"],
    payment: ["M2.5 6.5h19v11h-19z", "M2.5 10.5h19", "M6 14.5h4"],
    phone: [
      "M20.5 16.6v2.6a2 2 0 0 1-2.2 2 19 19 0 0 1-8.3-3 18.6 18.6 0 0 1-5.7-5.7 19 19 0 0 1-3-8.4 2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1l-1.1 1.1a15.2 15.2 0 0 0 5.7 5.7l1.1-1.1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"
    ],
    user: ["M20 20.5a8 8 0 0 0-16 0", "M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"],
    search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M16.2 16.2 21 21"],
    location: ["M12 21.5s7-6.1 7-11.5a7 7 0 1 0-14 0c0 5.4 7 11.5 7 11.5z", "M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"],
    bus: ["M4.5 6h15v9.5h-15z", "M4.5 10.5h15", "M8 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M16 18.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"],
    train: ["M6.5 3.5h11v12h-11z", "M6.5 10.5h11", "M9.5 20.5l-2-3", "M14.5 20.5l2-3", "M9.5 13.5h.01", "M14.5 13.5h.01"],
    hospital: ["M4.5 3.5h15v17h-15z", "M12 7.5v7", "M8.5 11h7"],
    government: ["M3.5 20.5h17", "M5.5 20.5v-10", "M9.5 20.5v-10", "M14.5 20.5v-10", "M18.5 20.5v-10", "M3.5 10.5 12 4l8.5 6.5"],
    warning: ["M12 3.5 21.5 20.5h-19z", "M12 9.5v5", "M12 17.5h.01"],
    info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5.5", "M12 7.5h.01"],
    help: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1 .9-1 1.7", "M12 17h.01"],
    back: ["M14.5 5.5 8 12l6.5 6.5"]
  };

  var DEFAULT_NAME = "help";
  var NAMES = Object.keys(PATHS);

  function has(name) {
    return Object.prototype.hasOwnProperty.call(PATHS, name);
  }

  function create(name, options) {
    options = options || {};
    var resolved = has(name) ? name : DEFAULT_NAME;
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", options.strokeWidth || "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.classList.add("ev-icon");
    if (options.className) svg.classList.add(options.className);

    PATHS[resolved].forEach(function (d) {
      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });

    svg.dataset.icon = resolved;
    if (resolved !== name) svg.dataset.iconFallback = "true";
    return svg;
  }

  global.EasyViewIcons = {
    names: NAMES,
    defaultName: DEFAULT_NAME,
    has: has,
    create: create
  };
})(window);
