(function () {
	const root = document.documentElement;
	if (!root) {
		return;
	}

	if (root.getAttribute('data-kumbukum-page-bridge') === 'ready') {
		return;
	}

	const REQUEST_EVENT = 'kumbukum:page-request';

	function serializeError(error) {
		if (!error) {
			return 'Unknown error';
		}

		return error.message || String(error);
	}

	function toArray(value) {
		if (Array.isArray(value)) {
			return value;
		}

		if (value == null) {
			return [];
		}

		return [value];
	}

	function getMessageValue(record, key) {
		if (!record) {
			return null;
		}

		if (typeof record.get === 'function') {
			return record.get(key);
		}

		return record[key];
	}

	function getBodyValue(partDescriptors, bodyValues) {
		const parts = Array.isArray(partDescriptors) ? partDescriptors : [];
		for (let i = 0; i < parts.length; i += 1) {
			const descriptor = parts[i];
			if (!descriptor || !descriptor.partId) {
				continue;
			}

			const entry = bodyValues[descriptor.partId];
			if (!entry || entry.isTruncated || typeof entry.value !== 'string' || !entry.value.trim()) {
				continue;
			}

			return entry.value;
		}

		return '';
	}

	function htmlToText(html) {
		const source = (html || '').trim();
		if (!source) {
			return '';
		}

		try {
			const doc = new DOMParser().parseFromString(source, 'text/html');
			return (doc.body && (doc.body.innerText || doc.body.textContent || '') || '').trim();
		} catch (_err) {
			return source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		}
	}

	function firstNonEmptyString(values) {
		const list = Array.isArray(values) ? values : [];

		for (let i = 0; i < list.length; i += 1) {
			const value = typeof list[i] === 'string' ? list[i].trim() : '';
			if (value) {
				return value;
			}
		}

		return '';
	}

	function getReactFiber(node) {
		if (!node) {
			return null;
		}

		const key = Object.keys(node).find(function (name) {
			return /^__reactFiber/.test(name);
		});

		return key ? node[key] : null;
	}

	function getOutlookReadingPaneRoot() {
		const candidates = Array.from(document.querySelectorAll('[role="main"], main'));
		for (let i = 0; i < candidates.length; i += 1) {
			const label = (candidates[i].getAttribute('aria-label') || '').toLowerCase();
			if (label.indexOf('reading pane') !== -1) {
				return candidates[i];
			}
		}

		return document.querySelector('[role="main"], main');
	}

	function getOutlookSelectedRow() {
		return document.querySelector('[role="option"][aria-selected="true"]');
	}

	function findNestedValue(rootObject, predicate, maxDepth) {
		const seen = new WeakSet();

		function visit(value, depth) {
			if (!value || depth > maxDepth) {
				return null;
			}

			if (typeof value !== 'object' && typeof value !== 'function') {
				return null;
			}

			if (seen.has(value)) {
				return null;
			}

			seen.add(value);

			if (predicate(value)) {
				return value;
			}

			const names = Object.getOwnPropertyNames(value).slice(0, 250);
			for (let i = 0; i < names.length; i += 1) {
				let child;
				try {
					child = value[names[i]];
				} catch (_err) {
					continue;
				}

				const found = visit(child, depth + 1);
				if (found) {
					return found;
				}
			}

			return null;
		}

		return visit(rootObject, 0);
	}

	function getMailbox(record) {
		if (!record) {
			return null;
		}

		return record.Mailbox || record.mailbox || null;
	}

	function mailboxToAddress(mailboxRecord) {
		const mailbox = getMailbox(mailboxRecord) || mailboxRecord;
		if (!mailbox) {
			return null;
		}

		const email = mailbox.EmailAddress || mailbox.emailAddress || '';
		const name = mailbox.Name || mailbox.name || '';
		if (!email && !name) {
			return null;
		}

		return {
			name: name || '',
			email: email || '',
		};
	}

	function mailboxesToAddresses(records) {
		const list = Array.isArray(records)
			? records
			: (records && typeof records.length === 'number' ? Array.from(records).slice(0, 100) : []);
		const results = [];
		for (let i = 0; i < list.length; i += 1) {
			const address = mailboxToAddress(list[i]);
			if (address) {
				results.push(address);
			}
		}

		return results;
	}

	function isOutlookItemRecord(value) {
		return Boolean(
			value
			&& value.ItemId
			&& value.ConversationId
			&& (value.InternetMessageId || value.From || value.Sender || value.ParentFolderId || value.ToRecipients)
		);
	}

	function getOutlookStateItemFromFiber(fiber) {
		if (!fiber) {
			return null;
		}

		const direct = fiber
			&& fiber.child
			&& fiber.child.child
			&& fiber.child.child.child
			&& fiber.child.child.child.child
			&& fiber.child.child.child.child.child
			&& fiber.child.child.child.child.child.child
			&& fiber.child.child.child.child.child.child.pendingProps
			&& fiber.child.child.child.child.child.child.pendingProps.itemReadingPaneViewState
			&& fiber.child.child.child.child.child.child.pendingProps.itemReadingPaneViewState.extendedCardViewState
			&& fiber.child.child.child.child.child.child.pendingProps.itemReadingPaneViewState.extendedCardViewState.cardViewState
			&& fiber.child.child.child.child.child.child.pendingProps.itemReadingPaneViewState.extendedCardViewState.cardViewState.item;

		if (direct) {
			return direct;
		}

		return findNestedValue(fiber, isOutlookItemRecord, 12);
	}

	function scoreOutlookItemMatch(item, node, currentSubject, readingPaneRoot) {
		let score = 0;
		const subject = ((item && (item.NormalizedSubject || item.Subject)) || '').trim();
		const normalizedCurrentSubject = (currentSubject || '').trim();

		if (subject && normalizedCurrentSubject) {
			if (subject === normalizedCurrentSubject) {
				score += 100;
			} else if (subject.indexOf(normalizedCurrentSubject) !== -1 || normalizedCurrentSubject.indexOf(subject) !== -1) {
				score += 60;
			}
		}

		if (item && item.InternetMessageId) {
			score += 40;
		}

		if (item && (item.From || item.Sender)) {
			score += 20;
		}

		if (item && item.ToRecipients) {
			score += 10;
		}

		if (readingPaneRoot && node && readingPaneRoot.contains(node)) {
			score += 10;
		}

		if (node && node.getAttribute && node.getAttribute('role') === 'heading') {
			score += 5;
		}

		return score;
	}

	function getOutlookStateItem() {
		const root = getOutlookReadingPaneRoot();
		const currentSubject = extractOutlookSubjectFromDom(root);
		const candidateNodes = [];

		if (root) {
			candidateNodes.push(root);
		}

		const selectedRow = getOutlookSelectedRow();
		if (selectedRow) {
			candidateNodes.push(selectedRow);
		}

		if (root) {
			const descendants = Array.from(root.querySelectorAll('[role="heading"], [role="document"], article, button, [role="button"]')).slice(0, 160);
			for (let i = 0; i < descendants.length; i += 1) {
				candidateNodes.push(descendants[i]);
			}
		}

		let bestItem = null;
		let bestScore = -1;

		for (let i = 0; i < candidateNodes.length; i += 1) {
			const fiber = getReactFiber(candidateNodes[i]);
			if (!fiber) {
				continue;
			}

			const item = getOutlookStateItemFromFiber(fiber);
			if (!item) {
				continue;
			}

			const score = scoreOutlookItemMatch(item, candidateNodes[i], currentSubject, root);
			if (score > bestScore) {
				bestItem = item;
				bestScore = score;
			}

			if (score >= 150) {
				break;
			}
		}

		if (bestItem) {
			return bestItem;
		}

		const fiber = getReactFiber(root);
		if (!fiber) {
			return null;
		}

		return getOutlookStateItemFromFiber(fiber);
	}

	function getOutlookSelectedRowData() {
		const row = getOutlookSelectedRow();
		const fiber = getReactFiber(row);
		if (!fiber) {
			return null;
		}

		return findNestedValue(fiber, function (value) {
			return Boolean(value && value.latestItemId && value.rowId && value.mailboxInfo);
		}, 8);
	}

	function sanitizeOutlookHeadingText(value) {
		let text = String(value || '').replace(/^[\uE000-\uF8FF\s]+/, '').replace(/\s+/g, ' ').trim();
		const prefixes = ['Open the previous item', 'Open the next item', 'Close'];
		let changed = true;
		while (changed && text) {
			changed = false;
			for (let i = 0; i < prefixes.length; i += 1) {
				if (text.toLowerCase().indexOf(prefixes[i].toLowerCase()) === 0) {
					text = text.slice(prefixes[i].length).replace(/^[\uE000-\uF8FF\s]+/, '').replace(/\s+/g, ' ').trim();
					changed = true;
				}
			}
		}

		return text;
	}

	function extractOutlookSubjectFromDom(root) {
		const pane = root || getOutlookReadingPaneRoot();
		if (!pane) {
			return '';
		}

		const headings = Array.from(pane.querySelectorAll('[role="heading"], h1, h2, h3'));
		for (let i = 0; i < headings.length; i += 1) {
			const text = sanitizeOutlookHeadingText(headings[i].innerText || headings[i].textContent || '');
			if (!text) {
				continue;
			}

			if (/^(from|to|cc|bcc)\s*:/i.test(text)) {
				continue;
			}

			if (/^(mon|tue|wed|thu|fri|sat|sun)\b/i.test(text)) {
				continue;
			}

			if (/\b\d{1,2}:\d{2}\b/i.test(text) && /\b(am|pm)\b/i.test(text)) {
				continue;
			}

			return text;
		}

		return '';
	}

	function extractOutlookBodyText(root) {
		const pane = root || getOutlookReadingPaneRoot();
		if (!pane) {
			return '';
		}

		const docs = Array.from(pane.querySelectorAll('[role="document"], article, [aria-label="Message body"]'));
		let best = '';
		for (let i = 0; i < docs.length; i += 1) {
			const text = (docs[i].innerText || docs[i].textContent || '').replace(/^[\uE000-\uF8FF\s]+/, '').trim();
			if (text.length > best.length) {
				best = text;
			}
		}

		return best;
	}

	function extractOutlookHeaderIds(item) {
		const itemObject = item || {};
		const references = [];
		const inReplyTo = [];
		let messageId = '';

		function collect(value, bucket) {
			if (!value) {
				return;
			}

			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i += 1) {
					collect(value[i], bucket);
				}
				return;
			}

			if (typeof value === 'string') {
				const matches = value.match(/<[^>]+>/g) || [];
				for (let i = 0; i < matches.length; i += 1) {
					bucket.push(matches[i]);
				}
			}
		}

		collect(itemObject.References, references);
		collect(itemObject.InReplyTo, inReplyTo);
		collect(itemObject.InReplyToId, inReplyTo);

		if (typeof itemObject.InternetMessageId === 'string' && itemObject.InternetMessageId.trim()) {
			messageId = itemObject.InternetMessageId.trim();
		}

		const internetHeaders = Array.isArray(itemObject.InternetMessageHeaders)
			? itemObject.InternetMessageHeaders
			: [];
		for (let i = 0; i < internetHeaders.length; i += 1) {
			const header = internetHeaders[i] || {};
			const name = String(header.Name || header.HeaderName || header.name || '').toLowerCase().trim();
			const value = String(header.Value || header.HeaderValue || header.value || '').trim();
			if (!name || !value) {
				continue;
			}

			if (name === 'message-id' && !messageId) {
				messageId = value;
			}

			if (name === 'references') {
				collect(value, references);
			}

			if (name === 'in-reply-to') {
				collect(value, inReplyTo);
			}
		}

		return {
			messageId: messageId,
			references: Array.from(new Set(references)),
			inReplyTo: Array.from(new Set(inReplyTo)),
		};
	}

	function extractOutlookCurrentEmail() {
		const readingPaneRoot = getOutlookReadingPaneRoot();
		const item = getOutlookStateItem();
		const rowData = getOutlookSelectedRowData();
		if (!readingPaneRoot && !item && !rowData) {
			return null;
		}

		const headerIds = extractOutlookHeaderIds(item);
		const fromMailbox = mailboxToAddress(item && (item.From || item.Sender)) || mailboxToAddress(rowData && rowData.lastSender) || null;
		const toRecipients = mailboxesToAddresses(item && item.ToRecipients);
		const ccRecipients = mailboxesToAddresses(item && item.CcRecipients);
		const bccRecipients = mailboxesToAddresses(item && item.BccRecipients);

		return {
			provider: 'outlook',
			subject: (item && (item.NormalizedSubject || item.Subject)) || extractOutlookSubjectFromDom(readingPaneRoot) || '',
			from: fromMailbox ? [fromMailbox] : [],
			to: toRecipients,
			cc: ccRecipients,
			bcc: bccRecipients,
			receivedAt: item && (item.DateTimeReceived || item.ReceivedTime || item.DateTimeCreated) || '',
			sentAt: item && (item.DateTimeSent || item.SentTime || '') || '',
			messageId: item && item.InternetMessageId ? [item.InternetMessageId] : (headerIds.messageId ? [headerIds.messageId] : []),
			references: headerIds.references,
			inReplyTo: headerIds.inReplyTo,
			itemId: (item && item.ItemId && item.ItemId.Id) || (rowData && rowData.latestItemId) || '',
			conversationId: (item && item.ConversationId && item.ConversationId.Id) || (rowData && rowData.conversationId) || '',
			bodyText: extractOutlookBodyText(readingPaneRoot),
		};
	}

	function extractFastmailCurrentEmail() {
		const fastMail = window.FastMail;
		if (!fastMail || typeof fastMail.getViewFromNode !== 'function') {
			return null;
		}

		const messageNode = document.querySelector('.v-MessageCard, .v-Message');
		if (!messageNode) {
			return null;
		}

		const view = fastMail.getViewFromNode(messageNode);
		const content = view && view.content;
		const bodyView = view && view._body;
		const message = bodyView && bodyView.message;
		if (!content) {
			return null;
		}

		const bodyParts = message && message.bodyParts ? message.bodyParts : {};
		const bodyValues = message && message.bodyValues ? message.bodyValues : {};
		const textBody = getBodyValue(bodyParts.text, bodyValues);
		const htmlBody = getBodyValue(bodyParts.html, bodyValues);
		const visibleBodyText = (
			messageNode.querySelector('.v-Message-body, [data-test-id="Message-body"]') || {}
		).innerText || '';
		const fallbackBodyValue = Object.keys(bodyValues).reduce(function (best, key) {
			if (best) {
				return best;
			}

			const entry = bodyValues[key];
			if (!entry || entry.isTruncated || typeof entry.value !== 'string' || !entry.value.trim()) {
				return '';
			}

			return entry.value;
		}, '');

		return {
			provider: 'fastmail',
			subject: getMessageValue(content, 'subject') || '',
			from: toArray(getMessageValue(content, 'from')),
			to: toArray(getMessageValue(content, 'to')),
			cc: toArray(getMessageValue(content, 'cc')),
			bcc: toArray(getMessageValue(content, 'bcc')),
			receivedAt: getMessageValue(content, 'receivedAt') || '',
			sentAt: getMessageValue(content, 'sentAt') || '',
			messageId: toArray(getMessageValue(content, 'messageId')),
			references: toArray(getMessageValue(content, 'references')),
			inReplyTo: toArray(getMessageValue(content, 'inReplyTo')),
			bodyText: firstNonEmptyString([
				textBody,
				htmlToText(htmlBody),
				htmlToText(fallbackBodyValue),
				visibleBodyText,
			]),
		};
	}

	function dispatchResponse(id, detail) {
		document.dispatchEvent(new CustomEvent('kumbukum:page-response:' + id, {
			detail,
		}));
	}

	document.addEventListener(REQUEST_EVENT, function (event) {
		const detail = event && event.detail ? event.detail : {};
		const requestId = detail.id;
		if (!requestId || !detail.type) {
			return;
		}

		try {
			if (detail.type === 'fastmail-current-email') {
				dispatchResponse(requestId, extractFastmailCurrentEmail());
				return;
			}

			if (detail.type === 'outlook-current-email') {
				dispatchResponse(requestId, extractOutlookCurrentEmail());
				return;
			}

			dispatchResponse(requestId, null);
		} catch (error) {
			dispatchResponse(requestId, {
				error: serializeError(error),
			});
		}
	});

	root.setAttribute('data-kumbukum-page-bridge', 'ready');
}());
