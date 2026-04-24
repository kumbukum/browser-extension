import browser from 'webextension-polyfill';
import {
	getAccounts, getActiveAccountId, setActiveAccount,
	addAccount, updateAccount, deleteAccount,
} from './storage.js';

const CLOUD_INSTANCE_URL = 'https://app.kumbukum.com';
const LOCAL_INSTANCE_URL = 'http://localhost:3000';

let _editingAccountId = null; // null = adding new, string = editing existing
let _mailboxConfigured = false;
let _resolvedDefaultInstanceUrl = null;

// DOM elements
let accountNameInput, instanceUrlInput, accessTokenInput, projectSelect;
let mailboxProviderSelect, mailboxEmailInput, mailboxAppPasswordInput;
let btnAddAccount, btnVerify, btnSave, btnCancelEdit;
let btnMailboxSetup, btnMailboxTest;
let verifyStatus, saveStatus, projectSection, editorSection, editorTitle;
let mailboxStatus;
let accountListEl, emptyState, versionSpan;

document.addEventListener('DOMContentLoaded', init);

async function init() {
	// Bind DOM elements
	accountNameInput = document.getElementById('account-name');
	instanceUrlInput = document.getElementById('instance-url');
	accessTokenInput = document.getElementById('access-token');
	projectSelect = document.getElementById('project-select');
	mailboxProviderSelect = document.getElementById('mailbox-provider');
	mailboxEmailInput = document.getElementById('mailbox-email');
	mailboxAppPasswordInput = document.getElementById('mailbox-app-password');
	btnAddAccount = document.getElementById('btn-add-account');
	btnVerify = document.getElementById('btn-verify');
	btnSave = document.getElementById('btn-save');
	btnCancelEdit = document.getElementById('btn-cancel-edit');
	btnMailboxSetup = document.getElementById('btn-mailbox-setup');
	btnMailboxTest = document.getElementById('btn-mailbox-test');
	verifyStatus = document.getElementById('verify-status');
	saveStatus = document.getElementById('save-status');
	mailboxStatus = document.getElementById('mailbox-status');
	projectSection = document.getElementById('project-section');
	editorSection = document.getElementById('editor-section');
	editorTitle = document.getElementById('editor-title');
	accountListEl = document.getElementById('account-list');
	emptyState = document.getElementById('empty-state');
	versionSpan = document.getElementById('version');

	versionSpan.textContent = browser.runtime.getManifest().version;

	// Bind events
	btnAddAccount.addEventListener('click', openNewAccountEditor);
	btnVerify.addEventListener('click', verifyConnection);
	btnSave.addEventListener('click', saveAccount);
	btnCancelEdit.addEventListener('click', closeEditor);
	btnMailboxSetup.addEventListener('click', setupMailboxConnector);
	btnMailboxTest.addEventListener('click', testMailboxConnector);
	mailboxProviderSelect.addEventListener('change', markMailboxDirty);
	mailboxEmailInput.addEventListener('input', markMailboxDirty);

	void resolveDefaultInstanceUrl();

	await renderAccountList();
}

async function renderAccountList() {
	const accounts = await getAccounts();
	const activeId = await getActiveAccountId();

	// Clear existing items (keep empty-state element)
	accountListEl.querySelectorAll('.account-item').forEach(function (el) {
		el.remove();
	});

	if (accounts.length === 0) {
		emptyState.style.display = 'block';
		return;
	}

	emptyState.style.display = 'none';

	accounts.forEach(function (account) {
		const item = document.createElement('div');
		item.className = 'account-item' + (account.id === activeId ? ' active' : '');
		item.innerHTML =
			'<div class="account-item-info">' +
				'<div class="account-item-name">' + escapeHtml(account.name) + '</div>' +
				'<div class="account-item-url">' + escapeHtml(account.instance_url || 'Not configured') + '</div>' +
				(account.project_name
					? '<div class="account-item-project">' + escapeHtml(account.project_name) + '</div>'
					: '') +
			'</div>' +
			'<div class="account-item-actions">' +
				'<button class="btn btn-outline-secondary btn-sm btn-edit">Edit</button>' +
				'<button class="btn btn-danger btn-sm btn-delete">Del</button>' +
			'</div>';

		item.querySelector('.btn-edit').addEventListener('click', function () {
			openEditAccountEditor(account);
		});
		item.querySelector('.btn-delete').addEventListener('click', function () {
			confirmDeleteAccount(account);
		});

		accountListEl.appendChild(item);
	});
}

async function openNewAccountEditor() {
	_editingAccountId = null;
	editorTitle.textContent = 'Add Account';
	accountNameInput.value = '';
	instanceUrlInput.value = await resolveDefaultInstanceUrl();
	accessTokenInput.value = '';
	projectSelect.innerHTML = '<option value="">-- Select a project --</option>';
	mailboxProviderSelect.value = '';
	mailboxEmailInput.value = '';
	mailboxAppPasswordInput.value = '';
	_mailboxConfigured = false;
	projectSection.style.display = 'none';
	hideStatus(verifyStatus);
	hideStatus(saveStatus);
	hideStatus(mailboxStatus);
	editorSection.style.display = 'block';
	accountNameInput.focus();
}

