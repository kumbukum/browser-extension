// Firefox background script (Manifest V2)
import browser from 'webextension-polyfill';

browser.runtime.onInstalled.addListener(function (details) {
	if (details.reason === 'install') {
		browser.runtime.openOptionsPage();
	}
});
