import browser from 'webextension-polyfill';
import {
	apiRequest,
	detectEmailCandidate,
	enrichEmailCandidateBeforeSave,
	firstEmail,
	getEmailDisplaySubject,
	isSaveableEmailCandidate,
	saveEmailToKumbukum,
	shouldRefreshEmailCandidateBeforeSave,
} from './email-utils.js';
import {
	getAllSettings,
} from './storage.js';

const EMAIL_CHANGE_POLL_MS = 1500;

let _settings = {};
let _currentTab = null;
let _emailCandidate = null;
let _emailRecord = null;
let _emailFingerprint = '';
let _relatedLoaded = false;
let _currentNotes = [];
let _noteEditorMode = 'add';
let _noteEditorNoteId = '';
let _noteEditorParentId = '';
let _emailChangeTimer = null;
let _emailDetectionInFlight = false;
let _activeActionCount = 0;

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', stopEmailChangeMonitor);

async function init() {
	bindEvents();
	await loadSettingsAndTab();
}

function bindEvents() {
	document.getElementById('btn-open-settings')?.addEventListener('click', function () {
		browser.runtime.openOptionsPage();
	});
	document.getElementById('btn-add-email')?.addEventListener('click', addEmail);
	document.getElementById('btn-summarize')?.addEventListener('click', summarizeEmail);
	document.getElementById('btn-suggest-reply')?.addEventListener('click', suggestReplies);
	document.getElementById('btn-add-note')?.addEventListener('click', function () {
		openNoteEditor();
	});
	document.getElementById('btn-show-related')?.addEventListener('click', function () {
		void showRelated({ force: true });
	});
	document.querySelectorAll('[data-ai-prompt]').forEach(function (button) {
		button.addEventListener('click', function () {
			const prompt = button.dataset.aiPrompt || button.textContent || '';
			const input = document.getElementById('ai-input');
			if (input) input.value = prompt;
			void askEmailAi(prompt);
		});
	});
	document.getElementById('btn-cancel-note')?.addEventListener('click', closeNoteEditor);
	document.getElementById('btn-save-note')?.addEventListener('click', saveInternalNote);
	document.getElementById('btn-ask-ai')?.addEventListener('click', function () {
		void askEmailAi();
	});
	document.querySelectorAll('[data-editor-command]').forEach(function (button) {
		button.addEventListener('click', function () {
			applyEditorCommand(button.dataset.editorCommand);
		});
	});
	document.querySelectorAll('[data-close-section]').forEach(function (button) {
		button.addEventListener('click', function () {
			closeSection(button.dataset.closeSection);
		});
	});
	document.getElementById('ai-input')?.addEventListener('keydown', function (event) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void askEmailAi();
		}
	});
}

async function loadSettingsAndTab() {
	_settings = await getAllSettings();
	if (!_settings.instance_url || !_settings.access_token || !_settings.project_id) {
		showWarning('This account is not fully configured. Please complete setup in settings.');
		return;
	}

	try {
		await apiRequest(_settings, '/counts', { method: 'GET' });
	} catch (_err) {
		showWarning('Could not connect to Kumbukum. Check settings or local http://localhost:3000.');
		return;
	}

	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	_currentTab = tabs[0] || null;
	showMain();
	await detectCurrentEmail();
	startEmailChangeMonitor();
}

async function detectCurrentEmail() {
	if (_emailDetectionInFlight) {
		return;
	}

	_emailDetectionInFlight = true;
	try {
		setEmailContext('Checking current tab...');
		setEmailActionsEnabled(false);
		clearCurrentEmailState();

		if (!_currentTab || !_currentTab.id || !_currentTab.url || !/^https?:\/\//i.test(_currentTab.url)) {
			setEmailContext('Open an email page first.');
			showStatus('Open an email page first.', 'info');
			return;
		}

		const candidate = await detectEmailCandidate(_currentTab, { allowInteractiveSource: false });
		await applyDetectedEmailCandidate(candidate, {
			noEmailStatus: 'Open an email first, then click Kumbukum again.',
		});
	} catch (_err) {
		setEmailContext('Could not inspect this email page.');
		showStatus('Could not inspect this email page.', 'error');
	} finally {
		_emailDetectionInFlight = false;
	}
}

