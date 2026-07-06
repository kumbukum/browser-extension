import browser from 'webextension-polyfill';

const EMAIL_EXTRACT_ACTION = 'streamient.extractEmailCandidate';

async function collectEmailCandidatesFromTab(tabId, options) {
	const frameIds = await getTabFrameIds(tabId);
	const responses = await Promise.all(frameIds.map(async function (frameId) {
		try {
			const response = await browser.tabs.sendMessage(tabId, {
				action: EMAIL_EXTRACT_ACTION,
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

async function detectEmailCandidate(tab, options) {
	if (!tab || !tab.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
		return null;
	}

	const candidates = await collectEmailCandidatesFromTab(tab.id, options || {});
	if (candidates.length === 0) {
		return null;
	}

	const mergedCandidate = mergeEmailCandidates(candidates);
	if (!mergedCandidate) {
		return null;
	}

	return normalizeEmailCandidate(mergedCandidate);
}

async function enrichEmailCandidateBeforeSave(tab, candidate, options) {
	let bestCandidate = candidate || null;
	const firstPass = await detectEmailCandidate(tab, { allowInteractiveSource: false });
	bestCandidate = mergeDetectedEmailCandidates(bestCandidate, firstPass);

	if (shouldUseInteractiveSourceRefresh(tab, bestCandidate)) {
		const interactivePass = await detectEmailCandidate(tab, { allowInteractiveSource: true });
		bestCandidate = mergeDetectedEmailCandidates(bestCandidate, interactivePass);
	}

	if (options && options.subject) {
		bestCandidate = applyEditedEmailSubject(bestCandidate, options.subject);
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
		html_content: bodyCandidate.html_content || bodyCandidate.body_html || best.html_content || best.body_html || '',
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
		html_content: candidate.html_content || candidate.body_html || '',
		raw_email: candidate.raw_email || '',
		mode: candidate.mode || 'structured_dom',
		confidence: candidate.confidence || 'medium',
		partial: Boolean(candidate.partial),
		provider: candidate.provider || 'unknown',
	};
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

function shouldUseInteractiveSourceRefresh(tab, candidate) {
	const provider = inferEmailProvider(tab, candidate);
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

function inferEmailProvider(tab, candidate) {
	if (candidate && candidate.provider && candidate.provider !== 'unknown') {
		return candidate.provider;
	}

	if (isOutlookUrl(tab && tab.url)) {
		return 'outlook';
	}

	if (isGmailUrl(tab && tab.url)) {
		return 'gmail';
	}

	if (isFastmailUrl(tab && tab.url)) {
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

function applyEditedEmailSubject(candidate, editedSubject) {
	if (!candidate || !editedSubject) {
		return candidate;
	}

	return {
		...candidate,
		subject: String(editedSubject || '').trim(),
	};
}

async function saveEmailToStreamient(settings, candidate, tab) {
	if (!candidate) {
		throw new Error('No email detected on page.');
	}

	const fromValue = candidate.from || candidate.sender || candidate.from_address || candidate.from_email || '';
	const fromEmail = firstEmail(fromValue) || firstEmail(candidate.from_email || '') || fromValue;
	const messageIdValue = candidate.message_id || candidate.messageId || '';
	const inReplyToValue = candidate.in_reply_to || candidate.inReplyTo || '';
	const referencesValue = Array.isArray(candidate.references) ? candidate.references.filter(Boolean) : [];
	const syntheticRawEmail = buildSyntheticRawEmail(candidate);
	const preferSyntheticRawEmail = candidate.provider === 'outlook' && !candidate.html_content;

	const basePayload = {
		source: 'browser-extension',
		project: settings.email_project_id || settings.project_id,
		mailbox: 'inbox',
	};

	const structuredPayload = {
		...basePayload,
		subject: candidate.subject || (tab ? tab.title : ''),
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

	if (candidate.html_content) {
		structuredPayload.html_content = candidate.html_content;
		structuredPayload.body_html = candidate.html_content;
	}

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
		html_content: structuredPayload.html_content || '',
		body_html: structuredPayload.body_html || '',
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
	} else if (syntheticRawEmail && !candidate.html_content) {
		payload.raw_email = syntheticRawEmail;
	}

	const { response, usedUrl, triedUrls } = await fetchWith404Fallback(settings.emails_create_url, {
		method: 'POST',
		headers: apiHeaders(settings),
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const data = await readResponseData(response);
		const apiMessage = getApiErrorMessage(data);

		if (response.status === 404) {
			const localHint = settings.instance_url === 'https://app.streamient.com'
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

async function apiRequest(settings, path, options) {
	const requestOptions = options || {};
	const url = path.startsWith('http') ? path : settings.instance_url.replace(/\/+$/, '') + '/api/v1' + path;
	const { response, usedUrl, triedUrls } = await fetchWith404Fallback(url, {
		...requestOptions,
		headers: {
			...apiHeaders(settings),
			...(requestOptions.headers || {}),
		},
	});

	const data = await readResponseData(response);
	if (!response.ok) {
		const apiMessage = getApiErrorMessage(data);
		throw new Error(apiMessage || `HTTP ${response.status} (${usedUrl || triedUrls[0]})`);
	}

	return data;
}

function apiHeaders(settings) {
	return {
		'Content-Type': 'application/json',
		'Authorization': `Token ${settings.access_token}`,
	};
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

function getEmailDisplaySubject(candidate, tab) {
	if (candidate && candidate.subject) {
		return candidate.subject;
	}

	if (tab && tab.title) {
		return tab.title;
	}

	return '';
}

export {
	apiRequest,
	applyEditedEmailSubject,
	collectEmailCandidatesFromTab,
	detectEmailCandidate,
	enrichEmailCandidateBeforeSave,
	firstEmail,
	getEmailDisplaySubject,
	isSaveableEmailCandidate,
	mergeDetectedEmailCandidates,
	mergeEmailCandidates,
	normalizeEmailCandidate,
	saveEmailToStreamient,
	shouldRefreshEmailCandidateBeforeSave,
};
