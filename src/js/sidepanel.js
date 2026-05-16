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

let _settings = {};
let _currentTab = null;
let _emailCandidate = null;
let _emailRecord = null;
let _relatedLoaded = false;

document.addEventListener('DOMContentLoaded', init);

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
	document.getElementById('btn-add-note')?.addEventListener('click', openNoteEditor);
	document.getElementById('btn-show-related')?.addEventListener('click', function () {
		void showRelated({ force: true });
	});
	document.getElementById('btn-cancel-note')?.addEventListener('click', closeNoteEditor);
	document.getElementById('btn-save-note')?.addEventListener('click', saveInternalNote);
	document.getElementById('btn-ask-ai')?.addEventListener('click', askEmailAi);
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
}

async function detectCurrentEmail() {
	setEmailContext('Checking current tab...');
	setEmailActionsEnabled(false);
	_emailCandidate = null;
	_emailRecord = null;
	_relatedLoaded = false;

	if (!_currentTab || !_currentTab.id || !_currentTab.url || !/^https?:\/\//i.test(_currentTab.url)) {
		setEmailContext('Open an email page first.');
		showStatus('Open an email page first.', 'info');
		return;
	}

	try {
		_emailCandidate = await detectEmailCandidate(_currentTab, { allowInteractiveSource: false });
		if (!_emailCandidate || !isSaveableEmailCandidate(_emailCandidate)) {
			setEmailContext('Email app detected. Open an email first.');
			showStatus('Open an email first, then click Kumbukum again.', 'info');
			return;
		}

		const subject = getEmailDisplaySubject(_emailCandidate, _currentTab) || '(No subject)';
		const from = _emailCandidate.from ? ' from ' + _emailCandidate.from : '';
		setEmailContext(subject + from);
		setEmailActionsEnabled(true);
		hideStatus();
		void showRelated({ auto: true });
	} catch (_err) {
		setEmailContext('Could not inspect this email page.');
		showStatus('Could not inspect this email page.', 'error');
	}
}

async function addEmail() {
	const button = document.getElementById('btn-add-email');
	await withButton(button, 'Adding...', async function () {
		await ensureEmailRecord();
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

function openNoteEditor() {
	document.getElementById('note-section').style.display = '';
	document.getElementById('note-input').focus();
}

function closeNoteEditor() {
	document.getElementById('note-section').style.display = 'none';
	document.getElementById('note-input').value = '';
}

async function saveInternalNote() {
	const button = document.getElementById('btn-save-note');
	await withButton(button, 'Saving...', async function () {
		const text = document.getElementById('note-input').value.trim();
		if (!text) {
			throw new Error('Write a note first.');
		}
		const email = await ensureEmailRecord();
		const id = getItemId(email);
		await apiRequest(_settings, '/emails/' + encodeURIComponent(id) + '/internal-notes', {
			method: 'POST',
			body: JSON.stringify({
				content: plainTextToHtml(text),
				text_content: text,
			}),
		});
		closeNoteEditor();
		showStatus('Note added.', 'success');
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
				per_page: 3,
				options: {
					group: true,
					includeEmails: true,
				},
			}),
		});
		_relatedLoaded = true;
		renderRelated(data.results || {});
		if (!opts.auto) {
			showStatus('Related knowledge loaded.', 'success');
		}
	} catch (err) {
		if (!opts.auto) {
			showStatus('Failed: ' + err.message, 'error');
		}
	}
}

async function askEmailAi() {
	const input = document.getElementById('ai-input');
	const button = document.getElementById('btn-ask-ai');
	const query = String(input.value || '').trim();
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

async function withButton(button, busyText, fn) {
	const originalText = button ? button.textContent : '';
	if (button) {
		button.disabled = true;
		button.textContent = busyText;
	}
	try {
		await fn();
	} catch (err) {
		showStatus('Failed: ' + (err.message || 'Action failed'), 'error');
	} finally {
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

function renderRelated(results) {
	const section = document.getElementById('related-section');
	const output = document.getElementById('related-output');
	const items = flattenSearchResults(results).slice(0, 8);
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
	const section = document.getElementById('summary-section');
	const output = document.getElementById('summary-output');
	output.innerHTML = '<div class="related-title">' + escapeHtml(query) + '</div>'
		+ '<div class="ai-answer">' + escapeHtml(answer || 'No answer returned.') + '</div>';
	section.style.display = '';
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
			});
		});
	});
	return items;
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
	const body = String(candidate.text_content || '').slice(0, 900);
	const sender = candidate.from || '';
	const senderEmail = firstEmail(sender);
	const senderDomain = senderEmail.split('@')[1] || '';
	return [subject, sender, senderEmail, senderDomain, body].filter(Boolean).join('\n');
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