function startEmailChangeMonitor() {
	stopEmailChangeMonitor();
	_emailChangeTimer = window.setInterval(function () {
		void refreshCurrentEmailIfChanged();
	}, EMAIL_CHANGE_POLL_MS);
	document.addEventListener('visibilitychange', handleVisibilityChange);
	browser.tabs.onActivated.addListener(handleActiveTabChanged);
	browser.tabs.onUpdated.addListener(handleTabUpdated);
}

function stopEmailChangeMonitor() {
	if (_emailChangeTimer) {
		window.clearInterval(_emailChangeTimer);
		_emailChangeTimer = null;
	}
	document.removeEventListener('visibilitychange', handleVisibilityChange);
	browser.tabs.onActivated.removeListener(handleActiveTabChanged);
	browser.tabs.onUpdated.removeListener(handleTabUpdated);
}

function handleVisibilityChange() {
	if (!document.hidden) {
		void refreshCurrentEmailIfChanged({ force: true });
	}
}

function handleActiveTabChanged() {
	void refreshCurrentEmailIfChanged({ force: true });
}

function handleTabUpdated(tabId, changeInfo) {
	if (!_currentTab || tabId !== _currentTab.id) {
		return;
	}
	if (changeInfo.url || changeInfo.status === 'complete' || changeInfo.title) {
		void refreshCurrentEmailIfChanged({ force: true });
	}
}

async function refreshCurrentEmailIfChanged(options) {
	const opts = options || {};
	if (!_settings.instance_url || !_settings.access_token || !_settings.project_id) {
		return;
	}
	if (!opts.force && document.hidden) {
		return;
	}
	if (_emailDetectionInFlight || _activeActionCount > 0) {
		return;
	}

	_emailDetectionInFlight = true;
	try {
		const tabs = await browser.tabs.query({ active: true, currentWindow: true });
		const tab = tabs[0] || null;
		const nextCandidate = tab && tab.id && tab.url && /^https?:\/\//i.test(tab.url)
			? await detectEmailCandidate(tab, { allowInteractiveSource: false })
			: null;
		const nextFingerprint = nextCandidate && isSaveableEmailCandidate(nextCandidate)
			? getEmailCandidateFingerprint(nextCandidate, tab)
			: '';

		if (nextFingerprint === _emailFingerprint) {
			_currentTab = tab || _currentTab;
			return;
		}

		_currentTab = tab;
		await applyDetectedEmailCandidate(nextCandidate, {
			noEmailStatus: 'Open an email first.',
		});
	} catch (_err) {
		// Polling is best-effort; explicit button actions still surface errors.
	} finally {
		_emailDetectionInFlight = false;
	}
}

async function applyDetectedEmailCandidate(candidate, options) {
	const opts = options || {};
	clearCurrentEmailState();
	_emailCandidate = candidate;

	if (!_emailCandidate || !isSaveableEmailCandidate(_emailCandidate)) {
		setEmailContext('Email app detected. Open an email first.');
		showStatus(opts.noEmailStatus || 'Open an email first.', 'info');
		setEmailActionsEnabled(false);
		return;
	}

	_emailFingerprint = getEmailCandidateFingerprint(_emailCandidate, _currentTab);
	const subject = getEmailDisplaySubject(_emailCandidate, _currentTab) || '(No subject)';
	const from = _emailCandidate.from ? ' from ' + _emailCandidate.from : '';
	setEmailContext(subject + from);
	setEmailActionsEnabled(true);
	hideStatus();
	await hydrateSavedEmail();
}

function clearCurrentEmailState() {
	_emailCandidate = null;
	_emailRecord = null;
	_emailFingerprint = '';
	_relatedLoaded = false;
	_currentNotes = [];
	closeNoteEditor();
	resetEmailOutputSections();
	renderInternalNotes([]);
}

async function addEmail() {
	const button = document.getElementById('btn-add-email');
	await withButton(button, 'Adding...', async function () {
		await ensureEmailRecord();
		await loadInternalNotes();
		showStatus('Email added.', 'success');
	});
}

