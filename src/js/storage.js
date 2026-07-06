// Cross-browser compatible storage module — multi-account support
import browser from 'webextension-polyfill';

const CLOUD_INSTANCE_URL = 'https://app.streamient.com';
const LOCAL_DEV_INSTANCE_URL = 'http://localhost:3000';
const MIN_AUTO_CAPTURE_SECONDS = 30;
const LEGACY_AUTO_CAPTURE_KEY = 'auto_capture_settings';

const DEFAULT_ACCOUNT_AUTO_CAPTURE = {
	enabled: false,
	delay_seconds: MIN_AUTO_CAPTURE_SECONDS,
	scroll_capture_enabled: false,
	exclude_sites: [],
};

let _legacyMigrationDone = false;

// --- Internal helpers ---

async function _read() {
	const data = await browser.storage.sync.get(['accounts', 'active_account_id']);
	return {
		accounts: data.accounts || [],
		active_account_id: data.active_account_id || null,
	};
}

function _write(data) {
	return browser.storage.sync.set(data);
}

function resolveEffectiveInstanceUrl(instanceUrl) {
	const normalized = (instanceUrl || '').replace(/\/+$/, '');
	const isDevMode = process.env.NODE_ENV === 'development';

	if (isDevMode && (!normalized || normalized === CLOUD_INSTANCE_URL)) {
		return LOCAL_DEV_INSTANCE_URL;
	}

	return normalized;
}

function computeApiUrls(obj) {
	const base = resolveEffectiveInstanceUrl(obj.instance_url);
	obj.instance_url = base;
	obj.token_test_url = `${base}/api/v1/counts`;
	obj.projects_url = `${base}/api/v1/projects`;
	obj.urls_create_url = `${base}/api/v1/urls`;
	obj.notes_create_url = `${base}/api/v1/notes`;
	obj.links_create_url = `${base}/api/v1/links`;
	obj.emails_create_url = `${base}/api/v1/emails`;
	return obj;
}

function normalizeStringList(value) {
	const values = Array.isArray(value) ? value : [];
	return Array.from(new Set(values.map(function (item) {
		return String(item || '').trim();
	}).filter(Boolean)));
}

function normalizeAccountAutoCapture(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const delaySeconds = Math.max(
		MIN_AUTO_CAPTURE_SECONDS,
		parseInt(source.delay_seconds, 10) || MIN_AUTO_CAPTURE_SECONDS,
	);
	return {
		enabled: Boolean(source.enabled),
		delay_seconds: delaySeconds,
		scroll_capture_enabled: Boolean(source.scroll_capture_enabled),
		exclude_sites: normalizeStringList(source.exclude_sites),
	};
}

function withNormalizedAutoCapture(account) {
	return {
		...account,
		auto_capture: normalizeAccountAutoCapture(account && account.auto_capture),
	};
}

async function _migrateLegacyAutoCaptureOnce() {
	if (_legacyMigrationDone) return;
	_legacyMigrationDone = true;

	let local;
	try {
		local = await browser.storage.local.get([LEGACY_AUTO_CAPTURE_KEY]);
	} catch (_err) {
		return;
	}
	const legacy = local && local[LEGACY_AUTO_CAPTURE_KEY];
	if (!legacy || typeof legacy !== 'object') return;

	const { accounts } = await _read();
	const targetIdx = legacy.account_id
		? accounts.findIndex(function (a) { return a.id === legacy.account_id; })
		: -1;

	if (targetIdx !== -1) {
		const current = accounts[targetIdx].auto_capture;
		const currentEnabled = Boolean(current && current.enabled);
		if (!currentEnabled) {
			accounts[targetIdx].auto_capture = normalizeAccountAutoCapture({
				enabled: legacy.enabled,
				delay_seconds: legacy.delay_seconds,
				scroll_capture_enabled: legacy.scroll_capture_enabled,
				exclude_sites: legacy.exclude_sites,
			});
			await _write({ accounts });
		}
	}

	try {
		await browser.storage.local.remove(LEGACY_AUTO_CAPTURE_KEY);
	} catch (_err) {
		// Best-effort cleanup; missing key is fine.
	}
}

