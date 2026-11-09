import { HttpError, parent, validPath } from './http';
import type { Lock } from './locks';
import type { Name } from './xml';

export type Item = {
	path: string;
	collection: number;
	blob: string | null;
	size: number;
	etag: string | null;
	created: number | null;
	modified: number | null;
	metadata: string;
};

type DeadProperty = Name & { value: string };
const privatePrefix = '/.webdav/';
const retention = 60 * 60 * 1000;
const treeLimit = 10_000;

export class Store {
	readonly sql: SqlStorage;

	constructor(
		readonly state: DurableObjectStorage,
		readonly bucket: R2Bucket,
	) {
		this.sql = state.sql;
		this.sql.exec(`
      CREATE TABLE IF NOT EXISTS items (
        path TEXT PRIMARY KEY, parent TEXT, collection INTEGER NOT NULL, blob TEXT, size INTEGER NOT NULL,
        etag TEXT, created INTEGER, modified INTEGER, metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS children ON items(parent, path);
      CREATE INDEX IF NOT EXISTS blobs ON items(blob);
      CREATE TABLE IF NOT EXISTS properties (
        path TEXT NOT NULL REFERENCES items(path) ON DELETE CASCADE, ns TEXT NOT NULL,
        name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(path, ns, name)
      );
      CREATE TABLE IF NOT EXISTS locks (
        token TEXT PRIMARY KEY, path TEXT NOT NULL, depth TEXT NOT NULL, scope TEXT NOT NULL,
        owner TEXT, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lock_expiry ON locks(expires);
      CREATE TABLE IF NOT EXISTS garbage (blob TEXT PRIMARY KEY, after INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS garbage_due ON garbage(after);
      CREATE TABLE IF NOT EXISTS import_state (id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT);
      INSERT OR IGNORE INTO items VALUES ('', NULL, 1, NULL, 0, NULL, NULL, NULL, '{}');
    `);
	}

