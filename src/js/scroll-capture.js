import browser from 'webextension-polyfill';

const SCROLL_CAPTURE_ACTION = 'streamient.autoCaptureScrollDepth';
const SCROLL_THRESHOLD = 0.5;

let lastNotifiedUrl = '';
let ticking = false;

function getScrollDepth() {
	const doc = document.documentElement;
	const body = document.body;
	const scrollTop = window.scrollY || doc.scrollTop || body?.scrollTop || 0;
	const viewportHeight = window.innerHeight || doc.clientHeight || 0;
	const scrollHeight = Math.max(
		doc.scrollHeight || 0,
		body?.scrollHeight || 0,
		doc.offsetHeight || 0,
		body?.offsetHeight || 0,
	);
	const scrollableHeight = scrollHeight - viewportHeight;

	if (scrollableHeight <= 0) {
		return 0;
	}

	return Math.min(1, (scrollTop + viewportHeight) / scrollHeight);
}

function maybeNotifyScrollDepth() {
	ticking = false;

	if (window.top !== window) {
		return;
	}

	const currentUrl = window.location.href;
	if (currentUrl === lastNotifiedUrl) {
		return;
	}

	if (getScrollDepth() < SCROLL_THRESHOLD) {
		return;
	}

	lastNotifiedUrl = currentUrl;
	browser.runtime.sendMessage({
		action: SCROLL_CAPTURE_ACTION,
		url: currentUrl,
		scroll_depth: SCROLL_THRESHOLD,
	}).catch(function () {
		// Background may be unavailable during extension reloads.
	});
}

function scheduleScrollCheck() {
	if (ticking) {
		return;
	}

	ticking = true;
	window.requestAnimationFrame(maybeNotifyScrollDepth);
}

window.addEventListener('scroll', scheduleScrollCheck, { passive: true });
window.addEventListener('resize', scheduleScrollCheck);
setTimeout(scheduleScrollCheck, 1000);
