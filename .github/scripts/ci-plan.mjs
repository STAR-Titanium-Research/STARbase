// Decide which of CI's jobs a run needs, and write the answer to $GITHUB_OUTPUT. A push to main, a
// manual run, or a change to CI itself runs everything; a pull request runs only the jobs whose
// inputs it touches, so a docs-only push costs the lint job and nothing else (minutes are billed
// per job, rounded up, see docs/ci-cd.md "Cost").
//
// Usage: node .github/scripts/ci-plan.mjs [changed-file ...]   (no files = run everything)
// Locally: node .github/scripts/ci-plan.mjs $(git diff --name-only origin/main...HEAD)
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The npm workspace's root files: a change here can break any workspace package.
const WORKSPACE_ROOT = ['package.json', 'package-lock.json'];

// Jobs that run or not as a whole, and the paths whose change makes them run.
export const JOBS = {
  // db/ for the migrations themselves; scripts/ for configure_all.sh, the access rules and the
  // roundtrip script; tests/ for the phase scripts; d1-access-guard ships rules the tests check.
  migrations: ['db/', 'scripts/', 'tests/', 'core/extensions/d1-access-guard/'],
  // tests/scripts against a migrated database, the diag goldens, and the release-notes checks
  // that read the force app's changelog.
  scripts: ['scripts/', 'tests/', 'db/', 'core/extensions/d1-access-guard/', 'apps/force-app/web/src/changelog'],
  forceAppJs: [
    'apps/force-app/web/', 'apps/force-app/desktop/', 'packages/force-plotting/', 'packages/d1-ui/',
    ...WORKSPACE_ROOT,
  ],
  // infra/caddy/: apps/starbase/web/src/csp.test.ts reads the Caddyfile (the :8090 CSP and the d1-edit COOP).
  directusUi: [
    'packages/d1-ui/', 'packages/fast-plotting/', 'packages/directus-host/', 'packages/starbase-pages/', 'packages/force-plotting/',
    'apps/starbase/web/', 'infra/caddy/', 'core/extensions/d1-edit-frame/', 'core/extensions/d1-lab-dashboard/',
    'core/extensions/d1-composition-bar/', 'core/extensions/d1-campaign-ops/',
    'core/extensions/d1-project-items/', 'tests/fixtures/d1-inbox/', ...WORKSPACE_ROOT,
  ],
  backend: ['apps/force-app/backend/'],
};

// Python services tested outside their image (Python 3.12, as their images run). diag-service's
// tests read tests/scripts/diag fixtures; filter-service's compare its parser with the backend's.
export const PY_SERVICES = [
  { name: 'backup-server', dir: 'apps/force-app/backup-server' },
  { name: 'bug-report-relay', dir: 'apps/force-app/bug-report-relay' },
  { name: 'filter-service', dir: 'plugins/filter-service', watch: ['plugins/filter-service/', 'apps/force-app/backend/app/d1lc.py'] },
  { name: 'diag-service', dir: 'plugins/diag-service', watch: ['plugins/diag-service/', 'scripts/diag/', 'tests/scripts/diag/'] },
];

// Service images: built from their Dockerfile, then `test` runs inside the image.
export const IMAGES = [
  { name: 'Heavy-data worker', image: 'd1-heavy-data-worker', context: 'plugins/heavy-data-worker', test: 'python -m pytest tests/ -q --tb=short' },
  { name: 'Analysis worker', image: 'd1-analysis-worker', context: 'plugins/analysis-worker', test: 'python -m pytest tests/ -q --tb=short' },
  { name: 'Text-to-SQL plugin', image: 'd1-llm-text-to-sql', context: 'plugins/llm-text-to-sql', test: 'python -m pytest tests/ -q --tb=short' },
  { name: 'Filter service', image: 'd1-filter-service', context: 'plugins/filter-service', test: '' },
  { name: 'Diagnostics service', image: 'd1-diag-service', context: '.', dockerfile: 'plugins/diag-service/Dockerfile', watch: ['plugins/diag-service/', 'scripts/diag/'], test: '' },
  { name: 'Plugin template', image: 'd1-plugin-template', context: 'plugins/plugin-template', test: 'python -m pytest tests/ -q --tb=short' },
  { name: 'Force-app backup server', image: 'd1-backup-server', context: 'apps/force-app/backup-server', test: 'python -m pytest -q --tb=short' },
  { name: 'Force-app bug-report relay', image: 'd1-bug-report-relay', context: 'apps/force-app/bug-report-relay', test: 'python -m pytest -q --tb=short' },
];

// Directus extensions with their own package-lock.json (outside the npm workspace). Nothing
// else builds them: the server builds each one by hand, so a broken import used to surface only
// there. The workspace extensions are built by the directusUi and forceAppJs jobs.
export function standaloneExtensions(root = 'core/extensions') {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${root}/${d.name}/package-lock.json`))
    .map((d) => {
      const scripts = JSON.parse(readFileSync(`${root}/${d.name}/package.json`, 'utf8')).scripts ?? {};
      return { name: d.name, dir: `${root}/${d.name}`, build: 'build' in scripts, test: 'test' in scripts };
    })
    .filter((e) => e.build || e.test)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function plan(changed, extensions = standaloneExtensions()) {
  const everything = changed.length === 0 || changed.some((f) => f.startsWith('.github/'));
  const touches = (prefixes) => everything || changed.some((f) => prefixes.some((p) => f.startsWith(p)));
  return {
    ...Object.fromEntries(Object.entries(JOBS).map(([job, watch]) => [job, touches(watch)])),
    pyServices: PY_SERVICES.filter((s) => touches(s.watch ?? [`${s.dir}/`])).map(({ watch, ...s }) => s),
    images: IMAGES.filter((i) => touches(i.watch ?? [`${i.context}/`])).map(({ watch, ...i }) => ({ dockerfile: `${i.context}/Dockerfile`, ...i })),
    extensions: extensions.filter((e) => touches([`${e.dir}/`])),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [k, v] of Object.entries(plan(process.argv.slice(2)))) {
    const shown = Array.isArray(v) ? v.map((x) => x.image ?? x.name).join(', ') || '(none)' : v;
    console.log(`${k}: ${shown}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${JSON.stringify(v)}\n`);
  }
}
