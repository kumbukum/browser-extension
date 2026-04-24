import browser from 'webextension-polyfill';
import { Readability } from '@mozilla/readability';

const EXTRACT_ACTION = 'kumbukum.extractEmailCandidate';
const PAGE_REQUEST_EVENT = 'kumbukum:page-request';
const PAGE_BRIDGE_STATUS_ATTRIBUTE = 'data-kumbukum-page-bridge';
const OUTLOOK_MESSAGE_SOURCE_CACHE = new Map();

const RAW_SOURCE_SIGNAL_HEADERS = [
	'return-path',
	'received',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'delivered-to',
	'dkim-signature',
];

browser.runtime.onMessage.addListener(function (message) {
	if (!message || message.action !== EXTRACT_ACTION) {
		return undefined;
	}

	return extractEmailCandidate(message.options || {}).catch(function (err) {
		return {
			is_email: false,
			error: err.message || 'Failed to extract email',
		};
	});
});

async function extractEmailCandidate(options) {
	const extractionOptions = normalizeExtractionOptions(options);
	const rawSource = detectRawSourceFromPage();
	if (rawSource) {
		return {
			is_email: true,
			mode: 'raw_source',
			confidence: 'high',
			...rawSource,
		};
	}

	const providerHint = extractProviderHint();
	const providerData = await detectProviderStructuredData(providerHint.provider);
	const enrichedProviderHint = mergeEmailData(providerData || {}, providerHint);
	const providerRawSource = await detectProviderRawSource(providerHint.provider, extractionOptions);
	if (providerRawSource) {
		return {
			is_email: true,
			mode: 'raw_source',
			confidence: 'high',
			provider: enrichedProviderHint.provider || providerRawSource.provider || 'unknown',
			...providerRawSource,
		};
	}

	const generic = extractGenericEmailView();
	const merged = mergeEmailData(enrichedProviderHint, generic);

	if (providerHint.provider === 'outlook' && !hasOpenOutlookMessageView()) {
		return {
			is_email: false,
			error: 'No email detected on current page.',
		};
	}

	if (!merged.text_content || merged.text_content.length < 120) {
		const read = extractBodyWithReadability();
		if (read && read.text_content && read.text_content.length > (merged.text_content || '').length) {
			merged.text_content = read.text_content;
			if (!merged.subject && read.subject) {
				merged.subject = read.subject;
			}
			if (!merged.mode) {
				merged.mode = 'readability_fallback';
			}
		}
	}

	if (!looksLikeEmail(merged)) {
		if (looksLikeProviderEmailFragment(merged, providerHint.provider)) {
			if (!merged.mode) {
				merged.mode = 'structured_dom';
			}
			if (!merged.confidence) {
				merged.confidence = 'low';
			}

			return {
				is_email: true,
				partial: true,
				...merged,
			};
		}

		return {
			is_email: false,
			error: 'No email detected on current page.',
		};
	}

	if (!merged.mode) {
		merged.mode = 'structured_dom';
	}

	if (!merged.confidence) {
		merged.confidence = scoreConfidence(merged);
	}

	return {
		is_email: true,
		...merged,
	};
}

function normalizeExtractionOptions(options) {
	return {
		allowInteractiveSource: Boolean(options && options.allowInteractiveSource),
	};
}

function detectRawSourceFromPage() {
	const text = getRawSourceText();
	return parseRawEmailText(text);
}

function parseRawEmailText(text) {
	const sourceText = normalizePossiblyMisdecodedUtf8((text || '').trim().slice(0, 2000000));
	if (!sourceText) return null;

	const sep = sourceText.match(/\r?\n\r?\n/);
	if (!sep) {
		return null;
	}

	const headerPart = sourceText.slice(0, sep.index);
	const bodyPart = sourceText.slice(sep.index + sep[0].length);

	const headerMatches = headerPart.match(/^(from|to|cc|bcc|subject|date|message-id|in-reply-to|references|return-path|received|mime-version|content-type|content-transfer-encoding|delivered-to|dkim-signature|x-[a-z0-9-]+):\s.+$/gim) || [];
	if (headerMatches.length < 4) {
		return null;
	}

	const unfolded = unfoldHeaderLines(headerPart);

	const headers = {};
	for (let i = 0; i < unfolded.length; i += 1) {
		const line = unfolded[i];
		if (!line) continue;
		const idx = line.indexOf(':');
		if (idx <= 0) continue;
		const name = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (!headers[name]) {
			headers[name] = value;
		} else {
			headers[name] += ', ' + value;
		}
	}

	if (!headers.subject || (!headers.from && !headers.to)) {
		return null;
	}

	let signalCount = 0;
	for (let i = 0; i < RAW_SOURCE_SIGNAL_HEADERS.length; i += 1) {
		if (headers[RAW_SOURCE_SIGNAL_HEADERS[i]]) {
			signalCount += 1;
		}
	}

	const hasCoreRawHeaders = Boolean(
		headers.subject
		&& (headers.from || headers.to)
		&& headers['message-id']
		&& headers['content-type']
	);

	if (signalCount < 2 && (!hasCoreRawHeaders || !hasRawMimeBodySignals(bodyPart, headers['content-type'] || ''))) {
		return null;
	}

	const body = extractTextContentFromRawBody(bodyPart, headers).trim();
	if (!body) return null;

	const parsed = {
		subject: normalizePossiblyMisdecodedUtf8(headers.subject || ''),
		from: normalizePossiblyMisdecodedUtf8(headers.from || firstEmail(headers.from) || ''),
		to: extractEmails(headers.to || ''),
		cc: extractEmails(headers.cc || ''),
		bcc: extractEmails(headers.bcc || ''),
		date: normalizePossiblyMisdecodedUtf8(headers.date || ''),
		message_id: extractMessageId(headers['message-id'] || ''),
		in_reply_to: extractMessageId(headers['in-reply-to'] || ''),
		references: extractMessageIds(headers.references || ''),
		text_content: normalizePossiblyMisdecodedUtf8(body),
		raw_email: sourceText,
	};

	if (!looksLikeEmail(parsed)) {
		return null;
	}

	return parsed;
}

async function detectProviderRawSource(provider, options) {
	if (provider === 'gmail') {
		return extractGmailOriginalSource();
	}

	if (provider === 'outlook' && options && options.allowInteractiveSource) {
		return extractOutlookMessageSource();
	}

	return null;
}

async function extractOutlookMessageSource() {
	await dismissOutlookBlockingDialogs(true);

	const cacheKey = getOutlookMessageCacheKey();
	if (cacheKey && OUTLOOK_MESSAGE_SOURCE_CACHE.has(cacheKey)) {
		return parseRawEmailText(OUTLOOK_MESSAGE_SOURCE_CACHE.get(cacheKey));
	}

	const existingSourceText = getOutlookMessageSourceText();
	const dialogWasAlreadyOpen = Boolean(existingSourceText);
	let sourceText = existingSourceText;

	if (!sourceText) {
		const opened = await openOutlookMessageSourceDialog();
		if (!opened) {
			return null;
		}

		sourceText = await waitForValue(getOutlookMessageSourceText, 2000, 50);
	}

	if (!dialogWasAlreadyOpen) {
		closeOutlookMessageSourceDialog();
		await dismissOutlookBlockingDialogs(false);
	}

	if (!sourceText) {
		return null;
	}

	if (cacheKey) {
		OUTLOOK_MESSAGE_SOURCE_CACHE.set(cacheKey, sourceText);
	}

	return parseRawEmailText(sourceText);
}

