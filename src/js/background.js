// Chrome background service worker (Manifest V3)
import browser from 'webextension-polyfill';

browser.runtime.onInstalled.addListener(function (details) {
	if (details.reason === 'install') {
		browser.runtime.openOptionsPage();
	}
});
