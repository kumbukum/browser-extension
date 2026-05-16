// Chrome background service worker (Manifest V3)
import browser from 'webextension-polyfill';
import {
	getAccountSettings,
	getAutoCaptureSettings,
} from './storage.js';
import {
	getAutoCaptureSkipReason,
	normalizeUrlForCapture,
	postUrlToKumbukum,
} from './url-capture.js';

const AUTO_CAPTURE_ALARM_NAME = 'kumbukum.autoCapture';
const AUTO_CAPTURE_PENDING_KEY = 'auto_capture_pending';
const EMAIL_EXTRACT_ACTION = 'kumbukum.extractEmailCandidate';
const SCROLL_CAPTURE_ACTION = 'kumbukum.autoCaptureScrollDepth';
const SIDEPANEL_PATH = 'sidepanel.html';
const POPUP_PATH = 'popup.html';
const EMAIL_ACTION_BADGE = 'AI';
const pendingStorage = browser.storage.session || browser.storage.local;
const EMAIL_APP_HOSTS = [
	'mail.google.com',
	'outlook.live.com',
	'outlook.office.com',
	'outlook.office365.com',
	'app.fastmail.com',
	'mail.yahoo.com',
	'proton.me',
	'mail.proton.me',
	'icloud.com',
];

browser.runtime.onInstalled.addListener(function (details) {
	if (details.reason === 'install') {
		browser.runtime.openOptionsPage();
	}
	void initializeSidePanelBehavior();
	void handleCurrentActiveTabChanged();
});

browser.runtime.onStartup.addListener(function () {
	void initializeSidePanelBehavior();
	void handleCurrentActiveTabChanged();
});

browser.tabs.onActivated.addListener(function (activeInfo) {
	void updateSidePanelForTabId(activeInfo.tabId);
	void scheduleCurrentActiveTab();
});

browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
	if (!changeInfo.url && changeInfo.status !== 'complete' && !changeInfo.title) {
		return;
	}
	if (tab && tab.active) {
		void updateSidePanelForTab(tab);
		void scheduleCurrentActiveTab();
	}
});

browser.windows.onFocusChanged.addListener(function (windowId) {
	if (windowId === browser.windows.WINDOW_ID_NONE) {
		void clearPendingCapture();
		return;
	}
	void handleCurrentActiveTabChanged();
});

browser.storage.onChanged.addListener(function (changes, areaName) {
	if (areaName === 'local' && changes.auto_capture_settings) {
		void scheduleCurrentActiveTab();
	}
});

browser.alarms.onAlarm.addListener(function (alarm) {
	if (alarm.name === AUTO_CAPTURE_ALARM_NAME) {
		void handleAutoCaptureAlarm();
	}
});

browser.runtime.onMessage.addListener(function (message, sender) {
	if (message && message.action === SCROLL_CAPTURE_ACTION) {
		void handleAutoCaptureScroll(message, sender);
	}
});

async function initializeSidePanelBehavior() {
	const sidePanelApi = getChromeSidePanelApi();
	if (!sidePanelApi || !sidePanelApi.setPanelBehavior) {
		return;
	}

	try {
		await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: true });
	} catch (_err) {
		// Side Panel support is Chrome-only and best-effort.
	}
}

async function handleCurrentActiveTabChanged() {
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	const tab = tabs[0];
	if (tab) {
		await updateSidePanelForTab(tab);
	}
	await scheduleCurrentActiveTab();
}

async function updateSidePanelForTabId(tabId) {
	if (!tabId) {
		return;
	}

	try {
		const tab = await browser.tabs.get(tabId);
		await updateSidePanelForTab(tab);
	} catch (_err) {
		// Tab may have disappeared.
	}
}

async function updateSidePanelForTab(tab) {
	if (!tab || !tab.id) {
		return;
	}

	const sidePanelApi = getChromeSidePanelApi();
	if (!sidePanelApi || !sidePanelApi.setOptions) {
		return;
	}

	const emailEligible = isEmailAppUrl(tab.url) || await isEmailPage(tab.id).catch(function () {
		return false;
	});

	try {
		if (emailEligible) {
			await sidePanelApi.setOptions({
				tabId: tab.id,
				path: SIDEPANEL_PATH,
				enabled: true,
			});
			await browser.action.setPopup({ tabId: tab.id, popup: '' });
			await browser.action.setBadgeText({ tabId: tab.id, text: EMAIL_ACTION_BADGE });
			await browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#2d9c6f' });
			await browser.action.setTitle({ tabId: tab.id, title: 'Open Kumbukum email helper' });
			return;
		}

		await sidePanelApi.setOptions({
			tabId: tab.id,
			enabled: false,
		});
		await browser.action.setPopup({ tabId: tab.id, popup: POPUP_PATH });
		await browser.action.setBadgeText({ tabId: tab.id, text: '' });
		await browser.action.setTitle({ tabId: tab.id, title: 'Kumbukum' });
	} catch (_err) {
		// Keep the default popup usable if tab-specific sidepanel setup fails.
		await browser.action.setPopup({ tabId: tab.id, popup: POPUP_PATH }).catch(function () {});
	}
}

function getChromeSidePanelApi() {
	if (typeof chrome === 'undefined' || !chrome.sidePanel) {
		return null;
	}
	return chrome.sidePanel;
}

function isEmailAppUrl(url) {
	try {
		const host = new URL(url || '').hostname.toLowerCase();
		return EMAIL_APP_HOSTS.some(function (emailHost) {
			return host === emailHost || host.endsWith('.' + emailHost);
		});
	} catch (_err) {
		return false;
	}
}