async function detectProviderStructuredData(provider) {
	if (provider === 'fastmail') {
		return extractFastmailPageData();
	}

	if (provider === 'outlook') {
		return extractOutlookPageData();
	}

	return null;
}

async function extractFastmailPageData() {
	const payload = await requestPageContextData('fastmail-current-email');
	if (!payload || payload.provider !== 'fastmail') {
		return null;
	}

	const fromEmails = extractEmailsFromAddressList(payload.from);
	const toEmails = extractEmailsFromAddressList(payload.to);
	const ccEmails = extractEmailsFromAddressList(payload.cc);
	const bccEmails = extractEmailsFromAddressList(payload.bcc);
	const messageId = firstValue(payload.messageId);
	const inReplyTo = firstValue(payload.inReplyTo);

	return {
		provider: 'fastmail',
		subject: payload.subject || '',
		from: fromEmails[0] || '',
		to: toEmails,
		cc: ccEmails,
		bcc: bccEmails,
		date: payload.sentAt || payload.receivedAt || '',
		message_id: normalizeMessageId(messageId),
		in_reply_to: normalizeMessageId(inReplyTo),
		references: normalizeMessageIdList(payload.references),
		text_content: (payload.bodyText || '').trim(),
		mode: 'fastmail_page_state',
	};
}

async function extractOutlookPageData() {
	const payload = await requestPageContextData('outlook-current-email');
	if (!payload || payload.provider !== 'outlook') {
		return null;
	}

	const fromEmails = extractEmailsFromAddressList(payload.from);
	const toEmails = extractEmailsFromAddressList(payload.to);
	const ccEmails = extractEmailsFromAddressList(payload.cc);
	const bccEmails = extractEmailsFromAddressList(payload.bcc);
	const messageId = firstValue(payload.messageId);
	const inReplyTo = firstValue(payload.inReplyTo);

	return {
		provider: 'outlook',
		subject: payload.subject || '',
		from: fromEmails[0] || '',
		to: toEmails,
		cc: ccEmails,
		bcc: bccEmails,
		date: payload.sentAt || payload.receivedAt || '',
		message_id: normalizeMessageId(messageId),
		in_reply_to: normalizeMessageId(inReplyTo),
		references: normalizeMessageIdList(payload.references),
		text_content: (payload.bodyText || '').trim(),
		mode: 'outlook_page_state',
	};
}

async function requestPageContextData(type, payload) {
	const isInjected = await ensurePageBridgeInjected();
	if (!isInjected) {
		return null;
	}

	return new Promise(function (resolve) {
		const requestId = 'kumbukum-' + type + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
		const responseEventName = 'kumbukum:page-response:' + requestId;
		let settled = false;

		function cleanup() {
			document.removeEventListener(responseEventName, onResponse);
		}

		function finish(value) {
			if (settled) {
				return;
			}

			settled = true;
			window.clearTimeout(timeoutId);
			cleanup();
			resolve(value || null);
		}

		function onResponse(event) {
			finish(event && event.detail ? event.detail : null);
		}

		const timeoutId = window.setTimeout(function () {
			finish(null);
		}, 2500);

		document.addEventListener(responseEventName, onResponse, { once: true });
		document.dispatchEvent(new CustomEvent(PAGE_REQUEST_EVENT, {
			detail: {
				id: requestId,
				type,
				payload: payload || null,
			},
		}));
	});
}

async function ensurePageBridgeInjected() {
	const root = document.documentElement;
	if (!root) {
		return false;
	}

	if (root.getAttribute(PAGE_BRIDGE_STATUS_ATTRIBUTE) === 'ready') {
		return true;
	}

	const existingScript = document.querySelector('script[data-kumbukum-page-bridge="true"]');
	if (existingScript) {
		return waitForPageBridgeReady();
	}

	return new Promise(function (resolve) {
		const script = document.createElement('script');
		script.src = browser.runtime.getURL('page_bridge.js');
		script.async = false;
		script.dataset.kumbukumPageBridge = 'true';
		script.onload = function () {
			script.remove();
			waitForPageBridgeReady().then(resolve);
		};
		script.onerror = function () {
			script.remove();
			resolve(false);
		};

		(document.head || root).appendChild(script);
	});
}

async function waitForPageBridgeReady() {
	const root = document.documentElement;
	if (!root) {
		return false;
	}

	if (root.getAttribute(PAGE_BRIDGE_STATUS_ATTRIBUTE) === 'ready') {
		return true;
	}

	return new Promise(function (resolve) {
		let attempts = 0;

		function checkReady() {
			attempts += 1;
			if (root.getAttribute(PAGE_BRIDGE_STATUS_ATTRIBUTE) === 'ready') {
				resolve(true);
				return;
			}

			if (attempts >= 20) {
				resolve(false);
				return;
			}

			window.setTimeout(checkReady, 50);
		}

		checkReady();
	});
}

function getRawSourceText() {
	const candidates = [];
	const rawContainers = Array.from(document.querySelectorAll('pre, code, textarea'));

	for (let i = 0; i < rawContainers.length; i += 1) {
		const text = (rawContainers[i].textContent || rawContainers[i].value || '').trim();
		if (text) {
			candidates.push(text);
		}
	}

	if (document.body) {
		const bodyTextContent = (document.body.textContent || '').trim();
		if (bodyTextContent) {
			candidates.push(bodyTextContent);
		}
	}

	for (let i = 0; i < candidates.length; i += 1) {
		if (looksLikeRawEmailText(candidates[i])) {
			return candidates[i];
		}
	}

	return '';
}

async function extractGmailOriginalSource() {
	const originalUrl = getGmailOriginalSourceUrl();
	if (!originalUrl) {
		return null;
	}

	try {
		const response = await fetch(originalUrl, {
			credentials: 'include',
			cache: 'no-store',
		});

		if (!response.ok) {
			return null;
		}

		const html = await response.text();
		const rawEmail = extractRawEmailFromGmailOriginalHtml(html);
		if (!rawEmail) {
			return null;
		}

		return parseRawEmailText(rawEmail);
	} catch (_err) {
		return null;
	}
}

function getGmailOriginalSourceUrl() {
	const permMessageId = getGmailPermMessageId();
	const ik = getGmailIkValue();
	if (!permMessageId || !ik) {
		return '';
	}

	const path = (window.location.pathname || '/mail/u/0').replace(/\/+$/, '') || '/mail/u/0';
	return `${window.location.origin}${path}?ik=${encodeURIComponent(ik)}&view=om&permmsgid=${encodeURIComponent(permMessageId)}`;
}

