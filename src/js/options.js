import browser from 'webextension-polyfill';
import { setSetting, getAllSettings } from './storage.js';

let _settings = {};

// DOM elements
let instanceUrlInput, accessTokenInput, projectSelect;
let btnVerify, btnSave;
let verifyStatus, saveStatus, projectSection, versionSpan;

document.addEventListener('DOMContentLoaded', init);

async function init() {
	// Bind DOM elements
	instanceUrlInput = document.getElementById('instance-url');
	accessTokenInput = document.getElementById('access-token');
	projectSelect = document.getElementById('project-select');
	btnVerify = document.getElementById('btn-verify');
	btnSave = document.getElementById('btn-save');
	verifyStatus = document.getElementById('verify-status');
	saveStatus = document.getElementById('save-status');
	projectSection = document.getElementById('project-section');
	versionSpan = document.getElementById('version');

	// Show version
	versionSpan.textContent = browser.runtime.getManifest().version;

	// Bind events
	btnVerify.addEventListener('click', verifyConnection);
	btnSave.addEventListener('click', saveSettings);

	// Load existing settings
	_settings = await getAllSettings();
	if (_settings.instance_url) {
		instanceUrlInput.value = _settings.instance_url;
	}
	if (_settings.access_token) {
		accessTokenInput.value = _settings.access_token;
	}

	// If already configured, try to load projects
	if (_settings.instance_url && _settings.access_token) {
		await loadProjects();
	}
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
		const response = await fetch(`${instanceUrl}/api/v1/counts`, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'Authorization': `Token ${accessToken}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		await response.json();

		// Save connection settings
		await setSetting({ instance_url: instanceUrl, access_token: accessToken });
		_settings = await getAllSettings();

		showStatus(verifyStatus, 'Connected successfully!', 'success');
		await loadProjects();
	} catch (err) {
		showStatus(verifyStatus, 'Connection failed. Check your URL and token.', 'error');
		projectSection.style.display = 'none';
	} finally {
		btnVerify.disabled = false;
	}
}

async function loadProjects() {
	try {
		const response = await fetch(_settings.projects_url, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'Authorization': `Token ${_settings.access_token}`,
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const data = await response.json();
		const projects = data.projects || data || [];

		// Clear and populate dropdown
		projectSelect.innerHTML = '<option value="">-- Select a project --</option>';
		projects.forEach(function (project) {
			const opt = document.createElement('option');
			opt.value = project._id;
			opt.textContent = project.name;
			if (_settings.project_id === project._id) {
				opt.selected = true;
			}
			projectSelect.appendChild(opt);
		});

		projectSection.style.display = 'block';
	} catch (err) {
		showStatus(verifyStatus, 'Connected, but failed to load projects.', 'error');
	}
}

async function saveSettings() {
	const projectId = projectSelect.value;
	const projectName = projectSelect.options[projectSelect.selectedIndex]?.text || '';

	if (!projectId) {
		showStatus(saveStatus, 'Please select a project.', 'error');
		return;
	}

	await setSetting({ project_id: projectId, project_name: projectName });
	showStatus(saveStatus, 'Settings saved!', 'success');
}

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
