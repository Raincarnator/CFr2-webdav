export class HttpError extends Error {
	constructor(
		readonly status: number,
		message?: string,
		readonly headers?: HeadersInit,
	) {
		super(message);
	}
}

export const methods = 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, COPY, MOVE, LOCK, UNLOCK';
const encoder = new TextEncoder();

export function validPath(path: string): boolean {
	return (
		encoder.encode(path).length <= 1023 &&
		(path === '' ||
			path
				.split('/')
				.every(
					(segment) =>
						segment !== '' &&
						segment !== '.' &&
						segment !== '..' &&
						!/[\\\u0000-\u001f\u007f\ufffe\uffff]/u.test(segment),
				))
	);
}

export function pathOf(url: URL): string {
	let path: string;
	try {
		path = url.pathname
			.slice(1)
			.replace(/\/$/, '')
			.split('/')
			.map((segment) => {
				const decoded = decodeURIComponent(segment);
				if (decoded.includes('/')) throw new Error();
				return decoded;
			})
			.join('/');
	} catch {
		throw new HttpError(400, 'Invalid path encoding');
	}
	if (!validPath(path) || url.pathname === '//') throw new HttpError(400, 'Invalid resource path');
	return path;
}

export function localPath(value: string, base: URL): string {
	let url: URL;
	try {
		if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) throw new Error();
		url = new URL(value, base);
	} catch {
		throw new HttpError(400, 'Invalid resource URI');
	}
	if (url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Invalid resource URI');
	if (url.origin !== base.origin) throw new HttpError(502, 'Cross-origin destination or resource tag');
	return pathOf(url);
}

export function href(path: string, collection = false): string {
	return '/' + path.split('/').map(encodeURIComponent).join('/') + (path && collection ? '/' : '');
}

export function parent(path: string): string {
	return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

export function within(path: string, root: string): boolean {
	return path === root || root === '' || path.startsWith(root + '/');
}

export function depth(headers: Headers, fallback: string, allowed: string[]): string {
	const value = headers.get('Depth') ?? fallback;
	if (!allowed.includes(value)) throw new HttpError(400, 'Invalid Depth header');
	return value;
}

export async function authenticate(request: Request, env: Env): Promise<boolean> {
	const match = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(request.headers.get('Authorization') ?? '');
	if (!match || match[1].length > 8192) return false;
	let supplied: string;
	try {
		supplied = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0)),
		);
	} catch {
		return false;
	}
	const [expected, actual] = await Promise.all(
		[env.USERNAME + ':' + env.PASSWORD, supplied].map((value) =>
			crypto.subtle.digest('SHA-256', encoder.encode(value)),
		),
	);
	return crypto.subtle.timingSafeEqual(expected, actual);
}

export type Validators = { etag: string | null; modified: number | null };

function etags(value: string): string[] {
	return value.match(/(?:W\/)?"[^"]*"/g) ?? [];
}

export function precondition(request: Request, item: Validators | null): number | undefined {
	const { headers, method } = request;
	const read = method === 'GET' || method === 'HEAD';
	const etag = item?.etag ?? null;
	const modified =
		item?.modified === null || item?.modified === undefined ? null : Math.floor(item.modified / 1000) * 1000;
	const ifMatch = headers.get('If-Match');
	const ifNoneMatch = headers.get('If-None-Match');
	const unmodified = Date.parse(headers.get('If-Unmodified-Since') ?? '');
	const since = Date.parse(headers.get('If-Modified-Since') ?? '');
	if (ifMatch !== null) {
		if (!item || (ifMatch !== '*' && (!etag || !etags(ifMatch).includes(etag)))) return 412;
	} else if (modified !== null && modified > unmodified) {
		return 412;
	}
	if (ifNoneMatch !== null) {
		if (item && (ifNoneMatch === '*' || (etag && etags(ifNoneMatch).some((tag) => tag.replace(/^W\//, '') === etag)))) {
			return read ? 304 : 412;
		}
	} else if (read && modified !== null && modified <= since) {
		return 304;
	}
}

export function byteRange(
	headers: Headers,
	size: number,
	item: Validators,
): { offset: number; length: number } | undefined {
	const range = headers.get('Range');
	const ifRange = headers.get('If-Range');
	if (!range) return;
	if (
		ifRange &&
		ifRange !== item.etag &&
		(item.modified === null || Date.parse(ifRange) !== Math.floor(item.modified / 1000) * 1000)
	)
		return;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
	if (!match || (!match[1] && !match[2])) return;
	const offset = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
	const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
	if (offset >= size || end < offset) throw new HttpError(416, undefined, { 'Content-Range': 'bytes */' + size });
	return { offset, length: end - offset + 1 };
}