function getGmailPermMessageId() {
	const selectors = [
		'.adn.ads[data-message-id]',
		'.adn[data-message-id]',
		'[data-message-id^="#msg-"]',
	];

	for (let i = 0; i < selectors.length; i += 1) {
		const els = Array.from(document.querySelectorAll(selectors[i]));
		for (let j = 0; j < els.length; j += 1) {
			const el = els[j];
			if (!isVisible(el)) continue;
			const rawId = (el.getAttribute('data-message-id') || '').trim();
			if (rawId) {
				return rawId.replace(/^#/, '');
			}
		}
	}

	return '';
}

function getGmailIkValue() {
	const scripts = Array.from(document.scripts || []);

	for (let i = 0; i < scripts.length; i += 1) {
		const text = scripts[i].textContent || '';
		if (!text) continue;

		const match = text.match(/GM_ID_KEY\s*=\s*['"]([a-z0-9]+)['"]/i);
		if (match && match[1]) {
			return match[1];
		}
	}

	return '';
}

function extractRawEmailFromGmailOriginalHtml(html) {
	const match = (html || '').match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
	if (!match || !match[1]) {
		return '';
	}

	return decodeHtmlEntities(match[1]).trim();
}

function decodeHtmlEntities(value) {
	return (value || '')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

function looksLikeRawEmailText(text) {
	const source = (text || '').trim();
	if (!source) return false;
	if (!/^(subject|from|to|message-id|content-type)\s*:/im.test(source)) return false;
	if (!/\r?\n\r?\n/.test(source)) return false;
	return true;
}

function hasRawMimeBodySignals(bodyPart, contentTypeHeader) {
	const body = (bodyPart || '').trim();
	if (!body) return false;

	const boundary = extractMimeBoundary(contentTypeHeader || '');
	if (boundary) {
		const marker = '--' + boundary;
		if (body.indexOf(marker) !== -1) {
			return true;
		}
	}

	if (/^content-transfer-encoding\s*:/im.test(body)) {
		return true;
	}

	if (/^content-type\s*:/im.test(body)) {
		return true;
	}

	const firstChunk = body.split(/\r?\n/).slice(0, 240).join('\n');
	if (looksLikeBase64Block(firstChunk)) {
		return true;
	}

	return false;
}

function unfoldHeaderLines(headerText) {
	const lines = headerText.split(/\r?\n/);
	const unfolded = [];

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line) {
			continue;
		}
		if (/^[ \t]+/.test(line) && unfolded.length > 0) {
			unfolded[unfolded.length - 1] += ' ' + line.trim();
		} else {
			unfolded.push(line.trim());
		}
	}

	return unfolded;
}

function extractTextContentFromRawBody(bodyPart, headers) {
	const body = (bodyPart || '').trim();
	if (!body) return '';

	const contentType = (headers['content-type'] || '').toLowerCase();
	if (contentType.includes('multipart/')) {
		const boundary = extractMimeBoundary(headers['content-type'] || '');
		if (boundary) {
			const parts = splitMimeParts(body, boundary);
			let htmlFallback = '';

			for (let i = 0; i < parts.length; i += 1) {
				const part = parseMimePart(parts[i]);
				if (!part) continue;

				const partContentType = (part.headers['content-type'] || '').toLowerCase();
				const decoded = decodeTransferEncodedBody(part.body, part.headers['content-transfer-encoding'] || '').trim();
				if (!decoded) continue;

				if (partContentType.includes('text/plain')) {
					return normalizePossiblyMisdecodedUtf8(decoded);
				}

				if (!htmlFallback && partContentType.includes('text/html')) {
					htmlFallback = normalizePossiblyMisdecodedUtf8(stripHtml(decoded));
				}
			}

			if (htmlFallback) {
				return htmlFallback;
			}
		}
	}

	const decodedTopLevel = decodeTransferEncodedBody(body, headers['content-transfer-encoding'] || '').trim();
	if (decodedTopLevel) {
		if (contentType.includes('text/html')) {
			return normalizePossiblyMisdecodedUtf8(stripHtml(decodedTopLevel));
		}

		return normalizePossiblyMisdecodedUtf8(decodedTopLevel);
	}

	if (looksLikeBase64Block(body)) {
		const base64Decoded = decodeBase64Utf8(body).trim();
		if (base64Decoded) {
			if (contentType.includes('text/html')) {
				return normalizePossiblyMisdecodedUtf8(stripHtml(base64Decoded));
			}

			return normalizePossiblyMisdecodedUtf8(base64Decoded);
		}
	}

	if (contentType.includes('text/html')) {
		return normalizePossiblyMisdecodedUtf8(stripHtml(body));
	}

	return normalizePossiblyMisdecodedUtf8(body);
}

function extractMimeBoundary(contentTypeHeader) {
	const match = (contentTypeHeader || '').match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
	if (!match) return '';
	return (match[1] || match[2] || '').trim();
}

function splitMimeParts(body, boundary) {
	const marker = '--' + boundary;
	const rawParts = body.split(marker);
	if (rawParts.length <= 1) {
		return [];
	}

	const parts = [];
	for (let i = 1; i < rawParts.length; i += 1) {
		const section = rawParts[i];
		if (!section) continue;
		if (section.startsWith('--')) {
			break;
		}

		const cleaned = section.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
		if (cleaned.trim()) {
			parts.push(cleaned);
		}
	}

	return parts;
}

function parseMimePart(partText) {
	if (!partText) return null;
	const sep = partText.match(/\r?\n\r?\n/);
	if (!sep) {
		return {
			headers: {},
			body: partText,
		};
	}

	const headerText = partText.slice(0, sep.index);
	const body = partText.slice(sep.index + sep[0].length);
	const headers = parseHeaderBlock(headerText);

	return {
		headers,
		body,
	};
}

function parseHeaderBlock(headerText) {
	const headers = {};
	const unfolded = unfoldHeaderLines(headerText);

	for (let i = 0; i < unfolded.length; i += 1) {
		const line = unfolded[i];
		const idx = line.indexOf(':');
		if (idx <= 0) continue;

		const name = line.slice(0, idx).trim().toLowerCase();
		const value = line.slice(idx + 1).trim();
		if (!headers[name]) {
			headers[name] = value;
		} else {
			headers[name] += ', ' + value;
		}
	}

	return headers;
}

function decodeTransferEncodedBody(content, encoding) {
	const body = (content || '').trim();
	if (!body) return '';

	const normalizedEncoding = (encoding || '').toLowerCase();
	if (normalizedEncoding.includes('base64')) {
		return decodeBase64Utf8(body);
	}

	if (normalizedEncoding.includes('quoted-printable')) {
		return decodeQuotedPrintable(body);
	}

	return body;
}

function decodeBase64Utf8(value) {
	const compact = (value || '').replace(/\s+/g, '');
	if (!compact) return '';
	if (!/^[A-Za-z0-9+/=]+$/.test(compact)) {
		return '';
	}

	try {
		const binary = atob(compact);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch (_err) {
		return '';
	}
}

function decodeQuotedPrintable(value) {
	const normalized = (value || '').replace(/=\r?\n/g, '');
	const binary = normalized.replace(/=([A-Fa-f0-9]{2})/g, function (_m, hex) {
		return String.fromCharCode(parseInt(hex, 16));
	});

	try {
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	} catch (_err) {
		return binary;
	}
}

function looksLikeBase64Block(value) {
	const compact = (value || '').replace(/\s+/g, '');
	if (compact.length < 120) return false;
	return /^[A-Za-z0-9+/=]+$/.test(compact);
}

function stripHtml(html) {
	const source = (html || '').trim();
	if (!source) return '';

	try {
		const doc = new DOMParser().parseFromString(source, 'text/html');
		return normalizePossiblyMisdecodedUtf8((doc.body && (doc.body.innerText || doc.body.textContent || '') || '').trim());
	} catch (_err) {
		return normalizePossiblyMisdecodedUtf8(source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
	}
}

function normalizePossiblyMisdecodedUtf8(value) {
	const source = value == null ? '' : String(value);
	if (!source) {
		return '';
	}

	if (!/[ÃÂâð][\u0080-\u00BF]*/.test(source) && !/â€|â€™|â€œ|â€”|ð[\u0080-\u00BF]{2,4}/.test(source)) {
		return source;
	}

	try {
		const bytes = new Uint8Array(source.length);
		for (let i = 0; i < source.length; i += 1) {
			bytes[i] = source.charCodeAt(i) & 0xff;
		}

		const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
		if (scoreMojibake(decoded) < scoreMojibake(source)) {
			return decoded;
		}
	} catch (_err) {
		return source;
	}

	return source;
}

function scoreMojibake(value) {
	const text = value || '';
	const patterns = [
		/Ã./g,
		/Â./g,
		/â[\u0080-\u00BF]/g,
		/â€|â€™|â€œ|â€”/g,
		/ð[\u0080-\u00BF]{2,4}/g,
		/\uFFFD/g,
	];

	let score = 0;
	for (let i = 0; i < patterns.length; i += 1) {
		const matches = text.match(patterns[i]);
		if (matches) {
			score += matches.length;
		}
	}

	return score;
}

function normalizeWhitespace(value) {
	return (value || '').replace(/\s+/g, ' ').trim();
}

function extractProviderHint() {
	const host = window.location.hostname.toLowerCase();
	const referrerHost = getReferrerHost();
	if (host.includes('mail.google.com')) {
		return extractGmailHint();
	}
	if (referrerHost.includes('mail.google.com')) {
		return extractGmailHint('gmail');
	}
	if (host.includes('outlook.live.com') || host.includes('outlook.office.com') || host.includes('outlook.office365.com')) {
		return extractOutlookHint();
	}
	if (referrerHost.includes('outlook.live.com') || referrerHost.includes('outlook.office.com') || referrerHost.includes('outlook.office365.com')) {
		return extractOutlookHint('outlook');
	}
	if (host.includes('app.fastmail.com')) {
		return extractFastmailHint();
	}
	if (referrerHost.includes('app.fastmail.com') || referrerHost.includes('fastmail.com')) {
		return extractFastmailHint('fastmail');
	}
	return {
		provider: 'unknown',
	};
}

function extractGmailHint(providerName) {
	const senderText = textFromSelector(['.gD[email]', '.gD span[email]', '.gD']);
	const fromHeaderText = extractHeaderValueFromVisibleText('from');
	const fromCandidates = dedupeEmails([
		...collectEmailsFromSelectors([
			'.gD[email]',
			'.yW [email]',
			'.gD span[email]',
			'.ajv [email]',
			'.ajy [email]',
			'[email][name]',
		]),
		...extractEmails(senderText),
		...extractEmails(fromHeaderText),
	]);
	const normalizedFrom = fromCandidates.length > 0 ? fromCandidates[0] : '';

	const toCandidates = collectEmailsFromSelectors([
		'.hb [email]',
		'.go [email]',
		'.g2[email]',
		'.ajy [email]',
		'.hb .g2',
		'.go .g2',
	]).filter(function (email) {
		return !normalizedFrom || email !== normalizedFrom;
	});

	const ccCandidates = collectEmailsFromSelectors([
		'.gE [email]',
		'.gE .g2',
		'[aria-label*="Cc"] [email]',
	]).filter(function (email) {
		return (!normalizedFrom || email !== normalizedFrom) && toCandidates.indexOf(email) === -1;
	});

	const msg = {
		provider: providerName || 'gmail',
		subject: textFromSelector(['h2.hP', '.hP']),
		from: normalizedFrom || senderText || fromHeaderText || '',
		date: attributeFromSelector(['.g3[title]'], 'title') || textFromSelector(['.g3[title]', '.g3']) || '',
		to: dedupeEmails(toCandidates),
		cc: dedupeEmails(ccCandidates),
		bcc: [],
		text_content: extractGmailBodyText(),
		references: extractMessageIds(extractHeaderValueFromVisibleText('references')),
		in_reply_to: extractMessageId(extractHeaderValueFromVisibleText('in-reply-to')),
	};

	msg.message_id = extractGmailMessageId();

	return msg;
}

function extractOutlookHint(providerName) {
	return {
		provider: providerName || 'outlook',
		subject: extractOutlookSubject() || textFromSelector(['[data-test-id="message-subject"]']),
		from: extractOutlookFrom() || extractEmailFromLabel('from') || textFromSelector(['[aria-label*="From"]']),
		to: extractOutlookAddressList('to').length > 0 ? extractOutlookAddressList('to') : extractEmails(extractEmailFromLabel('to') || textFromSelector(['[aria-label*="To"]'])),
		cc: extractOutlookAddressList('cc').length > 0 ? extractOutlookAddressList('cc') : extractEmails(extractEmailFromLabel('cc') || textFromSelector(['[aria-label*="Cc"]'])),
		bcc: extractOutlookAddressList('bcc').length > 0 ? extractOutlookAddressList('bcc') : extractEmails(extractEmailFromLabel('bcc') || textFromSelector(['[aria-label*="Bcc"]'])),
		date: extractOutlookDate() || textFromSelector(['[aria-label*="Sent"]', '[aria-label*="Date"]']),
		text_content: extractOutlookBodyText() || longestTextFromSelectors(['main [role="document"]', 'div[role="document"]', '[data-app-section="MailReadCompose"]']),
	};
}

function extractOutlookSubject() {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return '';
	}

	const headings = Array.from(root.querySelectorAll('[role="heading"], h1, h2, h3'));
	for (let i = 0; i < headings.length; i += 1) {
		const heading = headings[i];
		if (!isVisible(heading)) continue;

		const text = sanitizeOutlookHeadingText(heading.innerText || heading.textContent || '');
		if (!text) continue;
		if (/^(from|to|cc|bcc)\s*:/i.test(text)) continue;
		if (looksLikeOutlookDateText(text)) continue;
		if (/^message source$/i.test(text)) continue;

		return text;
	}

	return '';
}

function extractOutlookDate() {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return '';
	}

	const headings = Array.from(root.querySelectorAll('[role="heading"], h1, h2, h3, time'));
	for (let i = 0; i < headings.length; i += 1) {
		const heading = headings[i];
		if (!isVisible(heading)) continue;

		const text = normalizeWhitespace(heading.innerText || heading.textContent || '');
		if (!text) continue;
		if (looksLikeOutlookDateText(text)) {
			return text;
		}
	}

	return '';
}

function extractOutlookFrom() {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return '';
	}

	const controls = Array.from(root.querySelectorAll('button, [role="button"], [aria-label*="From:"]'));
	for (let i = 0; i < controls.length; i += 1) {
		const el = controls[i];
		if (!isVisible(el)) continue;

		const label = normalizeWhitespace(el.getAttribute('aria-label') || '');
		const text = normalizeWhitespace(el.innerText || el.textContent || '');
		if (!/^from:/i.test(label) && !/^from:/i.test(text)) {
			continue;
		}

		if (text && text.replace(/^from:\s*/i, '')) {
			return text.replace(/^from:\s*/i, '');
		}
	}

	const headings = Array.from(root.querySelectorAll('[role="heading"], h1, h2, h3'));
	for (let i = 0; i < headings.length; i += 1) {
		const text = normalizeWhitespace(headings[i].innerText || headings[i].textContent || '');
		if (/^from:\s*/i.test(text)) {
			return text.replace(/^from:\s*/i, '');
		}
	}

	return '';
}

function extractOutlookAddressList(kind) {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return [];
	}

	const prefix = new RegExp('^' + kind + ':', 'i');
	const values = [];
	const controls = Array.from(root.querySelectorAll('button, [role="button"], [aria-label]'));
	for (let i = 0; i < controls.length; i += 1) {
		const el = controls[i];
		if (!isVisible(el)) continue;

		const label = normalizeWhitespace(el.getAttribute('aria-label') || '');
		const text = normalizeWhitespace(el.innerText || el.textContent || '');
		if (prefix.test(label) || prefix.test(text)) {
			values.push(label.replace(prefix, '').trim());
			values.push(text.replace(prefix, '').trim());
		}
	}

	return dedupeEmails(values.flatMap(extractEmails));
}

