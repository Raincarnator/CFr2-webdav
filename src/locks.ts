import { HttpError, href, localPath, within } from './http';
import { escape } from './xml';

export type Lock = {
	token: string;
	path: string;
	depth: '0' | 'infinity';
	scope: 'exclusive' | 'shared';
	owner: string | null;
	expires: number;
};

export function covers(lock: Lock, path: string): boolean {
	return lock.path === path || (lock.depth === 'infinity' && within(path, lock.path));
}

export function lockXml(lock: Lock, collection: boolean): string {
	const seconds = Math.max(0, Math.ceil((lock.expires - Date.now()) / 1000));
	return (
		'<D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:' +
		lock.scope +
		'/></D:lockscope><D:depth>' +
		lock.depth +
		'</D:depth>' +
		(lock.owner ?? '') +
		'<D:timeout>Second-' +
		seconds +
		'</D:timeout><D:locktoken><D:href>' +
		lock.token +
		'</D:href></D:locktoken><D:lockroot><D:href>' +
		escape(href(lock.path, collection)) +
		'</D:href></D:lockroot></D:activelock>'
	);
}

export function timeout(headers: Headers): number {
	for (const value of (headers.get('Timeout') ?? '').split(',')) {
		const seconds = /^Second-(\d+)$/i.exec(value.trim());
		if (seconds) return Math.max(1, Math.min(3600, Number(seconds[1])));
		if (value.trim().toLowerCase() === 'infinite') break;
	}
	return 3600;
}

type Condition = { type: 'token' | 'etag'; value: string; negated: boolean };
type Submitted = Map<string, Set<string>>;

export function evaluateIf(
	request: Request,
	path: string,
	locks: Lock[],
	etagAt: (path: string) => string | null,
): Submitted {
	const header = request.headers.get('If');
	const submitted: Submitted = new Map();
	if (header === null) return submitted;
	if (header.length > 16384) throw new HttpError(431);
	let rest = header.trim();
	const take = (expression: RegExp) => {
		const match = expression.exec(rest);
		if (match) rest = rest.slice(match[0].length).trimStart();
		return match;
	};

	const groups = new Map<string, Condition[][]>();
	const tagged = rest.startsWith('<');
	do {
		let resource = path;
		if (tagged) {
			const tag = take(/^<([^<>\s]+)>/);
			if (!tag) throw new HttpError(400, 'Invalid If resource tag');
			resource = localPath(tag[1], new URL(request.url));
		}
		const lists = groups.get(resource) ?? [];
		if (!rest.startsWith('(')) throw new HttpError(400, 'Expected an If condition list');
		while (take(/^\(/)) {
			const list: Condition[] = [];
			while (!take(/^\)/)) {
				const negated = !!take(/^Not(?=\s|[<\[])/);
				const token = take(/^<([^<>\s]+)>/);
				const etag = token ? null : take(/^\[((?:W\/)?"[^"]*")\]/);
				if (!token && !etag) throw new HttpError(400, 'Invalid If condition');
				list.push({ type: token ? 'token' : 'etag', value: (token ?? etag)![1], negated });
			}
			if (!list.length) throw new HttpError(400, 'Empty If condition list');
			lists.push(list);
		}
		groups.set(resource, lists);
		if (!tagged && rest) throw new HttpError(400, 'Unexpected If resource tag');
	} while (rest);

	let matched = false;
	for (const [resource, lists] of groups) {
		const tokens = new Set(locks.filter((lock) => covers(lock, resource)).map((lock) => lock.token));
		const etag = etagAt(resource);
		const matching = lists.filter((list) =>
			list.every(({ type, value, negated }) => {
				const matches = type === 'token' ? tokens.has(value) : value.replace(/^W\//, '') === etag;
				return negated ? !matches : matches;
			}),
		);
		matched ||= matching.length > 0;
		submitted.set(
			resource,
			new Set(
				lists.flatMap((list) =>
					list.filter(({ type, negated }) => type === 'token' && !negated).map(({ value }) => value),
				),
			),
		);
	}
	if (!matched) throw new HttpError(412);
	return submitted;
}

export function blockedPaths(locks: Lock[], submitted: Submitted, affected: string[]): string[] {
	const tokens = new Set([...submitted.values()].flatMap((set) => [...set]));
	const blocked = new Set<string>();
	for (const path of affected) {
		const required = new Map<string, boolean>();
		for (const lock of locks) {
			if (covers(lock, path)) required.set(lock.path, !!required.get(lock.path) || tokens.has(lock.token));
		}
		for (const [root, authorized] of required) {
			if (!authorized) blocked.add(root);
		}
	}
	return [...blocked];
}