function openEditAccountEditor(account) {
	_editingAccountId = account.id;
	editorTitle.textContent = 'Edit Account';
	accountNameInput.value = account.name || '';
	instanceUrlInput.value = account.instance_url || '';
	accessTokenInput.value = account.access_token || '';
	projectSelect.innerHTML = '<option value="">-- Select a project --</option>';
	mailboxProviderSelect.value = account.mailbox_provider || '';
	mailboxEmailInput.value = account.mailbox_email || '';
	mailboxAppPasswordInput.value = '';
	_mailboxConfigured = Boolean(account.mailbox_configured);
	hideStatus(verifyStatus);
	hideStatus(saveStatus);
	hideStatus(mailboxStatus);

	// If already has a valid connection, try to load projects
	if (account.instance_url && account.access_token) {
		loadProjects(account.instance_url, account.access_token, account.project_id);
	} else {
		projectSection.style.display = 'none';
	}

	editorSection.style.display = 'block';
	accountNameInput.focus();
}

function closeEditor() {
	editorSection.style.display = 'none';
	_editingAccountId = null;
}

async function confirmDeleteAccount(account) {
	if (!confirm('Delete account "' + account.name + '"?')) return;
	await deleteAccount(account.id);

	// If we were editing this account, close the editor
	if (_editingAccountId === account.id) {
		closeEditor();
	}
	await renderAccountList();
}

async function verifyConnection() {
	const instanceUrl = instanceUrlInput.value.trim().replace(/\/+$/, '');
	const accessToken = accessTokenInput.value.trim();

	if (!instanceUrl) {
		showStatus(verifyStatus, 'Please enter your Kumbukum instance URL.', 'error');
		return;
	}
	if (!accessToken) {
		showStatus(verifyStatus, 'Please enter your access token.', 'error');
		return;
	}

	showStatus(verifyStatus, 'Verifying...', 'info');
	btnVerify.disabled = true;

	try {
		const response = await fetch(instanceUrl + '/api/v1/counts', {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'Authorization': 'Token ' + accessToken,
			},
		});

		if (!response.ok) {
			throw new Error('HTTP ' + response.status);
		}

		await response.json();
		showStatus(verifyStatus, 'Connected successfully!', 'success');
		await loadProjects(instanceUrl, accessToken, null);
	} catch (err) {
		showStatus(verifyStatus, 'Connection failed. Check your URL and token.', 'error');
		projectSection.style.display = 'none';
	} finally {
		btnVerify.disabled = false;
	}
}

async function loadProjects(instanceUrl, accessToken, selectedProjectId) {
	try {
		const base = instanceUrl.replace(/\/+$/, '');
		const response = await fetch(base + '/api/v1/projects', {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'Authorization': 'Token ' + accessToken,
			},
		});

		if (!response.ok) {
			throw new Error('HTTP ' + response.status);
		}

		const data = await response.json();
		const projects = data.projects || data || [];

		projectSelect.innerHTML = '<option value="">-- Select a project --</option>';
		projects.forEach(function (project) {
			const opt = document.createElement('option');
			opt.value = project._id;
			opt.textContent = project.name;
			if (selectedProjectId === project._id) {
				opt.selected = true;
			}
			projectSelect.appendChild(opt);
		});

		projectSection.style.display = 'block';
	} catch (err) {
		showStatus(verifyStatus, 'Connected, but failed to load projects.', 'error');
	}
}

async function saveAccount() {
	const name = accountNameInput.value.trim();
	const instanceUrl = instanceUrlInput.value.trim().replace(/\/+$/, '');
	const accessToken = accessTokenInput.value.trim();
	const projectId = projectSelect.value;
	const projectName = projectSelect.options[projectSelect.selectedIndex]?.text || '';
	const mailboxProvider = mailboxProviderSelect.value.trim();
	const mailboxEmail = mailboxEmailInput.value.trim().toLowerCase();
	const mailboxConfigured = Boolean(mailboxProvider && mailboxEmail && _mailboxConfigured);

	if (!name) {
		showStatus(saveStatus, 'Please enter an account name.', 'error');
		return;
	}
	if (!instanceUrl || !accessToken) {
		showStatus(saveStatus, 'Please enter URL and token, then verify.', 'error');
		return;
	}
	if (!projectId) {
		showStatus(saveStatus, 'Please select a project.', 'error');
		return;
	}

	try {
		if (_editingAccountId) {
			// Update existing
			await updateAccount(_editingAccountId, {
				name, instance_url: instanceUrl, access_token: accessToken,
				project_id: projectId, project_name: projectName,
				mailbox_provider: mailboxProvider,
				mailbox_email: mailboxEmail,
				mailbox_configured: mailboxConfigured,
			});
		} else {
			// Create new
			const account = await addAccount({ name, instance_url: instanceUrl, access_token: accessToken });
			await updateAccount(account.id, {
				project_id: projectId,
				project_name: projectName,
				mailbox_provider: mailboxProvider,
				mailbox_email: mailboxEmail,
				mailbox_configured: mailboxConfigured,
			});
			_editingAccountId = account.id;
		}

		showStatus(saveStatus, 'Account saved!', 'success');
		await renderAccountList();
	} catch (err) {
		showStatus(saveStatus, 'Failed to save: ' + err.message, 'error');
	}
}

