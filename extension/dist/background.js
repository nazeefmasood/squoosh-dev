'use strict';
(() => {
  // src/background.js
  var SITE_URL = 'https://smoosh-dev.vercel.app';
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'smoosh-open-site') {
      const tool = msg.tool === 'watermark' ? 'watermark' : 'compress';
      chrome.tabs.create({ url: `${SITE_URL}/?tool=${tool}` }, () => {
        void chrome.runtime.lastError;
        reply({ ok: true });
      });
      return true;
    }
  });
  chrome.runtime.onInstalled.addListener(() => {});
})();