function extractOutlookBodyText() {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return '';
	}

	const documents = Array.from(root.querySelectorAll('[role="document"], article, [aria-label="Message body"]'));
	let best = '';
	for (let i = 0; i < documents.length; i += 1) {
		const el = documents[i];
		if (!isVisible(el)) continue;
		const text = sanitizeOutlookBodyText(normalizePossiblyMisdecodedUtf8((el.innerText || el.textContent || '').trim()));
		if (text.length > best.length) {
			best = text;
		}
	}

	return best;
}

function sanitizeOutlookBodyText(value) {
	return normalizeWhitespace(String(value || '')
		.replace(/^[\uE000-\uF8FF\s]+/, '')
		.replace(/^(show original size|open the previous item|open the next item|close)\s+/i, ''));
}

function extractFastmailHint(providerName) {
	return {
		provider: providerName || 'fastmail',
		subject: extractDefinitionListValue(['subject']) || textFromSelector(['[data-test-id="Message-subject"]', '.v-Message-subject', 'h1']),
		from: extractDefinitionListValue(['from']) || extractEmailFromLabel('from') || textFromSelector(['[title*="From"]', '.v-MessageCard-from']),
		to: extractEmails(extractDefinitionListValue(['to']) || extractEmailFromLabel('to') || textFromSelector(['[title*="To"]', '.v-MessageCard-to'])),
		cc: extractEmails(extractDefinitionListValue(['cc']) || extractEmailFromLabel('cc') || textFromSelector(['[title*="Cc"]'])),
		bcc: extractEmails(extractDefinitionListValue(['bcc']) || extractEmailFromLabel('bcc') || textFromSelector(['[title*="Bcc"]'])),
		date: extractDefinitionListValue(['date']) || extractEmailFromLabel('date') || textFromSelector(['time', '.v-MessageCard-time']),
		text_content: longestTextFromSelectors(['[data-test-id="Message-body"]', '.v-Message-body', '.v-Message .v-Message-body', '.u-article', 'article']),
	};
}

