import browser from 'webextension-polyfill';
import { getAllSettings, getAccounts, getActiveAccountId, setActiveAccount } from './storage.js';
import EasyMDE from 'easymde';
import { marked } from 'marked';
import 'easymde/dist/easymde.min.css';

let _settings = {};
let _editor = null;
let _currentTab = null;
let _emailCandidate = null;

document.addEventListener('DOMContentLoaded', init);

async function init() {
	// Load accounts and populate switcher
	const accounts = await getAccounts();

	if (accounts.length === 0) {
		showView('view-warning');
		document.getElementById('warning-message').textContent =
			'No accounts configured. Please add one in settings.';
		document.getElementById('btn-open-settings').addEventListener('click', function () {
			browser.runtime.openOptionsPage();
		});
		return;
	}

	// Populate account switcher
	const switcher = document.getElementById('account-switcher');
	const activeId = await getActiveAccountId();
	switcher.innerHTML = '';
	accounts.forEach(function (account) {
		const opt = document.createElement('option');
		opt.value = account.id;
		opt.textContent = account.name + (account.project_name ? ' — ' + account.project_name : '');
		if (account.id === activeId) {
			opt.selected = true;
		}
		switcher.appendChild(opt);
	});

	switcher.addEventListener('change', async function () {
		await setActiveAccount(switcher.value);
		await loadActiveAccount();
	});

	await loadActiveAccount();
}

async function loadActiveAccount() {
	_settings = await getAllSettings();

	// Check if configured
	if (!_settings.instance_url || !_settings.access_token || !_settings.project_id) {
		document.getElementById('warning-message').textContent =
			'This account is not fully configured. Please complete setup in settings.';
		showView('view-warning');
		// Keep switcher visible even in warning state
		document.getElementById('account-switcher').closest('.section-account').style.display = '';
		document.getElementById('view-warning').querySelector('.warning-container').style.display = '';
		// Show both views: main (for switcher) and warning
		document.getElementById('view-main').style.display = 'block';
		document.getElementById('view-warning').style.display = 'block';
		document.getElementById('btn-open-settings').addEventListener('click', function () {
			browser.runtime.openOptionsPage();
		});
		// Hide main content sections but keep switcher
		hideCaptureUI();
		return;
	}

	// Validate token
	try {
		const response = await fetch(_settings.token_test_url, {
			method: 'GET',
			headers: {
				'Accept': 'application/json',
				'Authorization': 'Token ' + _settings.access_token,
			},
		});
		if (!response.ok) {
			document.getElementById('warning-message').textContent =
				'Your access token appears invalid. Please check your settings.';
			showView('view-warning');
			document.getElementById('view-main').style.display = 'block';
			document.getElementById('btn-open-settings').addEventListener('click', function () {
				browser.runtime.openOptionsPage();
			});
			hideCaptureUI();
			return;
		}
	} catch (_err) {
		document.getElementById('warning-message').textContent =
			'Could not connect to Kumbukum. Please check your settings.';
		showView('view-warning');
		document.getElementById('view-main').style.display = 'block';
		document.getElementById('btn-open-settings').addEventListener('click', function () {
			browser.runtime.openOptionsPage();
		});
		hideCaptureUI();
		return;
	}

	// Get current tab
	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	_currentTab = tabs[0] || null;

	// Show current URL
	const urlEl = document.getElementById('current-url');
	if (_currentTab && _currentTab.url) {
		urlEl.value = _currentTab.url;
		urlEl.title = _currentTab.url;
	} else {
		urlEl.value = 'No URL detected';
		urlEl.title = 'No URL detected';
	}

	renderEmailLoadingState();
	await detectEmailCandidate({ allowInteractiveSource: false });

	// Show main view, hide warning
	document.getElementById('view-warning').style.display = 'none';
	document.getElementById('view-main').style.display = 'block';
	showCaptureUI();

	// Init markdown editor (only once)
	if (!_editor) {
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

		// Bind events (only once)
		document.getElementById('btn-save-url-only').addEventListener('click', saveUrlOnly);
		document.getElementById('btn-save-email').addEventListener('click', saveEmail);
		document.getElementById('btn-email-settings').addEventListener('click', openConnectorSettings);
		document.getElementById('btn-save-note-only').addEventListener('click', saveNoteOnly);
		document.getElementById('btn-save-url-note').addEventListener('click', saveUrlAndNote);
	}
}

