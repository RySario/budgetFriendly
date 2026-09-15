/* Applies the saved light/dark choice before the page paints, so a dark theme
   never flashes white. A classic script in <head>; the app's modules call
   window.bfApplyTheme when the choice changes. No saved choice means follow
   the device. */
(function () {
  var COLORS = { light: '#f5f6fa', dark: '#0b0d14' };
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function apply(choice) {
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    var dark = choice === 'dark' || (choice !== 'light' && !!(media && media.matches));
    root.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.getElementById('theme-color');
    if (meta) meta.setAttribute('content', dark ? COLORS.dark : COLORS.light);
  }

  var saved = null;
  try { saved = localStorage.getItem('bf-theme'); } catch (e) { /* storage blocked: follow the device */ }
  apply(saved);
  window.bfApplyTheme = apply;
}());
