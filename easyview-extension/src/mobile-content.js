(function () {
  "use strict";
  try {
    window.EasyViewMobileOverlay.create();
  } catch (error) {
    console.error("[EasyView] China Mobile overlay could not be initialized.", error);
  }
})();
