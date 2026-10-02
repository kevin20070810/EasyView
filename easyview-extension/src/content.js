(function () {
  "use strict";
  try {
    window.EasyViewOverlay.create();
  } catch (error) {
    console.error("EasyView 12306 overlay could not be initialized.", error);
  }
})();
