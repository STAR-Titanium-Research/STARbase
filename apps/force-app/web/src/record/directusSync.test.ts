import { beforeEach, describe, expect, it, vi } from 'vitest';

// The offline queue persists to localStorage and posts over the network, so both are stubbed.
// `api.post` is controllable per-test, which is what lets the concurrency test hold a write open.
const post = vi.fn();
const get = vi.fn();
vi.mock('../directusClient', () => ({ api: { post: (...a: unknown[]) => post(...a), get: (...a: unknown[]) => get(...a) } }));
// Who is signed in decides which queued records may sync (see mayAutoSync).
// A reactive state: syncStatus's derived counts are computeds over it, as in the real store.
vi.mock('../authStore', async () => {
  const { reactive } = await import('vue');
  return { authStore: { state: reactive({ user: { id: 'u-me' } as { id: string } | null, offline: false }) } };
});
import { authStore } from '../authStore';
const auth = authStore as unknown as { state: { user: { id: string } | null; offline: boolean } };

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const LS_KEY = 'force-app.sync.queue';

import { discardQueued, flush, listQueue, logRun, retryQueued, syncStatus, uploadQueuedAsMe } from './directusSync';

function seed(items: Array<{ id: string; sample: string }>) {
  store.set(LS_KEY, JSON.stringify(items.map((i) => ({
    id: i.id,
    collection: 'manufacturing_operations',
    payload: { recorded_metadata: { sample_name: i.sample } },
    createdAt: Date.now(),
    attempts: 0,
  }))));
}
const idsInQueue = () => listQueue().map((q) => q.id);

beforeEach(() => {
  store.clear();
  post.mockReset();
  get.mockReset();
  auth.state.user = { id: 'u-me' };
  auth.state.offline = false;
});

describe('flush', () => {
  it('drops each item as it succeeds', async () => {
    seed([{ id: 'a', sample: 'S1' }, { id: 'b', sample: 'S2' }]);
    post.mockResolvedValue({ data: { data: {} } });

    await flush();

    expect(idsInQueue()).toEqual([]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stops at a permanent 4xx and keeps the item for manual retry', async () => {
    seed([{ id: 'a', sample: 'S1' }, { id: 'b', sample: 'S2' }]);
    post.mockRejectedValue({ response: { status: 403, data: { errors: [{ message: 'forbidden' }] } } });

    await flush();

    // Both remain: the head failed permanently, and everything behind it is blocked by design.
    expect(idsInQueue()).toEqual(['a', 'b']);
    expect(listQueue()[0].attempts).toBe(1);
    expect(listQueue()[0].lastError).toBeTruthy();
  });

  it('a discard while a write is in flight is not undone', async () => {
    // The regression this guards: flush() used to hold one array across its awaits and write it
    // back at the end. A discard landing during an in-flight POST was therefore clobbered — the
    // item the user deleted reappeared in the queue.
    seed([{ id: 'a', sample: 'S1' }, { id: 'b', sample: 'S2' }]);

    let releaseFirst!: () => void;
    post.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = () => resolve({ data: { data: {} } }); }),
    );
    post.mockResolvedValue({ data: { data: {} } });

    const running = flush();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    discardQueued('b');            // user deletes the queued item behind the one being written
    expect(idsInQueue()).toEqual(['a']);

    releaseFirst();
    await running;

    expect(idsInQueue()).toEqual([]);       // 'a' posted and dropped
    expect(post).toHaveBeenCalledTimes(1);  // 'b' was never sent — it was discarded first
  });

  it('an item enqueued while a write is in flight is not lost', async () => {
    seed([{ id: 'a', sample: 'S1' }]);

    let releaseFirst!: () => void;
    post.mockImplementationOnce(
      () => new Promise((resolve) => { releaseFirst = () => resolve({ data: { data: {} } }); }),
    );
    // The run continues past the first success, so the newly-added item is attempted too. Fail it
    // transiently to keep it queued and observable — the point is that it still EXISTS, rather
    // than having been erased by a stale write-back.
    post.mockRejectedValue({ message: 'Network Error' });

    const running = flush();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // logRun() calls flush() itself, but the in-progress run holds the `flushing` guard, so this
    // only enqueues — exactly the interleaving a cut finishing mid-sync produces.
    await logRun({ recorded_metadata: { sample_name: 'S-NEW' } });

    releaseFirst();
    await running;

    const names = listQueue().map((q) => q.payload.recorded_metadata.sample_name);
    expect(names).toEqual(['S-NEW']);
  });
});

