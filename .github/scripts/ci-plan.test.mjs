// node --test .github/scripts/ci-plan.test.mjs   (run by CI's lint job)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { IMAGES, JOBS, PY_SERVICES, plan } from './ci-plan.mjs';

const EXT = [{ name: 'd1-report', dir: 'core/extensions/d1-report', build: true, test: true }];
const nothing = { ...Object.fromEntries(Object.keys(JOBS).map((j) => [j, false])), pyServices: [], images: [], extensions: [] };

test('no changed files (main, manual run) runs everything', () => {
  const p = plan([], EXT);
  for (const j of Object.keys(JOBS)) assert.equal(p[j], true, j);
  assert.equal(p.pyServices.length, PY_SERVICES.length);
  assert.equal(p.images.length, IMAGES.length);
  assert.deepEqual(p.extensions, EXT);
});

test('a change under .github/ runs everything', () => {
  assert.deepEqual(plan(['.github/workflows/ci.yml'], EXT), plan([], EXT));
});

test('a docs-only change runs no job beyond lint', () => {
  assert.deepEqual(plan(['docs/ci-cd.md', 'docs/superpowers/plans/x.md', 'README.md', 'CLAUDE.md'], EXT), nothing);
});

test('a force-app web change runs the force-app JS job only', () => {
  assert.deepEqual(plan(['apps/force-app/web/src/record/workspace.ts'], EXT), { ...nothing, forceAppJs: true });
});

test('@d1/ui changes run both JS jobs, a root lockfile change too', () => {
  for (const f of ['packages/d1-ui/src/index.ts', 'package-lock.json']) {
    const p = plan([f], EXT);
    assert.equal(p.forceAppJs, true, f);
    assert.equal(p.directusUi, true, f);
  }
});

test('changes under the STARbase packages plan the directusUi job', () => {
  for (const f of ['packages/starbase-pages/src/index.ts', 'packages/fast-plotting/src/host.ts', 'packages/directus-host/src/directusHost.ts']) {
    assert.equal(plan([f], EXT).directusUi, true, f);
  }
});

test('the STARbase app and the force plotting it builds plan the directusUi job', () => {
  for (const f of ['apps/starbase/web/src/main.ts', 'packages/force-plotting/src/host.ts']) {
    assert.equal(plan([f], EXT).directusUi, true, f);
  }
});

test('a migration runs the schema and script tests', () => {
  assert.deepEqual(plan(['db/migrations/20261008000140_x.sql'], EXT), { ...nothing, migrations: true, scripts: true });
});

test('diag code runs the script tests, the diag service and its image', () => {
  const p = plan(['scripts/diag/runner.py'], EXT);
  assert.equal(p.scripts, true);
  assert.deepEqual(p.pyServices.map((s) => s.name), ['diag-service']);
  assert.deepEqual(p.images.map((i) => i.image), ['d1-diag-service']);
});

test("the backend's d1lc parser also runs the filter service's tests", () => {
  const p = plan(['apps/force-app/backend/app/d1lc.py'], EXT);
  assert.equal(p.backend, true);
  assert.deepEqual(p.pyServices.map((s) => s.name), ['filter-service']);
});

test('a service change builds its image and runs its tests, and nothing else', () => {
  const p = plan(['apps/force-app/backup-server/server.py'], EXT);
  assert.deepEqual(p.pyServices.map((s) => s.name), ['backup-server']);
  assert.deepEqual(p.images.map((i) => i.image), ['d1-backup-server']);
  assert.equal(p.backend, false);
});

test('an extension change builds that extension only', () => {
  assert.deepEqual(plan(['core/extensions/d1-report/src/index.ts'], EXT), { ...nothing, extensions: EXT });
});

test('every image has a dockerfile and no internal fields leak into the output', () => {
  for (const i of plan([], EXT).images) {
    assert.ok(i.dockerfile, i.name);
    assert.equal('watch' in i, false);
  }
  for (const s of plan([], EXT).pyServices) assert.equal('watch' in s, false);
});

test('the edit frame module plans the directusUi job', () => {
  assert.equal(plan(['core/extensions/d1-edit-frame/src/EditFramePage.vue'], EXT).directusUi, true);
});

test('a Caddyfile change plans the directusUi job (the CSP test reads the Caddyfile)', () => {
  for (const f of ['infra/caddy/Caddyfile']) {
    assert.equal(plan([f], EXT).directusUi, true, f);
  }
});

test('no job watches an extension that no longer exists', () => {
  for (const [job, paths] of Object.entries(JOBS)) {
    for (const p of paths) {
      if (p.startsWith('core/extensions/')) assert.ok(existsSync(new URL(`../../${p}`, import.meta.url)), `${job} watches missing ${p}`);
    }
  }
});
