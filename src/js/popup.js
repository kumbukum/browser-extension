import browser from 'webextension-polyfill';
import { getAllSettings } from './storage.js';
import EasyMDE from 'easymde';
import { marked } from 'marked';
import 'easymde/dist/easymde.min.css';

let _settings = {};
let _editor = null;
let _currentTab = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
	_settings = await getAllSettings();

	// Check if configured
	if (!_settings.instance_url || !_settings.access_token || !_settings.project_id) {
		showView('view-warning');
		document.getElementById('btn-open-settings').addEventListener('click', function () {
			browser.runtime.openOptionsPage();
		});
		return;
	}

	// Validate token
	try {
		const response = await fetch(_settings.token_test_url, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'Authorization': `Token ${_settings.access_token}`,
			},
		});
		if (!response.ok) {
			document.getElementById('warning-message').textContent =
				'Your access token appears invalid. Please check your settings.';
			showView('view-warning');
			document.getElementById('btn-open-settings').addEventListener('click', function () {
				browser.runtime.openOptionsPage();
			});
			return;
		}
	} catch (_err) {
		document.getElementById('warning-message').textContent =
			'Could not connect to Kumbukum. Please check your settings.';
		showView('view-warning');
		document.getElementById('btn-open-settings').addEventListener('click', function () {
			browser.runtime.openOptionsPage();
		});
		return;
	}

	// Get current tab
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	_currentTab = tabs[0] || null;

	// Show current URL
	const urlEl = document.getElementById('current-url');
	if (_currentTab && _currentTab.url) {
		urlEl.textContent = _currentTab.url;
		urlEl.title = _currentTab.url;
	} else {
		urlEl.textContent = 'No URL detected';
	}

	// Show main view
	showView('view-main');

	// Init markdown editor
	_editor = new EasyMDE({
		element: document.getElementById('note-editor'),
		spellChecker: false,
		autofocus: false,
		status: false,
		minHeight: '180px',
		toolbar: [
			'bold', 'italic', 'heading', '|',
			'unordered-list', 'ordered-list', '|',
			'link', 'code', 'quote', '|',
			'preview',
		],
		placeholder: 'Write your note in markdown...',
	});

	// Bind events
	document.getElementById('btn-save-url-only').addEventListener('click', saveUrlOnly);
	document.getElementById('btn-save-note-only').addEventListener('click', saveNoteOnly);
	document.getElementById('btn-save-url-note').addEventListener('click', saveUrlAndNote);
}

// --- API helpers ---

async function apiSaveUrl() {
	if (!_currentTab || !_currentTab.url) {
		throw new Error('No active tab found.');
	}
	const response = await fetch(_settings.urls_create_url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Token ${_settings.access_token}`,
		},
		body: JSON.stringify({
			url: _currentTab.url,
			title: _currentTab.title || '',
			project: _settings.project_id,
		}),
	});
	if (!response.ok) {
		const data = await response.json().catch(function () { return {}; });
		throw new Error(data.error || `HTTP ${response.status}`);
	}
	const data = await response.json();
	return data.url || data;
}

async function apiSaveNote() {
	const title = document.getElementById('note-title').value.trim();
	const markdown = _editor.value().trim();
	if (!markdown) {
		throw new Error('Please write some content.');
	}
	const htmlContent = marked(markdown);
	const noteData = {
		title: title || (_currentTab ? _currentTab.title : 'Untitled'),
		content: htmlContent,
		text_content: markdown,
		project: _settings.project_id,
	};
	const response = await fetch(_settings.notes_create_url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Token ${_settings.access_token}`,
		},
		body: JSON.stringify(noteData),
	});
	if (!response.ok) {
		const data = await response.json().catch(function () { return {}; });
		throw new Error(data.error || `HTTP ${response.status}`);
	}
	const data = await response.json();
	return data.note || data;
}

async function apiCreateLink(sourceId, sourceType, targetId, targetType) {
	const response = await fetch(_settings.links_create_url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Token ${_settings.access_token}`,
		},
		body: JSON.stringify({
			source_id: sourceId,
			source_type: sourceType,
			target_id: targetId,
			target_type: targetType,
		}),
	});
	if (!response.ok) {
		const data = await response.json().catch(function () { return {}; });
		throw new Error(data.error || `HTTP ${response.status}`);
	}
	return response.json();
}

// --- Actions ---

async function saveUrlOnly() {
	const btn = document.getElementById('btn-save-url-only');
	const statusEl = document.getElementById('url-status');
	btn.disabled = true;
	try {
		showStatus(statusEl, 'Saving URL...', 'info');
		await apiSaveUrl();
		showStatus(statusEl, 'URL saved!', 'success');
	} catch (err) {
		showStatus(statusEl, 'Failed: ' + err.message, 'error');
	} finally {
		btn.disabled = false;
	}
}

async function saveNoteOnly() {
	const btn = document.getElementById('btn-save-note-only');
	const statusEl = document.getElementById('note-status');
	btn.disabled = true;
	try {
		showStatus(statusEl, 'Saving note...', 'info');
		await apiSaveNote();
		showStatus(statusEl, 'Note saved!', 'success');
		_editor.value('');
		document.getElementById('note-title').value = '';
	} catch (err) {
		showStatus(statusEl, 'Failed: ' + err.message, 'error');
	} finally {
		btn.disabled = false;
	}
}

async function saveUrlAndNote() {
	const btn = document.getElementById('btn-save-url-note');
	const btnNoteOnly = document.getElementById('btn-save-note-only');
	const statusEl = document.getElementById('note-status');
	btn.disabled = true;
	btnNoteOnly.disabled = true;
	try {
		showStatus(statusEl, 'Saving URL & note...', 'info');
		const [savedUrl, savedNote] = await Promise.all([apiSaveUrl(), apiSaveNote()]);

		// Create a link between the URL and the note
		const urlId = savedUrl._id || savedUrl.id;
		const noteId = savedNote._id || savedNote.id;
		if (urlId && noteId) {
			try {
				await apiCreateLink(urlId, 'urls', noteId, 'notes');
			} catch (_linkErr) {
				// Link creation is best-effort; both items are already saved
			}
		}

		showStatus(statusEl, 'URL & note saved and linked!', 'success');
		_editor.value('');
		document.getElementById('note-title').value = '';
	} catch (err) {
		showStatus(statusEl, 'Failed: ' + err.message, 'error');
	} finally {
		btn.disabled = false;
		btnNoteOnly.disabled = false;
	}
}

// --- Utilities ---

function showView(viewId) {
	document.querySelectorAll('.view').forEach(function (el) {
		el.style.display = 'none';
	});
	document.getElementById(viewId).style.display = 'block';
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