// --- Public API ---

async function getAccounts() {
	await _migrateLegacyAutoCaptureOnce();
	const { accounts } = await _read();
	return accounts.map(withNormalizedAutoCapture);
}

async function getActiveAccountId() {
	const { active_account_id } = await _read();
	return active_account_id;
}

async function getActiveAccount() {
	await _migrateLegacyAutoCaptureOnce();
	const { accounts, active_account_id } = await _read();
	const found = accounts.find(function (a) { return a.id === active_account_id; });
	return found ? withNormalizedAutoCapture(found) : null;
}

async function setActiveAccount(id) {
	await _write({ active_account_id: id });
}

async function addAccount({ name, instance_url, access_token }) {
	const { accounts } = await _read();
	const account = {
		id: crypto.randomUUID(),
		name: name || 'Account',
		instance_url: (instance_url || 'https://app.streamient.com').replace(/\/+$/, ''),
		access_token: access_token || '',
		project_id: '',
		project_name: '',
		email_project_id: '',
		email_project_name: '',
		url_project_id: '',
		url_project_name: '',
		auto_capture: { ...DEFAULT_ACCOUNT_AUTO_CAPTURE },
	};
	accounts.push(account);
	const update = { accounts };
	if (accounts.length === 1) {
		update.active_account_id = account.id;
	}
	await _write(update);
	return account;
}

async function updateAccount(id, fields) {
	const { accounts } = await _read();
	const idx = accounts.findIndex(function (a) { return a.id === id; });
	if (idx === -1) throw new Error('Account not found');
	const next = { ...fields };
	if (next.instance_url) {
		next.instance_url = next.instance_url.replace(/\/+$/, '');
	}
	if (Object.prototype.hasOwnProperty.call(next, 'auto_capture')) {
		next.auto_capture = normalizeAccountAutoCapture(next.auto_capture);
	}
	Object.assign(accounts[idx], next);
	await _write({ accounts });
	return accounts[idx];
}

async function deleteAccount(id) {
	const data = await _read();
	data.accounts = data.accounts.filter(function (a) { return a.id !== id; });
	if (data.active_account_id === id) {
		data.active_account_id = data.accounts.length > 0 ? data.accounts[0].id : null;
	}
	await _write(data);
}

/**
 * Returns the active account's settings with computed API URLs.
 * Shape is compatible with the old flat format used by popup.js.
 */
async function getAllSettings() {
	const account = await getActiveAccount();
	if (!account) return {};
	return computeApiUrls({ ...account });
}

async function getAccountSettings(accountId) {
	await _migrateLegacyAutoCaptureOnce();
	const { accounts } = await _read();
	const account = accounts.find(function (a) { return a.id === accountId; });
	if (!account) return {};
	return computeApiUrls({ ...withNormalizedAutoCapture(account) });
}

/**
 * Returns every account with auto_capture.enabled, project_id, access_token
 * set, each enriched with computed API URLs. Performs the one-shot legacy
 * migration on first call.
 */
async function getEnabledAutoCaptureAccounts() {
	await _migrateLegacyAutoCaptureOnce();
	const { accounts } = await _read();
	return accounts
		.map(withNormalizedAutoCapture)
		.filter(function (account) {
			return account.auto_capture.enabled
				&& account.project_id
				&& account.access_token
				&& account.instance_url;
		})
		.map(function (account) { return computeApiUrls({ ...account }); });
}

export {
	DEFAULT_ACCOUNT_AUTO_CAPTURE,
	getAccounts,
	getActiveAccountId,
	getActiveAccount,
	getAccountSettings,
	setActiveAccount,
	addAccount,
	updateAccount,
	deleteAccount,
	getAllSettings,
	getEnabledAutoCaptureAccounts,
	normalizeAccountAutoCapture,
};
