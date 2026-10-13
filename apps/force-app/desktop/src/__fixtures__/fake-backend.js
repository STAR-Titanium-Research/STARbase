// Minimal HTTP fixture standing in for the real recorder backend in sidecar tests.
// Args: <port> [--token=<t>] [--delay=<ms>] [--chatty=<bytes>] [--hang-after=<ms>]
//   token:      serve health on /health/<token> only, so a test's health check can be answered
//               by the process that test started and by nothing else that holds the port
//   delay:      how long /health returns 503 before flipping to 200
//   chatty:     bytes written to stdout per request, synchronously, as uvicorn's access log is:
//               once nobody drains the pipe, that write blocks the whole server (#106)
//   hang-after: block the event loop for good after this long, as a wedged backend would
//   exit-once:  <file>; the first launch exits at once, later ones run normally
//   exit-after: exit with code 3 after this long, as a backend that dies while starting would
const fs = require('node:fs');
const http = require('node:http');

const port = Number(process.argv[2]);
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : 0;
};
const token = (process.argv.find((x) => x.startsWith('--token=')) || '').split('=')[1];
const healthPath = token ? `/health/${token}` : '/health';
const delayMs = arg('delay');
const chattyBytes = arg('chatty');
const hangAfterMs = arg('hang-after');
const exitAfterMs = arg('exit-after');
// --exit-once=<file>: the first launch creates the file and exits at once; later launches see it and run.
const exitOnce = (process.argv.find((x) => x.startsWith('--exit-once=')) || '').split('=')[1];
if (exitOnce && !fs.existsSync(exitOnce)) {
  fs.writeFileSync(exitOnce, '1');
  process.exit(3);
}
const startedAt = Date.now();
const line = chattyBytes ? Buffer.alloc(chattyBytes, 'x') : null;

const server = http.createServer((req, res) => {
  if (line) fs.writeSync(1, line);
  if (req.url === healthPath) {
    if (Date.now() - startedAt < delayMs) {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});
// Loopback only, as the health URL and the real backend use: the wildcard address also clashed
// with any socket on any interface that happened to use the port.
server.listen(port, '127.0.0.1');

if (exitAfterMs) setTimeout(() => process.exit(3), exitAfterMs);

if (hangAfterMs) {
  setTimeout(() => {
    for (;;) {
      /* wedged */
    }
  }, hangAfterMs);
}