describe('queue management', () => {
  it('discardQueued removes only the named item', () => {
    seed([{ id: 'a', sample: 'S1' }, { id: 'b', sample: 'S2' }, { id: 'c', sample: 'S3' }]);
    discardQueued('b');
    expect(idsInQueue()).toEqual(['a', 'c']);
  });

  it('retryQueued promotes the item to the head so it is attempted first', async () => {
    // flush() stops at the first permanent failure, so a poisoned head blocks everything behind
    // it. Promoting is what makes a targeted retry reach the network at all.
    seed([{ id: 'a', sample: 'STUCK' }, { id: 'b', sample: 'WANTED' }]);
    post.mockRejectedValue({ response: { status: 400, data: { errors: [{ message: 'bad' }] } } });
    await flush();                       // 'a' fails permanently and parks at the head
    expect(listQueue()[0].id).toBe('a');

    post.mockReset();
    // Only the promoted item succeeds; the stuck one keeps failing, as it would in reality.
    post.mockResolvedValueOnce({ data: { data: {} } });
    post.mockRejectedValue({ response: { status: 400, data: { errors: [{ message: 'bad' }] } } });
    await retryQueued('b');

    // The promoted item is written FIRST — that is the whole point, since flush() would otherwise
    // stop on the stuck head and never reach it.
    expect(post.mock.calls[0][1]).toMatchObject({ recorded_metadata: { sample_name: 'WANTED' } });
    expect(idsInQueue()).toEqual(['a']);   // 'b' went through; the stuck one is still queued
  });

  it('retryQueued keeps the previous error visible until the retry actually resolves it', async () => {
    // The diagnosis must not be wiped optimistically: flush() is a no-op while another run holds
    // the guard, so clearing it up front repainted the row as a healthy "queued" item with no
    // error and nothing retried. It goes away when the write succeeds (the item disappears) or is
    // replaced by the next failure.
    seed([{ id: 'a', sample: 'S1' }]);
    post.mockRejectedValue({ response: { status: 400, data: { errors: [{ message: 'bad' }] } } });
    await flush();
    expect(listQueue()[0].lastError).toBeTruthy();

    post.mockReset();
    // Held open so the state can be inspected mid-retry, then released — `flushing` is module
    // state, so leaving a write pending would wedge the guard for every later test.
    let release!: () => void;
    post.mockImplementation(
      () => new Promise((_res, rej) => { release = () => rej({ message: 'Network Error' }); }),
    );
    const retrying = retryQueued('a');
    await vi.waitFor(() => expect(post).toHaveBeenCalled());

    expect(listQueue()[0].lastError).toBeTruthy();

    release();
    await retrying;
  });

  it('retryQueued reports that nothing was attempted when a sync is already running', async () => {
    seed([{ id: 'a', sample: 'S1' }, { id: 'b', sample: 'S2' }]);
    let release!: () => void;
    post.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ data: { data: {} } }); }),
    );
    post.mockRejectedValue({ message: 'Network Error' });

    const running = flush();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));

    // flush() is guarded, so this cannot send anything right now — say so rather than letting the
    // caller report a retry that never happened.
    expect(await retryQueued('b')).toBe(false);
    expect(idsInQueue()[0]).toBe('b');   // still promoted, so the running flush reaches it next

    release();
    await running;
  });

  it('retryQueued on an unknown id is a no-op', async () => {
    seed([{ id: 'a', sample: 'S1' }]);
    post.mockResolvedValue({ data: { data: {} } });
    await retryQueued('nope');
    expect(post).not.toHaveBeenCalled();
    expect(idsInQueue()).toEqual(['a']);
  });
});


