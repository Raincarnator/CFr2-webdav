import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Readable } from 'node:stream';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { DOMParser } from '@xmldom/xmldom';
import { unstable_readConfig } from 'wrangler';

const { compatibility_date: compatibilityDate } = unstable_readConfig({ config: 'wrangler.jsonc' });
const username = 'tester';
const password = '測試:password';
const credentials = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
const lockBody = (scope = 'exclusive') =>
	'<lockinfo xmlns="DAV:"><lockscope><' +
	scope +
	'/></lockscope><locktype><write/></locktype>' +
	'<owner><href>urn:test</href></owner></lockinfo>';
let worker;
let origin;

before(async () => {
	worker = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			scriptPath: 'dist/index.js',
			compatibilityDate,
			bindings: { USERNAME: username, PASSWORD: password },
			durableObjects: { DAV: { className: 'WebDAV', useSQLite: true } },
			r2Buckets: ['BUCKET'],
			port: 0,
		}),
	);
	origin = (await worker.ready).origin;
	const bucket = await worker.getR2Bucket('BUCKET');
	await bucket.put('legacy/folder/', '');
	await bucket.put('legacy/folder/existing.txt', 'old', { httpMetadata: { contentType: 'text/plain' } });
	await bucket.put('legacy/implicit/file', 'implicit');
});
after(async () => worker?.dispose());

async function request(method, path, status, { headers = {}, body, auth = credentials } = {}) {
	const result = await fetch(origin + path, {
		method,
		headers: { ...(auth ? { Authorization: auth } : {}), ...headers },
		body,
		...(body instanceof Readable ? { duplex: 'half' } : {}),
	});
	const data = Buffer.from(await result.arrayBuffer());
	assert.equal(result.status, status, method + ' ' + path + ' returned ' + data.toString().slice(0, 400));
	return { headers: result.headers, text: data.toString(), data };
}

function parse(text) {
	return new DOMParser({ onError: (_, message) => assert.fail(message) }).parseFromString(text, 'application/xml');
}

function hrefs(text) {
	return Array.from(parse(text).getElementsByTagNameNS('DAV:', 'href'), (item) => item.textContent);
}

test('auth, DAV capability discovery, and legacy collection markers', async () => {
	const { headers } = await request('OPTIONS', '/', 200, { auth: null });
	assert.equal(headers.get('dav'), '1, 2');
	assert.match(headers.get('allow'), /PROPPATCH/);
	assert.match((await request('GET', '/', 401, { auth: 'Basic invalid' })).headers.get('www-authenticate'), /Basic/);
	assert.equal((await request('GET', '/legacy/folder/existing.txt', 200)).text, 'old');
	const root = await request('PROPFIND', '/', 207, { headers: { Depth: '0' } });
	assert.deepEqual(hrefs(root.text), ['/']);
	const level1 = await request('PROPFIND', '/legacy', 207, { headers: { Depth: '1' } });
	assert.deepEqual(hrefs(level1.text), ['/legacy/', '/legacy/folder/', '/legacy/implicit/']);
	const deep = await request('PROPFIND', '/legacy', 207);
	assert.deepEqual(hrefs(deep.text), [
		'/legacy/',
		'/legacy/folder/',
		'/legacy/folder/existing.txt',
		'/legacy/implicit/',
		'/legacy/implicit/file',
	]);
});

test('HTTP validators, ranges, normalized hrefs, and safe file delivery', async () => {
	await request('MKCOL', '/missing/nested', 409);
	await request('MKCOL', '/io', 415, { body: 'unsupported' });
	await request('MKCOL', '/io', 201);
	const file = '/io/%E6%B5%8B%E8%AF%95%20%26%3Cscript%3E%252F';
	const created = await request('PUT', file, 201, { body: '0123456789', headers: { 'Content-Type': 'text/html' } });
	const etag = created.headers.get('etag');
	assert.match(etag, /^".+"$/);
	const found = await request('PROPFIND', '/io/', 207, { headers: { Depth: '1' } });
	assert.deepEqual(hrefs(found.text), ['/io/', file]);
	const browser = await request('GET', '/io/', 200);
	assert.match(browser.text, /&lt;script&gt;/);
	const read = await request('GET', file, 206, { headers: { Range: 'bytes=2-5' } });
	assert.equal(read.text, '2345');
	assert.equal(read.headers.get('content-range'), 'bytes 2-5/10');
	assert.match(read.headers.get('content-disposition'), /^attachment/);
	assert.match(read.headers.get('content-security-policy'), /sandbox/);
	assert.equal((await request('GET', file, 206, { headers: { Range: 'bytes=-2' } })).text, '89');
	await request('GET', file, 200, { headers: { Range: 'bytes=2-5', 'If-Range': '"bad"' } });
	assert.equal(
		(await request('GET', file, 416, { headers: { Range: 'bytes=10-' } })).headers.get('content-range'),
		'bytes */10',
	);
	const head = await request('HEAD', file, 200);
	assert.equal(head.headers.get('content-length'), '10');
	assert.equal(head.text, '');
	await request('GET', file, 304, { headers: { 'If-None-Match': 'W/' + etag } });
	await request('PUT', file, 412, { headers: { 'If-None-Match': '*' }, body: 'rejected' });
	await request('PUT', file, 204, { headers: { 'If-Match': etag }, body: 'replacement' });
	await request('GET', '/io/a%2fb', 400);
	await request('GET', '/io/a%5cb', 400);
});

