// install-chrome.js
const puppeteer = require('puppeteer');

(async () => {
  console.log('Downloading Chromium for Puppeteer...');
  const browserFetcher = puppeteer.createBrowserFetcher();
  const revisionInfo = await browserFetcher.download('146.0.7680.31');
  console.log(`Chromium downloaded at: ${revisionInfo.executablePath}`);
})();