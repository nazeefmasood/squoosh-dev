'use strict';
(() => {
  // src/site-handoff.js
  var KEY = 'smooshHandoff';
  (async () => {
    const found = await chrome.storage.local.get(KEY);
    const data = found[KEY];
    if (!data) return;
    await chrome.storage.local.remove(KEY);
    const file = new File([data.buffer], data.name || 'image.png', {
      type: data.mimeType || 'image/png',
    });
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
    tick();
    const fast = setInterval(tick, 350);
    setTimeout(() => clearInterval(fast), 6e3);
    setTimeout(() => {
      if (!location.pathname.startsWith('/editor')) tick();
    }, 7500);
  })();
})();