function hideCaptureUI() {
	var urlSection = document.querySelector('.section-url');
	var emailSection = document.querySelector('.section-email');
	var divider = document.querySelector('.divider');
	var noteSection = document.querySelector('.section-note');
	if (urlSection) urlSection.style.display = 'none';
	if (emailSection) emailSection.style.display = 'none';
	if (divider) divider.style.display = 'none';
	if (noteSection) noteSection.style.display = 'none';
}

function showCaptureUI() {
	var urlSection = document.querySelector('.section-url');
	var divider = document.querySelector('.divider');
	var noteSection = document.querySelector('.section-note');
	if (urlSection) urlSection.style.display = '';
	if (divider) divider.style.display = '';
	if (noteSection) noteSection.style.display = '';
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

async function apiSaveEmail(candidate) {
	if (!candidate) {
		throw new Error('No email detected on page.');
	}

	const fromValue = candidate.from || candidate.sender || candidate.from_address || candidate.from_email || '';
	const fromEmail = firstEmail(fromValue) || firstEmail(candidate.from_email || '') || fromValue;
	const messageIdValue = candidate.message_id || candidate.messageId || '';
	const inReplyToValue = candidate.in_reply_to || candidate.inReplyTo || '';
	const referencesValue = Array.isArray(candidate.references) ? candidate.references.filter(Boolean) : [];
	const syntheticRawEmail = buildSyntheticRawEmail(candidate);
	const preferSyntheticRawEmail = candidate.provider === 'outlook';

	const basePayload = {
		source: 'browser-extension',
		project: _settings.project_id,
	};

	const structuredPayload = {
		...basePayload,
		subject: candidate.subject || (_currentTab ? _currentTab.title : ''),
		from: fromValue,
		from_email: fromEmail,
		sender: fromValue,
		to: candidate.to || [],
		cc: candidate.cc || [],
		bcc: candidate.bcc || [],
		date: candidate.date || '',
		message_id: messageIdValue,
		in_reply_to: inReplyToValue,
		references: referencesValue,
		text_content: candidate.text_content || '',
		body: candidate.text_content || '',
	};

	const parsedEmailPayload = {
		subject: structuredPayload.subject,
		from: structuredPayload.from,
		from_email: structuredPayload.from_email,
		sender: structuredPayload.sender,
		to: structuredPayload.to,
		cc: structuredPayload.cc,
		bcc: structuredPayload.bcc,
		date: structuredPayload.date,
		message_id: structuredPayload.message_id,
		messageId: structuredPayload.message_id,
		in_reply_to: structuredPayload.in_reply_to,
		inReplyTo: structuredPayload.in_reply_to,
		references: structuredPayload.references,
		text_content: structuredPayload.text_content,
		text: structuredPayload.text_content,
		body_text: structuredPayload.text_content,
		body: structuredPayload.body,
		source: basePayload.source,
		mode: candidate.mode || 'structured_dom',
	};

	const payload = {
		...structuredPayload,
		messageId: structuredPayload.message_id,
		inReplyTo: structuredPayload.in_reply_to,
		parsed_email: parsedEmailPayload,
	};

	if (!preferSyntheticRawEmail && candidate.raw_email) {
		payload.raw_email = candidate.raw_email;
	} else if (syntheticRawEmail) {
		payload.raw_email = syntheticRawEmail;
	}

	const { response, usedUrl, triedUrls } = await fetchWith404Fallback(_settings.emails_create_url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Token ${_settings.access_token}`,
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const data = await readResponseData(response);
		const apiMessage = getApiErrorMessage(data);

		if (response.status === 404) {
			const localHint = _settings.instance_url === 'https://app.kumbukum.com'
				? ' If running local dev, set Instance URL to http://localhost:3000 in extension settings.'
				: '';
			throw new Error(`Email endpoint not found (404). Tried: ${triedUrls.join(' | ')}. Backend may not support /api/v1/emails yet.${localHint}`);
		}

		if (response.status === 403) {
			throw new Error(apiMessage || 'Email feature unavailable for this account/plan.');
		}
		throw new Error(apiMessage || `HTTP ${response.status} (${usedUrl})`);
	}

	const data = await response.json();
	return data.email || data;
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

async function saveEmail() {
	const btn = document.getElementById('btn-save-email');
	const statusEl = document.getElementById('email-status');
	btn.disabled = true;
	try {
		const editedSubject = getEditedEmailSubject();

		if (!_emailCandidate) {
			await detectEmailCandidate({ allowInteractiveSource: false });
		}

		let candidate = applyEditedEmailSubject(_emailCandidate, editedSubject);
		if (shouldRefreshEmailCandidateBeforeSave(candidate)) {
			showStatus(statusEl, 'Inspecting email details...', 'info');
			candidate = applyEditedEmailSubject(await enrichEmailCandidateBeforeSave(candidate), editedSubject);
		}

		if (!candidate) {
			throw new Error('No email found on this page.');
		}
		showStatus(statusEl, 'Adding email...', 'info');
		await apiSaveEmail(candidate);
		showStatus(statusEl, 'Email added!', 'success');
	} catch (err) {
		showStatus(statusEl, 'Failed: ' + err.message, 'error');
	} finally {
		btn.disabled = false;
	}
}

async function enrichEmailCandidateBeforeSave(candidate) {
	let bestCandidate = candidate || null;

	await detectEmailCandidate({ allowInteractiveSource: false });
	bestCandidate = mergeDetectedEmailCandidates(bestCandidate, _emailCandidate);

	if (shouldUseInteractiveSourceRefresh(bestCandidate)) {
		await detectEmailCandidate({ allowInteractiveSource: true });
		bestCandidate = mergeDetectedEmailCandidates(bestCandidate, _emailCandidate);
	}

	return bestCandidate;
}

function mergeDetectedEmailCandidates() {
	const candidates = Array.from(arguments)
		.filter(Boolean)
		.map(function (candidate) {
			return candidate && candidate.is_email ? candidate : {
				is_email: true,
				...candidate,
			};
		});

	if (candidates.length === 0) {
		return null;
	}

	const merged = mergeEmailCandidates(candidates);
	return merged ? normalizeEmailCandidate(merged) : normalizeEmailCandidate(candidates[0]);
}

function openConnectorSettings() {
	browser.runtime.openOptionsPage();
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

async function detectEmailCandidate(options) {
	hideEmailStatus();
	_emailCandidate = null;

	if (!_currentTab || !_currentTab.id || !_currentTab.url || !/^https?:\/\//i.test(_currentTab.url)) {
		renderEmailUnavailableState('Open an email page to add it to Kumbukum.', false);
		return;
	}

	try {
		const candidates = await collectEmailCandidatesFromTab(_currentTab.id, options || {});
		if (candidates.length === 0) {
			renderEmailUnavailableState('Couldn’t detect an email here. If parsing is not working, you may want to add connector settings.', true);
			return;
		}

		const mergedCandidate = mergeEmailCandidates(candidates);
		if (!mergedCandidate) {
			renderEmailUnavailableState('Couldn’t detect an email here. If parsing is not working, you may want to add connector settings.', true);
			return;
		}

		const normalizedCandidate = normalizeEmailCandidate(mergedCandidate);
		if (!isSaveableEmailCandidate(normalizedCandidate)) {
			renderEmailUnavailableState('We found email metadata, but the mail body is still missing. If parsing is not working, you may want to add connector settings.', true);
			return;
		}

		_emailCandidate = normalizedCandidate;
		renderEmailPreview(_emailCandidate);
	} catch (_err) {
		renderEmailUnavailableState('Couldn’t inspect this page for email content. If parsing is not working, you may want to add connector settings.', true);
	}
}

async function collectEmailCandidatesFromTab(tabId, options) {
	const frameIds = await getTabFrameIds(tabId);
	const responses = await Promise.all(frameIds.map(async function (frameId) {
		try {
			const response = await browser.tabs.sendMessage(tabId, {
				action: 'kumbukum.extractEmailCandidate',
				options: options || {},
			}, { frameId });

			if (!response || !response.is_email) {
				return null;
			}

			return {
				...response,
				_frameId: frameId,
			};
		} catch (_err) {
			return null;
		}
	}));

	return responses.filter(Boolean);
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

function selectBestEmailCandidate(candidates) {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		return null;
	}

	let best = candidates[0];
	let bestScore = scoreEmailCandidate(best);

	for (let i = 1; i < candidates.length; i += 1) {
		const score = scoreEmailCandidate(candidates[i]);
		if (score > bestScore) {
			best = candidates[i];
			bestScore = score;
		}
	}

	return best;
}

function mergeEmailCandidates(candidates) {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		return null;
	}

	const best = selectBestEmailCandidate(candidates);
	if (!best) {
		return null;
	}

	const rawCandidate = candidates.find(function (candidate) {
		return candidate && candidate.mode === 'raw_source' && candidate.raw_email;
	}) || null;
	const bodyCandidate = rawCandidate && rawCandidate.text_content ? rawCandidate : (selectBestBodyCandidate(candidates) || best);
	const headerCandidate = rawCandidate || selectBestHeaderCandidate(candidates) || best;
	const referenceCandidate = rawCandidate && (rawCandidate.in_reply_to || (Array.isArray(rawCandidate.references) && rawCandidate.references.length > 0) || rawCandidate.message_id)
		? rawCandidate
		: (selectBestReferenceCandidate(candidates) || best);

	return {
		is_email: true,
		partial: Boolean(best.partial || headerCandidate.partial || bodyCandidate.partial),
		subject: headerCandidate.subject || best.subject || '',
		from: headerCandidate.from || best.from || '',
		to: Array.isArray(headerCandidate.to) && headerCandidate.to.length > 0 ? headerCandidate.to : (best.to || []),
		cc: Array.isArray(headerCandidate.cc) && headerCandidate.cc.length > 0 ? headerCandidate.cc : (best.cc || []),
		bcc: Array.isArray(headerCandidate.bcc) && headerCandidate.bcc.length > 0 ? headerCandidate.bcc : (best.bcc || []),
		date: headerCandidate.date || best.date || '',
		message_id: headerCandidate.message_id || best.message_id || '',
		in_reply_to: referenceCandidate.in_reply_to || best.in_reply_to || '',
		references: Array.isArray(referenceCandidate.references) && referenceCandidate.references.length > 0 ? referenceCandidate.references : (best.references || []),
		text_content: bodyCandidate.text_content || best.text_content || '',
		raw_email: rawCandidate ? rawCandidate.raw_email : (best.raw_email || ''),
		mode: rawCandidate ? rawCandidate.mode : (bodyCandidate.mode || headerCandidate.mode || best.mode || 'structured_dom'),
		confidence: calculateMergedConfidence(headerCandidate, bodyCandidate, best),
		provider: headerCandidate.provider || bodyCandidate.provider || best.provider || 'unknown',
	};
}

function selectBestBodyCandidate(candidates) {
	let best = null;
	let bestLength = -1;
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		const bodyLength = candidate && candidate.text_content ? candidate.text_content.trim().length : 0;
		if (bodyLength > bestLength) {
			best = candidate;
			bestLength = bodyLength;
		}
	}
	return best;
}

function selectBestHeaderCandidate(candidates) {
	let best = null;
	let bestScore = -1;
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		const score = scoreHeaderFields(candidate);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

function selectBestReferenceCandidate(candidates) {
	let best = null;
	let bestScore = -1;
	for (let i = 0; i < candidates.length; i += 1) {
		const candidate = candidates[i];
		const score = (Array.isArray(candidate.references) ? candidate.references.length : 0) * 10 + (candidate.in_reply_to ? 5 : 0);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
}

function scoreHeaderFields(candidate) {
	if (!candidate) return -1;
	let score = 0;
	if (candidate.subject) score += 10;
	if (candidate.from) score += 15;
	if (Array.isArray(candidate.to) && candidate.to.length > 0) score += 10;
	if (Array.isArray(candidate.cc) && candidate.cc.length > 0) score += 4;
	if (candidate.date) score += 4;
	if (candidate.message_id) score += 12;
	if (candidate.mode === 'raw_source') score += 8;
	return score;
}

function calculateMergedConfidence(headerCandidate, bodyCandidate, bestCandidate) {
	const headerScore = scoreHeaderFields(headerCandidate);
	const bodyLength = bodyCandidate && bodyCandidate.text_content ? bodyCandidate.text_content.trim().length : 0;
	if (headerScore >= 35 && bodyLength >= 200) return 'high';
	if (headerScore >= 18 || bodyLength >= 120) return 'medium';
	return (bestCandidate && bestCandidate.confidence) || 'low';
}

function scoreEmailCandidate(candidate) {
	if (!candidate || !candidate.is_email) {
		return -1;
	}

	let score = 0;
	if (candidate.mode === 'raw_source') score += 200;
	if (candidate.message_id) score += 120;
	if (candidate.from) score += 80;
	if (Array.isArray(candidate.to) && candidate.to.length > 0) score += 60;
	if (candidate.subject) score += 40;
	if (Array.isArray(candidate.references) && candidate.references.length > 0) score += 20;
	if (candidate.text_content) score += Math.min(candidate.text_content.length, 4000) / 10;
	if (candidate._frameId && candidate._frameId !== 0) score += 15;
	return score;
}

function normalizeEmailCandidate(candidate) {
	return {
		subject: candidate.subject || '',
		from: candidate.from || candidate.sender || candidate.from_address || candidate.from_email || '',
		to: Array.isArray(candidate.to) ? candidate.to : [],
		cc: Array.isArray(candidate.cc) ? candidate.cc : [],
		bcc: Array.isArray(candidate.bcc) ? candidate.bcc : [],
		date: candidate.date || '',
		message_id: candidate.message_id || '',
		in_reply_to: candidate.in_reply_to || '',
		references: Array.isArray(candidate.references) ? candidate.references : [],
		text_content: candidate.text_content || '',
		raw_email: candidate.raw_email || '',
		mode: candidate.mode || 'structured_dom',
		confidence: candidate.confidence || 'medium',
		partial: Boolean(candidate.partial),
		provider: candidate.provider || 'unknown',
	};
}

function renderEmailPreview(candidate) {
	const section = document.getElementById('email-section');
	const previewEl = document.getElementById('email-preview');
	const emptyStateEl = document.getElementById('email-empty-state');
	const subjectInput = document.getElementById('email-preview-subject');
	const saveBtn = document.getElementById('btn-save-email');
	const settingsBtn = document.getElementById('btn-email-settings');

	if (!section || !previewEl || !emptyStateEl || !subjectInput || !saveBtn || !settingsBtn) {
		return;
	}

	const displaySubject = getDisplayEmailSubject(candidate);
	subjectInput.value = displaySubject;
	subjectInput.title = displaySubject || 'Email subject';
	previewEl.style.display = '';
	emptyStateEl.style.display = 'none';
	emptyStateEl.textContent = '';
	saveBtn.style.display = '';
	saveBtn.disabled = false;
	settingsBtn.style.display = 'none';
	section.style.display = '';
}

function renderEmailLoadingState() {
	renderEmailUnavailableState('Checking current page for email…', false);
}

function renderEmailUnavailableState(message, showSettingsButton) {
	const section = document.getElementById('email-section');
	const previewEl = document.getElementById('email-preview');
	const emptyStateEl = document.getElementById('email-empty-state');
	const saveBtn = document.getElementById('btn-save-email');
	const settingsBtn = document.getElementById('btn-email-settings');

	if (!section || !previewEl || !emptyStateEl || !saveBtn || !settingsBtn) {
		return;
	}

	previewEl.style.display = 'none';
	emptyStateEl.textContent = message || '';
	emptyStateEl.style.display = 'none';
	saveBtn.style.display = 'none';
	settingsBtn.style.display = 'none';
	section.style.display = 'none';
}

function getEditedEmailSubject() {
	const subjectInput = document.getElementById('email-preview-subject');
	if (!subjectInput) {
		return '';
	}

	return String(subjectInput.value || '').trim();
}

function applyEditedEmailSubject(candidate, editedSubject) {
	if (!candidate) {
		return candidate;
	}

	if (!editedSubject) {
		return candidate;
	}

	return {
		...candidate,
		subject: editedSubject,
	};
}

function getDisplayEmailSubject(candidate) {
	if (candidate && candidate.subject) {
		return candidate.subject;
	}

	if (_currentTab && _currentTab.title) {
		return _currentTab.title;
	}

	return '';
}

function formatMode(mode) {
	if (mode === 'raw_source') return 'Raw source';
	if (mode === 'fastmail_page_state') return 'Provider data';
	if (mode === 'readability_fallback') return 'Readability fallback';
	return 'Structured view';
}

function formatEmailMeta(candidate) {
	const parts = [formatMode(candidate.mode), `${candidate.confidence} confidence`];
	if (candidate.partial) {
		parts.push('connector may help if details look off');
	}
	return parts.join(' · ');
}

function isSaveableEmailCandidate(candidate) {
	if (!candidate) {
		return false;
	}

	const hasHeader = Boolean(candidate.subject || candidate.from || candidate.message_id || (candidate.to && candidate.to.length > 0));
	const hasBody = Boolean(candidate.text_content && candidate.text_content.trim().length > 0);
	return hasHeader && hasBody;
}

function shouldRefreshEmailCandidateBeforeSave(candidate) {
	if (!candidate) {
		return true;
	}

	if (!candidate.message_id || !candidate.from) {
		return true;
	}

	if (looksLikeReplySubject(candidate.subject) && !hasThreadReferenceData(candidate)) {
		return true;
	}

	return false;
}

function shouldUseInteractiveSourceRefresh(candidate) {
	const provider = inferEmailProvider(candidate);
	if (provider !== 'outlook') {
		return false;
	}

	if (!candidate) {
		return true;
	}

	if (!candidate.message_id || !candidate.from) {
		return true;
	}

	if (looksLikeReplySubject(candidate.subject) && !hasThreadReferenceData(candidate)) {
		return true;
	}

	return false;
}

function inferEmailProvider(candidate) {
	if (candidate && candidate.provider && candidate.provider !== 'unknown') {
		return candidate.provider;
	}

	if (isOutlookUrl(_currentTab && _currentTab.url)) {
		return 'outlook';
	}

	if (isGmailUrl(_currentTab && _currentTab.url)) {
		return 'gmail';
	}

	if (isFastmailUrl(_currentTab && _currentTab.url)) {
		return 'fastmail';
	}

	return 'unknown';
}

function looksLikeReplySubject(subject) {
	return /^(re|fw|fwd)\s*:/i.test(String(subject || '').trim());
}

function hasThreadReferenceData(candidate) {
	if (!candidate) {
		return false;
	}

	return Boolean(
		candidate.in_reply_to
		|| (Array.isArray(candidate.references) && candidate.references.length > 0)
	);
}

function isOutlookUrl(url) {
	try {
		const host = new URL(url || '').hostname.toLowerCase();
		return host.includes('outlook.live.com') || host.includes('outlook.office.com') || host.includes('outlook.office365.com');
	} catch (_err) {
		return false;
	}
}

function isGmailUrl(url) {
	try {
		const host = new URL(url || '').hostname.toLowerCase();
		return host.includes('mail.google.com');
	} catch (_err) {
		return false;
	}
}

function isFastmailUrl(url) {
	try {
		const host = new URL(url || '').hostname.toLowerCase();
		return host.includes('app.fastmail.com');
	} catch (_err) {
		return false;
	}
}

function buildSyntheticRawEmail(candidate) {
	if (!candidate || !candidate.text_content || !candidate.text_content.trim()) {
		return '';
	}

	const headers = [];
	const from = formatRawAddressHeader(candidate.from);
	const to = formatRawAddressList(candidate.to);
	const cc = formatRawAddressList(candidate.cc);
	const bcc = formatRawAddressList(candidate.bcc);

	if (from) headers.push(`From: ${from}`);
	if (to) headers.push(`To: ${to}`);
	if (cc) headers.push(`Cc: ${cc}`);
	if (bcc) headers.push(`Bcc: ${bcc}`);
	if (candidate.subject) headers.push(`Subject: ${sanitizeRawHeader(candidate.subject)}`);
	if (candidate.date) headers.push(`Date: ${sanitizeRawHeader(candidate.date)}`);
	if (candidate.message_id) headers.push(`Message-ID: ${sanitizeRawHeader(candidate.message_id)}`);
	if (candidate.in_reply_to) headers.push(`In-Reply-To: ${sanitizeRawHeader(candidate.in_reply_to)}`);
	if (Array.isArray(candidate.references) && candidate.references.length > 0) {
		headers.push(`References: ${candidate.references.map(sanitizeRawHeader).filter(Boolean).join(' ')}`);
	}

	headers.push('MIME-Version: 1.0');
	headers.push('Content-Type: text/plain; charset=UTF-8');
	headers.push('Content-Transfer-Encoding: 8bit');

	return headers.join('\r\n') + '\r\n\r\n' + normalizeRawBody(candidate.text_content);
}

function formatRawAddressHeader(value) {
	const raw = sanitizeRawHeader(value || '');
	if (!raw) {
		return '';
	}

	return raw;
}

function formatRawAddressList(values) {
	const list = Array.isArray(values) ? values : [];
	return list.map(function (value) {
		return sanitizeRawHeader(value || '');
	}).filter(Boolean).join(', ');
}

function sanitizeRawHeader(value) {
	return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function normalizeRawBody(value) {
	return String(value || '').replace(/\r?\n/g, '\r\n').trim();
}

function firstEmail(value) {
	const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
	return match ? match[0].toLowerCase() : '';
}

function hideEmailStatus() {
	const statusEl = document.getElementById('email-status');
	if (statusEl) {
		statusEl.style.display = 'none';
	}
}

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