function extractDefinitionListValue(labels) {
	const normalizedLabels = (labels || []).map(function (label) {
		return (label || '').trim().toLowerCase().replace(/:$/, '');
	}).filter(Boolean);

	if (normalizedLabels.length === 0) {
		return '';
	}

	const terms = Array.from(document.querySelectorAll('dt, .v-Message-detailsTitle'));
	for (let i = 0; i < terms.length; i += 1) {
		const term = terms[i];
		const key = ((term.textContent || '').trim().toLowerCase()).replace(/:$/, '');
		if (normalizedLabels.indexOf(key) === -1) {
			continue;
		}

		let next = term.nextElementSibling;
		while (next && next.tagName === 'DT') {
			next = next.nextElementSibling;
		}

		if (next) {
			const value = (next.innerText || next.textContent || '').trim();
			if (value) {
				return value;
			}
		}
	}

	return '';
}

function extractGenericEmailView() {
	const text = getBodyText();
	if (!text) return {};

	const lineHeaders = extractHeadersFromVisibleText(text);
	const body = extractLikelyBodyText();

	return {
		subject: lineHeaders.subject || lineHeaders.re || '',
		from: lineHeaders.from || '',
		to: lineHeaders.to ? extractEmails(lineHeaders.to) : [],
		cc: lineHeaders.cc ? extractEmails(lineHeaders.cc) : [],
		bcc: lineHeaders.bcc ? extractEmails(lineHeaders.bcc) : [],
		date: lineHeaders.date || '',
		message_id: extractMessageId(lineHeaders['message-id'] || ''),
		in_reply_to: extractMessageId(lineHeaders['in-reply-to'] || ''),
		references: extractMessageIds(lineHeaders.references || ''),
		text_content: body,
	};
}

function extractBodyWithReadability() {
	try {
		const clone = document.cloneNode(true);
		const article = new Readability(clone).parse();
		if (!article || !article.textContent) {
			return null;
		}
		return {
			subject: article.title || '',
			text_content: article.textContent.trim(),
		};
	} catch (_err) {
		return null;
	}
}

function mergeEmailData(base, fallback) {
	const merged = {
		subject: base.subject || fallback.subject || '',
		from: base.from || fallback.from || '',
		to: dedupeEmails([...(base.to || []), ...(fallback.to || [])]),
		cc: dedupeEmails([...(base.cc || []), ...(fallback.cc || [])]),
		bcc: dedupeEmails([...(base.bcc || []), ...(fallback.bcc || [])]),
		date: base.date || fallback.date || '',
		message_id: base.message_id || fallback.message_id || '',
		in_reply_to: base.in_reply_to || fallback.in_reply_to || '',
		references: dedupeValues([...(base.references || []), ...(fallback.references || [])]),
		text_content: base.text_content || fallback.text_content || '',
		provider: base.provider || fallback.provider || 'unknown',
		mode: base.mode || fallback.mode || '',
	};

	if (merged.subject && /^re:\s*$/i.test(merged.subject) && fallback.subject) {
		merged.subject = fallback.subject;
	}

	return merged;
}

function looksLikeProviderEmailFragment(email, provider) {
	if (!email || provider === 'unknown') {
		return false;
	}

	if (provider === 'outlook' && !hasOutlookReadingPaneSignals(email)) {
		return false;
	}

	const hasAnyHeader = Boolean(
		email.subject
		|| email.from
		|| (email.to && email.to.length)
		|| (email.cc && email.cc.length)
		|| email.date
		|| email.message_id
	);
	const hasMeaningfulBody = Boolean(email.text_content && email.text_content.trim().length >= 120);

	return hasMeaningfulBody || hasAnyHeader;
}

