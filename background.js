// Captures the Authorization header the Discord web client already sends,
// so the extension can make the same requests. The token is kept only in
// chrome.storage.session (memory, cleared when the browser closes) and is
// only ever used for requests to https://discord.com.

let lastToken = null;

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const header = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === 'authorization'
    );
    if (header && header.value && header.value !== lastToken) {
      lastToken = header.value;
      chrome.storage.session.set({ token: header.value });
    }
  },
  { urls: ['https://discord.com/api/*'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (msg && msg.type === 'getToken') {
    // Only the content script running on discord.com gets the actual value.
    if (!sender.tab || !sender.url || !sender.url.startsWith('https://discord.com/')) {
      sendResponse({ token: null });
      return;
    }
    chrome.storage.session.get('token').then(({ token }) => sendResponse({ token: token || null }));
    return true;
  }

  if (msg && msg.type === 'hasToken') {
    chrome.storage.session.get('token').then(({ token }) => sendResponse({ hasToken: !!token }));
    return true;
  }
});
