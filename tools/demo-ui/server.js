// Server của UI demo. Chạy trên HOST (không trong container) vì nó gọi
// `docker compose` để bật/tắt/kill process thật.
//
//   npm run ui   ->  http://127.0.0.1:3100
//
// Server này CHỈ phục vụ demo: nó không tham gia vào đường đi của sự kiện.
// Mọi thao tác nó làm đều là thứ gõ tay được bằng curl và docker compose.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CASES, caseList, runCase, snapshot, resetFixture, setFault, complete, replay, proc, CONF,
} from '../lab.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = Number(process.env.UI_PORT ?? 3100);

const app = express();
app.use(express.json());
app.use(express.static(path.join(HERE, 'public')));
// Sơ đồ hệ thống dùng chung với docs/
app.get('/so-do.svg', (_req, res) => res.sendFile(path.join(ROOT, 'docs/so-do-he-thong.svg')));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

app.get('/api/cases', wrap(async () => ({ cases: caseList() })));
app.get('/api/state', wrap(async () => snapshot()));
app.post('/api/reset', wrap(async () => {
  await resetFixture();
  return { ok: true };
}));
app.post('/api/complete/:jobId', wrap((req) => complete(req.params.jobId)));
app.post('/api/replay/:eventId', wrap((req) => replay(req.params.eventId, req.body?.note)));
app.post('/api/fault', wrap((req) => setFault(req.body?.fault ?? null)));
app.post('/api/proc', wrap(async (req) => {
  const r = await proc(req.body.service, req.body.action);
  return { ok: r.code === 0, out: r.out, err: r.err };
}));

// Một ca chạy tại một thời điểm: các ca đều reset fixture nên chạy chồng sẽ
// phá nhau.
let running = null;

app.get('/api/case/:id/stream', async (req, res) => {
  if (running) {
    res.status(409).json({ error: `đang chạy ca ${running}` });
    return;
  }
  if (!CASES.some((c) => c.id === req.params.id)) {
    res.status(404).json({ error: 'không có ca này' });
    return;
  }
  running = req.params.id;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

  try {
    await runCase(req.params.id, send);
  } catch (e) {
    send({ type: 'error', msg: e.message });
  } finally {
    running = null;
    res.end();
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`UI demo: http://127.0.0.1:${PORT}`);
  console.log(`  sender  ${CONF.senderUrl}`);
  console.log(`  receiver ${CONF.receiverUrl}`);
});