	async importExisting(): Promise<void> {
		try {
			await this.indexExisting();
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) {
				// The namespace is still offline. A corrected bucket can be indexed from scratch.
				this.state.transactionSync(() => {
					this.sql.exec("DELETE FROM items WHERE path <> ''");
					this.sql.exec('DELETE FROM import_state');
				});
			}
			throw error;
		}
	}

	private async indexExisting(): Promise<void> {
		const progress = this.sql
			.exec<{ cursor: string | null }>('SELECT cursor FROM import_state WHERE id = 1')
			.toArray()[0];
		if (progress?.cursor === null) return;
		let cursor = progress?.cursor ?? undefined;
		for (let page = 0; page < 4; page++) {
			const batch = await this.bucket.list({ cursor, limit: 250, include: ['httpMetadata'] });
			this.state.transactionSync(() => {
				for (const object of batch.objects) {
					if (object.key.startsWith(privatePrefix)) continue;
					const path = object.key.replace(/\/$/, '');
					if (!path || !validPath(path)) continue;
					const collection = Number(path !== object.key);
					const previous = this.get(path);
					if (previous && previous.collection !== collection) {
						throw new HttpError(409, 'R2 contains a file and collection at the same WebDAV path');
					}
					for (let ancestor = parent(path); ancestor; ancestor = parent(ancestor)) {
						const existing = this.get(ancestor);
						if (existing) {
							if (!existing.collection) throw new HttpError(409, 'R2 contains files below a WebDAV file');
							break;
						}
						this.put(collectionAt(ancestor, null));
					}
					this.put({
						path,
						collection,
						blob: object.key,
						size: collection ? 0 : object.size,
						etag: collection ? null : object.httpEtag,
						created: object.uploaded.getTime(),
						modified: collection ? null : object.uploaded.getTime(),
						metadata: JSON.stringify(object.httpMetadata ?? {}),
					});
				}
				this.sql.exec('INSERT OR REPLACE INTO import_state VALUES (1, ?)', batch.truncated ? batch.cursor : null);
			});
			if (!batch.truncated) return;
			cursor = batch.cursor;
		}
		throw new HttpError(503, 'R2 indexing in progress', { 'Retry-After': '1' });
	}

	get(path: string): Item | null {
		return this.sql.exec<Item>('SELECT * FROM items WHERE path = ?', path).toArray()[0] ?? null;
	}

	tree(root: Item, depth: string): Item[] {
		if (depth === '0' || !root.collection) return [root];
		let descendants: Iterable<Item>;
		if (depth === '1') {
			descendants = this.sql.exec<Item>(
				'SELECT * FROM items WHERE parent = ? ORDER BY path LIMIT ?',
				root.path,
				treeLimit,
			);
		} else if (!root.path) {
			descendants = this.sql.exec<Item>("SELECT * FROM items WHERE path > '' ORDER BY path LIMIT ?", treeLimit);
		} else {
			descendants = this.sql.exec<Item>(
				'SELECT * FROM items WHERE path >= ? AND path < ? ORDER BY path LIMIT ?',
				root.path + '/',
				root.path + '0',
				treeLimit,
			);
		}
		const items = Array.from(descendants);
		if (items.length >= treeLimit) throw new HttpError(507, 'WebDAV operation exceeds the 10,000-resource limit');
		return [root, ...items];
	}

	put(item: Item): void {
		this.sql.exec(
			`
      INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET collection=excluded.collection, blob=excluded.blob,
        size=excluded.size, etag=excluded.etag, created=excluded.created, modified=excluded.modified, metadata=excluded.metadata
    `,
			item.path,
			parent(item.path),
			item.collection,
			item.blob,
			item.size,
			item.etag,
			item.created,
			item.modified,
			item.metadata,
		);
	}

	remove(item: Item): void {
		this.sql.exec('DELETE FROM items WHERE path = ?', item.path);
		if (item.blob) this.retire(item.blob);
	}

	properties(path: string): DeadProperty[] {
		return this.sql
			.exec<DeadProperty>('SELECT ns, name, value FROM properties WHERE path = ? ORDER BY ns, name', path)
			.toArray();
	}

	setProperty(path: string, name: Name, value: string | null): void {
		if (value === null) {
			this.sql.exec('DELETE FROM properties WHERE path = ? AND ns = ? AND name = ?', path, name.ns, name.name);
		} else {
			this.sql.exec('INSERT OR REPLACE INTO properties VALUES (?, ?, ?, ?)', path, name.ns, name.name, value);
		}
	}

	copyProperties(source: string, destination: string): void {
		this.sql.exec(
			'INSERT INTO properties SELECT ?, ns, name, value FROM properties WHERE path = ?',
			destination,
			source,
		);
	}

	locks(): Lock[] {
		this.sql.exec('DELETE FROM locks WHERE expires <= ?', Date.now());
		return this.sql.exec<Lock>('SELECT * FROM locks').toArray();
	}

	putLock(lock: Lock): void {
		this.sql.exec(
			'INSERT OR REPLACE INTO locks VALUES (?, ?, ?, ?, ?, ?)',
			lock.token,
			lock.path,
			lock.depth,
			lock.scope,
			lock.owner,
			lock.expires,
		);
	}

	removeLock(token: string): void {
		this.sql.exec('DELETE FROM locks WHERE token = ?', token);
	}

	retire(blob: string): void {
		this.sql.exec('INSERT OR REPLACE INTO garbage VALUES (?, ?)', blob, Date.now() + retention);
	}

	async scheduleGarbage(): Promise<void> {
		const next = this.sql.exec<{ after: number }>('SELECT after FROM garbage ORDER BY after LIMIT 1').toArray()[0];
		if (!next) return;
		const alarm = await this.state.getAlarm();
		if (alarm === null || alarm > next.after) await this.state.setAlarm(Math.max(Date.now() + 1000, next.after));
	}

	async collectGarbage(): Promise<void> {
		const due = this.sql
			.exec<{ blob: string }>('SELECT blob FROM garbage WHERE after <= ? ORDER BY after LIMIT 128', Date.now())
			.toArray();
		const unused = due.filter(
			({ blob }) => !this.sql.exec('SELECT 1 FROM items WHERE blob = ? LIMIT 1', blob).toArray().length,
		);
		if (unused.length) await this.bucket.delete(unused.map(({ blob }) => blob));
		this.state.transactionSync(() => {
			for (const { blob } of due) this.sql.exec('DELETE FROM garbage WHERE blob = ?', blob);
		});
		await this.scheduleGarbage();
	}

	commitUpload(blob: string): void {
		this.sql.exec('DELETE FROM garbage WHERE blob = ?', blob);
	}

	async upload(request: Request): Promise<R2Object> {
		const key = privatePrefix + crypto.randomUUID();
		this.retire(key);
		await this.scheduleGarbage();
		const httpMetadata = Object.fromEntries(
			Object.entries({
				contentType: request.headers.get('Content-Type') ?? 'application/octet-stream',
				contentLanguage: request.headers.get('Content-Language'),
				contentEncoding: request.headers.get('Content-Encoding'),
			}).filter(([, value]) => value !== null),
		);
		if (!request.body) return this.bucket.put(key, new Uint8Array(), { httpMetadata });
		const length = request.headers.get('Content-Length');
		if (length !== null) {
			const bytes = Number(length);
			if (!/^\d+$/.test(length) || !Number.isSafeInteger(bytes)) throw new HttpError(400);
			const stream = new FixedLengthStream(bytes);
			const writing = request.body.pipeTo(stream.writable);
			const uploading = this.bucket.put(key, stream.readable, { httpMetadata });
			try {
				const [object] = await Promise.all([uploading, writing]);
				return object;
			} catch (error) {
				await Promise.allSettled([stream.readable.cancel(), writing]);
				throw error;
			}
		}
		return uploadMultipart(this.bucket, key, request.body, httpMetadata);
	}
}

