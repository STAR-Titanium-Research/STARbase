import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debouncePublish, diagSyncName, openDiagSync, type DiagSyncMsg } from './diagSync';

// A minimal same-realm BroadcastChannel: every instance on a name receives what the others
// post, and never its own message. That is the property the sync model depends on.
class FakeBroadcastChannel {
	static live = new Map<string, FakeBroadcastChannel[]>();
	onmessage: ((ev: MessageEvent) => void) | null = null;
	closed = false;

	constructor(public name: string) {
		const peers = FakeBroadcastChannel.live.get(name) ?? [];
		peers.push(this);
		FakeBroadcastChannel.live.set(name, peers);
	}

	postMessage(data: unknown) {
		if (this.closed) throw new Error('closed');
		for (const peer of FakeBroadcastChannel.live.get(this.name) ?? []) {
			if (peer !== this && !peer.closed) peer.onmessage?.({ data } as MessageEvent);
		}
	}

	close() {
		this.closed = true;
		const peers = (FakeBroadcastChannel.live.get(this.name) ?? []).filter((p) => p !== this);
		FakeBroadcastChannel.live.set(this.name, peers);
	}
}

beforeEach(() => {
	FakeBroadcastChannel.live.clear();
	vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});
afterEach(() => vi.unstubAllGlobals());

describe('diagSyncName', () => {
	it('keys the channel per analysis so two open cuts never cross-talk', () => {
		expect(diagSyncName('a1')).not.toBe(diagSyncName('a2'));
		expect(diagSyncName('a1')).toContain('a1');
	});
});

describe('openDiagSync', () => {
	it('delivers a published message to another window on the same analysis', () => {
		const seen: DiagSyncMsg[] = [];
		openDiagSync('a1', (m) => seen.push(m));       // the pop-out
		const main = openDiagSync('a1', () => {});      // the workbench

		main.post({ t: 'isolate', clusterId: 3 });

		expect(seen).toEqual([{ t: 'isolate', clusterId: 3 }]);
	});

	it('does not deliver across analyses', () => {
		const seen: DiagSyncMsg[] = [];
		openDiagSync('a1', (m) => seen.push(m));
		openDiagSync('a2', () => {}).post({ t: 'isolate', clusterId: 1 });
		expect(seen).toEqual([]);
	});

	it('does not echo a window its own messages', () => {
		const seen: DiagSyncMsg[] = [];
		const ch = openDiagSync('a1', (m) => seen.push(m));
		ch.post({ t: 'hello' });
		expect(seen).toEqual([]);
	});

	it('lets a late pop-out ask for state with hello, and the publisher answer it', () => {
		// The stale-on-open case: a window opened after the last edit must not miss it.
		const popout: DiagSyncMsg[] = [];
		const recipe = { recipe_version: 1, name: 'Edited', steps: [] };

		const main = openDiagSync('a1', (m) => {
			if (m.t === 'hello') main.post({ t: 'recipe', recipe });
		});
		const detached = openDiagSync('a1', (m) => popout.push(m));

		detached.post({ t: 'hello' });

		expect(popout).toEqual([{ t: 'recipe', recipe }]);
	});

	it('ignores a malformed payload rather than throwing into the handler', () => {
		const seen: DiagSyncMsg[] = [];
		openDiagSync('a1', (m) => seen.push(m));
		const main = openDiagSync('a1', () => {});
		for (const junk of [null, 'nope', 42, {}, { nope: 1 }]) {
			expect(() => main.post(junk as unknown as DiagSyncMsg)).not.toThrow();
		}
		expect(seen).toEqual([]);
	});

	it('survives a subscriber whose handler throws', () => {
		// One stale pop-out must not break the publisher or the other listeners.
		const good: DiagSyncMsg[] = [];
		openDiagSync('a1', () => { throw new Error('stale component'); });
		openDiagSync('a1', (m) => good.push(m));
		const main = openDiagSync('a1', () => {});

		expect(() => main.post({ t: 'hello' })).not.toThrow();
		expect(good).toEqual([{ t: 'hello' }]);
	});

	it('stops delivering once closed', () => {
		const seen: DiagSyncMsg[] = [];
		const detached = openDiagSync('a1', (m) => seen.push(m));
		const main = openDiagSync('a1', () => {});
		detached.close();
		main.post({ t: 'hello' });
		expect(seen).toEqual([]);
	});

	it('degrades to a no-op where BroadcastChannel is unavailable', () => {
		// The pop-out then behaves exactly as it did before sync existed.
		vi.stubGlobal('BroadcastChannel', undefined);
		const ch = openDiagSync('a1', () => { throw new Error('must not be called'); });
		expect(() => { ch.post({ t: 'hello' }); ch.close(); }).not.toThrow();
	});
});

describe('debouncePublish', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('coalesces a burst of keystrokes into one publish carrying the last value', () => {
		const published: number[] = [];
		const d = debouncePublish<number>((v) => published.push(v), 150);
		d.push(1); d.push(2); d.push(3);

		expect(published).toEqual([]);
		vi.advanceTimersByTime(150);
		expect(published).toEqual([3]);
	});

	it('publishes again after the window has elapsed', () => {
		const published: number[] = [];
		const d = debouncePublish<number>((v) => published.push(v), 150);
		d.push(1);
		vi.advanceTimersByTime(150);
		d.push(2);
		vi.advanceTimersByTime(150);
		expect(published).toEqual([1, 2]);
	});

	it('flush answers a hello immediately rather than on the next trailing edge', () => {
		const published: number[] = [];
		const d = debouncePublish<number>((v) => published.push(v), 150);
		d.push(7);
		d.flush();
		expect(published).toEqual([7]);
		// ...and the cancelled timer does not fire a duplicate.
		vi.advanceTimersByTime(500);
		expect(published).toEqual([7]);
	});

	it('flush with nothing pending publishes nothing', () => {
		const published: number[] = [];
		const d = debouncePublish<number>((v) => published.push(v), 150);
		d.flush();
		d.push(1);
		vi.advanceTimersByTime(150);
		d.flush();
		expect(published).toEqual([1]);
	});

	it('cancel drops a pending publish', () => {
		const published: number[] = [];
		const d = debouncePublish<number>((v) => published.push(v), 150);
		d.push(1);
		d.cancel();
		vi.advanceTimersByTime(500);
		expect(published).toEqual([]);
	});
});