async function summarizeEmail() {
	const button = document.getElementById('btn-summarize');
	await withButton(button, 'Summarizing...', async function () {
		const email = await ensureEmailRecord();
		const id = getItemId(email);
		const data = await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/summarize', {
			method: 'POST',
			body: JSON.stringify({}),
		});
		if (data.email) {
			_emailRecord = data.email;
		}
		renderSummary(data.summary || data.email?.triage_summary || '');
		showStatus('Summary ready.', 'success');
	});
}

async function suggestReplies() {
	const button = document.getElementById('btn-suggest-reply');
	await withButton(button, 'Writing...', async function () {
		const email = await ensureEmailRecord();
		const id = getItemId(email);
		showReplySection('Writing reply options...');
		const data = await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/suggest-replies', {
			method: 'POST',
			body: JSON.stringify({
				context_scope: 'all-projects',
			}),
		});
		renderReplies((data.replies || []).slice(0, 2));
		showStatus('Reply options ready.', 'success');
	});
}

function openNoteEditor(options) {
	const opts = options || {};
	_noteEditorMode = opts.mode || 'add';
	_noteEditorNoteId = opts.noteId || '';
	_noteEditorParentId = opts.parentNoteId || '';
	document.getElementById('note-section').style.display = '';
	document.getElementById('note-editor-panel').style.display = '';
	setEditorHtml(opts.content || '');
	document.getElementById('note-editor').focus();
}

function closeNoteEditor() {
	document.getElementById('note-editor-panel').style.display = 'none';
	setEditorHtml('');
	_noteEditorMode = 'add';
	_noteEditorNoteId = '';
	_noteEditorParentId = '';
	if (_currentNotes.length === 0) {
		document.getElementById('note-section').style.display = 'none';
	}
}

function closeSection(sectionId) {
	const section = document.getElementById(sectionId);
	if (!section) return;
	section.style.display = 'none';
	if (sectionId === 'note-section') {
		closeNoteEditor();
	}
}

async function saveInternalNote() {
	const button = document.getElementById('btn-save-note');
	await withButton(button, 'Saving...', async function () {
		const editor = document.getElementById('note-editor');
		const text = (editor.textContent || '').trim();
		if (!text) {
			throw new Error('Write a note first.');
		}
		const email = await ensureEmailRecord();
		const id = getItemId(email);
		const mode = _noteEditorMode;
		const payload = {
			content: sanitizeNoteHtml(editor.innerHTML || ''),
			text_content: text,
		};
		if (mode === 'reply') {
			payload.parent_note = _noteEditorParentId;
		}
		if (mode === 'edit') {
			await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/internal-notes/' + encodeURIComponent(_noteEditorNoteId), {
				method: 'PUT',
				body: JSON.stringify(payload),
			});
		} else {
			await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/internal-notes', {
				method: 'POST',
				body: JSON.stringify(payload),
			});
		}
		closeNoteEditor();
		await loadInternalNotes();
		showStatus(mode === 'edit' ? 'Note updated.' : 'Note added.', 'success');
	});
}

async function showRelated(options) {
	const opts = options || {};
	if (_relatedLoaded && !opts.force) {
		return;
	}
	if (!_emailCandidate || !isSaveableEmailCandidate(_emailCandidate)) {
		return;
	}

	if (!opts.auto) {
		showStatus('Finding related knowledge...', 'info');
	}

	try {
		const data = await apiRequest(_settings, '/search/knowledge', {
			method: 'POST',
			body: JSON.stringify({
				query: buildRelatedQuery(_emailCandidate),
				per_page: 5,
				options: {
					group: true,
					includeEmails: true,
				},
			}),
		});
		_relatedLoaded = true;
		renderRelated(data.results || {}, _emailCandidate);
		if (!opts.auto) {
			showStatus('Related knowledge loaded.', 'success');
		}
	} catch (err) {
		if (!opts.auto) {
			showStatus('Failed: ' + err.message, 'error');
		}
	}
}

