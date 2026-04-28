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
const pendingStorage = browser.storage.session || browser.storage.local;

browser.runtime.onInstalled.addListener(function (details) {
	if (details.reason === 'install') {
		browser.runtime.openOptionsPage();
	}
	void scheduleCurrentActiveTab();
});

browser.runtime.onStartup.addListener(function () {
	void scheduleCurrentActiveTab();
});

browser.tabs.onActivated.addListener(function () {
	void scheduleCurrentActiveTab();
});

browser.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
	if (!changeInfo.url && changeInfo.status !== 'complete' && !changeInfo.title) {
		return;
	}
	if (tab && tab.active) {
		void scheduleCurrentActiveTab();
	}
});

browser.windows.onFocusChanged.addListener(function (windowId) {
	if (windowId === browser.windows.WINDOW_ID_NONE) {
		void clearPendingCapture();
		return;
	}
	void scheduleCurrentActiveTab();
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

	if (!tab.active || tab.windowId !== pending.window_id || normalizeUrlForCapture(tab.url) !== pending.normalized_url) {
		await clearPendingCapture();
		return;
	}

	let win;
	try {
		win = await browser.windows.get(tab.windowId);
	} catch (_err) {
		await clearPendingCapture();
		return;
	}

	if (!win.focused) {
		await clearPendingCapture();
		return;
	}

	if (getAutoCaptureSkipReason(tab.url, settings.exclude_sites)) {
		await clearPendingCapture();
		return;
	}

	if (await isEmailPage(tab.id)) {
		await clearPendingCapture();
		return;
	}

	const accountSettings = await getAccountSettings(settings.account_id);
	if (!accountSettings.urls_create_url || !accountSettings.access_token || !settings.project_id) {
		await clearPendingCapture();
		return;
	}

	try {
		await postUrlToKumbukum(accountSettings, {
			url: tab.url,
			title: tab.title || pending.title || '',
			project_id: settings.project_id,
		});
	} catch (_err) {
		// Autocapture is best-effort; manual capture remains available.
	} finally {
		await clearPendingCapture();
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
