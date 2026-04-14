// Cross-browser compatible storage module
import browser from 'webextension-polyfill';

const setSetting = function (obj) {
	return browser.storage.sync.set(obj);
};

const getSetting = async function (key) {
	const result = await browser.storage.sync.get(key);
	return result[key] != null ? result[key] : null;
};

const getAllSettings = async function () {
	const items = await browser.storage.sync.get();
	return computeApiUrls(items);
};

const computeApiUrls = function (obj) {
	const base = (obj.instance_url || '').replace(/\/+$/, '');
	obj.instance_url = base;
	obj.token_test_url = `${base}/api/v1/counts`;
	obj.projects_url = `${base}/api/v1/projects`;
	obj.urls_create_url = `${base}/api/v1/urls`;
	obj.notes_create_url = `${base}/api/v1/notes`;
	obj.links_create_url = `${base}/api/v1/links`;
	return obj;
};

export { setSetting, getSetting, getAllSettings };
