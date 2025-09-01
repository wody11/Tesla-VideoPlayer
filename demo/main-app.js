// Minimal demo shim (plain JS).
// This file intentionally does not import TS sources. It only ensures that if a built bundle
// exposes `PlayerCore` on the page, it stays available for the demo page's inline script.
(function(){
  // If a bundler/build has already exposed PlayerCore globally, do nothing.
  if (window.PlayerCore) return;

  // Otherwise, we cannot create a PlayerCore instance from TS source without a build step.
  // No automatic fallback here; main demo page uses PlayerCore-only path.
  console.info('demo shim loaded; window.PlayerCore not found (build demo bundle first)');
})();
