const MIN_AUTO_CAPTURE_SECONDS = 30;

const DEFAULT_EXCLUDED_HOSTS = [
	'mail.google.com',
	'outlook.live.com',
	'outlook.office.com',
	'outlook.office365.com',
	'app.fastmail.com',
	'mail.yahoo.com',
	'proton.me',
	'mail.proton.me',
	'icloud.com',
	'google.com',
	'bing.com',
	'duckduckgo.com',
	'search.yahoo.com',
	'yandex.com',
	'baidu.com',
	'ecosia.org',
	'startpage.com',
	'search.brave.com',
	'kagi.com',
	'chatgpt.com',
	'chat.openai.com',
	'openai.com',
	'claude.ai',
	'perplexity.ai',
	'gemini.google.com',
	'copilot.microsoft.com',
	'poe.com',
	'you.com',
	'mistral.ai',
	'grok.com',
	'app.razuna.com',
	'app.streamient.com',
	'app.helpmonks.com',
];

const PRIVATE_HOST_LABELS = [
	'app',
	'admin',
	'dashboard',
	'console',
	'portal',
	'account',
	'auth',
];

const PRIVATE_PATH_PARTS = [
	'/login',
	'/signin',
	'/sign-in',
	'/auth',
	'/account',
	'/settings',
	'/dashboard',
	'/admin',
	'/console',
];

function normalizeUrlForCapture(url) {
	try {
		const parsed = new URL(url);
		parsed.hash = '';
		parsed.hostname = parsed.hostname.toLowerCase();
		if (parsed.pathname.length > 1) {
			parsed.pathname = parsed.pathname.replace(/\/+$/, '');
		}
		return parsed.toString();
	} catch (_err) {
		return '';
	}
}

function normalizeAutoCaptureDelay(value) {
	return Math.max(MIN_AUTO_CAPTURE_SECONDS, parseInt(value, 10) || MIN_AUTO_CAPTURE_SECONDS);
}

function normalizeExcludeSites(value) {
	const rawItems = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
	return Array.from(new Set(rawItems.map(function (item) {
		return String(item || '').trim().toLowerCase();
	}).filter(Boolean)));
}

function getAutoCaptureSkipReason(url, userExcludeSites) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch (_err) {
		return 'invalid-url';
	}

	if (parsed.protocol !== 'https:') {
		return 'non-https';
	}

	const host = parsed.hostname.toLowerCase();
	const path = parsed.pathname.toLowerCase();

	if (DEFAULT_EXCLUDED_HOSTS.some(function (excludedHost) {
		return matchesHost(host, excludedHost);
	})) {
		return 'default-excluded-host';
	}

	if (PRIVATE_HOST_LABELS.some(function (label) {
		return host.split('.').includes(label);
	})) {
		return 'private-app-host';
	}

	if (PRIVATE_PATH_PARTS.some(function (pathPart) {
		return path.includes(pathPart);
	})) {
		return 'private-app-path';
	}

	if (normalizeExcludeSites(userExcludeSites).some(function (excludeSite) {
		return matchesUserExclude(parsed, excludeSite);
	})) {
		return 'user-excluded';
	}

	return '';
}

async function postUrlToStreamient(settings, urlInfo) {
	const payload = {
		url: urlInfo.url,
		title: urlInfo.title || '',
		project: urlInfo.project_id || settings.project_id,
	};

	if (urlInfo.screenshot_data_url) {
		payload.screenshot_data_url = urlInfo.screenshot_data_url;
	}

	const response = await fetch(settings.urls_create_url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Token ${settings.access_token}`,
		},
		body: JSON.stringify(payload),
	});

	const data = await response.json().catch(function () { return {}; });
	if (!response.ok) {
		if (isDuplicateUrlResponse(response, data)) {
			return {
				...(data.url || data),
				_is_duplicate: true,
			};
		}
		throw new Error(data.error || data.message || `HTTP ${response.status}`);
	}

	return data.url || data;
}

function isDuplicateUrlResponse(response, data) {
	if (response.status === 409) {
		return true;
	}
	const message = String((data && (data.error || data.message || data.detail)) || '').toLowerCase();
	return message.includes('duplicate') || message.includes('already exists') || message.includes('already saved');
}

function matchesUserExclude(parsedUrl, excludeSite) {
	if (!excludeSite) return false;
	const normalizedExclude = excludeSite.replace(/^https?:\/\//, '').replace(/\/+$/, '');
	if (!normalizedExclude) return false;

	if (normalizedExclude.includes('/')) {
		const slashIndex = normalizedExclude.indexOf('/');
		const excludedHost = normalizeExcludedHostPattern(normalizedExclude.slice(0, slashIndex));
		const excludedPath = normalizedExclude.slice(slashIndex).toLowerCase();
		return matchesHost(parsedUrl.hostname.toLowerCase(), excludedHost) && parsedUrl.pathname.toLowerCase().startsWith(excludedPath);
	}

	return matchesHost(parsedUrl.hostname.toLowerCase(), normalizeExcludedHostPattern(normalizedExclude));
}

function normalizeExcludedHostPattern(hostPattern) {
	return hostPattern.toLowerCase().replace(/^\*\.?/, '');
}

function matchesHost(host, excludedHost) {
	const normalized = excludedHost.toLowerCase();
	return host === normalized || host.endsWith('.' + normalized);
}

export {
	MIN_AUTO_CAPTURE_SECONDS,
	getAutoCaptureSkipReason,
	normalizeAutoCaptureDelay,
	normalizeExcludeSites,
	normalizeUrlForCapture,
	postUrlToStreamient,
};
