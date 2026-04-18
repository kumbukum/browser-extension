import browser from 'webextension-polyfill';
import {
	getAccounts, getActiveAccountId, setActiveAccount,
	addAccount, updateAccount, deleteAccount,
} from './storage.js';

let _editingAccountId = null; // null = adding new, string = editing existing

// DOM elements
let accountNameInput, instanceUrlInput, accessTokenInput, projectSelect;
let btnAddAccount, btnVerify, btnSave, btnCancelEdit;
let verifyStatus, saveStatus, projectSection, editorSection, editorTitle;
let accountListEl, emptyState, versionSpan;

document.addEventListener('DOMContentLoaded', init);

async function init() {
	// Bind DOM elements
	accountNameInput = document.getElementById('account-name');
	instanceUrlInput = document.getElementById('instance-url');
	accessTokenInput = document.getElementById('access-token');
	projectSelect = document.getElementById('project-select');
	btnAddAccount = document.getElementById('btn-add-account');
	btnVerify = document.getElementById('btn-verify');
	btnSave = document.getElementById('btn-save');
	btnCancelEdit = document.getElementById('btn-cancel-edit');
	verifyStatus = document.getElementById('verify-status');
	saveStatus = document.getElementById('save-status');
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

function openNewAccountEditor() {
	_editingAccountId = null;
	editorTitle.textContent = 'Add Account';
	accountNameInput.value = '';
	instanceUrlInput.value = 'https://app.kumbukum.com';
	accessTokenInput.value = '';
	projectSelect.innerHTML = '<option value="">-- Select a project --</option>';
	projectSection.style.display = 'none';
	hideStatus(verifyStatus);
	hideStatus(saveStatus);
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
	hideStatus(verifyStatus);
	hideStatus(saveStatus);

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
			});
		} else {
			// Create new
			const account = await addAccount({ name, instance_url: instanceUrl, access_token: accessToken });
			await updateAccount(account.id, { project_id: projectId, project_name: projectName });
			_editingAccountId = account.id;
		}

		showStatus(saveStatus, 'Account saved!', 'success');
		await renderAccountList();
	} catch (err) {
		showStatus(saveStatus, 'Failed to save: ' + err.message, 'error');
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
