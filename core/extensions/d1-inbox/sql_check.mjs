// Prints a PREPARE statement for every piece of SQL the d1-inbox endpoint sends (SQL.* and the queries buildListQuery builds), with each `?`
// turned into $1, $2, ... as the Postgres driver sends it. tests/phase1_schema.sh pipes this into psql inside a rolled-back transaction on the
// CI database, so a column, table or type that the real schema does not have fails the build (the unit tests use a fake knex and cannot see that),
// and then runs the summary, list and accept statements on seeded rows. Run by hand: node core/extensions/d1-inbox/sql_check.mjs | psql ...
//
// Names: the SQL key in lower snake case, dots as underscores (junctionFindMany.physical_samples -> junctionfindmany_physical_samples), plus
// count_new, list_new, list_new_scans, accept_open, accept_after and similar for the dynamic queries (the _scans ones are the variants for a database that
// has the surface_scans table).
import { SQL, buildListQuery, parseFileFilters } from './index.js';

const numbered = (sql) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};
const out = [];
const prepare = (name, sql) => out.push(`PREPARE ${name} AS ${numbered(sql)};`);

for (const [key, value] of Object.entries(SQL)) {
  if (typeof value === 'string') prepare(key.toLowerCase(), value);
  else for (const [sub, text] of Object.entries(value)) prepare(`${key}_${sub}`.toLowerCase(), text);
}

const scope = { personId: '00000000-0000-4000-8000-000000000001', teamIds: [], admin: false };
const other = '00000000-0000-4000-8000-000000000002';
const variants = {
  new: {}, older: { tab: 'older' }, open: { tab: 'open' },
  linked: { tab: 'linked', link_kind: 'auto', owner: 'me' },
  dismissed: { tab: 'dismissed', owner: `team:${other}` },
  filtered: { kind: 'image,sem_image', strength: 'short_id,code', folder: 'run', from: '2026-01-01', to: '2026-02-01', owner: `person:${other}` },
};
for (const [name, query] of Object.entries(variants)) {
  const f = parseFileFilters(query);
  prepare(`list_${name}`, buildListQuery(scope, f).sql);
  prepare(`count_${name}`, buildListQuery(scope, f, { count: true }).sql);
  // where the surface_scans table exists the endpoint also leaves out undecided surface scan files that already have a scan
  prepare(`list_${name}_scans`, buildListQuery(scope, f, { scans: true }).sql);
  prepare(`count_${name}_scans`, buildListQuery(scope, f, { count: true, scans: true }).sql);
}
const open = parseFileFilters({}, { defaultTab: 'open' });
prepare('accept_open', buildListQuery(scope, open, { accept: true, pageSize: 500 }).sql);
prepare('accept_after', buildListQuery(scope, open, { accept: true, pageSize: 500, after: { at: '2026-01-01T00:00:00.000Z', id: other } }).sql);

process.stdout.write(`${out.join('\n')}\n`);
