import browser from 'webextension-polyfill';
import {
	getAccounts, getActiveAccountId, setActiveAccount,
	addAccount, updateAccount, deleteAccount,
	DEFAULT_ACCOUNT_AUTO_CAPTURE,
	normalizeAccountAutoCapture,
} from './storage.js';
import {
	normalizeAutoCaptureDelay,
	normalizeExcludeSites,
} from './url-capture.js';

const CLOUD_INSTANCE_URL = 'https://app.kumbukum.com';
const LOCAL_INSTANCE_URL = 'http://localhost:3000';

let _editingAccountId = null; // null = adding new, string = editing existing
let _resolvedDefaultInstanceUrl = null;

// DOM elements
let accountNameInput, instanceUrlInput, accessTokenInput, projectSelect, urlProjectSelect, emailProjectSelect, projectSelectCount;
let editorAutoCaptureEnabledInput, editorAutoCaptureScrollEnabledInput, editorAutoCaptureDelayInput, editorAutoCaptureExcludeSitesInput, editorAutoCaptureProjectReadout;
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
	urlProjectSelect = document.getElementById('url-project-select');
	emailProjectSelect = document.getElementById('email-project-select');
	projectSelectCount = document.getElementById('project-select-count');
	editorAutoCaptureEnabledInput = document.getElementById('editor-auto-capture-enabled');
	editorAutoCaptureScrollEnabledInput = document.getElementById('editor-auto-capture-scroll-enabled');
	editorAutoCaptureDelayInput = document.getElementById('editor-auto-capture-delay');
	editorAutoCaptureExcludeSitesInput = document.getElementById('editor-auto-capture-exclude-sites');
	editorAutoCaptureProjectReadout = document.getElementById('editor-auto-capture-project-readout');
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
	editorAutoCaptureDelayInput.addEventListener('input', clampEditorAutoCaptureDelay);
	projectSelect.addEventListener('change', updateAutoCaptureProjectReadout);
	urlProjectSelect.addEventListener('change', updateAutoCaptureProjectReadout);

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
	urlProjectSelect.innerHTML = '<option value="">(use default project)</option>';
	emailProjectSelect.innerHTML = '<option value="">(use default project)</option>';
	applyAutoCaptureToEditor(DEFAULT_ACCOUNT_AUTO_CAPTURE);
	updateAutoCaptureProjectReadout();
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
	urlProjectSelect.innerHTML = '<option value="">(use default project)</option>';
	emailProjectSelect.innerHTML = '<option value="">(use default project)</option>';
	applyAutoCaptureToEditor(normalizeAccountAutoCapture(account.auto_capture));
	setAutoCaptureProjectReadout(account.project_name || '');
	hideStatus(verifyStatus);
	hideStatus(saveStatus);

	// If already has a valid connection, try to load projects
	if (account.instance_url && account.access_token) {
		loadProjects(account.instance_url, account.access_token, {
			default_id: account.project_id,
			url_id: account.url_project_id,
			email_id: account.email_project_id,
		});
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
		await loadProjects(instanceUrl, accessToken, {
			default_id: '',
			url_id: '',
			email_id: '',
		});
	} catch (err) {
		showStatus(verifyStatus, 'Connection failed. Check your URL and token.', 'error');
		projectSection.style.display = 'none';
	} finally {
		btnVerify.disabled = false;
	}
}

function extractProjectsFromResponse(data) {
	if (Array.isArray(data)) return data;
	if (data && typeof data === 'object') {
		if (Array.isArray(data.projects)) return data.projects;
		if (Array.isArray(data.items)) return data.items;
		if (Array.isArray(data.results)) return data.results;
		if (data.projects && Array.isArray(data.projects.items)) return data.projects.items;
		if (data.data && Array.isArray(data.data)) return data.data;
	}
	return [];
}

async function loadProjects(instanceUrl, accessToken, selections) {
	const wanted = selections && typeof selections === 'object' ? selections : { default_id: selections };
	const defaultId = wanted.default_id || '';
	const urlId = wanted.url_id || '';
	const emailId = wanted.email_id || '';

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
		const projects = extractProjectsFromResponse(data);

		if (projects.length === 0) {
			console.warn('[Kumbukum] /api/v1/projects returned no projects. Response:', data);
		}

		projectSelect.innerHTML = '<option value="">-- Select a project --</option>';
		urlProjectSelect.innerHTML = '<option value="">(use default project)</option>';
		emailProjectSelect.innerHTML = '<option value="">(use default project)</option>';

		projects.forEach(function (project) {
			const pid = project._id || project.id;
			const pname = project.name || '(unnamed)';
			appendProjectOption(projectSelect, pid, pname, defaultId === pid);
			appendProjectOption(urlProjectSelect, pid, pname, urlId === pid);
			appendProjectOption(emailProjectSelect, pid, pname, emailId === pid);
		});

		if (projectSelectCount) {
			projectSelectCount.textContent = projects.length === 1
				? '1 project loaded. Notes and anything not routed elsewhere are saved here.'
				: projects.length + ' projects loaded. Notes and anything not routed elsewhere are saved here.';
		}

		projectSection.style.display = 'block';
		updateAutoCaptureProjectReadout();
	} catch (err) {
		showStatus(verifyStatus, 'Connected, but failed to load projects.', 'error');
	}
}