async function askEmailAi(promptOverride) {
	const input = document.getElementById('ai-input');
	const button = document.getElementById('btn-ask-ai');
	const queryValue = typeof promptOverride === 'string' ? promptOverride : input.value;
	const query = String(queryValue || '').trim();
	if (!query) return;

	await withButton(button, '...', async function () {
		const email = await ensureEmailRecord();
		const id = getItemId(email);
		input.value = '';
		const data = await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/ai', {
			method: 'POST',
			body: JSON.stringify({ query }),
		});
		renderAiAnswer(query, data.answer || '');
	});
}

async function ensureEmailRecord() {
	if (_emailRecord && getItemId(_emailRecord)) {
		return _emailRecord;
	}

	let candidate = _emailCandidate;
	if (!candidate || shouldRefreshEmailCandidateBeforeSave(candidate)) {
		showStatus('Inspecting email details...', 'info');
		candidate = await enrichEmailCandidateBeforeSave(_currentTab, candidate);
	}

	if (!candidate || !isSaveableEmailCandidate(candidate)) {
		throw new Error('No saveable email found on this page.');
	}

	_emailCandidate = candidate;
	_emailRecord = await saveEmailToKumbukum(_settings, candidate, _currentTab);
	return _emailRecord;
}

async function hydrateSavedEmail() {
	if (!_emailCandidate || !_emailCandidate.message_id) {
		return;
	}

	try {
		const data = await apiRequest(_settings, '/emails/triage-status?message_id=' + encodeURIComponent(_emailCandidate.message_id) + '&include=email&limit=1', {
			method: 'GET',
		});
		const status = Array.isArray(data.statuses) ? data.statuses[0] : null;
		if (!status) {
			return;
		}
		_emailRecord = status.email || {
			_id: status.email_id,
			id: status.email_id,
			message_id: status.message_id,
			subject: status.subject,
		};
		await loadInternalNotes();
	} catch (_err) {
		// Existing-note lookup is best-effort; saving remains available.
	}
}

async function loadInternalNotes() {
	if (!_emailRecord || !getItemId(_emailRecord)) {
		return;
	}

	const data = await apiRequest(_settings, '/emails/' + encodeURIComponent(getItemId(_emailRecord)) + '/internal-notes', {
		method: 'GET',
	});
	_currentNotes = Array.isArray(data.notes) ? data.notes : [];
	renderInternalNotes(_currentNotes);
}

async function withButton(button, busyText, fn) {
	const originalText = button ? button.textContent : '';
	_activeActionCount += 1;
	if (button) {
		button.disabled = true;
		button.textContent = busyText;
	}
	try {
		await fn();
	} catch (err) {
		showStatus('Failed: ' + (err.message || 'Action failed'), 'error');
	} finally {
		_activeActionCount = Math.max(0, _activeActionCount - 1);
		if (button) {
			button.disabled = false;
			button.textContent = originalText;
		}
	}
}

function showWarning(message) {
	document.getElementById('warning-message').textContent = message;
	document.getElementById('warning-view').style.display = '';
	document.getElementById('main-view').style.display = 'none';
	document.querySelector('.ai-composer').style.display = 'none';
	setEmailContext('Settings required.');
}

function showMain() {
	document.getElementById('warning-view').style.display = 'none';
	document.getElementById('main-view').style.display = '';
	document.querySelector('.ai-composer').style.display = '';
}

function setEmailContext(text) {
	document.getElementById('email-context').textContent = text || '';
}

function setEmailActionsEnabled(enabled) {
	[
		'btn-add-email',
		'btn-summarize',
		'btn-suggest-reply',
		'btn-add-note',
		'btn-show-related',
		'btn-ask-ai',
	].forEach(function (id) {
		const el = document.getElementById(id);
		if (el) el.disabled = !enabled;
	});
	document.getElementById('ai-input').disabled = !enabled;
	document.querySelectorAll('.ai-prompt-button').forEach(function (button) {
		button.disabled = !enabled;
	});
}

function showStatus(message, type) {
	const el = document.getElementById('status');
	el.textContent = message;
	el.className = 'status status-' + (type || 'info');
	el.style.display = '';
	if (type === 'success') {
		setTimeout(function () {
			if (el.textContent === message) {
				hideStatus();
			}
		}, 2500);
	}
}

