// Chrome background service worker (Manifest V3)
import browser from 'webextension-polyfill';
import {
	getAccountSettings,
	getEnabledAutoCaptureAccounts,
} from './storage.js';
import {
	getAutoCaptureSkipReason,
	normalizeUrlForCapture,
	postUrlToStreamient,
} from './url-capture.js';

const AUTO_CAPTURE_ALARM_PREFIX = 'streamient.autoCapture.';
// Pre-rebrand prefix; persisted alarms from old installs must be cleared on update.
const LEGACY_AUTO_CAPTURE_ALARM_PREFIX = 'kumbukum.autoCapture.';
const AUTO_CAPTURE_PENDING_KEY = 'auto_capture_pending';
const REBRAND_NOTICE_KEY = 'streamient.rebrandNoticePending';
const REBRAND_BADGE_TEXT = 'NEW';
const REBRAND_BADGE_COLOR = '#2d9c6f';

function alarmNameFor(accountId) {
	return AUTO_CAPTURE_ALARM_PREFIX + accountId;
}

function accountIdFromAlarm(name) {
	if (!name || !name.startsWith(AUTO_CAPTURE_ALARM_PREFIX)) return '';
	return name.slice(AUTO_CAPTURE_ALARM_PREFIX.length);
}
const EMAIL_EXTRACT_ACTION = 'streamient.extractEmailCandidate';
const EMAIL_APP_CONTEXT_ACTION = 'streamient.detectEmailAppContext';
const SCROLL_CAPTURE_ACTION = 'streamient.autoCaptureScrollDepth';
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
	void maybeFlagRebrandNotice(details);
	void clearLegacyAutoCaptureAlarms();
	void initializeSidePanelBehavior();
	void handleCurrentActiveTabChanged();
});

browser.runtime.onStartup.addListener(function () {
	void restoreRebrandBadge();
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
	if (areaName === 'sync' && changes.accounts) {
		void scheduleCurrentActiveTab();
	}
});

browser.alarms.onAlarm.addListener(function (alarm) {
	const accountId = accountIdFromAlarm(alarm && alarm.name);
	if (accountId) {
		void handleAutoCaptureAlarm(accountId);
	}
});

browser.runtime.onMessage.addListener(function (message, sender) {
	if (message && message.action === SCROLL_CAPTURE_ACTION) {
		void handleAutoCaptureScroll(message, sender);
	}
});

browser.action.onClicked.addListener(function (tab) {
	void handleActionClickFallback(tab);
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
		return false;
	}

	const sidePanelApi = getChromeSidePanelApi();
	if (!sidePanelApi || !sidePanelApi.setOptions) {
		return false;
	}

	const emailEligible = isEmailAppUrl(tab.url) || await isEmailAppPage(tab.id).catch(function () {
		return false;
	}) || await isEmailPage(tab.id).catch(function () {
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
			await browser.action.setTitle({ tabId: tab.id, title: 'Open Streamient email helper' });
			return true;
		}

		await sidePanelApi.setOptions({
			tabId: tab.id,
			enabled: false,
		});
		await browser.action.setPopup({ tabId: tab.id, popup: POPUP_PATH });
		// null (not '') falls back to the global badge, so the rebrand badge stays visible.
		await browser.action.setBadgeText({ tabId: tab.id, text: null });
		await browser.action.setTitle({ tabId: tab.id, title: 'Streamient' });
		return false;
	} catch (_err) {
		// Keep the default popup usable if tab-specific sidepanel setup fails.
		await browser.action.setPopup({ tabId: tab.id, popup: POPUP_PATH }).catch(function () {});
		return false;
	}
}

