// Background service worker.
//
// Opens the Smoosh website in the right tool when the content script hands an
// image off. The actual watermark removal / compression happens on the site,
// which receives the image via the site-handoff content script.
const SITE_URL = 'https://smoosh-dev.vercel.app';

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'smoosh-open-site') {
    const tool = msg.tool === 'watermark' ? 'watermark' : 'compress';
    chrome.tabs.create({ url: `${SITE_URL}/?tool=${tool}` }, () => {
      // Reading lastError avoids an "unchecked" console warning if the tab
      // open is blocked (e.g. during automated testing).
      void chrome.runtime.lastError;
      reply({ ok: true });
    });
    return true; // async reply
  }
});

chrome.runtime.onInstalled.addListener(() => {
  // no one-time setup needed
});