function hideStatus() {
	const el = document.getElementById('status');
	el.style.display = 'none';
}

function resetEmailOutputSections() {
	[
		'summary-section',
		'reply-section',
		'related-section',
		'ai-response-section',
		'note-section',
	].forEach(function (id) {
		const section = document.getElementById(id);
		if (section) {
			section.style.display = 'none';
		}
	});

	[
		'summary-output',
		'reply-output',
		'related-output',
		'ai-response-output',
		'notes-list',
	].forEach(function (id) {
		const output = document.getElementById(id);
		if (output) {
			output.innerHTML = '';
		}
	});

	const input = document.getElementById('ai-input');
	if (input) {
		input.value = '';
	}
}

function renderSummary(summary) {
	const section = document.getElementById('summary-section');
	const output = document.getElementById('summary-output');
	output.textContent = summary || 'No summary returned.';
	section.style.display = '';
}

function showReplySection(message) {
	const section = document.getElementById('reply-section');
	const output = document.getElementById('reply-output');
	output.textContent = message || '';
	section.style.display = '';
}

function renderReplies(replies) {
	const section = document.getElementById('reply-section');
	const output = document.getElementById('reply-output');
	if (!Array.isArray(replies) || replies.length === 0) {
		output.textContent = 'No reply options returned.';
		section.style.display = '';
		return;
	}

	output.innerHTML = replies.map(function (reply, index) {
		return '<div class="reply-option">'
			+ '<div class="reply-title">' + escapeHtml(reply.title || ('Reply ' + (index + 1))) + '</div>'
			+ '<div class="reply-body">' + escapeHtml(reply.body_text || '') + '</div>'
			+ '<button type="button" class="btn btn-primary copy-reply" data-index="' + index + '">Copy reply</button>'
			+ '</div>';
	}).join('');

	output.querySelectorAll('.copy-reply').forEach(function (button) {
		button.addEventListener('click', async function () {
			const reply = replies[parseInt(button.dataset.index, 10)];
			await navigator.clipboard.writeText(reply.body_text || '');
			showStatus('Reply copied.', 'success');
		});
	});
	section.style.display = '';
}

function renderRelated(results, candidate) {
	const section = document.getElementById('related-section');
	const output = document.getElementById('related-output');
	const items = filterRelatedItems(flattenSearchResults(results), candidate).slice(0, 6);
	if (!items.length) {
		output.textContent = 'No related knowledge found.';
		section.style.display = '';
		return;
	}

	output.innerHTML = items.map(function (item) {
		return '<div class="related-item">'
			+ '<div class="related-type">' + escapeHtml(item.type) + '</div>'
			+ '<div class="related-title">' + escapeHtml(item.title) + '</div>'
			+ '<div class="related-excerpt">' + escapeHtml(item.excerpt) + '</div>'
			+ '</div>';
	}).join('');
	section.style.display = '';
}

function renderAiAnswer(query, answer) {
	const section = document.getElementById('ai-response-section');
	const output = document.getElementById('ai-response-output');
	output.innerHTML = '<div class="related-title">' + escapeHtml(query) + '</div>'
		+ '<div class="ai-answer">' + escapeHtml(answer || 'No answer returned.') + '</div>';
	section.style.display = '';
	section.scrollIntoView({ block: 'nearest' });
}

function renderInternalNotes(notes) {
	const section = document.getElementById('note-section');
	const list = document.getElementById('notes-list');
	if (!section || !list) return;

	const hasEditor = document.getElementById('note-editor-panel')?.style.display !== 'none';
	if (!Array.isArray(notes) || notes.length === 0) {
		list.innerHTML = '';
		if (!hasEditor) {
			section.style.display = 'none';
		}
		return;
	}

	section.style.display = '';
	list.innerHTML = groupInternalNotes(notes).map(function (note) {
		return renderInternalNote(note, 0);
	}).join('');
	bindInternalNoteActions();
}