async function handleActionClickFallback(tab) {
	if (!tab || !tab.id) {
		return;
	}

	const sidePanelApi = getChromeSidePanelApi();
	if (!sidePanelApi || !sidePanelApi.open) {
		await browser.action.setPopup({ tabId: tab.id, popup: POPUP_PATH }).catch(function () {});
		return;
	}

	try {
		const emailEligible = await updateSidePanelForTab(tab);
		if (!emailEligible) {
			await browser.action.setPopup({ tabId: tab.id, popup: POPUP_PATH }).catch(function () {});
			return;
		}
		await sidePanelApi.open({ tabId: tab.id });
	} catch (_err) {
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

async function clearAllAutoCaptureAlarms() {
	const alarms = await browser.alarms.getAll();
	await Promise.all(alarms
		.filter(function (a) { return a && a.name && a.name.startsWith(AUTO_CAPTURE_ALARM_PREFIX); })
		.map(function (a) { return browser.alarms.clear(a.name); }));
}

async function clearLegacyAutoCaptureAlarms() {
	const alarms = await browser.alarms.getAll();
	await Promise.all(alarms
		.filter(function (a) { return a && a.name && a.name.startsWith(LEGACY_AUTO_CAPTURE_ALARM_PREFIX); })
		.map(function (a) { return browser.alarms.clear(a.name); }));
}

// Installs updated in place from a pre-rebrand (Kumbukum) version get a one-time
// notice: a global action badge plus a dismissible banner in the popup.
async function maybeFlagRebrandNotice(details) {
	if (details.reason !== 'update') return;
	// Kumbukum shipped up to 2.0.x; the Streamient rebrand starts at 2.1.0.
	if (!/^(1\.|2\.0\.)/.test(details.previousVersion || '')) return;
	await browser.storage.local.set({ [REBRAND_NOTICE_KEY]: true });
	await showRebrandBadge();
}

// The global badge does not survive a browser restart; the storage flag does.
async function restoreRebrandBadge() {
	const data = await browser.storage.local.get([REBRAND_NOTICE_KEY]);
	if (data[REBRAND_NOTICE_KEY]) {
		await showRebrandBadge();
	}
}

async function showRebrandBadge() {
	await browser.action.setBadgeText({ text: REBRAND_BADGE_TEXT });
	await browser.action.setBadgeBackgroundColor({ color: REBRAND_BADGE_COLOR });
}

async function scheduleCurrentActiveTab() {
	const enabledAccounts = await getEnabledAutoCaptureAccounts();

	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	const tab = tabs[0];
	if (!tab || !tab.id || !tab.url) {
		await clearPendingCapture();
		return;
	}

	const normalizedUrl = normalizeUrlForCapture(tab.url);
	if (!normalizedUrl) {
		await clearPendingCapture();
		return;
	}

	const eligible = enabledAccounts.filter(function (account) {
		return !getAutoCaptureSkipReason(tab.url, account.auto_capture.exclude_sites);
	});

	await clearAllAutoCaptureAlarms();

	if (eligible.length === 0) {
		await pendingStorage.remove(AUTO_CAPTURE_PENDING_KEY);
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

	const now = Date.now();
	await Promise.all(eligible.map(function (account) {
		return browser.alarms.create(alarmNameFor(account.id), {
			when: now + account.auto_capture.delay_seconds * 1000,
		});
	}));
}

async function handleAutoCaptureAlarm(accountId) {
	const data = await pendingStorage.get([AUTO_CAPTURE_PENDING_KEY]);
	const pending = data[AUTO_CAPTURE_PENDING_KEY];
	if (!pending || !pending.tab_id || !pending.normalized_url) {
		return;
	}

	const account = await getAccountSettings(accountId);
	if (!account || !account.id || !account.auto_capture || !account.auto_capture.enabled) {
		return;
	}

	let tab;
	try {
		tab = await browser.tabs.get(pending.tab_id);
	} catch (_err) {
		return;
	}

	if (tab.windowId !== pending.window_id) {
		return;
	}

	await captureTabIfEligible(tab, account, {
		normalized_url: pending.normalized_url,
		title: pending.title || '',
	});
}

async function handleAutoCaptureScroll(message, sender) {
	const tab = sender && sender.tab;
	if (!tab || !tab.id || !tab.url) {
		return;
	}

	const normalizedMessageUrl = normalizeUrlForCapture(message.url || '');
	if (!normalizedMessageUrl || normalizeUrlForCapture(tab.url) !== normalizedMessageUrl) {
		return;
	}

	const enabledAccounts = await getEnabledAutoCaptureAccounts();
	const scrollAccounts = enabledAccounts.filter(function (account) {
		return account.auto_capture.scroll_capture_enabled;
	});
	if (scrollAccounts.length === 0) return;

	const pendingContext = {
		normalized_url: normalizedMessageUrl,
		title: tab.title || '',
	};

	await Promise.all(scrollAccounts.map(function (account) {
		return captureTabIfEligible(tab, account, pendingContext);
	}));
}

async function captureTabIfEligible(tab, account, pending) {
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

	if (getAutoCaptureSkipReason(tab.url, account.auto_capture.exclude_sites)) {
		return false;
	}

	if (await isEmailPage(tab.id)) {
		return false;
	}

	const urlProjectId = account.url_project_id || account.project_id;
	if (!account.urls_create_url || !account.access_token || !urlProjectId) {
		return false;
	}

	try {
		const screenshotDataUrl = await captureVisibleScreenshot(tab);
		await postUrlToStreamient(account, {
			url: tab.url,
			title: tab.title || (pending && pending.title) || '',
			project_id: urlProjectId,
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

async function isEmailAppPage(tabId) {
	const frameIds = await getTabFrameIds(tabId);
	for (const frameId of frameIds) {
		try {
			const response = await browser.tabs.sendMessage(tabId, {
				action: EMAIL_APP_CONTEXT_ACTION,
				options: {},
			}, { frameId });
			if (response && response.is_email_app) {
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
	await clearAllAutoCaptureAlarms();
	await pendingStorage.remove(AUTO_CAPTURE_PENDING_KEY);
}