async function scheduleCurrentActiveTab() {
	const settings = await getAutoCaptureSettings();
	if (!settings.enabled || !settings.account_id || !settings.project_id) {
		await clearPendingCapture();
		return;
	}

	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	const tab = tabs[0];
	if (!tab || !tab.id || !tab.url) {
		await clearPendingCapture();
		return;
	}

	const skipReason = getAutoCaptureSkipReason(tab.url, settings.exclude_sites);
	const normalizedUrl = normalizeUrlForCapture(tab.url);
	if (skipReason || !normalizedUrl) {
		await clearPendingCapture();
		return;
	}

	await pendingStorage.set({
		[AUTO_CAPTURE_PENDING_KEY]: {
			tab_id: tab.id,
			window_id: tab.windowId,
			normalized_url: normalizedUrl,
			title: tab.title || '',
			started_at: Date.now(),
		},
	});
	await browser.alarms.clear(AUTO_CAPTURE_ALARM_NAME);
	await browser.alarms.create(AUTO_CAPTURE_ALARM_NAME, {
		when: Date.now() + settings.delay_seconds * 1000,
	});
}

async function handleAutoCaptureAlarm() {
	const data = await pendingStorage.get([AUTO_CAPTURE_PENDING_KEY]);
	const pending = data[AUTO_CAPTURE_PENDING_KEY];
	if (!pending || !pending.tab_id || !pending.normalized_url) {
		await clearPendingCapture();
		return;
	}

	const settings = await getAutoCaptureSettings();
	if (!settings.enabled || !settings.account_id || !settings.project_id) {
		await clearPendingCapture();
		return;
	}

	let tab;
	try {
		tab = await browser.tabs.get(pending.tab_id);
	} catch (_err) {
		await clearPendingCapture();
		return;
	}

	if (tab.windowId !== pending.window_id) {
		await clearPendingCapture();
		return;
	}

	await captureTabIfEligible(tab, settings, {
		normalized_url: pending.normalized_url,
		title: pending.title || '',
	});
	await clearPendingCapture();
}

async function handleAutoCaptureScroll(message, sender) {
	const settings = await getAutoCaptureSettings();
	if (!settings.enabled || !settings.scroll_capture_enabled || !settings.account_id || !settings.project_id) {
		return;
	}

	const tab = sender && sender.tab;
	if (!tab || !tab.id || !tab.url) {
		return;
	}

	const normalizedMessageUrl = normalizeUrlForCapture(message.url || '');
	if (!normalizedMessageUrl || normalizeUrlForCapture(tab.url) !== normalizedMessageUrl) {
		return;
	}

	await captureTabIfEligible(tab, settings, {
		normalized_url: normalizedMessageUrl,
		title: tab.title || '',
	});
	await clearPendingCapture();
}

async function captureTabIfEligible(tab, settings, pending) {
	if (!tab || !tab.id || !tab.url || !tab.active) {
		return false;
	}

	if (pending && pending.normalized_url && normalizeUrlForCapture(tab.url) !== pending.normalized_url) {
		return false;
	}

	let win;
	try {
		win = await browser.windows.get(tab.windowId);
	} catch (_err) {
		return false;
	}

	if (!win.focused) {
		return false;
	}

	if (getAutoCaptureSkipReason(tab.url, settings.exclude_sites)) {
		return false;
	}

	if (await isEmailPage(tab.id)) {
		return false;
	}

	const accountSettings = await getAccountSettings(settings.account_id);
	if (!accountSettings.urls_create_url || !accountSettings.access_token || !settings.project_id) {
		return false;
	}

	try {
		const screenshotDataUrl = await captureVisibleScreenshot(tab);
		await postUrlToKumbukum(accountSettings, {
			url: tab.url,
			title: tab.title || (pending && pending.title) || '',
			project_id: settings.project_id,
			screenshot_data_url: screenshotDataUrl,
		});
		return true;
	} catch (_err) {
		// Autocapture is best-effort; manual capture remains available.
		return false;
	}
}

async function captureVisibleScreenshot(tab) {
	try {
		return await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
	} catch (_err) {
		return '';
	}
}

async function isEmailPage(tabId) {
	const frameIds = await getTabFrameIds(tabId);
	for (const frameId of frameIds) {
		try {
			const response = await browser.tabs.sendMessage(tabId, {
				action: EMAIL_EXTRACT_ACTION,
				options: {},
			}, { frameId });
			if (response && response.is_email) {
				return true;
			}
		} catch (_err) {
			// Some frames cannot be inspected.
		}
	}
	return false;
}

async function getTabFrameIds(tabId) {
	if (!browser.webNavigation || !browser.webNavigation.getAllFrames) {
		return [0];
	}

	try {
		const frames = await browser.webNavigation.getAllFrames({ tabId });
		if (!Array.isArray(frames) || frames.length === 0) {
			return [0];
		}
		return Array.from(new Set(frames.map(function (frame) {
			return typeof frame.frameId === 'number' ? frame.frameId : 0;
		}))).sort(function (a, b) {
			return a - b;
		});
	} catch (_err) {
		return [0];
	}
}

async function clearPendingCapture() {
	await browser.alarms.clear(AUTO_CAPTURE_ALARM_NAME);
	await pendingStorage.remove(AUTO_CAPTURE_PENDING_KEY);
}
