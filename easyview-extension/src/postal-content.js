(function () {
  "use strict";
  try {
    window.EasyViewPostalOverlay.create();
  } catch (error) {
    console.error("[EasyView] postal overlay could not be initialized.", error);
  }
})();