function appendProjectOption(selectEl, value, text, selected) {
	const opt = document.createElement('option');
	opt.value = value;
	opt.textContent = text;
	if (selected) opt.selected = true;
	selectEl.appendChild(opt);
}

async function saveAccount() {
	const name = accountNameInput.value.trim();
	const instanceUrl = instanceUrlInput.value.trim().replace(/\/+$/, '');
	const accessToken = accessTokenInput.value.trim();
	const projectId = projectSelect.value;
	const projectName = projectSelect.options[projectSelect.selectedIndex]?.text || '';
	const urlProjectId = urlProjectSelect.value;
	const urlProjectName = urlProjectId ? (urlProjectSelect.options[urlProjectSelect.selectedIndex]?.text || '') : '';
	const emailProjectId = emailProjectSelect.value;
	const emailProjectName = emailProjectId ? (emailProjectSelect.options[emailProjectSelect.selectedIndex]?.text || '') : '';
	const autoCapture = readAutoCaptureFromEditor();

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
	if (autoCapture.enabled && !projectId) {
		showStatus(saveStatus, 'Select a default project before enabling autocapture.', 'error');
		return;
	}

	try {
		if (_editingAccountId) {
			await updateAccount(_editingAccountId, {
				name, instance_url: instanceUrl, access_token: accessToken,
				project_id: projectId, project_name: projectName,
				url_project_id: urlProjectId, url_project_name: urlProjectName,
				email_project_id: emailProjectId, email_project_name: emailProjectName,
				auto_capture: autoCapture,
			});
		} else {
			const account = await addAccount({ name, instance_url: instanceUrl, access_token: accessToken });
			await updateAccount(account.id, {
				project_id: projectId,
				project_name: projectName,
				url_project_id: urlProjectId, url_project_name: urlProjectName,
				email_project_id: emailProjectId, email_project_name: emailProjectName,
				auto_capture: autoCapture,
			});
			_editingAccountId = account.id;
		}

		showStatus(saveStatus, 'Account saved!', 'success');
		await renderAccountList();
	} catch (err) {
		showStatus(saveStatus, 'Failed to save: ' + err.message, 'error');
	}
}

function applyAutoCaptureToEditor(autoCapture) {
	const normalized = normalizeAccountAutoCapture(autoCapture);
	editorAutoCaptureEnabledInput.checked = normalized.enabled;
	editorAutoCaptureScrollEnabledInput.checked = normalized.scroll_capture_enabled;
	editorAutoCaptureDelayInput.value = normalized.delay_seconds;
	editorAutoCaptureExcludeSitesInput.value = normalized.exclude_sites.join('\n');
}

function readAutoCaptureFromEditor() {
	return normalizeAccountAutoCapture({
		enabled: editorAutoCaptureEnabledInput.checked,
		delay_seconds: normalizeAutoCaptureDelay(editorAutoCaptureDelayInput.value),
		scroll_capture_enabled: editorAutoCaptureScrollEnabledInput.checked,
		exclude_sites: normalizeExcludeSites(editorAutoCaptureExcludeSitesInput.value),
	});
}

function clampEditorAutoCaptureDelay() {
	const currentValue = parseInt(editorAutoCaptureDelayInput.value, 10);
	if (Number.isNaN(currentValue)) {
		return;
	}
	if (currentValue < 30) {
		editorAutoCaptureDelayInput.value = 30;
	}
}

function setAutoCaptureProjectReadout(projectName) {
	if (!editorAutoCaptureProjectReadout) return;
	const name = (projectName || '').trim();
	editorAutoCaptureProjectReadout.textContent = name
		? 'Capturing to URL project: ' + name
		: 'Select a default (or URL) project above to enable autocapture.';
}

function updateAutoCaptureProjectReadout() {
	const urlOpt = urlProjectSelect && urlProjectSelect.options[urlProjectSelect.selectedIndex];
	const urlName = urlOpt && urlOpt.value ? urlOpt.text : '';
	if (urlName) {
		setAutoCaptureProjectReadout(urlName);
		return;
	}
	const defaultOpt = projectSelect && projectSelect.options[projectSelect.selectedIndex];
	const defaultName = defaultOpt && defaultOpt.value ? defaultOpt.text : '';
	setAutoCaptureProjectReadout(defaultName);
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
