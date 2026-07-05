import browser from 'webextension-polyfill';
import {
	apiRequest,
	detectEmailCandidate,
	enrichEmailCandidateBeforeSave,
	getEmailDisplaySubject,
	isSaveableEmailCandidate,
	saveEmailToStreamient,
	shouldRefreshEmailCandidateBeforeSave,
} from './email-utils.js';
import { getAllSettings } from './storage.js';

const EMAIL_CHANGE_POLL_MS = 1500;

let _settings = {};
let _currentTab = null;
let _emailCandidate = null;
let _emailFingerprint = '';
let _emailChangeTimer = null;
let _emailDetectionInFlight = false;

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', stopEmailChangeMonitor);

async function init() {
	document.getElementById('btn-open-settings')?.addEventListener('click', function () {
		browser.runtime.openOptionsPage();
	});
	document.getElementById('btn-add-email')?.addEventListener('click', addEmail);
	await loadSettingsAndTab();
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
		showWarning('Could not connect to Streamient. Check settings.');
		return;
	}

	const tabs = await browser.tabs.query({ active: true, currentWindow: true });
	_currentTab = tabs[0] || null;
	showMain();
	await detectCurrentEmail();
	startEmailChangeMonitor();
}

async function detectCurrentEmail() {
	if (_emailDetectionInFlight) return;
	_emailDetectionInFlight = true;
	try {
		setEmailContext('Checking current tab...');
		setEmailActionsEnabled(false);
		_emailCandidate = null;
		_emailFingerprint = '';

		if (!_currentTab || !_currentTab.id || !_currentTab.url || !/^https?:\/\//i.test(_currentTab.url)) {
			setEmailContext('Open an email page first.');
			showStatus('Open an email page first.', 'info');
			return;
		}

		const candidate = await detectEmailCandidate(_currentTab.id, _currentTab.url);
		if (!isSaveableEmailCandidate(candidate)) {
			setEmailContext('No email detected on this tab.');
			showStatus('Open an email message, then click Add Email.', 'info');
			return;
		}

		_emailCandidate = candidate;
		_emailFingerprint = emailFingerprint(candidate);
		setEmailContext(getEmailDisplaySubject(candidate) || 'Email detected');
		hideStatus();
		setEmailActionsEnabled(true);
	} catch (err) {
		setEmailContext('Could not inspect this tab.');
		showStatus(err.message || 'Email detection failed', 'error');
	} finally {
		_emailDetectionInFlight = false;
	}
}

async function addEmail() {
	const button = document.getElementById('btn-add-email');
	setLoading(button, true, 'Adding...');
	try {
		let candidate = _emailCandidate;
		if (shouldRefreshEmailCandidateBeforeSave(candidate)) {
			candidate = await enrichEmailCandidateBeforeSave(candidate, _currentTab?.id, _currentTab?.url);
		}
		const result = await saveEmailToStreamient(_settings, candidate);
		showStatus(result?.duplicate ? 'Email already stored.' : 'Email stored in Streamient.', 'success');
	} catch (err) {
		showStatus(err.message || 'Could not store email.', 'error');
	} finally {
		setLoading(button, false);
	}
}

function setEmailContext(text) {
	const el = document.getElementById('email-context');
	if (el) el.textContent = text;
}

function showWarning(message) {
	document.getElementById('main-view').style.display = 'none';
	document.getElementById('warning-view').style.display = '';
	document.getElementById('warning-message').textContent = message;
}

function showMain() {
	document.getElementById('warning-view').style.display = 'none';
	document.getElementById('main-view').style.display = '';
}

function setEmailActionsEnabled(enabled) {
	const button = document.getElementById('btn-add-email');
	if (button) button.disabled = !enabled;
}

function showStatus(message, type) {
	const el = document.getElementById('status');
	if (!el) return;
	el.textContent = message;
	el.className = 'status status-' + (type || 'info');
	el.style.display = '';
}

function hideStatus() {
	const el = document.getElementById('status');
	if (el) el.style.display = 'none';
}

function setLoading(button, loading, label) {
	if (!button) return;
	if (loading) {
		button.dataset.originalText = button.textContent;
		button.textContent = label || 'Working...';
		button.disabled = true;
		return;
	}
	button.textContent = button.dataset.originalText || 'Add Email';
	button.disabled = false;
}

function emailFingerprint(candidate) {
	if (!candidate) return '';
	return [
		candidate.message_id || '',
		candidate.subject || '',
		(candidate.from || []).join(','),
		candidate.text_content || '',
	].join('|');
}

function startEmailChangeMonitor() {
	stopEmailChangeMonitor();
	_emailChangeTimer = setInterval(async function () {
		if (!_currentTab?.id || _emailDetectionInFlight) return;
		const candidate = await detectEmailCandidate(_currentTab.id, _currentTab.url).catch(() => null);
		const nextFingerprint = emailFingerprint(candidate);
		if (nextFingerprint && nextFingerprint !== _emailFingerprint) {
			await detectCurrentEmail();
		}
	}, EMAIL_CHANGE_POLL_MS);
}

function stopEmailChangeMonitor() {
	if (_emailChangeTimer) clearInterval(_emailChangeTimer);
	_emailChangeTimer = null;
}
