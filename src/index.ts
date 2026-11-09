import { DurableObject } from 'cloudflare:workers';
import {
	authenticate,
	byteRange,
	depth,
	href,
	HttpError,
	localPath,
	methods,
	parent,
	pathOf,
	precondition,
	validPath,
	within,
} from './http';
import { blockedPaths, covers, evaluateIf, lockXml, timeout, type Lock } from './locks';
import { collectionAt, fileAt, Store, type Item } from './storage';
import {
	children,
	dav,
	davError,
	empty,
	escape,
	findRequest,
	isDav,
	multistatus,
	nameKey,
	patchRequest,
	propertyXml,
	propstat,
	readXml,
	response,
	xml,
	type Name,
} from './xml';

const supportedLock =
	'<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
	'<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>';
const liveNames = new Set([
	'resourcetype',
	'creationdate',
	'getcontentlanguage',
	'getcontentlength',
	'getcontenttype',
	'getetag',
	'getlastmodified',
	'supportedlock',
	'lockdiscovery',
]);
const supportedMethods = new Set(methods.split(', '));

function options(status: number): Response {
	return new Response(null, { status, headers: { Allow: methods, DAV: '1, 2' } });
}

function secure(result: Response, head: boolean): Response {
	const headers = new Headers(result.headers);
	headers.set('Cache-Control', 'private, no-store');
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Content-Security-Policy', "sandbox allow-downloads; default-src 'none'; base-uri 'none'");
	headers.set('Referrer-Policy', 'no-referrer');
	return new Response(head ? null : result.body, { status: result.status, headers, encodeBody: 'manual' });
}

function failure(error: unknown): Response {
	if (error instanceof HttpError)
		return new Response(error.message || null, { status: error.status, headers: error.headers });
	console.error('WebDAV operation failed', error instanceof Error ? error.name : 'UnknownError');
	return new Response('Internal Server Error', { status: 500 });
}

export default {
	async fetch(request, env): Promise<Response> {
		let result: Response;
		try {
			if (request.method === 'OPTIONS') result = options(200);
			else if (!env.USERNAME || !env.PASSWORD || env.USERNAME.includes(':'))
				result = new Response('WebDAV is not configured', { status: 503 });
			else if (!(await authenticate(request, env))) {
				result = new Response(null, {
					status: 401,
					headers: { 'WWW-Authenticate': 'Basic realm="WebDAV", charset="UTF-8"' },
				});
			} else if (!supportedMethods.has(request.method)) result = options(405);
			else result = await env.DAV.getByName('namespace').fetch(request);
		} catch (error) {
			result = failure(error);
		}
		return secure(result, request.method === 'HEAD');
	},
} satisfies ExportedHandler<Env>;

