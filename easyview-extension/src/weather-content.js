(function () {
  "use strict";
  try {
    window.EasyViewWeatherOverlay.create();
  } catch (error) {
    console.error("[EasyView] weather overlay could not be initialized.", error);
  }
})();
