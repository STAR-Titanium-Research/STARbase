// Run with: node --test core/extensions/d1-access-guard/index.archive-pointers.test.mjs
// ADR-0022: a non-admin cannot create an archive pointer row (storage 'star' / metadata.archive_path) or repoint one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import hook from './index.js';
import { archivePath, createsPointer, repointsPointer } from './archivePointers.js';

const filters = {};
hook({ filter: (name, fn) => (filters[name] = fn) }, { services: { ItemsService: class {} } });

const member = { user: 'user-1', admin: false };
const PATH = 'User/ab123/scan.al3d';
const POINTER = { id: 'f1', storage: 'star', filename_disk: PATH, metadata: { archive_path: PATH, width: 3 } };

// db('directus_files').whereIn('id', keys).select(...) -> the rows of `stored` whose id is in keys
const database = (stored = [POINTER]) => (table) => {
  assert.equal(table, 'directus_files');
  return { whereIn: (_col, keys) => ({ select: async () => stored.filter((r) => keys.includes(r.id)) }) };
};
const ctx = (over = {}) => ({ database: database(), accountability: member, ...over });
const meta = (over = {}) => ({ collection: 'directus_files', ...over });

const refused = async (promise) => {
  const err = await promise.then(
    () => assert.fail('expected a refusal'),
    (e) => e,
  );
  assert.equal(err.status, 403);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.extensions.source, 'd1-access-guard');
  assert.equal(err.extensions.collection, 'directus_files');
  assert.equal(err.extensions.reason, err.message);
  assert.doesNotMatch(err.message, /_|ADR|[0-9a-f]{8}-/i, 'the message is plain words');
  return err;
};

test('registers the file filters next to the items ones', () => {
  for (const name of ['files.create', 'files.update', 'files.upload', 'items.create', 'items.update']) {
    assert.equal(typeof filters[name], 'function', name);
  }
});

test('archivePath reads an object or a JSON string and ignores everything else', () => {
  assert.equal(archivePath({ archive_path: PATH }), PATH);
  assert.equal(archivePath(JSON.stringify({ archive_path: PATH })), PATH);
  assert.equal(archivePath({ archive_path: '' }), '');
  assert.equal(archivePath(null), '');
  assert.equal(archivePath('not json'), '');
  assert.equal(archivePath(5), '');
});

test('create: a member cannot make a pointer row, however it is spelled', async () => {
  const forged = [
    { id: 'x', storage: 'star', metadata: { archive_path: PATH } },
    { storage: 'star' },
    { storage: ' STAR ' },
    { storage: 'local', metadata: { archive_path: PATH } },
    { metadata: JSON.stringify({ archive_path: PATH }) },
  ];
  for (const event of ['files.create', 'files.upload', 'items.create']) {
    for (const payload of forged) {
      await refused(Promise.resolve().then(() => filters[event](payload, meta(), ctx())));
      await refused(Promise.resolve().then(() => filters[event]([{ title: 'ok' }, payload], meta(), ctx())));
    }
  }
});

test('create: an ordinary upload, with or without metadata, passes untouched', async () => {
  const upload = { storage: 'local', filename_download: 'a.png', type: 'image/png', metadata: { exif: { make: 'x' } }, title: 't' };
  for (const event of ['files.create', 'files.upload', 'items.create']) {
    assert.equal(await filters[event](upload, meta(), ctx()), upload);
    const bare = { title: 'no storage, no metadata' };
    assert.equal(await filters[event](bare, meta(), ctx()), bare);
  }
});

test('create: administrators, internal calls and other collections are not checked', async () => {
  const forged = { id: 'x', storage: 'star', metadata: { archive_path: PATH } };
  assert.equal(await filters['files.create'](forged, meta(), ctx({ accountability: { user: 'a', admin: true } })), forged);
  assert.equal(await filters['files.create'](forged, meta(), ctx({ accountability: null })), forged);
  assert.equal(await filters['items.create'](forged, { collection: 'samples_notes' }, ctx()), forged);
});

test('update: a member cannot repoint a pointer row', async () => {
  const bad = [
    { metadata: { archive_path: 'User/other/private.al3d', width: 3 } },
    { metadata: { width: 3 } }, // dropping the path is a change too
    { metadata: JSON.stringify({ archive_path: 'User/other/private.al3d' }) },
    { storage: 'local' },
    { filename_disk: 'User/other/private.al3d' },
    { id: 'f2' },
  ];
  for (const payload of bad) {
    await refused(Promise.resolve().then(() => filters['files.update'](payload, meta({ keys: ['f1'] }), ctx())));
    await refused(Promise.resolve().then(() => filters['items.update'](payload, meta({ keys: ['f1'] }), ctx())));
  }
});

test('update: a member cannot turn an ordinary file into a pointer', async () => {
  const plain = { id: 'f9', storage: 'local', filename_disk: 'abc.png', metadata: { exif: {} } };
  const db = database([plain]);
  for (const payload of [{ storage: 'star' }, { metadata: { archive_path: PATH } }]) {
    await refused(Promise.resolve().then(() => filters['files.update'](payload, meta({ keys: ['f9'] }), ctx({ database: db }))));
  }
});

test('update: editing the rest of a pointer row, or saving the whole form back, is allowed', async () => {
  const same = [
    { title: 'a better title', description: 'd' },
    { metadata: { archive_path: PATH, width: 9, note: 'edited' } },
    { storage: 'star', filename_disk: PATH, id: 'F1', metadata: JSON.stringify({ archive_path: PATH }) },
  ];
  for (const payload of same) {
    assert.equal(await filters['files.update'](payload, meta({ keys: ['f1'] }), ctx()), payload);
  }
});

test('update: ordinary files stay editable and administrators and internal calls are exempt', async () => {
  const plain = { id: 'f9', storage: 'local', filename_disk: 'abc.png', metadata: {} };
  const db = database([plain]);
  const edit = { title: 'x', metadata: { exif: { make: 'y' } }, filename_disk: 'renamed.png' };
  assert.equal(await filters['files.update'](edit, meta({ keys: ['f9'] }), ctx({ database: db })), edit);
  const repoint = { metadata: { archive_path: 'User/other/private.al3d' } };
  assert.equal(await filters['files.update'](repoint, meta({ keys: ['f1'] }), ctx({ accountability: { user: 'a', admin: true } })), repoint);
  assert.equal(await filters['files.update'](repoint, meta({ keys: ['f1'] }), ctx({ accountability: null })), repoint);
});

test('update: with no key to look up, only a pointer on its face is refused', async () => {
  await refused(Promise.resolve().then(() => filters['files.update']({ storage: 'star' }, meta(), ctx())));
  const edit = { title: 'x' };
  assert.equal(await filters['files.update'](edit, meta(), ctx()), edit);
});

test('the pure predicates agree with the filters', () => {
  assert.equal(createsPointer({ storage: 'star' }), true);
  assert.equal(createsPointer({ storage: 'local' }), false);
  assert.equal(createsPointer(null), false);
  assert.equal(repointsPointer(POINTER, { title: 'x' }), false);
  assert.equal(repointsPointer(null, { storage: 'star' }), false);
  assert.equal(repointsPointer(POINTER, { filename_disk: PATH }), false);
});