function groupInternalNotes(notes) {
	const byId = new Map();
	const roots = [];
	(notes || []).forEach(function (note) {
		const copy = {
			...note,
			_children: [],
		};
		byId.set(internalNoteId(copy), copy);
	});
	byId.forEach(function (note) {
		const parentId = internalNoteParentId(note);
		const parent = parentId ? byId.get(parentId) : null;
		if (parent) {
			parent._children.push(note);
		} else {
			roots.push(note);
		}
	});
	byId.forEach(function (note) {
		note._children.sort(function (a, b) {
			return internalNoteTime(a) - internalNoteTime(b);
		});
	});
	roots.sort(function (a, b) {
		return internalNoteTime(b) - internalNoteTime(a);
	});
	return roots;
}

function renderInternalNote(note, depth) {
	const id = internalNoteId(note);
	const children = note._children || [];
	const hasReplies = children.length > 0;
	const depthClass = depth > 0 ? ' internal-note-reply' : '';
	return '<div class="internal-note' + depthClass + '" data-note-id="' + escapeHtml(id) + '">'
		+ '<div class="internal-note-meta">'
		+ '<span>' + escapeHtml(internalNoteOwner(note)) + '</span>'
		+ '<time>' + escapeHtml(formatDateTime(note.createdAt || note.updatedAt)) + '</time>'
		+ '</div>'
		+ '<div class="internal-note-body">' + sanitizeNoteHtml(internalNoteContent(note)) + '</div>'
		+ '<div class="internal-note-actions">'
		+ '<button type="button" class="note-action note-reply" data-note-id="' + escapeHtml(id) + '">Reply</button>'
		+ '<button type="button" class="note-action note-edit" data-note-id="' + escapeHtml(id) + '">Edit</button>'
		+ (hasReplies ? '' : '<button type="button" class="note-action note-action-danger note-delete" data-note-id="' + escapeHtml(id) + '">Delete</button>')
		+ '</div>'
		+ (children.length
			? '<div class="internal-note-replies">' + children.map(function (child) {
				return renderInternalNote(child, depth + 1);
			}).join('') + '</div>'
			: '')
		+ '</div>';
}

function bindInternalNoteActions() {
	document.querySelectorAll('.note-reply').forEach(function (button) {
		button.addEventListener('click', function () {
			openNoteEditor({
				mode: 'reply',
				parentNoteId: button.dataset.noteId || '',
			});
		});
	});
	document.querySelectorAll('.note-edit').forEach(function (button) {
		button.addEventListener('click', function () {
			const note = findInternalNote(button.dataset.noteId || '');
			if (!note) return;
			openNoteEditor({
				mode: 'edit',
				noteId: internalNoteId(note),
				content: internalNoteContent(note),
			});
		});
	});
	document.querySelectorAll('.note-delete').forEach(function (button) {
		button.addEventListener('click', function () {
			void deleteInternalNote(button.dataset.noteId || '');
		});
	});
}

async function deleteInternalNote(noteId) {
	if (!noteId) return;
	const confirmed = window.confirm('Delete this note?');
	if (!confirmed) return;
	await withButton(document.querySelector('.note-delete[data-note-id="' + cssEscape(noteId) + '"]'), 'Deleting...', async function () {
		const email = await ensureEmailRecord();
		const id = getItemId(email);
		const clientRequestId = internalNoteClientRequestId();
		await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/internal-notes/' + encodeURIComponent(noteId) + '?client_request_id=' + encodeURIComponent(clientRequestId), {
			method: 'DELETE',
		});
		await loadInternalNotes();
		showStatus('Note deleted.', 'success');
	});
}

function applyEditorCommand(command) {
	const editor = document.getElementById('note-editor');
	if (!editor || !command) return;
	editor.focus();
	document.execCommand(command, false, null);
}

function setEditorHtml(html) {
	const editor = document.getElementById('note-editor');
	if (!editor) return;
	editor.innerHTML = sanitizeNoteHtml(html || '');
}

function findInternalNote(noteId) {
	return (_currentNotes || []).find(function (note) {
		return internalNoteId(note) === noteId;
	});
}

function objectIdValue(value) {
	return String(value && value._id || value || '');
}

