// Cross-browser compatible storage module — multi-account support
import browser from 'webextension-polyfill';

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

function computeApiUrls(obj) {
	const base = (obj.instance_url || '').replace(/\/+$/, '');
	obj.instance_url = base;
	obj.token_test_url = `${base}/api/v1/counts`;
	obj.projects_url = `${base}/api/v1/projects`;
	obj.urls_create_url = `${base}/api/v1/urls`;
	obj.notes_create_url = `${base}/api/v1/notes`;
	obj.links_create_url = `${base}/api/v1/links`;
	return obj;
}

// --- Public API ---

async function getAccounts() {
	const { accounts } = await _read();
	return accounts;
}

async function getActiveAccountId() {
	const { active_account_id } = await _read();
	return active_account_id;
}

async function getActiveAccount() {
	const { accounts, active_account_id } = await _read();
	return accounts.find(function (a) { return a.id === active_account_id; }) || null;
}

async function setActiveAccount(id) {
	await _write({ active_account_id: id });
}

async function addAccount({ name, instance_url, access_token }) {
	const { accounts } = await _read();
	const account = {
		id: crypto.randomUUID(),
		name: name || 'Account',
		instance_url: (instance_url || 'https://app.kumbukum.com').replace(/\/+$/, ''),
		access_token: access_token || '',
		project_id: '',
		project_name: '',
	};
	accounts.push(account);
	// If this is the first account, make it active
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
	if (fields.instance_url) {
		fields.instance_url = fields.instance_url.replace(/\/+$/, '');
	}
	Object.assign(accounts[idx], fields);
	await _write({ accounts });
	return accounts[idx];
}

async function deleteAccount(id) {
	const data = await _read();
	data.accounts = data.accounts.filter(function (a) { return a.id !== id; });
	// If we deleted the active account, switch to the first remaining one
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

export {
	getAccounts,
	getActiveAccountId,
	getActiveAccount,
	setActiveAccount,
	addAccount,
	updateAccount,
	deleteAccount,
	getAllSettings,
};