function hasOutlookReadingPaneSignals(email) {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return false;
	}

	if (email && email.message_id) {
		return true;
	}

	const bodyText = extractOutlookBodyText();
	if (bodyText && bodyText.length >= 40) {
		return true;
	}

	const fromValue = extractOutlookFrom();
	const toValues = extractOutlookAddressList('to');
	if (fromValue && toValues.length > 0) {
		return true;
	}

	if (extractOutlookDate() && (fromValue || toValues.length > 0)) {
		return true;
	}

	return false;
}

function hasOpenOutlookMessageView() {
	const root = getOutlookReadingPaneRoot();
	if (!root) {
		return false;
	}

	if (!isVisible(root)) {
		return false;
	}

	if (extractOutlookBodyText()) {
		return true;
	}

	if (extractOutlookFrom() && extractOutlookAddressList('to').length > 0) {
		return true;
	}

	if (extractOutlookDate() && extractOutlookSubject()) {
		return true;
	}

	return false;
}

function getReferrerHost() {
	try {
		if (!document.referrer) return '';
		return new URL(document.referrer).hostname.toLowerCase();
	} catch (_err) {
		return '';
	}
}

function looksLikeEmail(email) {
	const hasHeader = Boolean(email.subject || email.from || (email.to && email.to.length) || email.date || email.message_id);
	const hasBody = Boolean(email.text_content && email.text_content.trim().length >= 60);
	return hasHeader && hasBody;
}

function scoreConfidence(email) {
	let score = 0;
	if (email.subject) score += 1;
	if (email.from) score += 1;
	if (email.to && email.to.length > 0) score += 1;
	if (email.date) score += 1;
	if (email.message_id) score += 1;
	if (email.text_content && email.text_content.length > 200) score += 1;

	if (score >= 5) return 'high';
	if (score >= 3) return 'medium';
	return 'low';
}

function getOutlookReadingPaneRoot() {
	const mains = Array.from(document.querySelectorAll('[role="main"], main'));
	for (let i = 0; i < mains.length; i += 1) {
		const label = (mains[i].getAttribute('aria-label') || '').toLowerCase();
		if (label.includes('reading pane')) {
			return mains[i];
		}
	}

	const bodyNode = Array.from(document.querySelectorAll('[role="document"], [aria-label="Message body"], article')).find(function (node) {
		return isVisible(node);
	});
	if (bodyNode) {
		return bodyNode.closest('[role="main"], main, article, section, [data-app-section="MailReadCompose"]') || bodyNode.parentElement;
	}

	return null;
}

function sanitizeOutlookHeadingText(value) {
	let text = normalizeWhitespace((value || '').replace(/^[\uE000-\uF8FF\s]+/, ''));
	if (!text) {
		return '';
	}

	const prefixes = ['Open the previous item', 'Open the next item', 'Close'];
	let changed = true;
	while (changed && text) {
		changed = false;
		for (let i = 0; i < prefixes.length; i += 1) {
			const prefix = prefixes[i];
			if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
				text = normalizeWhitespace(text.slice(prefix.length).replace(/^[\uE000-\uF8FF\s]+/, ''));
				changed = true;
			}
		}
	}

	return normalizeWhitespace(text.replace(/^[\uE000-\uF8FF\s]+/, ''));
}

function looksLikeOutlookDateText(value) {
	const text = normalizeWhitespace(value);
	if (!text) return false;
	if (/^(from|to|cc|bcc)\s*:/i.test(text)) return false;
	if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) return true;
	if (/\b\d{1,2}:\d{2}\b/i.test(text) && /\b(am|pm)\b/i.test(text)) return true;
	return false;
}

function getOutlookMessageCacheKey() {
	const path = window.location.pathname || '';
	const search = window.location.search || '';
	if (!/\/id\//.test(path)) {
		return '';
	}

	return path + search;
}

async function openOutlookMessageSourceDialog() {
	if (getOutlookMessageSourceText()) {
		return true;
	}

	await dismissOutlookBlockingDialogs(true);

	const root = getOutlookReadingPaneRoot() || document;
	const moreButton = findVisibleElementByAccessibleName(['button', '[role="button"]'], /^more items$/i, root);
	if (!moreButton) {
		return false;
	}

	clickElement(moreButton);

	let sourceItem = await waitForValue(function () {
		return findVisibleMenuItemByAccessibleName(/^view message source$/i);
	}, 500, 50);

	if (!sourceItem) {
		const viewButton = await waitForValue(function () {
			return findVisibleMenuItemByAccessibleName(/^view$/i);
		}, 1000, 50);

		if (!viewButton) {
			return false;
		}

		clickElement(viewButton);
		sourceItem = await waitForValue(function () {
			return findVisibleMenuItemByAccessibleName(/^view message source$/i);
		}, 1000, 50);
	}

	if (!sourceItem) {
		return false;
	}

	clickElement(sourceItem);

	const sourceText = await waitForValue(getOutlookMessageSourceText, 1500, 50);
	return Boolean(sourceText);
}

function closeOutlookMessageSourceDialog() {
	const dialog = findVisibleDialogByHeading(/^message source$/i);
	if (!dialog) {
		return;
	}

	const closeButton = findVisibleElementByAccessibleName(['button', '[role="button"]'], /^close$/i, dialog);
	if (closeButton) {
		clickElement(closeButton);
	}
}

async function dismissOutlookBlockingDialogs(preserveMessageSource) {
	let attempts = 0;
	while (attempts < 5) {
		attempts += 1;
		const dialog = findOutlookBlockingDialog(preserveMessageSource);
		if (!dialog) {
			return;
		}

		const closeButton = findVisibleElementByAccessibleName([
			'button',
			'[role="button"]',
		], /^(close|dismiss|cancel|back)$/i, dialog);
		const globalCloseButton = closeButton || findTopmostVisibleElementByAccessibleName([
			'button',
			'[role="button"]',
		], /^(close|dismiss|cancel|back)$/i);

		if (globalCloseButton) {
			clickElement(globalCloseButton);
		} else {
			try {
				document.dispatchEvent(new KeyboardEvent('keydown', {
					key: 'Escape',
					code: 'Escape',
					keyCode: 27,
					which: 27,
					bubbles: true,
					cancelable: true,
				}));
			} catch (_err) {
				return;
			}
		}

		await waitForValue(function () {
			return !findOutlookBlockingDialog(preserveMessageSource);
		}, 600, 50);
	}
}

function findOutlookBlockingDialog(preserveMessageSource) {
	const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]'));
	for (let i = dialogs.length - 1; i >= 0; i -= 1) {
		const dialog = dialogs[i];
		if (!isVisible(dialog)) continue;

		const headings = Array.from(dialog.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6'));
		const headingText = normalizeWhitespace(headings.map(function (heading) {
			return heading.innerText || heading.textContent || '';
		}).join(' '));

		if (preserveMessageSource && /message source/i.test(headingText)) {
			continue;
		}

		return dialog;
	}

	return null;
}

function getOutlookMessageSourceText() {
	const dialog = findVisibleDialogByHeading(/^message source$/i);
	if (!dialog) {
		return '';
	}

	const candidates = Array.from(dialog.querySelectorAll('*'));
	let best = '';
	let bestScore = 0;

	for (let i = 0; i < candidates.length; i += 1) {
		const text = (candidates[i].innerText || candidates[i].textContent || '').trim();
		const score = scoreRawSourceCandidate(text);
		if (score > bestScore || (score === bestScore && text.length > best.length)) {
			best = text;
			bestScore = score;
		}
	}

	return bestScore > 0 ? best : '';
}

