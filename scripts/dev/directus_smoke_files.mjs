// File steps for scripts/dev/directus_smoke.sh (T0e): the harness inserts a file_fingerprints row between
// the upload and the delete, which the node container cannot do itself. Node 20, no dependencies.
//   node directus_smoke_files.mjs upload        -> prints the new file id
//   node directus_smoke_files.mjs delete <id>   -> prints the HTTP status of DELETE /files/<id>
// Env: DIRECTUS_URL, TOKEN (admin static token of the copy). The throwaway Directus stores uploads inside its
// own container, never in live's uploads volume.
const BASE = process.env.DIRECTUS_URL;
const TOKEN = process.env.TOKEN;
const [mode, id] = process.argv.slice(2);

if (mode === 'upload') {
  const form = new FormData();
  form.append('title', 'smoke fingerprint file');
  form.append('file', new Blob(['smoke file for the file_fingerprints cascade\n'], { type: 'text/plain' }), 'smoke.txt');
  const res = await fetch(`${BASE}/files`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.data?.id) {
    console.error(`upload failed: ${res.status} ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(body.data.id);
} else if (mode === 'delete' && id) {
  const res = await fetch(`${BASE}/files/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log(res.status);
} else {
  console.error('usage: directus_smoke_files.mjs upload | delete <id>');
  process.exit(2);
}