function internalNoteId(note) {
	return objectIdValue(note && (note._id || note.id));
}

function internalNoteParentId(note) {
	return objectIdValue(note && note.parent_note);
}

function internalNoteOwner(note) {
	if (!note) return 'Team member';
	return note.owner?.name || note.owner?.email || 'Team member';
}

function internalNoteContent(note) {
	return note?.content || plainTextToHtml(note?.text_content || '');
}

function internalNoteTime(note) {
	const time = new Date(note?.createdAt || note?.updatedAt || 0).getTime();
	return Number.isFinite(time) ? time : 0;
}

function internalNoteClientRequestId() {
	if (window.crypto?.randomUUID) {
		return window.crypto.randomUUID();
	}
	return String(Date.now()) + '-' + Math.random().toString(36).slice(2);
}

function formatDateTime(value) {
	if (!value) return '';
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return '';
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(date);
}

function sanitizeNoteHtml(html) {
	const template = document.createElement('template');
	template.innerHTML = String(html || '');
	const allowedTags = new Set(['A', 'B', 'BR', 'DIV', 'EM', 'I', 'LI', 'OL', 'P', 'STRONG', 'U', 'UL']);
	Array.from(template.content.querySelectorAll('*')).forEach(function (el) {
		if (!allowedTags.has(el.tagName)) {
			el.replaceWith(...Array.from(el.childNodes));
			return;
		}
		Array.from(el.attributes).forEach(function (attr) {
			if (el.tagName === 'A' && attr.name === 'href') {
				const href = String(attr.value || '');
				if (/^(https?:|mailto:)/i.test(href)) {
					return;
				}
			}
			el.removeAttribute(attr.name);
		});
		if (el.tagName === 'A') {
			el.setAttribute('target', '_blank');
			el.setAttribute('rel', 'noopener noreferrer');
		}
	});
	return template.innerHTML;
}

