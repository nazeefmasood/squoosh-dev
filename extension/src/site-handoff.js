// Runs on smoosh-dev.vercel.app. If the extension just handed an image over
// (from a Gemini/ChatGPT button click), drop it into the site's own
// <file-drop> handler so the site's watermark/compress pipeline loads it —
// no custom processing in the extension at all.
const KEY = 'smooshHandoff';

(async () => {
  const found = await chrome.storage.local.get(KEY);
  const data = found[KEY];
  if (!data) return; // normal page load, nothing to do
  // Consume immediately so a reload or second open doesn't re-fire.
  await chrome.storage.local.remove(KEY);

  const file = new File([data.buffer], data.name || 'image.png', {
    type: data.mimeType || 'image/png',
  });

  // Drop the file onto the site's <file-drop> element. The element reads
  // dataTransfer.items on the native 'drop' and emits 'filedrop', which the
  // app wires to handleFiles() -> opens the right tool with the file.
  function drop() {
    const fd = document.querySelector('file-drop');
    if (!fd) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    fd.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      }),
    );
    return true;
  }

  // The SPA hydrates asynchronously; the app's onfiledrop handler isn't bound
  // until then. Retry until the URL moves to /editor (handleFiles opened it),
  // or give up after a few seconds.
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  const tick = () => {
    if (stopped) return;
    if (location.pathname.startsWith('/editor')) {
      stop();
      return;
    }
    drop();
  };
  // A few immediate attempts, then a slower poll.
  tick();
  const fast = setInterval(tick, 350);
  setTimeout(() => clearInterval(fast), 6000);
  // Also catch a late hydration after the fast window.
  setTimeout(() => {
    if (!location.pathname.startsWith('/editor')) tick();
  }, 7500);
})();