function markMailboxDirty() {
	if (_mailboxConfigured) {
		_mailboxConfigured = false;
		showStatus(mailboxStatus, 'Mailbox fields changed. Run Setup Connector again before saving.', 'info');
	}
}

async function testMailboxConnector() {
	await runMailboxAction(false);
}

async function setupMailboxConnector() {
	await runMailboxAction(true);
}

async function runMailboxAction(isSetup) {
	const instanceUrl = instanceUrlInput.value.trim().replace(/\/+$/, '');
	const accessToken = accessTokenInput.value.trim();
	const mailboxProvider = mailboxProviderSelect.value.trim();
	const mailboxEmail = mailboxEmailInput.value.trim().toLowerCase();
	const appPassword = mailboxAppPasswordInput.value.trim();

	if (!instanceUrl || !accessToken) {
		showStatus(mailboxStatus, 'Set instance URL and token first.', 'error');
		return;
	}

	if (!mailboxProvider || !mailboxEmail || !appPassword) {
		showStatus(mailboxStatus, 'Provider, mailbox email, and app password/token are required.', 'error');
		return;
	}

	const endpoint = isSetup
		? '/api/v1/mailbox/setup-credentials'
		: '/api/v1/mailbox/test-connection';
	const requestUrl = instanceUrl + endpoint;

	showStatus(mailboxStatus, isSetup ? 'Setting up connector...' : 'Testing connector...', 'info');
	btnMailboxSetup.disabled = true;
	btnMailboxTest.disabled = true;

	try {
		const { response, usedUrl, triedUrls } = await fetchWith404Fallback(requestUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': 'Token ' + accessToken,
			},
			body: JSON.stringify({
				provider: mailboxProvider,
				email: mailboxEmail,
				app_password: appPassword,
			}),
		});

		if (!response.ok) {
			const data = await readResponseData(response);
			const apiMessage = getApiErrorMessage(data);
			if (response.status === 404) {
				throw new Error('Connector endpoint not found (404). Tried: ' + triedUrls.join(' | '));
			}
			throw new Error(apiMessage || ('HTTP ' + response.status + ' (' + usedUrl + ')'));
		}

		if (isSetup) {
			_mailboxConfigured = true;
			showStatus(mailboxStatus, 'Connector configured on backend. Password/token not stored in extension.', 'success');
		} else {
			showStatus(mailboxStatus, 'Connector test successful.', 'success');
		}

		mailboxAppPasswordInput.value = '';
	} catch (err) {
		showStatus(mailboxStatus, 'Mailbox error: ' + err.message, 'error');
	} finally {
		btnMailboxSetup.disabled = false;
		btnMailboxTest.disabled = false;
	}
}

async function fetchWith404Fallback(url, init) {
	const triedUrls = [url];
	let usedUrl = url;
	let response = await fetch(url, init);

	if (response.status === 404) {
		const fallbackUrl = toggleTrailingSlash(url);
		if (fallbackUrl !== url) {
			triedUrls.push(fallbackUrl);
			response = await fetch(fallbackUrl, init);
			usedUrl = fallbackUrl;
		}
	}

	return { response, usedUrl, triedUrls };
}

function toggleTrailingSlash(url) {
	if (url.endsWith('/')) {
		return url.replace(/\/+$/, '');
	}
	return url + '/';
}

async function readResponseData(response) {
	let text = '';
	try {
		text = await response.text();
	} catch (_err) {
		return {};
	}

	if (!text) {
		return {};
	}

	try {
		return JSON.parse(text);
	} catch (_err) {
		return { detail: text };
	}
}

function getApiErrorMessage(data) {
	if (!data || typeof data !== 'object') {
		return '';
	}
	return data.error || data.detail || data.message || '';
}

async function resolveDefaultInstanceUrl() {
	if (_resolvedDefaultInstanceUrl) {
		return _resolvedDefaultInstanceUrl;
	}

	const localReachable = await isLikelyLocalKumbukumReachable();
	_resolvedDefaultInstanceUrl = localReachable ? LOCAL_INSTANCE_URL : CLOUD_INSTANCE_URL;
	return _resolvedDefaultInstanceUrl;
}

async function isLikelyLocalKumbukumReachable() {
	try {
		const response = await fetch(LOCAL_INSTANCE_URL + '/api/v1/counts', {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
			},
		});

		// 200 = open endpoint, 401/403 = protected but reachable API
		return response.status === 200 || response.status === 401 || response.status === 403;
	} catch (_err) {
		return false;
	}
}

// --- Utilities ---

function showStatus(el, message, type) {
	el.textContent = message;
	el.className = 'status status-' + type;
	el.style.display = 'block';
	if (type === 'success') {
		setTimeout(function () {
			el.style.display = 'none';
		}, 3000);
	}
}

function hideStatus(el) {
	el.style.display = 'none';
}

function escapeHtml(str) {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}