export class WebDAV extends DurableObject<Env> {
	private readonly store: Store;
	private queue = Promise.resolve();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.store = new Store(ctx.storage, env.BUCKET);
	}

	private serialize<T>(run: () => Promise<T>): Promise<T> {
		const current = this.queue.then(run);
		this.queue = current.then(
			() => {},
			() => {},
		);
		return current;
	}

	override fetch(request: Request): Promise<Response> {
		return this.serialize(async () => {
			try {
				const path = pathOf(new URL(request.url));
				await this.store.importExisting();
				return await this.dispatch(request, path);
			} catch (error) {
				return failure(error);
			}
		});
	}

	override alarm(): Promise<void> {
		return this.serialize(() => this.store.collectGarbage());
	}

	private requireParent(path: string): void {
		if (!this.store.get(parent(path))?.collection) throw new HttpError(409, 'Parent collection does not exist');
	}

	private async dispatch(request: Request, path: string): Promise<Response> {
		const { headers, method } = request;
		const item = this.store.get(path);
		if (!item && !['PUT', 'MKCOL', 'LOCK'].includes(method)) throw new HttpError(404);
		const status = precondition(request, item);
		if (status) return new Response(null, { status, headers: item ? validators(item) : undefined });
		const locks = this.store.locks();
		const submitted = evaluateIf(request, path, locks, (tag) => this.store.get(tag)?.etag ?? null);
		const check = (paths: string[], trees: string[] = []) => {
			const blocked = blockedPaths(locks, submitted, [...new Set(paths)]);
			if (!blocked.length) return;
			if (blocked.every((root) => trees.some((tree) => tree !== root && within(root, tree)))) {
				return multistatus(
					blocked.map((root) =>
						this.resourceStatus(root, '423 Locked', '<D:error><D:lock-token-submitted/></D:error>'),
					),
				);
			}
			return davError(423, 'lock-token-submitted', blocked);
		};
		const rootsUnder = (root: string) => locks.filter((lock) => within(lock.path, root)).map((lock) => lock.path);

		switch (method) {
			case 'GET':
			case 'HEAD':
				return this.read(request, item!);
			case 'PROPFIND':
				return this.find(request, item!, locks);
			case 'PROPPATCH':
				return check([path]) ?? this.patch(request, item!);
			case 'MKCOL': {
				if (item) return options(405);
				this.requireParent(path);
				const blocked = check([path, parent(path)]);
				if (blocked) return blocked;
				if (await hasBody(request)) throw new HttpError(415, 'MKCOL request bodies are unsupported');
				this.store.put(collectionAt(path));
				return new Response(null, { status: 201, headers: { Location: href(path, true) } });
			}
			case 'PUT': {
				if (item?.collection) return options(405);
				if (headers.has('Content-Range')) throw new HttpError(400, 'Partial PUT is unsupported');
				this.requireParent(path);
				const blocked = check(item ? [path] : [path, parent(path)]);
				if (blocked) return blocked;
				const object = await this.store.upload(request);
				this.ctx.storage.transactionSync(() => {
					if (item?.blob) this.store.retire(item.blob);
					this.store.put(fileAt(path, object, item?.created ?? undefined));
					this.store.commitUpload(object.key);
				});
				return new Response(null, { status: item ? 204 : 201, headers: { ETag: object.httpEtag } });
			}
			case 'DELETE': {
				if (!path) return options(405);
				depth(headers, 'infinity', ['infinity']);
				const affected = [path, parent(path), ...rootsUnder(path)];
				const blocked = check(affected, [path]);
				if (blocked) return blocked;
				const items = this.store.tree(item!, 'infinity');
				await this.armCleanup();
				this.ctx.storage.transactionSync(() => {
					for (const entry of items) this.store.remove(entry);
					for (const lock of locks) if (within(lock.path, path)) this.store.removeLock(lock.token);
				});
				return new Response(null, { status: 204 });
			}
			case 'COPY':
			case 'MOVE': {
				if (!path && method === 'MOVE') return options(405);
				const destination = headers.get('Destination');
				if (!destination) throw new HttpError(400, 'Destination is required');
				const target = localPath(destination, new URL(request.url));
				const levels = depth(headers, 'infinity', method === 'COPY' ? ['0', 'infinity'] : ['infinity']);
				if (!target || within(path, target) || (levels !== '0' && within(target, path))) {
					throw new HttpError(403, 'Source and destination overlap');
				}
				const existing = this.store.get(target);
				const overwrite = headers.get('Overwrite') ?? 'T';
				if (overwrite !== 'T' && overwrite !== 'F') throw new HttpError(400);
				if (existing && overwrite === 'F') throw new HttpError(412);
				this.requireParent(target);
				const affected = [target, parent(target), ...rootsUnder(target)];
				if (method === 'MOVE') affected.push(path, parent(path), ...rootsUnder(path));
				const blocked = check(affected, method === 'MOVE' ? [path, target] : [target]);
				return blocked ?? this.transfer(item!, target, existing, levels, method === 'MOVE', locks);
			}
			case 'LOCK':
				return this.lock(request, path, item, locks, submitted, check);
			case 'UNLOCK': {
				const token = /^<([^<>\s]+)>$/.exec(headers.get('Lock-Token') ?? '')?.[1];
				if (!token) throw new HttpError(400, 'Lock-Token is required');
				const lock = locks.find((lock) => lock.token === token && covers(lock, path));
				if (!lock) return davError(409, 'lock-token-matches-request-uri');
				this.store.removeLock(lock.token);
				return new Response(null, { status: 204 });
			}
			default:
				return options(405);
		}
	}

	private resourceStatus(path: string, status: string, detail = ''): string {
		return response(
			href(path, !!this.store.get(path)?.collection),
			'<D:status>HTTP/1.1 ' + status + '</D:status>' + detail,
		);
	}

	private async armCleanup(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
		}
	}

	private async transfer(
		source: Item,
		target: string,
		existing: Item | null,
		depth: string,
		move: boolean,
		locks: Lock[],
	): Promise<Response> {
		const items = this.store.tree(source, depth);
		const old = existing ? this.store.tree(existing, 'infinity') : [];
		const mapped = items.map((item) => ({ ...item, path: target + item.path.slice(source.path.length) }));
		const invalid = mapped.filter((item) => !validPath(item.path));
		if (invalid.length)
			return multistatus(
				invalid.map((item) =>
					response(href(item.path, !!item.collection), '<D:status>HTTP/1.1 414 URI Too Long</D:status>'),
				),
			);
		const targets = new Set(mapped.map((item) => item.path));
		if (old.length || move) await this.armCleanup();
		this.ctx.storage.transactionSync(() => {
			for (const item of old) this.store.remove(item);
			for (const [index, item] of mapped.entries()) {
				this.store.put({ ...item, created: move ? item.created : Date.now() });
				this.store.copyProperties(items[index].path, item.path);
			}
			if (move) for (const item of items) this.store.remove(item);
			for (const lock of locks) {
				if ((move && within(lock.path, source.path)) || (within(lock.path, target) && !targets.has(lock.path))) {
					this.store.removeLock(lock.token);
				}
			}
		});
		return new Response(null, {
			status: existing ? 204 : 201,
			headers: { Location: href(target, !!source.collection) },
		});
	}

	private async read(request: Request, item: Item): Promise<Response> {
		const headers = validators(item);
		const head = request.method === 'HEAD';
		if (item.collection) {
			headers.set('Content-Type', 'text/html; charset=utf-8');
			if (head) return new Response(null, { headers });
			const listing = this.store
				.tree(item, '1')
				.slice(1)
				.map(
					(child) =>
						'<li><a href="' +
						escape(href(child.path, !!child.collection)) +
						'">' +
						escape(child.path.split('/').at(-1)! + (child.collection ? '/' : '')) +
						'</a></li>',
				);
			if (item.path) listing.unshift('<li><a href="' + escape(href(parent(item.path), true)) + '">../</a></li>');
			return new Response(
				'<!doctype html><html><meta charset="utf-8"><title>WebDAV</title><h1>' +
					escape('/' + item.path) +
					'</h1><ul>' +
					listing.join('') +
					'</ul></html>',
				{ headers },
			);
		}
		const metadata: R2HTTPMetadata = JSON.parse(item.metadata);
		headers.set('Content-Type', metadata.contentType ?? 'application/octet-stream');
		if (metadata.contentLanguage) headers.set('Content-Language', metadata.contentLanguage);
		if (metadata.contentEncoding) headers.set('Content-Encoding', metadata.contentEncoding);
		headers.set(
			'Content-Disposition',
			"attachment; filename*=UTF-8''" +
				encodeURIComponent(item.path.split('/').at(-1)!).replace(
					/['()*]/g,
					(char) => '%' + char.charCodeAt(0).toString(16),
				),
		);
		headers.set('Accept-Ranges', 'bytes');
		const range = head ? undefined : byteRange(request.headers, item.size, item);
		headers.set('Content-Length', String(range?.length ?? item.size));
		if (range)
			headers.set('Content-Range', 'bytes ' + range.offset + '-' + (range.offset + range.length - 1) + '/' + item.size);
		if (head) return new Response(null, { headers });
		const object = await this.store.bucket.get(item.blob!, { range });
		if (!object || object.httpEtag !== item.etag) throw new HttpError(503, 'Indexed R2 object is missing or changed');
		return new Response(object.body, { status: range ? 206 : 200, headers, encodeBody: 'manual' });
	}

	private async find(request: Request, item: Item, locks: Lock[]): Promise<Response> {
		const level = depth(request.headers, 'infinity', ['0', '1', 'infinity']);
		const { mode, names } = findRequest(await readXml(request));
		let outputSize = 0;
		const result = this.store.tree(item, level).map((entry) => {
			const live = this.live(entry, locks);
			const properties = new Map<string, { name: Name; value: string }>();
			for (const [name, value] of Object.entries(live)) {
				if (value !== null) {
					const qualified = { ns: dav, name };
					properties.set(nameKey(qualified), {
						name: qualified,
						value: '<D:' + name + '>' + value + '</D:' + name + '>',
					});
				}
			}
			for (const { ns, name, value } of this.store.properties(entry.path)) {
				properties.set(nameKey({ ns, name }), { name: { ns, name }, value });
			}
			const wanted = new Map<string, Name>();
			if (mode !== 'selected') for (const [key, property] of properties) wanted.set(key, property.name);
			for (const name of names) wanted.set(nameKey(name), name);
			const found: string[] = [];
			const missing: string[] = [];
			for (const [key, name] of wanted) {
				const property = properties.get(key);
				if (property) found.push(mode === 'names' ? empty(name) : property.value);
				else missing.push(empty(name));
			}
			const result = response(
				href(entry.path, !!entry.collection),
				propstat(found, 200) + propstat(missing, 404) || '<D:status>HTTP/1.1 200 OK</D:status>',
			);
			outputSize += result.length;
			if (outputSize > 4 * 1024 * 1024) throw new HttpError(507, 'PROPFIND response exceeds the configured limit');
			return result;
		});
		return multistatus(result);
	}

	private live(item: Item, locks: Lock[]): Record<string, string | null> {
		const metadata: R2HTTPMetadata = JSON.parse(item.metadata);
		return {
			resourcetype: item.collection ? '<D:collection/>' : '',
			creationdate: item.created === null ? null : new Date(item.created).toISOString(),
			getcontentlanguage: metadata.contentLanguage ? escape(metadata.contentLanguage) : null,
			getcontentlength: item.collection ? null : String(item.size),
			getcontenttype: escape(
				item.collection ? 'text/html; charset=utf-8' : (metadata.contentType ?? 'application/octet-stream'),
			),
			getetag: item.etag ? escape(item.etag) : null,
			getlastmodified: item.modified === null ? null : new Date(item.modified).toUTCString(),
			supportedlock: supportedLock,
			lockdiscovery: locks
				.filter((lock) => covers(lock, item.path))
				.map((lock) => lockXml(lock, !!this.store.get(lock.path)?.collection))
				.join(''),
		};
	}

	private async patch(request: Request, item: Item): Promise<Response> {
		const updates = patchRequest(await readXml(request));
		const protectedNames = updates.filter(({ name }) => name.ns === dav && liveNames.has(name.name));
		const resource = href(item.path, !!item.collection);
		if (protectedNames.length) {
			const rejected = new Set(protectedNames.map(({ name }) => nameKey(name)));
			const failed = updates.filter(({ name }) => !rejected.has(nameKey(name))).map(({ name }) => empty(name));
			return multistatus([
				response(
					resource,
					propstat(
						protectedNames.map(({ name }) => empty(name)),
						403,
						'<D:error><D:cannot-modify-protected-property/></D:error>',
					) + propstat(failed, 424),
				),
			]);
		}
		this.ctx.storage.transactionSync(() => {
			for (const { name, value } of updates) this.store.setProperty(item.path, name, value);
			const properties = this.store.properties(item.path);
			if (properties.length > 128 || properties.reduce((size, { value }) => size + value.length, 0) > 128 * 1024) {
				throw new HttpError(507, 'Resource property quota exceeded');
			}
		});
		return multistatus([
			response(
				resource,
				propstat(
					updates.map(({ name }) => empty(name)),
					200,
				),
			),
		]);
	}

	private async lock(
		request: Request,
		path: string,
		item: Item | null,
		locks: Lock[],
		submitted: Map<string, Set<string>>,
		check: (paths: string[]) => Response | undefined,
	): Promise<Response> {
		const root = await readXml(request);
		const seconds = timeout(request.headers);
		const expires = Date.now() + seconds * 1000;
		if (!root) {
			const tokens = new Set([...submitted.values()].flatMap((set) => [...set]));
			if (!tokens || tokens.size !== 1) throw new HttpError(400, 'Refresh requires one lock token');
			const existing = locks.find((lock) => covers(lock, path) && tokens.has(lock.token));
			if (!existing) return davError(412, 'lock-token-matches-request-uri');
			const refreshed = { ...existing, expires };
			this.store.putLock(refreshed);
			return lockResponse(refreshed, !!this.store.get(existing.path)?.collection, 200, seconds);
		}
		if (!isDav(root, 'lockinfo')) throw new HttpError(400);
		const parts = children(root);
		const scopes = parts.filter((child) => isDav(child, 'lockscope'));
		const types = parts.filter((child) => isDav(child, 'locktype'));
		const owners = parts.filter((child) => isDav(child, 'owner'));
		const [scope] = scopes.flatMap(children);
		if (
			parts.length !== scopes.length + types.length + owners.length ||
			scopes.length !== 1 ||
			types.length !== 1 ||
			owners.length > 1 ||
			children(scopes[0]).length !== 1 ||
			children(types[0]).length !== 1 ||
			!(isDav(scope, 'shared') || isDav(scope, 'exclusive')) ||
			!isDav(children(types[0])[0], 'write')
		) {
			throw new HttpError(400, 'Invalid lockinfo');
		}
		const requestedDepth = depth(request.headers, 'infinity', ['0', 'infinity']) as Lock['depth'];
		const lock: Lock = {
			token: 'opaquelocktoken:' + crypto.randomUUID(),
			path,
			expires,
			depth: requestedDepth,
			scope: isDav(scope, 'shared') ? 'shared' : 'exclusive',
			owner: owners[0] ? propertyXml(owners[0]) : null,
		};
		if (lock.owner && lock.owner.length > 4096) throw new HttpError(413, 'Lock owner exceeds 4 KiB');
		const conflict = locks.filter(
			(other) =>
				(lock.scope === 'exclusive' || other.scope === 'exclusive') &&
				(covers(other, path) || covers(lock, other.path)),
		);
		if (conflict.some((other) => covers(other, path))) {
			return davError(
				423,
				'no-conflicting-lock',
				conflict.map((other) => other.path),
			);
		}
		if (conflict.length) {
			const paths = new Set(conflict.map((other) => other.path));
			return multistatus([
				this.resourceStatus(path, '424 Failed Dependency'),
				...[...paths].map((root) =>
					this.resourceStatus(root, '423 Locked', '<D:error><D:no-conflicting-lock/></D:error>'),
				),
			]);
		}
		if (locks.length >= 2048) throw new HttpError(507, 'Active lock limit exceeded');
		if (!item) {
			this.requireParent(path);
			// Creating an unmapped resource also changes its parent's membership.
			const blocked = check([parent(path)]);
			if (blocked) return blocked;
			const object = await this.store.upload(new Request(request.url, { method: 'PUT' }));
			this.ctx.storage.transactionSync(() => {
				this.store.put(fileAt(path, object));
				this.store.putLock(lock);
				this.store.commitUpload(object.key);
			});
		} else this.store.putLock(lock);
		return lockResponse(lock, !!item?.collection, item ? 200 : 201, seconds, true);
	}
}

async function hasBody(request: Request): Promise<boolean> {
	if (!request.body) return false;
	const reader = request.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (value.length) return true;
		}
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function validators(item: Item): Headers {
	const headers = new Headers();
	if (item.etag) headers.set('ETag', item.etag);
	if (item.modified !== null) headers.set('Last-Modified', new Date(item.modified).toUTCString());
	return headers;
}

function lockResponse(lock: Lock, collection: boolean, status: number, seconds: number, created = false): Response {
	const headers = new Headers({ Timeout: 'Second-' + seconds });
	if (created) headers.set('Lock-Token', '<' + lock.token + '>');
	return xml(
		'<D:prop xmlns:D="DAV:"><D:lockdiscovery>' + lockXml(lock, collection) + '</D:lockdiscovery></D:prop>',
		status,
		headers,
	);
}