function scoreRawSourceCandidate(value) {
	const text = (value || '').trim();
	if (!text) {
		return 0;
	}

	let score = 0;
	if (/^(received|return-path|from|subject|message-id|content-type)\s*:/i.test(text)) {
		score += 24;
	}

	const headerMatches = text.match(/^(received|return-path|from|to|subject|date|message-id|references|content-type|mime-version)\s*:/gim) || [];
	score += headerMatches.length * 3;

	if (/\r?\n\r?\n/.test(text)) {
		score += 8;
	}

	if (/message-id\s*:/i.test(text)) {
		score += 8;
	}

	if (/<!(doctype html)|<html[\s>]/i.test(text)) {
		score += 4;
	}

	if (text.length > 600) {
		score += 4;
	}

	return score;
}

function findVisibleDialogByHeading(headingPattern) {
	const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]'));
	for (let i = 0; i < dialogs.length; i += 1) {
		const dialog = dialogs[i];
		if (!isVisible(dialog)) continue;

		const headings = Array.from(dialog.querySelectorAll('[role="heading"], h1, h2, h3, h4, h5, h6'));
		for (let j = 0; j < headings.length; j += 1) {
			const text = normalizeWhitespace(headings[j].innerText || headings[j].textContent || '');
			if (headingPattern.test(text)) {
				return dialog;
			}
		}
	}

	return null;
}

function findVisibleMenuItemByAccessibleName(pattern) {
	const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(isVisible);
	for (let i = menus.length - 1; i >= 0; i -= 1) {
		const found = findVisibleElementByAccessibleName(['button', '[role="menuitem"]'], pattern, menus[i]);
		if (found) {
			return found;
		}
	}

	return null;
}

function findVisibleElementByAccessibleName(selectors, pattern, root) {
	const scope = root || document;
	const elements = Array.from(scope.querySelectorAll(selectors.join(', ')));
	for (let i = 0; i < elements.length; i += 1) {
		const el = elements[i];
		if (!isVisible(el)) continue;

		const labels = [
			normalizeWhitespace(el.getAttribute('aria-label') || ''),
			normalizeWhitespace(el.getAttribute('title') || ''),
			normalizeWhitespace(el.innerText || el.textContent || ''),
			normalizeWhitespace(el.value || ''),
		].filter(Boolean);

		for (let j = 0; j < labels.length; j += 1) {
			if (pattern.test(labels[j])) {
				return el;
			}
		}
	}

	return null;
}

function findTopmostVisibleElementByAccessibleName(selectors, pattern) {
	const elements = Array.from(document.querySelectorAll(selectors.join(', ')));
	let best = null;
	let bestTop = Number.POSITIVE_INFINITY;

	for (let i = 0; i < elements.length; i += 1) {
		const el = elements[i];
		if (!isVisible(el)) continue;

		const labels = [
			normalizeWhitespace(el.getAttribute('aria-label') || ''),
			normalizeWhitespace(el.getAttribute('title') || ''),
			normalizeWhitespace(el.innerText || el.textContent || ''),
		].filter(Boolean);

		if (!labels.some(function (label) { return pattern.test(label); })) {
			continue;
		}

		const rect = el.getBoundingClientRect();
		if (rect.top < bestTop) {
			best = el;
			bestTop = rect.top;
		}
	}

	return best;
}

function clickElement(el) {
	if (!el) {
		return false;
	}

	try {
		el.click();
		return true;
	} catch (_err) {
		// fall through
	}

	try {
		el.dispatchEvent(new MouseEvent('click', {
			bubbles: true,
			cancelable: true,
			view: window,
		}));
		return true;
	} catch (_err) {
		return false;
	}
}

async function waitForValue(getter, timeoutMs, intervalMs) {
	const startedAt = Date.now();
	while (Date.now() - startedAt <= timeoutMs) {
		const value = getter();
		if (value) {
			return value;
		}

		await new Promise(function (resolve) {
			window.setTimeout(resolve, intervalMs);
		});
	}

	return null;
}

function extractHeaderValueFromVisibleText(headerName) {
	const text = getBodyText();
	if (!text) return '';

	const lines = text.split(/\r?\n/).slice(0, 500);
	const regex = new RegExp('^' + headerName + '\\s*:\\s*(.+)$', 'i');

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trim();
		const match = line.match(regex);
		if (match && match[1]) {
			return match[1].trim();
		}
	}

	return '';
}

function extractHeadersFromVisibleText(text) {
	const lines = text
		.split(/\r?\n/)
		.map(function (line) { return line.trim(); })
		.filter(Boolean)
		.slice(0, 400);

	const headers = {};
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const match = line.match(/^(from|to|cc|bcc|subject|date|message-id|in-reply-to|references)\s*:\s*(.+)$/i);
		if (!match) continue;
		headers[match[1].toLowerCase()] = match[2].trim();
	}
	return headers;
}

function extractLikelyBodyText() {
	const hinted = longestTextFromSelectors([
		'.a3s.aiL',
		'.ii.gt',
		'div[role="document"]',
		'[data-test-id="Message-body"]',
		'article',
		'main',
	]);
	if (hinted && hinted.length > 80) {
		return hinted;
	}

	const blocks = Array.from(document.querySelectorAll('article, main, section, div, p'));
	let best = '';
	let bestScore = 0;

	for (let i = 0; i < blocks.length; i += 1) {
		const el = blocks[i];
		if (!isVisible(el)) continue;
		const text = (el.innerText || '').trim();
		if (text.length < 120) continue;

		const links = el.querySelectorAll('a').length;
		const score = text.length - links * 18;
		if (score > bestScore) {
			bestScore = score;
			best = text;
		}
	}

	return best;
}

function getBodyText() {
	if (!document.body) return '';
	return (document.body.innerText || '').trim();
}

function textFromSelector(selectors) {
	for (let i = 0; i < selectors.length; i += 1) {
		const el = document.querySelector(selectors[i]);
		if (!el || !isVisible(el)) continue;
		const text = (el.innerText || el.textContent || '').trim();
		if (text) return text;
	}
	return '';
}

function attributeFromSelector(selectors, attributeName) {
	for (let i = 0; i < selectors.length; i += 1) {
		const els = Array.from(document.querySelectorAll(selectors[i]));
		for (let j = 0; j < els.length; j += 1) {
			const value = (els[j].getAttribute(attributeName) || '').trim();
			if (value) {
				return value;
			}
		}
	}
	return '';
}

function firstEmailAttributeFromSelectors(selectors) {
	for (let i = 0; i < selectors.length; i += 1) {
		const els = Array.from(document.querySelectorAll(selectors[i]));
		for (let j = 0; j < els.length; j += 1) {
			const attr = (els[j].getAttribute('email') || '').trim();
			if (!attr) continue;
			const found = firstEmail(attr);
			if (found) {
				return found;
			}
		}
	}
	return '';
}