describe('who a queued record syncs under', () => {
  const seedOwned = (items: Array<{ id: string; by?: string }>) => {
    store.set(LS_KEY, JSON.stringify(items.map((i) => ({
      id: i.id, collection: 'manufacturing_operations', createdAt: Date.now(), attempts: 0,
      payload: { recorded_metadata: { recorded_by_user_id: i.by } }, recordedBy: i.by,
    }))));
  };

  it('logRun remembers the recorder from the payload', async () => {
    post.mockRejectedValue({ message: 'Network Error' }); // stays queued
    await logRun({ recorded_metadata: { recorded_by_user_id: 'u-me', recorded_by_name: 'Me' } });
    expect(listQueue()[0]).toMatchObject({ recordedBy: 'u-me', recordedByLabel: 'Me' });
  });

  it("only syncs the signed-in user's own records; others wait for their recorder", async () => {
    seedOwned([{ id: 'theirs', by: 'u-other' }, { id: 'mine', by: 'u-me' }, { id: 'legacy' }]);
    post.mockResolvedValue({ data: { data: {} } });

    await flush();

    expect(post).toHaveBeenCalledTimes(2); // mine + legacy (no recorder known); never "theirs"
    expect(listQueue().map((q) => q.id)).toEqual(['theirs']);
    expect(syncStatus.waitingForOthers).toBe(1);
  });

  it("a blocked record doesn't hold up this user's later ones", async () => {
    seedOwned([{ id: 'theirs', by: 'u-other' }, { id: 'mine', by: 'u-me' }]);
    post.mockResolvedValue({ data: { data: {} } });
    await flush();
    expect(listQueue().map((q) => q.id)).toEqual(['theirs']);
  });

  it('uploadQueuedAsMe is the explicit override, and keeps the recorder in the payload', async () => {
    seedOwned([{ id: 'theirs', by: 'u-other' }]);
    post.mockResolvedValue({ data: { data: {} } });
    get.mockResolvedValue({ data: { data: [{ person_id: 'person-other' }] } });

    await uploadQueuedAsMe('theirs');

    expect(listQueue()).toEqual([]);
    const sent = post.mock.calls[0][1];
    expect(sent.recorded_metadata.recorded_by_user_id).toBe('u-other'); // recorder preserved
    expect(sent.recorded_metadata.synced_by_user_id).toBe('u-me');      // uploader recorded beside it
  });

  it('an offline session never tries the network, and says it needs a sign-in', async () => {
    seedOwned([{ id: 'mine', by: 'u-me' }]);
    auth.state.offline = true;

    await flush();

    expect(post).not.toHaveBeenCalled();
    expect(syncStatus.needsSignIn).toBe(true);
    expect(listQueue().map((q) => q.id)).toEqual(['mine']);
  });

  it('the derived counts follow the signed-in user without any flush', async () => {
    seedOwned([{ id: 'theirs', by: 'u-other' }]);
    post.mockRejectedValue({ message: 'Network Error' });
    await logRun({ recorded_metadata: { recorded_by_user_id: 'u-me' } });   // loads the queue into the status

    expect(syncStatus.waitingForOthers).toBe(1);                             // 'theirs' waits for u-other
    auth.state.user = { id: 'u-other' };                                     // the recorder signs in:
    expect(syncStatus.waitingForOthers).toBe(1);                             // 'mine' (u-me's) now waits instead
    auth.state.user = { id: 'u-third' };
    expect(syncStatus.waitingForOthers).toBe(2);
    auth.state.user = { id: 'u-me' };
    auth.state.offline = true;                                               // ...but as an offline session
    expect(syncStatus.needsSignIn).toBe(true);
    auth.state.offline = false;
    expect(syncStatus.needsSignIn).toBe(false);
  });

  it("resolves the recorder's person when the stamp has none, and owns the record by them, not the uploader", async () => {
    seedOwned([{ id: 'theirs', by: 'u-other' }]);
    get.mockResolvedValue({ data: { data: [{ person_id: 'person-other' }] } });
    post.mockResolvedValue({ data: { data: {} } });

    await uploadQueuedAsMe('theirs');

    expect(get.mock.calls[0][1].params.filter).toEqual({ user_id: { _eq: 'u-other' } });
    expect(post.mock.calls[0][1].owner_person_id).toBe('person-other');
  });

  it('a failed person lookup leaves the record queued rather than letting the uploader own it', async () => {
    seedOwned([{ id: 'theirs', by: 'u-other' }]);
    get.mockRejectedValue({ message: 'Network Error' });

    await uploadQueuedAsMe('theirs');

    expect(post).not.toHaveBeenCalled();
    expect(listQueue().map((q) => q.id)).toEqual(['theirs']);
  });

  it("doesn't look anything up for the recorder's own record", async () => {
    seedOwned([{ id: 'mine', by: 'u-me' }]);
    post.mockResolvedValue({ data: { data: {} } });
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

// Nit (review): the queued operation POST has no idempotency key, so a retry after a lost reply
// must look for the row the first attempt created.
describe('retry after a lost reply', () => {
  const queued = (attempts: number) => store.set(LS_KEY, JSON.stringify([{
    id: 'q1', collection: 'manufacturing_operations',
    payload: { recorded_metadata: { capture_id: '20260930-101500-abc', sample_name: 'S1' } },
    createdAt: Date.now(), attempts,
  }]));
  const found = { data: { data: [{ operation_id: 'op-1', recorded_metadata: { capture_id: '20260930-101500-abc' } }] } };

  it('does not insert again when the earlier attempt actually created the row', async () => {
    queued(1);
    get.mockResolvedValue(found);
    await flush();
    expect(post).not.toHaveBeenCalled();
    expect(idsInQueue()).toEqual([]);
  });

  it('inserts when no such row exists', async () => {
    queued(1);
    get.mockResolvedValue({ data: { data: [] } });
    post.mockResolvedValue({ data: { data: {} } });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    expect(idsInQueue()).toEqual([]);
  });

  it('inserts when the lookup itself fails (offline-ish): never blocks the write', async () => {
    queued(2);
    get.mockRejectedValue(new Error('Network Error'));
    post.mockResolvedValue({ data: { data: {} } });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not look anything up on the first attempt', async () => {
    queued(0);
    post.mockResolvedValue({ data: { data: {} } });
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