function cssEscape(value) {
	if (window.CSS?.escape) {
		return window.CSS.escape(value);
	}
	return String(value || '').replace(/"/g, '\\"');
}

function flattenSearchResults(results) {
	const items = [];
	Object.entries(results || {}).forEach(function ([type, result]) {
		(result.hits || []).forEach(function (hit) {
			const doc = hit.document || {};
			items.push({
				type: formatType(type),
				title: getResultTitle(type, doc),
				excerpt: getResultExcerpt(type, doc),
				distance: typeof hit.vector_distance === 'number' ? hit.vector_distance : null,
			});
		});
	});
	return items;
}

function filterRelatedItems(items, candidate) {
	const signals = buildRelatedSignals(candidate);
	return items
		.map(function (item) {
			return {
				...item,
				_score: scoreRelatedItem(item, signals),
			};
		})
		.filter(function (item) {
			if (item._score >= 3) return true;
			return item._score >= 2 && (item.distance === null || item.distance <= 0.13);
		})
		.sort(function (a, b) {
			if (b._score !== a._score) return b._score - a._score;
			if (a.distance === null && b.distance === null) return 0;
			if (a.distance === null) return 1;
			if (b.distance === null) return -1;
			return a.distance - b.distance;
		});
}

function buildRelatedSignals(candidate) {
	const senderEmail = firstEmail(candidate && candidate.from);
	const senderDomain = senderEmail.split('@')[1] || '';
	const domains = [
		senderDomain,
		...extractDomains(String(candidate && candidate.text_content || '')),
	].filter(Boolean);
	const domainTokens = domains.map(normalizeSignal).filter(Boolean);
	const subjectTokens = extractUsefulTokens(candidate && candidate.subject);
	return {
		domainTokens,
		subjectTokens,
	};
}

function scoreRelatedItem(item, signals) {
	const haystack = normalizeSignal([item.title, item.excerpt].join(' '));
	if (!haystack) return 0;
	let score = 0;
	signals.domainTokens.forEach(function (token) {
		if (token && haystack.includes(token)) {
			score += 4;
		}
	});
	let subjectMatches = 0;
	signals.subjectTokens.forEach(function (token) {
		if (token && haystack.includes(token)) {
			subjectMatches += 1;
		}
	});
	score += subjectMatches;
	return score;
}

function getResultTitle(type, doc) {
	if (type === 'emails') return doc.subject || '(No subject)';
	return doc.title || doc.name || doc.url || '(Untitled)';
}

function getResultExcerpt(type, doc) {
	if (type === 'memory') return String(doc.content || doc.text_content || '').slice(0, 260);
	if (type === 'urls' || type === 'pages') return String(doc.description || doc.text_content || doc.url || '').slice(0, 260);
	if (type === 'emails') return String(doc.triage_summary || doc.text_content || '').slice(0, 260);
	return String(doc.text_content || doc.content || '').slice(0, 260);
}

function formatType(type) {
	if (type === 'memory') return 'memory';
	if (type === 'urls') return 'url';
	if (type === 'pages') return 'page';
	return type || 'item';
}

function buildRelatedQuery(candidate) {
	const subject = candidate.subject || '';
	const body = extractUsefulTokens(candidate.text_content).slice(0, 12).join(' ');
	const sender = candidate.from || '';
	const senderEmail = firstEmail(sender);
	const senderDomain = senderEmail.split('@')[1] || '';
	const bodyDomains = extractDomains(candidate.text_content).join(' ');
	return [subject, senderEmail, senderDomain, bodyDomains, body].filter(Boolean).join('\n');
}

function extractDomains(value) {
	const text = String(value || '');
	const domains = [];
	const urlMatches = text.match(/https?:\/\/[^\s<>"')]+/gi) || [];
	urlMatches.forEach(function (rawUrl) {
		try {
			domains.push(new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase());
		} catch (_err) {}
	});
	const emailMatches = text.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi) || [];
	emailMatches.forEach(function (email) {
		const domain = email.split('@')[1];
		if (domain) domains.push(domain.toLowerCase());
	});
	return Array.from(new Set(domains));
}

function extractUsefulTokens(value) {
	const stopWords = new Set(['about', 'action', 'administrator', 'because', 'being', 'click', 'court', 'dear', 'during', 'email', 'from', 'have', 'information', 'instructions', 'more', 'please', 'receive', 'sending', 'that', 'this', 'time', 'will', 'with', 'your']);
	return Array.from(new Set(String(value || '')
		.toLowerCase()
		.match(/[a-z0-9]{4,}/g) || []))
		.filter(function (token) {
			return !stopWords.has(token);
		})
		.slice(0, 24);
}

function normalizeSignal(value) {
	return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getEmailCandidateFingerprint(candidate, tab) {
	if (!candidate) {
		return '';
	}

	const provider = candidate.provider || inferProviderFromTab(tab);
	if (candidate.message_id) {
		return [provider, 'message-id', normalizeFingerprintValue(candidate.message_id)].join('|');
	}

	return [
		provider,
		normalizeFingerprintValue(candidate.subject),
		normalizeFingerprintValue(candidate.from),
		normalizeFingerprintValue(candidate.date),
		hashString([
			candidate.text_content || '',
			candidate.html_content || '',
		].join('\n').slice(0, 12000)),
	].join('|');
}

function inferProviderFromTab(tab) {
	try {
		const host = new URL((tab && tab.url) || '').hostname.toLowerCase();
		if (host.includes('app.fastmail.com')) return 'fastmail';
		if (host.includes('mail.google.com')) return 'gmail';
		if (host.includes('outlook.')) return 'outlook';
		return host || 'unknown';
	} catch (_err) {
		return 'unknown';
	}
}

function normalizeFingerprintValue(value) {
	return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hashString(value) {
	const text = String(value || '');
	let hash = 0;
	for (let i = 0; i < text.length; i += 1) {
		hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
	}
	return String(hash);
}

function getItemId(item) {
	return item && (item._id || item.id);
}

function plainTextToHtml(text) {
	return String(text || '')
		.split(/\n{2,}/)
		.map(function (paragraph) {
			return '<p>' + escapeHtml(paragraph).replace(/\n/g, '<br>') + '</p>';
		})
		.join('');
}

function escapeHtml(value) {
	return String(value || '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
