// Background service worker. Minimal for now — the heavy work happens in the
// content-script-spawned worker. Kept as a no-op module so MV3 keeps the
// extension alive when needed.
chrome.runtime.onInstalled.addListener(() => {
  // no setup required
});
