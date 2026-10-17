// The Inbox's picture cache and queue (spec 2026-10-15-found-files-inbox-design.md section 14). Framework-free, so it is tested without a page.
//
// A row (or the preview dialog) `acquire`s the picture of one file and size, and `release`s it when it goes. The store
//  - loads each picture once however many holders ask (a row and the dialog share the thumbnail),
//  - runs at most `maxInFlight` loads at once and queues the rest in the order they were asked (a preview a person clicked on jumps the queue),
//  - drops a queued load nobody wants any more (a row that scrolled out of the list's life before its turn),
//  - revokes an object URL when its last holder lets go (and, if `keepUnused` is set, when it falls off the end of the unused pictures it keeps
//    for a quick return). A failed load is not remembered: the next acquire tries again, which is how a remounted row or Retry works.
// The loader and the revoker are given, so the real ones (loadPicture, URL.revokeObjectURL) and test doubles both fit.
import type { HostApi } from '@d1/ui';
import { loadPicture, type PictureSize } from './inboxApi';

export interface PictureHandle {
	/** The object URL when the picture is in; rejects when it failed, or when every holder let go before it was loaded. */
	promise: Promise<string>;
	/** Let go of the picture. Safe to call twice. */
	release(): void;
}

export interface PictureStoreOptions {
	load: (candidateId: string, size: PictureSize) => Promise<string>;
	revoke: (url: string) => void;
	/** How many loads run at once. Default 4. */
	maxInFlight?: number;
	/** How many pictures nobody holds are kept for a quick return before the oldest is revoked. Default 0: a picture goes when its last holder does. */
	keepUnused?: number;
}

export interface PictureStore {
	acquire(candidateId: string, size: PictureSize, opts?: { priority?: boolean }): PictureHandle;
	/** For tests and diagnostics: what the store holds right now. */
	stats(): { inFlight: number; queued: number; held: number; unused: number };
}

export const MAX_PICTURES_IN_FLIGHT = 4;

/** Rejects the promise of a load dropped before it started: nobody is waiting for it. */
export class PictureCancelled extends Error {
	constructor() {
		super('The picture was no longer wanted.');
		this.name = 'PictureCancelled';
	}
}

interface Entry {
	key: string;
	id: string;
	size: PictureSize;
	refs: number;
	state: 'queued' | 'loading' | 'ready' | 'failed';
	url: string | null;
	promise: Promise<string>;
	resolve(url: string): void;
	reject(e: unknown): void;
}

export function createPictureStore(o: PictureStoreOptions): PictureStore {
	const max = Math.max(1, o.maxInFlight ?? MAX_PICTURES_IN_FLIGHT);
	const keep = Math.max(0, o.keepUnused ?? 0);
	const entries = new Map<string, Entry>();
	const queue: Entry[] = [];
	/** Ready pictures nobody holds, oldest first. */
	const unused = new Set<Entry>();
	let inFlight = 0;

	function drop(e: Entry): void {
		if (entries.get(e.key) === e) entries.delete(e.key);
		unused.delete(e);
		if (e.url) o.revoke(e.url);
		e.url = null;
	}
	function trimUnused(): void {
		while (unused.size > keep) {
			const oldest = unused.values().next().value as Entry;
			drop(oldest);
		}
	}

	function pump(): void {
		while (inFlight < max && queue.length) {
			const e = queue.shift() as Entry;
			e.state = 'loading';
			inFlight += 1;
			let loaded: Promise<string>;
			try {
				loaded = o.load(e.id, e.size);
			} catch (err) {
				loaded = Promise.reject(err);
			}
			loaded.then(
				(url) => {
					inFlight -= 1;
					if (e.refs <= 0) {
						// everyone let go while it loaded: the picture is not wanted, so its URL must not leak
						o.revoke(url);
						if (entries.get(e.key) === e) entries.delete(e.key);
						e.reject(new PictureCancelled());
					} else {
						e.state = 'ready';
						e.url = url;
						e.resolve(url);
					}
					pump();
				},
				(err) => {
					inFlight -= 1;
					e.state = 'failed';
					if (entries.get(e.key) === e) entries.delete(e.key);
					e.reject(err);
					pump();
				},
			);
		}
	}

	function create(id: string, size: PictureSize, key: string): Entry {
		let resolve!: (url: string) => void;
		let reject!: (e: unknown) => void;
		const promise = new Promise<string>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		promise.catch(() => {}); // a holder that already let go must not leave an unhandled rejection behind
		return { key, id, size, refs: 0, state: 'queued', url: null, promise, resolve, reject };
	}

	return {
		acquire(id, size, opts = {}) {
			const key = `${size}:${id}`;
			let e = entries.get(key);
			if (!e) {
				e = create(id, size, key);
				entries.set(key, e);
				if (opts.priority) queue.unshift(e);
				else queue.push(e);
			} else if (opts.priority && e.state === 'queued') {
				queue.splice(queue.indexOf(e), 1);
				queue.unshift(e);
			}
			unused.delete(e);
			e.refs += 1;
			const entry = e;
			let released = false;
			queueMicrotask(pump); // start after the caller's own acquires in this tick, so a priority one is ahead of the rest
			return {
				promise: entry.promise,
				release() {
					if (released) return;
					released = true;
					entry.refs -= 1;
					if (entry.refs > 0) return;
					if (entry.state === 'queued') {
						queue.splice(queue.indexOf(entry), 1);
						if (entries.get(entry.key) === entry) entries.delete(entry.key);
						entry.reject(new PictureCancelled());
					} else if (entry.state === 'ready') {
						unused.add(entry);
						trimUnused();
					}
					// 'loading': its URL is revoked when it arrives (see pump); 'failed' is already gone
				},
			};
		},
		stats: () => ({ inFlight, queued: queue.length, held: [...entries.values()].filter((e) => e.refs > 0).length, unused: unused.size }),
	};
}

// One store per host api (a page's calls all share its session), made on first use. The real loader and URL.revokeObjectURL.
const stores = new WeakMap<object, PictureStore>();
export function picturesFor(api: HostApi): PictureStore {
	let s = stores.get(api);
	if (!s) {
		s = createPictureStore({ load: (id, size) => loadPicture(api, id, size), revoke: (u) => URL.revokeObjectURL(u) });
		stores.set(api, s);
	}
	return s;
}
