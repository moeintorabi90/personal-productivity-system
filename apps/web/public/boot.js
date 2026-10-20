// Runs before the app bundle. Reads a non-sensitive hint (language and theme only) written by the
// app, so the first paint uses the right direction and theme. The source of truth is IndexedDB.
(function () {
  try {
    var hint = JSON.parse(localStorage.getItem("pps-shell") || "null");
    if (!hint) return;
    var root = document.documentElement;
    if (hint.language === "fa" || hint.language === "en") {
      root.lang = hint.language;
      root.dir = hint.language === "fa" ? "rtl" : "ltr";
    }
    if (hint.theme === "light" || hint.theme === "dark" || hint.theme === "system") {
      root.setAttribute("data-theme", hint.theme);
    }
  } catch (e) {
    // Ignore: storage unavailable or malformed hint.
  }
})();