export function collectionAt(path: string, created: number | null = Date.now()): Item {
	return { path, collection: 1, blob: null, size: 0, etag: null, created, modified: null, metadata: '{}' };
}

export function fileAt(path: string, object: R2Object, created: number = object.uploaded.getTime()): Item {
	return {
		path,
		collection: 0,
		blob: object.key,
		size: object.size,
		etag: object.httpEtag,
		created,
		modified: object.uploaded.getTime(),
		metadata: JSON.stringify(object.httpMetadata ?? {}),
	};
}

async function uploadMultipart(
	bucket: R2Bucket,
	key: string,
	stream: ReadableStream<Uint8Array>,
	httpMetadata: R2HTTPMetadata,
): Promise<R2Object> {
	const partSize = 8 * 1024 * 1024;
	const buffer = new Uint8Array(partSize);
	const parts: R2UploadedPart[] = [];
	const reader = stream.getReader();
	let upload: R2MultipartUpload | undefined;
	let used = 0;
	let total = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > 512 * 1024 * 1024) throw new HttpError(413, 'Upload exceeds 512 MiB');
			for (let offset = 0; offset < value.length;) {
				const length = Math.min(partSize - used, value.length - offset);
				buffer.set(value.subarray(offset, offset + length), used);
				offset += length;
				used += length;
				if (used === partSize) {
					upload ??= await bucket.createMultipartUpload(key, { httpMetadata });
					parts.push(await upload.uploadPart(parts.length + 1, buffer));
					used = 0;
				}
			}
		}
		if (!upload) return await bucket.put(key, buffer.subarray(0, used), { httpMetadata });
		if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
		return await upload.complete(parts);
	} catch (error) {
		void reader.cancel().catch(() => {});
		await upload?.abort().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}