function collectEmailsFromSelectors(selectors) {
	const collected = [];
	for (let i = 0; i < selectors.length; i += 1) {
		const els = Array.from(document.querySelectorAll(selectors[i]));
		for (let j = 0; j < els.length; j += 1) {
			const el = els[j];
			const attrEmail = (el.getAttribute('email') || '').trim();
			if (attrEmail) {
				collected.push(attrEmail);
			}
			const text = (el.innerText || el.textContent || '').trim();
			if (text) {
				const textEmails = extractEmails(text);
				for (let k = 0; k < textEmails.length; k += 1) {
					collected.push(textEmails[k]);
				}
			}
		}
	}

	return dedupeEmails(collected);
}

function collectAttributeValuesFromSelectors(selectorAttributePairs) {
	const values = [];

	for (let i = 0; i < selectorAttributePairs.length; i += 1) {
		const pair = selectorAttributePairs[i];
		if (!pair || !pair.selector || !pair.attribute) continue;

		const els = Array.from(document.querySelectorAll(pair.selector));
		for (let j = 0; j < els.length; j += 1) {
			const value = (els[j].getAttribute(pair.attribute) || '').trim();
			if (value) {
				values.push(value);
			}
		}
	}

	return values;
}

function extractGmailBodyText() {
	const direct = longestTextFromSelectors([
		'.adn .a3s.aiL',
		'.adn .ii.gt',
		'[data-message-id] .a3s.aiL',
		'[data-legacy-message-id] .a3s.aiL',
		'.a3s.aiL',
		'.ii.gt',
		'.a3s',
	]);

	let best = direct || '';
	const containers = Array.from(document.querySelectorAll('.adn.ads, .adn, [data-message-id], [data-legacy-message-id], [role="listitem"]'));

	for (let i = 0; i < containers.length; i += 1) {
		const container = containers[i];
		if (!isVisible(container)) continue;

		const nested = longestTextFromNodeSelectors(container, ['.a3s.aiL', '.ii.gt', '.a3s', '[dir="ltr"]']);
		if (nested.length > best.length) {
			best = nested;
		}

		const blockText = (container.innerText || '').trim();
		if (blockText.length > best.length) {
			best = blockText;
		}
	}

	return best;
}

function extractGmailMessageId() {
	const candidates = [
		extractHeaderValueFromVisibleText('message-id'),
		...collectAttributeValuesFromSelectors([
			{ selector: '[data-legacy-message-id]', attribute: 'data-legacy-message-id' },
			{ selector: '[data-message-id]', attribute: 'data-message-id' },
			{ selector: '[data-legacy-last-message-id]', attribute: 'data-legacy-last-message-id' },
			{ selector: '[data-last-message-id]', attribute: 'data-last-message-id' },
		]),
	];

	for (let i = 0; i < candidates.length; i += 1) {
		const normalized = normalizeMessageId(candidates[i]);
		if (normalized) {
			return normalized;
		}
	}

	return '';
}

function longestTextFromNodeSelectors(node, selectors) {
	let best = '';
	for (let i = 0; i < selectors.length; i += 1) {
		const els = Array.from(node.querySelectorAll(selectors[i]));
		for (let j = 0; j < els.length; j += 1) {
			const el = els[j];
			if (!isVisible(el)) continue;
			const text = (el.innerText || el.textContent || '').trim();
			if (text.length > best.length) {
				best = text;
			}
		}
	}
	return best;
}

function normalizeMessageId(value) {
	const token = extractMessageIdToken(value);
	if (!token) {
		return '';
	}

	return '<' + token + '>';
}

function extractMessageIdToken(value) {
	const raw = (value || '').trim();
	if (!raw) return '';
	if (/^(thread-|thread-f:|thread-a:|#?msg-f:|#?msg-a:)/i.test(raw)) {
		return '';
	}

	const bracketedMatch = raw.match(/<([^<>\s@]+@[^<>\s]+)>/i);
	if (bracketedMatch && bracketedMatch[1]) {
		return bracketedMatch[1].trim();
	}

	const plainMatch = raw.match(/(^|[\s<(])([^\s<>"'(),;]+@[^\s<>"'(),;]+)(?=$|[\s>),;])/i);
	if (plainMatch && plainMatch[2]) {
		return plainMatch[2].trim();
	}

	return '';
}

function longestTextFromSelectors(selectors) {
	let best = '';
	for (let i = 0; i < selectors.length; i += 1) {
		const els = Array.from(document.querySelectorAll(selectors[i]));
		for (let j = 0; j < els.length; j += 1) {
			const el = els[j];
			if (!isVisible(el)) continue;
			const text = (el.innerText || el.textContent || '').trim();
			if (text.length > best.length) {
				best = text;
			}
		}
	}
	return best;
}

function extractEmailFromLabel(name) {
	const all = Array.from(document.querySelectorAll('div, span, p, dt, dd, th, td, label'));
	for (let i = 0; i < all.length; i += 1) {
		const el = all[i];
		if (!isVisible(el)) continue;
		const text = (el.textContent || '').trim();
		if (!text) continue;
		const regex = new RegExp('^' + name + '\\s*:\\s*(.+)$', 'i');
		const match = text.match(regex);
		if (!match) continue;
		return match[1].trim();
	}
	return '';
}

function extractEmails(input) {
	if (!input) return [];
	const matches = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
	return dedupeEmails(matches);
}

function firstEmail(input) {
	const list = extractEmails(input);
	return list.length > 0 ? list[0] : '';
}

function extractMessageId(input) {
	return normalizeMessageId(input);
}

function extractMessageIds(input) {
	if (!input) return [];
	const angleMatches = input.match(/<[^>]+>/g) || [];
	const plainMatches = input.match(/[^\s<>"'(),;]+@[^\s<>"'(),;]+/g) || [];
	const normalized = angleMatches
		.concat(plainMatches)
		.map(function (value) { return normalizeMessageId(value); })
		.filter(Boolean);
	return dedupeValues(normalized);
}

function dedupeEmails(values) {
	const normalized = values
		.map(function (value) { return (value || '').trim().toLowerCase(); })
		.filter(Boolean);
	return dedupeValues(normalized);
}

function extractEmailsFromAddressList(values) {
	const flattened = [];
	const list = Array.isArray(values) ? values : [];

	for (let i = 0; i < list.length; i += 1) {
		const value = list[i];
		if (!value) continue;

		if (typeof value === 'string') {
			flattened.push(value);
			continue;
		}

		if (value.email) {
			flattened.push(value.email);
		}

		if (value.name) {
			flattened.push(value.name);
		}
	}

	return dedupeEmails(flattened);
}

function normalizeMessageIdList(values) {
	const list = Array.isArray(values) ? values : [];
	return dedupeValues(list.map(function (value) {
		return normalizeMessageId(value);
	}).filter(Boolean));
}

function firstValue(value) {
	if (Array.isArray(value)) {
		return value.length > 0 ? value[0] : '';
	}

	return typeof value === 'string' ? value : '';
}

function dedupeValues(values) {
	return Array.from(new Set(values));
}

function isVisible(el) {
	if (!el) return false;
	const style = window.getComputedStyle(el);
	if (!style) return false;
	if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
	const rect = el.getBoundingClientRect();
	if (rect.width > 0 && rect.height > 0) return true;
	if (el.getClientRects && el.getClientRects().length > 0) return true;
	if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
	return false;
}