test('streams a chunked multipart upload and guards concurrent conditional writes', async () => {
	const block = Buffer.alloc(1024 * 1024, 'a');
	const parts = Array.from({ length: 9 }, () => block);
	await request('PUT', '/stream', 201, { body: Readable.from(parts) });
	const result = await request('GET', '/stream', 206, { headers: { Range: 'bytes=-2' } });
	assert.equal(result.headers.get('content-range'), 'bytes 9437182-9437183/9437184');
	assert.equal(result.text, 'aa');
	const options = { method: 'PUT', headers: { Authorization: credentials, 'If-None-Match': '*' }, body: 'value' };
	const responses = await Promise.all([fetch(origin + '/race', options), fetch(origin + '/race', options)]);
	assert.deepEqual(responses.map((item) => item.status).sort(), [201, 412]);
	await Promise.all(responses.map((item) => item.arrayBuffer()));
});

test('qualified dead properties, atomic PROPPATCH, protected properties, and XML rejection', async () => {
	await request('PUT', '/props', 201, { body: 'file' });
	const update =
		'<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test" xmlns:Y="urn:value"><D:set><D:prop>' +
		'<X:label><Y:node code="Y:name">&amp;</Y:node></X:label></D:prop></D:set></D:propertyupdate>';
	assert.match((await request('PROPPATCH', '/props', 207, { body: update })).text, /200 OK/);
	const invalid =
		'<propertyupdate xmlns="DAV:" xmlns:X="urn:test"><set><prop><X:label>changed</X:label>' +
		'<getetag>ignored</getetag></prop></set></propertyupdate>';
	const failed = await request('PROPPATCH', '/props', 207, { body: invalid });
	assert.match(failed.text, /403 Forbidden/);
	assert.match(failed.text, /424 Failed Dependency/);
	const selection = '<propfind xmlns="DAV:" xmlns:X="urn:test"><prop><X:label/><X:absent/></prop></propfind>';
	const found = await request('PROPFIND', '/props', 207, { body: selection, headers: { Depth: '0' } });
	assert.match(found.text, /404 Not Found/);
	assert.equal(parse(found.text).getElementsByTagNameNS('urn:value', 'node')[0].textContent, '&');
	const names = await request('PROPFIND', '/props', 207, { body: '<propfind xmlns="DAV:"><propname/></propfind>' });
	assert.equal(parse(names.text).getElementsByTagNameNS('urn:test', 'label')[0].textContent, '');
	await request('PROPFIND', '/props', 400, { body: '<!DOCTYPE x [<!ENTITY a "unsafe">]><propfind xmlns="DAV:"/>' });
	await request('PROPFIND', '/props', 400, { body: '<D:propfind><D:allprop/></D:propfind>' });
	await request('PROPPATCH', '/props', 207, {
		body: Buffer.from(
			'\ufeff<?xml version="1.0" encoding="UTF-16"?><propertyupdate xmlns="DAV:"><set><prop>' +
				'<displayname>中文名稱</displayname></prop></set></propertyupdate>',
			'utf16le',
		),
	});
	const display = parse((await request('PROPFIND', '/props', 207)).text);
	assert.equal(display.getElementsByTagNameNS('DAV:', 'displayname')[0].textContent, '中文名稱');
	await request('PROPPATCH', '/props', 207, {
		body: '<propertyupdate xmlns="DAV:"><remove><prop><label xmlns="urn:test"/></prop></remove></propertyupdate>',
	});
	assert.equal(
		parse((await request('PROPFIND', '/props', 207)).text).getElementsByTagNameNS('urn:test', 'label').length,
		0,
	);
});

