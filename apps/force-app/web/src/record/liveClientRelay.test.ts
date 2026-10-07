import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordClient } from './liveClient';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// connect() opens a real WebSocket; the handshake tests only care about what it says on the relay.
class FakeWS {
	static OPEN = 1;
	binaryType = '';
	onopen: unknown; onclose: unknown; onerror: unknown; onmessage: unknown;
	close() {}
}

describe('pop-out relay handshake', () => {
	const open: { close(): void }[] = [];
	afterEach(() => { for (const c of open.splice(0)) c.close(); vi.unstubAllGlobals(); });

	it('a pop-out asks for a sync again when the source window connects after it (#108)', async () => {
		const requests: unknown[] = [];
		const source = new BroadcastChannel('force-app-live');   // stands in for the main window
		open.push(source);
		source.onmessage = (ev) => { if (ev.data?.type === 'sync-request') requests.push(ev.data); };

		const popout = new RecordClient();
		open.push({ close: () => popout.disconnect() });
		popout.connectViaRelay();
		await tick();
		expect(requests).toHaveLength(1);   // its first request on opening

		source.postMessage({ type: 'source-ready' });   // what connect() announces
		await tick();
		expect(requests).toHaveLength(2);
	});

	it('connect() announces itself on the relay with source-ready', async () => {
		vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
		const heard: unknown[] = [];
		const listener = new BroadcastChannel('force-app-live');
		open.push(listener);
		listener.onmessage = (ev) => heard.push(ev.data);

		const source = new RecordClient();
		open.push({ close: () => source.disconnect() });
		source.connect();
		await tick();

		expect(heard).toContainEqual({ type: 'source-ready' });
	});

	it('source-ready re-sends the sync-request (id and retainSec) even within 500 ms of the last one', async () => {
		const requests: { id?: string; retainSec?: number }[] = [];
		const source = new BroadcastChannel('force-app-live');
		open.push(source);
		source.onmessage = (ev) => { if (ev.data?.type === 'sync-request') requests.push(ev.data); };

		const popout = new RecordClient();
		open.push({ close: () => popout.disconnect() });
		popout.connectViaRelay();
		await tick();
		expect(requests).toHaveLength(1);   // the request it made on opening

		// A delta that does not fit what the pop-out holds makes it call requestSync(), which arms
		// its 500 ms throttle. (connectViaRelay's own first request does not go through it.)
		popout.applySnapshot({ full: false, epoch: 7, frm: { from: 99 } });
		await tick();
		expect(requests).toHaveLength(2);
		popout.applySnapshot({ full: false, epoch: 7, frm: { from: 99 } });
		await tick();
		expect(requests).toHaveLength(2);   // throttled: this is what source-ready has to get past

		source.postMessage({ type: 'source-ready' });   // well inside that 500 ms window
		await tick();

		expect(requests).toHaveLength(3);
		expect(requests[2].id).toBe(requests[0].id);
		expect(requests[2].id).toBeTruthy();
		expect(requests[2].retainSec).toBe(popout.retainSec);
	});

	it('a pop-out opened first ends up with the snapshot of an opener that connects later', async () => {
		vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
		const popout = new RecordClient();
		open.push({ close: () => popout.disconnect() });
		popout.connectViaRelay();   // restored pop-out opens first; nobody is listening to answer
		await tick();
		expect(popout.frm.count).toBe(0);

		const opener = new RecordClient();
		open.push({ close: () => opener.disconnect() });
		opener.frm.count = 3;
		opener.frm.xy.set([1, 2, 3, 4, 5, 6]);
		opener.frm.cx.set([1, 1, 1]);
		opener.frm.cy.set([1, 1, 1]);
		opener.frm.cz.set([1, 1, 1]);
		opener.status.nTotal = 99;
		opener.connect();   // posts source-ready; the pop-out answers with a sync-request
		await tick(100);

		expect(popout.frm.count).toBe(3);
		expect(Array.from(popout.frm.xy.subarray(0, 6))).toEqual([1, 2, 3, 4, 5, 6]);
		expect(popout.status.nTotal).toBe(99);
		expect(popout.snapshotReady.value).toBe(true);
	});
});
