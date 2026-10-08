// Decide which of CI's per-component builds a run needs, and write them to $GITHUB_OUTPUT as
// JSON matrices. A push to main, a manual run, or a change to CI itself builds everything; a pull
// request builds only the components it touches, so the extension and image matrices cost
// nothing on a PR that doesn't go near them.
//
// Usage: node .github/scripts/ci-plan.mjs [changed-file ...]   (no files = build everything)
// Locally: node .github/scripts/ci-plan.mjs $(git diff --name-only origin/main...HEAD)
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';

// Service images: built from their Dockerfile, then `test` runs inside the image. `always` keeps
// the three images that CI has always built running on every PR, as before. diag-service's and
// filter-service's tests read files outside their image (tests/scripts/diag fixtures; the
// backend's own d1lc.py, to check the two parsers agree): the force-app-python job runs them.
const IMAGES = [
  { name: 'Heavy-data worker (docker build + unit tests)', image: 'd1-heavy-data-worker', context: 'plugins/heavy-data-worker', test: 'python -m pytest tests/ -q --tb=short', always: true },
  { name: 'Analysis worker (docker build + unit tests)', image: 'd1-analysis-worker', context: 'plugins/analysis-worker', test: 'python -m pytest tests/ -q --tb=short', always: true },
  { name: 'Text-to-SQL plugin (docker build + guard tests)', image: 'd1-llm-text-to-sql', context: 'plugins/llm-text-to-sql', test: 'python -m pytest tests/ -q --tb=short', always: true },
  { name: 'Filter service (docker build)', image: 'd1-filter-service', context: 'plugins/filter-service', test: '' },
  { name: 'Diagnostics service (docker build)', image: 'd1-diag-service', context: '.', dockerfile: 'plugins/diag-service/Dockerfile', watch: ['plugins/diag-service/', 'scripts/diag/'], test: '' },
  { name: 'Plugin template (docker build + unit tests)', image: 'd1-plugin-template', context: 'plugins/plugin-template', test: 'python -m pytest tests/ -q --tb=short' },
  { name: 'Force-app backup server (docker build + unit tests)', image: 'd1-backup-server', context: 'apps/force-app/backup-server', test: 'python -m pytest -q --tb=short' },
  { name: 'Force-app bug-report relay (docker build + unit tests)', image: 'd1-bug-report-relay', context: 'apps/force-app/bug-report-relay', test: 'python -m pytest -q --tb=short' },
];

// Directus extensions with their own package-lock.json (outside the npm workspace). Nothing
// else builds them: the server builds each one by hand, so a broken import used to surface only
// there. The workspace extensions are built by the directus-ui and force-app-js jobs.
function standaloneExtensions() {
  const root = 'core/extensions';
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${root}/${d.name}/package-lock.json`))
    .map((d) => {
      const scripts = JSON.parse(readFileSync(`${root}/${d.name}/package.json`, 'utf8')).scripts ?? {};
      return { name: d.name, dir: `${root}/${d.name}`, build: 'build' in scripts, test: 'test' in scripts };
    })
    .filter((e) => e.build || e.test)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const changed = process.argv.slice(2);
const everything = changed.length === 0 || changed.some((f) => f.startsWith('.github/'));
const touches = (prefixes) => everything || changed.some((f) => prefixes.some((p) => f.startsWith(p)));

const images = IMAGES.filter((i) => i.always || touches(i.watch ?? [`${i.context}/`])).map(
  ({ always, watch, ...i }) => ({ dockerfile: `${i.context}/Dockerfile`, ...i }),
);
const extensions = standaloneExtensions().filter((e) => touches([`${e.dir}/`]));

const out = { images: JSON.stringify(images), extensions: JSON.stringify(extensions) };
for (const [k, v] of Object.entries(out)) {
  console.log(`${k}: ${JSON.parse(v).map((x) => x.image ?? x.name).join(', ') || '(none)'}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
}