test('depth, overwrite, destination validation, and recursive collection transactions', async () => {
	await request('MKCOL', '/source', 201);
	await request('MKCOL', '/source/sub', 201);
	await request('PUT', '/source/sub/file', 201, { body: 'shared blob' });
	await request('PROPPATCH', '/source/sub/file', 207, {
		body: '<propertyupdate xmlns="DAV:"><set><prop><label xmlns="urn:test">value</label></prop></set></propertyupdate>',
	});
	await request('COPY', '/source/', 201, { headers: { Destination: '/source/snapshot', Depth: '0' } });
	await request('GET', '/source/snapshot/sub', 404);
	await request('DELETE', '/source/snapshot', 204);
	await request('COPY', '/source/', 201, { headers: { Destination: '/shallow', Depth: '0' } });
	await request('GET', '/shallow/sub', 404);
	await request('COPY', '/source/', 412, { headers: { Destination: '/shallow', Overwrite: 'F' } });
	await request('COPY', '/source/', 502, { headers: { Destination: 'https://example.com/foreign' } });
	await request('MOVE', '/source', 403, { headers: { Destination: '/source/sub/loop' } });
	await request('MOVE', '/source/', 204, { headers: { Destination: '/shallow', Overwrite: 'T' } });
	await request('PROPFIND', '/source', 404);
	assert.match((await request('PROPFIND', '/shallow/sub/file', 207)).text, /value/);
	await request('COPY', '/shallow', 201, { headers: { Destination: '/copy' } });
	await request('DELETE', '/shallow', 204);
	assert.equal((await request('GET', '/copy/sub/file', 200)).text, 'shared blob');
	await request('DELETE', '/copy', 204);
	await request('MKCOL', '/copy', 201);
	await request('GET', '/copy/sub/file', 404);
});

test('exclusive and shared locks, depth, refresh, conditional writes, and LOCK creation', async () => {
	await request('MKCOL', '/locked', 201);
	await request('PUT', '/locked/child', 201, { body: 'before lock' });
	const lock = await request('LOCK', '/locked', 200, { body: lockBody() });
	const token = lock.headers.get('lock-token');
	assert.match(token, /^<opaquelocktoken:/);
	await request('LOCK', '/locked/child', 423, { body: lockBody() });
	await request('PUT', '/locked/child', 423, { body: 'no token' });
	await request('PUT', '/locked/child', 412, { body: 'bad token', headers: { If: '(<opaquelocktoken:missing>)' } });
	await request('PUT', '/locked/child', 204, { body: 'with token', headers: { If: '(' + token + ')' } });
	const refresh = await request('LOCK', '/locked', 200, { headers: { If: '(' + token + ')', Timeout: 'Second-120' } });
	assert.equal(refresh.headers.get('timeout'), 'Second-120');
	await request('DELETE', '/locked', 423);
	await request('UNLOCK', '/locked/child', 204, { headers: { 'Lock-Token': token } });
	const first = await request('LOCK', '/locked/child', 200, { body: lockBody('shared'), headers: { Depth: '0' } });
	const second = await request('LOCK', '/locked/child', 200, { body: lockBody('shared'), headers: { Depth: '0' } });
	assert.notEqual(first.headers.get('lock-token'), second.headers.get('lock-token'));
	await request('PUT', '/locked/child', 204, {
		body: 'shared update',
		headers: { If: '(' + second.headers.get('lock-token') + ')' },
	});
	const conflict = await request('LOCK', '/locked', 207, { body: lockBody() });
	assert.match(conflict.text, /424 Failed Dependency/);
	assert.deepEqual(hrefs(conflict.text), ['/locked/', '/locked/child']);
	const denied = await request('DELETE', '/locked', 207);
	assert.deepEqual(hrefs(denied.text), ['/locked/child']);
	await request('GET', '/locked/child', 200);
	await request('DELETE', '/locked', 204, {
		headers: { If: '</locked/child> (' + first.headers.get('lock-token') + ')' },
	});
	const empty = await request('LOCK', '/newly-locked', 201, { body: lockBody() });
	await request('GET', '/newly-locked', 200);
	await request('UNLOCK', '/newly-locked', 204, { headers: { 'Lock-Token': empty.headers.get('lock-token') } });
	assert.equal((await request('GET', '/newly-locked', 200)).text, '');
	await request('LOCK', '/newly-locked', 200, { body: lockBody(), headers: { Timeout: 'Second-1' } });
	await new Promise((resolve) => setTimeout(resolve, 1100));
	await request('PUT', '/newly-locked', 204, { body: 'expired lock no longer applies' });
});
