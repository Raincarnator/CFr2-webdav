import { DOMParser, XMLSerializer, type Element } from '@xmldom/xmldom';
import { HttpError, href } from './http';

export const dav = 'DAV:';
const xmlHeader = '<?xml version="1.0" encoding="utf-8"?>';
const serializer = new XMLSerializer();

export function escape(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(char) =>
			({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&apos;',
			})[char]!,
	);
}

export function xml(body: string, status: number, headers?: HeadersInit): Response {
	const result = new Headers(headers);
	result.set('Content-Type', 'application/xml; charset=utf-8');
	return new Response(xmlHeader + body, { status, headers: result });
}

export function davError(status: number, condition: string, paths: string[] = []): Response {
	return xml(
		'<D:error xmlns:D="DAV:"><D:' +
			condition +
			'>' +
			paths.map((path) => '<D:href>' + escape(href(path)) + '</D:href>').join('') +
			'</D:' +
			condition +
			'></D:error>',
		status,
	);
}

export function multistatus(responses: string[]): Response {
	return xml('<D:multistatus xmlns:D="DAV:">' + responses.join('') + '</D:multistatus>', 207);
}

const reasons: Record<number, string> = {
	200: 'OK',
	403: 'Forbidden',
	404: 'Not Found',
	424: 'Failed Dependency',
};
export function propstat(properties: string[], status: number, error = ''): string {
	if (!properties.length) return '';
	return (
		'<D:propstat><D:prop>' +
		properties.join('') +
		'</D:prop><D:status>HTTP/1.1 ' +
		status +
		' ' +
		reasons[status] +
		'</D:status>' +
		error +
		'</D:propstat>'
	);
}

export function response(resourceHref: string, propstats: string): string {
	return '<D:response><D:href>' + escape(resourceHref) + '</D:href>' + propstats + '</D:response>';
}

export async function readXml(request: Request): Promise<Element | null> {
	if (!request.body) return null;
	const reader = request.body.getReader();
	const buffer = new Uint8Array(64 * 1024);
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size + value.length > buffer.length) throw new HttpError(413, 'XML body exceeds 64 KiB');
			buffer.set(value, size);
			size += value.length;
		}
		const encoding =
			(buffer[0] === 0xfe && buffer[1] === 0xff) || (buffer[0] === 0 && buffer[1] === 60)
				? 'utf-16be'
				: (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 60 && buffer[1] === 0)
					? 'utf-16le'
					: 'utf-8';
		const source = new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size));
		if (!source.trim()) return null;
		if (/<!\s*(DOCTYPE|ENTITY)/i.test(source)) throw new Error('DTD is disabled');
		const document = new DOMParser({
			onError: (_level, message) => {
				throw new Error(message);
			},
		}).parseFromString(source, 'application/xml');
		const root = document.documentElement;
		if (!root) throw new Error('Missing document element');
		const pending: Array<[Element, number]> = [[root, 0]];
		let elements = 0;
		while (pending.length) {
			const [element, level] = pending.pop()!;
			if (++elements > 1024 || level > 32) throw new HttpError(413, 'XML is too complex');
			for (const child of children(element)) pending.push([child, level + 1]);
		}
		return root;
	} catch (error) {
		void reader.cancel().catch(() => {});
		if (error instanceof HttpError) throw error;
		throw new HttpError(400, 'Invalid WebDAV XML');
	} finally {
		reader.releaseLock();
	}
}

export function children(element: Element): Element[] {
	return Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
}

export function isDav(element: Element | undefined, name: string): boolean {
	return element?.namespaceURI === dav && element.localName === name;
}

export type Name = { ns: string; name: string };
export function nameOf(element: Element): Name {
	return { ns: element.namespaceURI ?? '', name: element.localName ?? element.nodeName };
}

export function nameKey(name: Name): string {
	return JSON.stringify([name.ns, name.name]);
}

export function empty({ ns, name }: Name): string {
	return '<' + name + ' xmlns="' + escape(ns) + '"/>';
}

export function propertyXml(element: Element): string {
	const copy = element.cloneNode(true) as Element;
	const seen = new Set<string>();
	for (
		let ancestor: Element | null = element;
		ancestor;
		ancestor = ancestor.parentNode?.nodeType === 1 ? (ancestor.parentNode as Element) : null
	) {
		for (const attr of Array.from(ancestor.attributes)) {
			if ((attr.name === 'xmlns' || attr.prefix === 'xmlns' || attr.name === 'xml:lang') && !seen.has(attr.name)) {
				seen.add(attr.name);
				copy.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
			}
		}
	}
	// Reset an empty default namespace when embedding in DAV XML.
	if (!seen.has('xmlns') && !element.namespaceURI) copy.setAttribute('xmlns', '');
	return serializer.serializeToString(copy);
}

export function findRequest(root: Element | null): { mode: 'all' | 'names' | 'selected'; names: Name[] } {
	if (!root) return { mode: 'all', names: [] };
	if (!isDav(root, 'propfind')) throw new HttpError(400);
	const [first, second, ...rest] = children(root);
	if (!rest.length && isDav(first, 'allprop') && (!second || isDav(second, 'include'))) {
		return { mode: 'all', names: second ? children(second).map(nameOf) : [] };
	}
	if (!second && isDav(first, 'propname')) return { mode: 'names', names: [] };
	if (!second && isDav(first, 'prop')) return { mode: 'selected', names: children(first).map(nameOf) };
	throw new HttpError(400);
}

export function patchRequest(root: Element | null): Array<{ name: Name; value: string | null }> {
	if (!root || !isDav(root, 'propertyupdate')) throw new HttpError(400);
	const updates = children(root).flatMap((command) => {
		const [prop, extra] = children(command);
		const set = isDav(command, 'set');
		if ((!set && !isDav(command, 'remove')) || !prop || extra || !isDav(prop, 'prop') || !children(prop).length) {
			throw new HttpError(400);
		}
		return children(prop).map((element) => ({ name: nameOf(element), value: set ? propertyXml(element) : null }));
	});
	if (!updates.length) throw new HttpError(400);
	return updates;
}
