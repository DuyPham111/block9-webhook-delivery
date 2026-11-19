// Engine chạy các ca kiểm chứng của Block 9.
//
// Chạy trên HOST (không trong container) vì nó cần gọi `docker compose` để
// dừng, bật và kill process thật — đúng việc mà đề bài yêu cầu harness làm:
//   chờ marker -> kill process thật -> snapshot hai DB -> so expected/observed
//
// Dùng được hai cách:
//   node tools/lab.js list
//   node tools/lab.js case H0
//   node tools/lab.js snapshot
//   node tools/lab.js all
// và UI web gọi runCase() để phát từng bước ra trình duyệt.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONF = {
  network: process.env.LAB_NETWORK ?? 'block9_default',
  image: process.env.LAB_IMAGE ?? 'block9-app:latest',
  secret: process.env.WEBHOOK_SECRET ?? 'lab-secret-khong-dung-that',
  senderUrl: process.env.SENDER_URL ?? 'http://127.0.0.1:3000',
  receiverUrl: process.env.RECEIVER_URL ?? 'http://127.0.0.1:3001',
  pgSender: 'postgres://app:app@postgres:5432/sender',
  pgReceiver: 'postgres://app:app@postgres:5432/receiver',
  webhookUrl: 'http://receiver-api:3001/webhooks/summaries',
  services: ['postgres', 'sender-api', 'relay', 'receiver-api', 'receiver-worker'],
};

// ---------------------------------------------------------------------------
// Chạy lệnh ngoài
// ---------------------------------------------------------------------------
function sh(args, { input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(args[0], args.slice(1), { cwd: ROOT, shell: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.trim(), err: err.trim() });
    });
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

const compose = (...args) => sh(['docker', 'compose', ...args]);

// SQL đi qua stdin: không phải lo chuyện escape dấu nháy trên Windows.
async function psql(db, sql, extra = []) {
  return sh(['docker', 'compose', 'exec', '-T', 'postgres', 'psql', '-U', 'app', '-d', db, '-q', ...extra], {
    input: sql,
  });
}

async function psqlJson(db, sql) {
  const r = await psql(db, sql, ['-t', '-A']);
  if (r.code !== 0) throw new Error(`psql ${db} lỗi: ${r.err || r.out}`);
  try {
    return JSON.parse(r.out || 'null');
  } catch {
    throw new Error(`psql ${db} trả về không phải JSON: ${r.out.slice(0, 200)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* không có body JSON */
    }
    return { status: res.status, body: payload };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Snapshot hai DB + trạng thái process
// ---------------------------------------------------------------------------
const SQL_SENDER = `SELECT json_build_object(
  'jobs',    (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT job_id, video_id, version, status, done_at FROM jobs ORDER BY job_id) t),
  'outbox',  (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT event_id, job_id, status, round, attempts_in_round, next_attempt_at, delivered_at, dead_at, encode(body_sha256,'hex') AS body_sha256 FROM outbox ORDER BY event_id) t),
  'attempts',(SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT attempt_id, event_id, round, attempt_in_round, outcome, http_status, error_kind, retry_after_s, started_at, finished_at FROM delivery_attempts ORDER BY started_at, attempt_id) t),
  'replays', (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT event_id, round, replayed_at, note FROM replays ORDER BY round) t)
)`;

const SQL_RECEIVER = `SELECT json_build_object(
  'inbox',          (SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT source, event_id, video_id, version, status, received_at, processed_at, encode(body_sha256,'hex') AS body_sha256 FROM inbox ORDER BY received_at) t),
  'video_summaries',(SELECT coalesce(json_agg(t), '[]'::json) FROM (SELECT video_id, version, summary, applied_count, source_event_id, updated_at FROM video_summaries ORDER BY video_id) t)
)`;

export async function procStates() {
  // --format json, KHÔNG dùng template có dấu nháy đơn và \t: lệnh chạy qua
  // cmd.exe trên Windows, nơi nháy đơn không phải ký tự trích dẫn nên chuỗi
  // format bị lẫn cả dấu nháy vào output.
  const r = await compose('ps', '-a', '--format', 'json');
  const map = {};
  const rows = [];
  const text = r.out.trim();
  if (text.startsWith('[')) {
    try {
      rows.push(...JSON.parse(text));
    } catch {
      /* bỏ qua, thử từng dòng bên dưới */
    }
  }
  if (rows.length === 0) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* bỏ qua dòng không phải JSON */
      }
    }
  }
  for (const row of rows) {
    const svc = row.Service ?? row.service;
    if (svc) map[svc] = String(row.State ?? row.state ?? '').toLowerCase();
  }
  for (const s of CONF.services) if (!(s in map)) map[s] = 'missing';
  return map;
}

export async function snapshot() {
  const [sender, receiver, procs] = await Promise.all([
    psqlJson('sender', SQL_SENDER),
    psqlJson('receiver', SQL_RECEIVER),
    procStates(),
  ]);
  const health = await http('GET', `${CONF.receiverUrl}/healthz`);
  return { at: new Date().toISOString(), sender, receiver, procs, fault: health.body?.fault ?? null };
}

// ---------------------------------------------------------------------------
// Thao tác cơ bản
// ---------------------------------------------------------------------------
export async function resetFixture() {
  const r = await psql('app', await readFileText('tests/reset-fixture.sql'), ['-v', 'ON_ERROR_STOP=1']);
  if (r.code !== 0) throw new Error(`reset fixture lỗi: ${r.err || r.out}`);
}

async function readFileText(rel) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path.join(ROOT, rel), 'utf8');
}

export const setFault = (fault) => http('POST', `${CONF.receiverUrl}/admin/fault`, { fault: fault || null });
export const complete = (jobId) => http('POST', `${CONF.senderUrl}/jobs/${jobId}/complete`);
export const replay = (eventId, note) => http('POST', `${CONF.senderUrl}/events/${eventId}/replay`, { note: note ?? null });
export const summaryApi = (videoId) => http('GET', `${CONF.receiverUrl}/videos/${videoId}/summary`);

export async function proc(service, action) {
  if (!CONF.services.includes(service)) throw new Error(`service lạ: ${service}`);
  if (action === 'kill') return compose('kill', '-s', 'SIGKILL', service);
  if (action === 'stop') return compose('stop', '-t', '0', service);
  if (action === 'start') return compose('start', service);
  throw new Error(`action lạ: ${action}`);
}

// Chờ tới khi predicate(snapshot) đúng.
async function waitFor(label, predicate, { timeoutMs = 45000, everyMs = 400 } = {}) {
  const until = Date.now() + timeoutMs;
  let snap;
  for (;;) {
    snap = await snapshot();
    if (predicate(snap)) return snap;
    if (Date.now() > until) throw new Error(`hết thời gian chờ: ${label}`);
    await sleep(everyMs);
  }
}

// ---------------------------------------------------------------------------
// Process một lần, chạy với MARKER bật, để kill thật
// ---------------------------------------------------------------------------
const ONEOFF = {
  'sender-api': {
    container: 'block9-case-sender',
    cmd: 'node services/sender-api/index.js',
    env: () => ({ DATABASE_URL_SENDER: CONF.pgSender, WEBHOOK_SECRET: CONF.secret, PORT: '3000' }),
    ports: ['127.0.0.1:3000:3000'],
  },
  relay: {
    container: 'block9-case-relay',
    cmd: 'node services/relay/index.js',
    env: () => ({ DATABASE_URL_SENDER: CONF.pgSender, WEBHOOK_SECRET: CONF.secret, WEBHOOK_URL: CONF.webhookUrl }),
    ports: [],
  },
  'receiver-worker': {
    container: 'block9-case-worker',
    cmd: 'node services/receiver-worker/index.js',
    env: () => ({ DATABASE_URL_RECEIVER: CONF.pgReceiver }),
    ports: [],
  },
};

async function startOneoff(service, envExtra = {}) {
  const spec = ONEOFF[service];
  await compose('stop', '-t', '0', service);
  await sh(['docker', 'rm', '-f', spec.container]);
  const env = { ...spec.env(), ...envExtra };
  const args = ['docker', 'run', '-d', '--name', spec.container, '--network', CONF.network];
  for (const p of spec.ports) args.push('-p', p);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(CONF.image, spec.cmd);
  const r = await sh(args);
  if (r.code !== 0) throw new Error(`không chạy được ${spec.container}: ${r.err || r.out}`);
  return spec.container;
}

async function waitLogLine(container, needle, timeoutMs = 40000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await sh(['docker', 'logs', container]);
    const all = `${r.out}\n${r.err}`;
    if (all.includes(needle)) return all.split('\n').find((l) => l.includes(needle)).trim();
    if (Date.now() > until) throw new Error(`không thấy '${needle}' trong log ${container}`);
    await sleep(300);
  }
}

async function killOneoff(service) {
  const spec = ONEOFF[service];
  await sh(['docker', 'kill', '-s', 'SIGKILL', spec.container]);
  await sh(['docker', 'rm', '-f', spec.container]);
}

// ---------------------------------------------------------------------------
// Định nghĩa các ca. Mỗi ca: { id, title, fault?, steps(ctx) }
// ctx cho phép ghi log từng bước, chụp snapshot có nhãn, và khai báo kiểm tra.
// ---------------------------------------------------------------------------
function makeCtx(emit) {
  const snapshots = {};
  const checks = [];
  const notes = [];
  return {
    snapshots,
    checks,
    notes,
    log(msg) {
      emit({ type: 'step', msg });
    },
    async snap(label) {
      const s = await snapshot();
      snapshots[label] = s;
      emit({ type: 'snapshot', label, snapshot: s });
      return s;
    },
    check(name, expected, observed) {
      const ok = JSON.stringify(expected) === JSON.stringify(observed);
      checks.push({ name, expected, observed, ok });
      emit({ type: 'check', name, expected, observed, ok });
    },
    note(msg) {
      notes.push(msg);
      emit({ type: 'note', msg });
    },
    waitFor,
    sleep,
  };
}

// Tóm gọn một snapshot thành các con số dùng để so expected/observed.
const sum = (s) => ({
  jobs: Object.fromEntries(s.sender.jobs.map((j) => [j.job_id, j.status])),
  outbox: s.sender.outbox.map((o) => ({ event_id: o.event_id, status: o.status, round: o.round, attempts: o.attempts_in_round })),
  attempts: s.sender.attempts.map((a) => ({ id: a.attempt_id, n: a.attempt_in_round, outcome: a.outcome, http: a.http_status })),
  inbox: s.receiver.inbox.map((i) => ({ event_id: i.event_id, version: i.version, status: i.status })),
  summaries: s.receiver.video_summaries.map((v) => ({ video_id: v.video_id, version: v.version, applied_count: v.applied_count })),
});

const H0_EXPECTED = {
  jobs: { J42: 'DONE', J43: 'READY' },
  outboxStatus: ['DELIVERED'],
  inbox: [{ event_id: 'E42', version: 1, status: 'PROCESSED' }],
  summaries: [{ video_id: 'V7', version: 1, applied_count: 1 }],
};

function checkH0(ctx, s, prefix = '') {
  const v = sum(s);
  ctx.check(`${prefix}job J42 DONE, J43 READY`, H0_EXPECTED.jobs, v.jobs);
  ctx.check(`${prefix}một outbox DELIVERED`, H0_EXPECTED.outboxStatus, v.outbox.map((o) => o.status));
  ctx.check(`${prefix}một inbox PROCESSED`, H0_EXPECTED.inbox, v.inbox);
  ctx.check(`${prefix}V7 version 1, applied_count = 1`, H0_EXPECTED.summaries, v.summaries);
}

const waitProcessed = (eventId = 'E42') =>
  waitFor(`inbox ${eventId} PROCESSED`, (s) => s.receiver.inbox.some((i) => i.event_id === eventId && i.status === 'PROCESSED'));
const waitOutbox = (eventId, status) =>
  waitFor(`outbox ${eventId} ${status}`, (s) => s.sender.outbox.some((o) => o.event_id === eventId && o.status === status));

export const CASES = [
  {
    id: 'H0',
    title: 'Hoàn tất J42, không fault',
    expected: 'Job DONE, một outbox DELIVERED, một inbox PROCESSED, V7 version 1, applied_count = 1',
    kill: false,
    async steps(ctx) {
      ctx.log('Hoàn tất J42 qua POST /jobs/J42/complete');
      const r = await complete('J42');
      ctx.check('response 200 kèm event_id E42', { status: 200, event_id: 'E42' }, { status: r.status, event_id: r.body?.event_id });
      ctx.log('Chờ relay giao và worker xử lý');
      const s = await waitProcessed();
      await ctx.snap('cuối cùng');
      checkH0(ctx, s);
    },
  },
  {
    id: 'F1',
    title: 'Kill sender trước INSERT outbox',
    expected: 'Transaction chưa commit → J42 vẫn READY, không có outbox. Gọi complete lại → đạt H0',
    kill: true,
    async steps(ctx) {
      ctx.log('Chạy sender-api với MARKER=after_job_update_before_outbox');
      const c = await startOneoff('sender-api', { MARKER: 'after_job_update_before_outbox' });
      await waitLogLine(c, 'sender-api nghe ở');
      ctx.log('Gọi /complete — request sẽ treo tại marker');
      const pending = complete('J42');
      const line = await waitLogLine(c, 'MARKER after_job_update_before_outbox');
      ctx.note(`marker: ${line}`);
      ctx.log('SIGKILL sender-api (kill process thật)');
      await killOneoff('sender-api');
      const clientRes = await pending;
      ctx.check('client không nhận được response', 0, clientRes.status);
      const s1 = await ctx.snap('sau khi kill');
      const v1 = sum(s1);
      ctx.check('J42 vẫn READY', 'READY', v1.jobs.J42);
      ctx.check('outbox rỗng', 0, v1.outbox.length);
      ctx.log('Bật lại sender-api và gọi /complete lần nữa');
      await compose('start', 'sender-api');
      await waitFor('sender-api sẵn sàng', () => true);
      for (let i = 0; i < 40; i++) {
        const h = await http('GET', `${CONF.senderUrl}/healthz`);
        if (h.status === 200) break;
        await sleep(500);
      }
      await complete('J42');
      const s2 = await waitProcessed();
      await ctx.snap('cuối cùng');
      checkH0(ctx, s2);
    },
  },
  {
    id: 'F2',
    title: 'Kill sender sau commit, trước response',
    expected: 'DB có DONE + outbox PENDING dù client không nhận response. Bật relay → H0; gọi complete lại không tạo event mới',
    kill: true,
    async steps(ctx) {
      ctx.log('Tắt relay để sự kiện nằm lại trong outbox');
      await proc('relay', 'stop');
      ctx.log('Chạy sender-api với MARKER=after_sender_commit_before_response');
      const c = await startOneoff('sender-api', { MARKER: 'after_sender_commit_before_response' });
      await waitLogLine(c, 'sender-api nghe ở');
      const pending = complete('J42');
      const line = await waitLogLine(c, 'MARKER after_sender_commit_before_response');
      ctx.note(`marker: ${line}`);
      ctx.log('SIGKILL sender-api sau khi transaction đã commit');
      await killOneoff('sender-api');
      const clientRes = await pending;
      ctx.check('client không nhận được response', 0, clientRes.status);
      const s1 = await ctx.snap('sau khi kill');
      const v1 = sum(s1);
      ctx.check('J42 đã DONE', 'DONE', v1.jobs.J42);
      ctx.check('outbox E42 PENDING, chưa có attempt', [{ event_id: 'E42', status: 'PENDING', round: 1, attempts: 0 }], v1.outbox);
      ctx.check('inbox rỗng (relay đang tắt)', 0, v1.inbox.length);
      ctx.log('Bật lại sender-api, gọi /complete lần nữa');
      await compose('start', 'sender-api');
      for (let i = 0; i < 40; i++) {
        const h = await http('GET', `${CONF.senderUrl}/healthz`);
        if (h.status === 200) break;
        await sleep(500);
      }
      const again = await complete('J42');
      ctx.check(
        'gọi lại trả cùng event, không tạo event mới',
        { status: 200, event_id: 'E42', already_completed: true },
        { status: again.status, event_id: again.body?.event_id, already_completed: again.body?.already_completed },
      );
      const mid = await snapshot();
      ctx.check('outbox vẫn một dòng', 1, mid.sender.outbox.length);
      ctx.log('Bật relay');
      await proc('relay', 'start');
      const s2 = await waitProcessed();
      await ctx.snap('cuối cùng');
      checkH0(ctx, s2);
    },
  },
  {
    id: 'F3',
    title: 'Kill relay sau 2xx, trước DELIVERED',
    expected: 'Receiver đã có inbox, sender chưa DELIVERED. Restart → gửi lại cùng event_id, attempt ID mới; một inbox, applied_count = 1',
    kill: true,
    async steps(ctx) {
      ctx.log('Tắt relay, hoàn tất J42 để có outbox PENDING');
      await proc('relay', 'stop');
      await complete('J42');
      ctx.log('Chạy relay với MARKER=after_http_2xx_before_delivery_commit');
      const c = await startOneoff('relay', { MARKER: 'after_http_2xx_before_delivery_commit' });
      const line = await waitLogLine(c, 'MARKER after_http_2xx_before_delivery_commit');
      ctx.note(`marker: ${line}`);
      ctx.log('SIGKILL relay ngay sau khi nhận 2xx, trước khi ghi DELIVERED');
      await killOneoff('relay');
      const s1 = await ctx.snap('sau khi kill');
      const v1 = sum(s1);
      ctx.check('outbox còn PENDING', 'PENDING', v1.outbox[0]?.status);
      ctx.check('attempt đầu còn STARTED', 'STARTED', v1.attempts[0]?.outcome);
      ctx.check('receiver ĐÃ có inbox', 1, v1.inbox.length);
      ctx.log('Bật lại relay: T4 đóng attempt dang dở rồi gửi lại cùng event_id');
      await proc('relay', 'start');
      const s2 = await waitOutbox('E42', 'DELIVERED');
      await waitProcessed();
      const s3 = await ctx.snap('cuối cùng');
      const v3 = sum(s3);
      ctx.check('attempt 1 thành UNKNOWN', 'UNKNOWN', v3.attempts[0]?.outcome);
      ctx.check('attempt 2 ACKNOWLEDGED 202', { outcome: 'ACKNOWLEDGED', http: 202 }, { outcome: v3.attempts[1]?.outcome, http: v3.attempts[1]?.http });
      ctx.check('hai attempt cùng một event_id', ['E42', 'E42'], s3.sender.attempts.map((a) => a.event_id));
      ctx.check('vẫn chỉ một inbox', 1, v3.inbox.length);
      checkH0(ctx, s3);
    },
  },
  {
    id: 'F3b',
    title: 'Kill relay trong lần gửi thứ 4 (ca thêm của nhóm)',
    expected: 'Sau restart: attempt thứ 4 thành UNKNOWN, vòng được kết sổ DEAD, relay không thử lần thứ 5 và không crash',
    kill: true,
    async steps(ctx) {
      ctx.log('Hoàn tất J42, rồi chạy relay gửi vào một địa chỉ không có ai nhận');
      await proc('relay', 'stop');
      await complete('J42');
      // Tên một nhãn không có container nào: DNS nội bộ của Docker treo, nên
      // mỗi lần gửi tốn trọn 2 giây timeout. Cần vậy mới có cửa sổ để kill
      // đúng lúc lần thứ 4 đang bay — cổng đóng thì lỗi tức thì, cửa sổ chỉ
      // vài micro giây và không kill kịp.
      const c = await startOneoff('relay', { WEBHOOK_URL: 'http://khong-co-ai-o-day:3001/webhooks/summaries' });
      ctx.log('Chờ tới lần gửi thứ 4 đang bay (mỗi lần tốn 2 giây timeout)');
      await waitFor(
        'attempt thứ 4 đang STARTED',
        (s) => s.sender.attempts.some((a) => a.attempt_in_round === 4 && a.outcome === 'STARTED'),
        { timeoutMs: 60000, everyMs: 150 },
      );
      ctx.log('SIGKILL relay đúng trong lần gửi thứ 4');
      await killOneoff('relay');
      const s1 = await ctx.snap('sau khi kill');
      const v1 = sum(s1);
      ctx.check('đã dùng hết 4 lượt', 4, v1.outbox[0]?.attempts);
      ctx.check('outbox còn PENDING', 'PENDING', v1.outbox[0]?.status);
      ctx.check('attempt thứ 4 còn STARTED', 'STARTED', v1.attempts[3]?.outcome);
      ctx.log('Bật lại relay: T4 phải kết sổ vòng thành DEAD, không thử lần thứ 5');
      await proc('relay', 'start');
      const s2 = await waitOutbox('E42', 'DEAD');
      const v2 = sum(s2);
      ctx.check('attempt thứ 4 thành UNKNOWN', 'UNKNOWN', v2.attempts[3]?.outcome);
      ctx.check('đúng 4 attempt, không có lần thứ 5', 4, v2.attempts.length);
      ctx.check('outbox DEAD', 'DEAD', v2.outbox[0]?.status);
      const procs = await procStates();
      ctx.check('relay vẫn chạy (không crash)', 'running', procs.relay);
      await ctx.snap('cuối cùng');
    },
  },
  {
    id: 'F4',
    title: 'Receiver đóng kết nối sau commit inbox',
    expected: 'Sender thấy lỗi/timeout và retry. Receiver vẫn một inbox; sau khi worker chạy, applied_count = 1',
    kill: false,
    async steps(ctx) {
      ctx.log('Bật fault close_after_inbox_commit (một lần)');
      await setFault('close_after_inbox_commit');
      await complete('J42');
      const s = await waitProcessed();
      await waitOutbox('E42', 'DELIVERED');
      const s2 = await ctx.snap('cuối cùng');
      const v = sum(s2);
      ctx.check('lần gửi 1 là lỗi kết nối', 'RETRYABLE', v.attempts[0]?.outcome);
      ctx.check('lần gửi 2 nhận 202', { outcome: 'ACKNOWLEDGED', http: 202 }, { outcome: v.attempts[1]?.outcome, http: v.attempts[1]?.http });
      ctx.check('vẫn chỉ một inbox', 1, v.inbox.length);
      checkH0(ctx, s2);
      void s;
    },
  },
  {
    id: 'F5',
    title: 'Payload sửa / chữ ký sai / timestamp lệch',
    expected: 'Mỗi request 401; không có inbox mới, không thay đổi nghiệp vụ. Kiểm lệch 300 s cả hai phía',
    kill: false,
    async steps(ctx) {
      ctx.log('Hoàn tất J42 để có raw body đã ký trong outbox');
      await complete('J42');
      await waitProcessed();
      const before = await ctx.snap('trước khi gõ');
      ctx.log('Chạy tests/webhook-probe.js: 11 ca gõ thẳng vào webhook');
      const r = await sh(['node', 'tests/webhook-probe.js']);
      const lines = r.out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l));
      for (const l of lines) ctx.note(l);
      ctx.check('tất cả ca probe đạt', 0, lines.filter((l) => l.startsWith('FAIL')).length);
      ctx.check('số ca probe', 11, lines.length);
      const after = await ctx.snap('cuối cùng');
      ctx.check('inbox không thêm dòng nào', before.receiver.inbox.length, after.receiver.inbox.length);
      ctx.check(
        'applied_count không đổi',
        before.receiver.video_summaries[0]?.applied_count ?? null,
        after.receiver.video_summaries[0]?.applied_count ?? null,
      );
    },
  },
  {
    id: 'F6',
    title: '5 bản sao đồng thời; cùng ID khác body',
    expected: 'Cả 5 nhận 202, một inbox, applied_count = 1. Cùng ID khác body: 409, dữ liệu cũ không đổi',
    kill: false,
    async steps(ctx) {
      ctx.log('Hoàn tất J42 rồi gửi lại 5 bản sao đồng thời');
      await complete('J42');
      await waitProcessed();
      const r = await sh(['node', 'tests/webhook-probe.js']);
      const concurrent = r.out.split('\n').find((l) => l.includes('5 bản sao đồng thời'));
      const conflict = r.out.split('\n').find((l) => l.includes('cùng ID khác payload'));
      ctx.note(concurrent ?? '(không thấy dòng kết quả 5 bản sao)');
      ctx.note(conflict ?? '(không thấy dòng kết quả 409)');
      ctx.check('5 bản sao đồng thời đều 202', true, Boolean(concurrent?.startsWith('PASS')));
      ctx.check('cùng ID khác payload trả 409', true, Boolean(conflict?.startsWith('PASS')));
      const s = await ctx.snap('cuối cùng');
      ctx.check('chỉ một dòng inbox', 1, s.receiver.inbox.length);
      checkH0(ctx, s);
    },
  },
  {
    id: 'F7',
    title: 'Kill worker trước commit',
    expected: 'Sau kill: inbox RECEIVED, chưa có cập nhật nghiệp vụ đã commit. Restart → PROCESSED, applied_count = 1',
    kill: true,
    async steps(ctx) {
      ctx.log('Tắt worker, hoàn tất J42 để inbox dừng ở RECEIVED');
      await proc('receiver-worker', 'stop');
      await complete('J42');
      await waitFor('inbox RECEIVED', (s) => s.receiver.inbox.some((i) => i.status === 'RECEIVED'));
      ctx.log('Chạy worker với MARKER=after_projection_write_before_commit');
      const c = await startOneoff('receiver-worker', { MARKER: 'after_projection_write_before_commit' });
      const line = await waitLogLine(c, 'MARKER after_projection_write_before_commit');
      ctx.note(`marker: ${line}`);
      ctx.log('SIGKILL worker sau khi đã ghi nghiệp vụ, trước commit');
      await killOneoff('receiver-worker');
      const s1 = await ctx.snap('sau khi kill');
      const v1 = sum(s1);
      ctx.check('inbox vẫn RECEIVED', 'RECEIVED', v1.inbox[0]?.status);
      ctx.check('video_summaries rỗng (cùng rollback)', 0, v1.summaries.length);
      const api1 = await summaryApi('V7');
      ctx.check('API bản tóm tắt trả 404', 404, api1.status);
      ctx.log('Bật lại worker: đọc lại đúng dòng đó và áp dụng MỘT lần');
      await proc('receiver-worker', 'start');
      const s2 = await waitProcessed();
      const s3 = await ctx.snap('cuối cùng');
      ctx.check('applied_count = 1 (không phải 2)', 1, s3.receiver.video_summaries[0]?.applied_count);
      checkH0(ctx, s3);
      void s2;
    },
  },
  {
    id: 'F8',
    title: '503 cả 4 lần, rồi replay',
    expected: '4 attempt lỗi, event DEAD, inbox rỗng. Gỡ fault, replay giữ ID + body → DELIVERED, PROCESSED, applied_count = 1',
    kill: false,
    async steps(ctx) {
      ctx.log('Bật fault respond_503_before_inbox');
      await setFault('respond_503_before_inbox');
      await complete('J42');
      ctx.log('Chờ hết 4 lượt, chờ 1 / 3 / 9 giây giữa các lần');
      const s1 = await waitOutbox('E42', 'DEAD');
      await ctx.snap('trước replay');
      const v1 = sum(s1);
      ctx.check('4 attempt, tất cả 503 RETRYABLE', [503, 503, 503, 503], v1.attempts.map((a) => a.http));
      ctx.check('outbox DEAD', 'DEAD', v1.outbox[0]?.status);
      ctx.check('inbox rỗng', 0, v1.inbox.length);
      const waits = [];
      for (let i = 1; i < s1.sender.attempts.length; i++) {
        const prev = new Date(s1.sender.attempts[i - 1].finished_at).getTime();
        const cur = new Date(s1.sender.attempts[i].started_at).getTime();
        waits.push(Math.round((cur - prev) / 100) / 10);
      }
      ctx.note(`khoảng chờ đo từ finished_at: ${waits.join(' / ')} giây (lịch 1 / 3 / 9)`);
      const sha1 = s1.sender.outbox[0]?.body_sha256;
      ctx.log('Gỡ fault rồi replay');
      await setFault(null);
      const rp = await replay('E42', 'gỡ fault 503');
      ctx.check('replay trả 202, cấp vòng 2', { status: 202, round: 2 }, { status: rp.status, round: rp.body?.round });
      const s2 = await waitProcessed();
      const s3 = await ctx.snap('cuối cùng');
      ctx.check('raw body không đổi qua replay', sha1, s3.sender.outbox[0]?.body_sha256);
      checkH0(ctx, s3);
      void s2;
    },
  },
  {
    id: 'F9',
    title: 'E43 (version 2) đến trước E42 (version 1)',
    expected: 'Cả hai inbox PROCESSED; bản hiện tại vẫn version 2, applied_count = 1',
    kill: false,
    async steps(ctx) {
      ctx.log('Hoàn tất J43 (version 2) trước');
      await complete('J43');
      await waitProcessed('E43');
      const mid = await ctx.snap('sau E43 (version 2)');
      ctx.check('V7 ở version 2, applied_count 1', { version: 2, applied_count: 1 }, {
        version: mid.receiver.video_summaries[0]?.version,
        applied_count: mid.receiver.video_summaries[0]?.applied_count,
      });
      ctx.log('Hoàn tất J42 (version 1) sau — phải là no-op về nghiệp vụ');
      await complete('J42');
      await waitProcessed('E42');
      const s = await ctx.snap('cuối cùng');
      const v = sum(s);
      ctx.check('cả hai inbox PROCESSED', ['PROCESSED', 'PROCESSED'], v.inbox.map((i) => i.status));
      ctx.check('bản hiện tại VẪN version 2', 2, v.summaries[0]?.version);
      ctx.check('applied_count vẫn 1', 1, v.summaries[0]?.applied_count);
      ctx.check('bản hiện tại thuộc E43', 'E43', s.receiver.video_summaries[0]?.source_event_id);
    },
  },
  {
    id: 'F10',
    title: 'Worker tắt, hoàn tất J42',
    expected: 'Sender DELIVERED, inbox RECEIVED, API bản tóm tắt trả 404. Bật worker → PROCESSED, bản tóm tắt xuất hiện',
    kill: false,
    async steps(ctx) {
      ctx.log('Tắt receiver-worker');
      await proc('receiver-worker', 'stop');
      await complete('J42');
      const s1 = await waitOutbox('E42', 'DELIVERED');
      await ctx.snap('khi worker đang tắt');
      const v1 = sum(s1);
      ctx.check('sender đã DELIVERED', 'DELIVERED', v1.outbox[0]?.status);
      ctx.check('inbox mới chỉ RECEIVED', 'RECEIVED', v1.inbox[0]?.status);
      ctx.check('video_summaries rỗng', 0, v1.summaries.length);
      const api1 = await summaryApi('V7');
      ctx.check('API bản tóm tắt trả 404', 404, api1.status);
      ctx.note('DELIVERED không chứng minh nghiệp vụ đã đổi — đây chính là giới hạn đã công bố');
      ctx.log('Bật worker');
      await proc('receiver-worker', 'start');
      const s2 = await waitProcessed();
      const api2 = await summaryApi('V7');
      ctx.check('API bản tóm tắt trả 200', 200, api2.status);
      await ctx.snap('cuối cùng');
      checkH0(ctx, s2);
    },
  },
];

export const caseList = () =>
  CASES.map((c) => ({ id: c.id, title: c.title, expected: c.expected, kill: Boolean(c.kill) }));

// ---------------------------------------------------------------------------
// Chạy một ca: reset fixture, chạy các bước, rồi luôn luôn dọn về trạng thái sạch
// ---------------------------------------------------------------------------
export async function runCase(id, emit = () => {}) {
  const def = CASES.find((c) => c.id === id);
  if (!def) throw new Error(`không có ca ${id}`);
  const ctx = makeCtx(emit);
  const started = Date.now();

  emit({ type: 'begin', id: def.id, title: def.title, expected: def.expected });
  let error = null;
  try {
    ctx.log('Dọn về trạng thái fixture và bật đủ 4 process');
    await setFault(null);
    for (const s of ['sender-api', 'relay', 'receiver-api', 'receiver-worker']) await compose('start', s);
    await resetFixture();
    await ctx.snap('bắt đầu');
    await def.steps(ctx);
  } catch (e) {
    error = e.message;
    emit({ type: 'error', msg: e.message });
  } finally {
    // Luôn trả hệ thống về trạng thái chạy được, kể cả khi ca lỗi giữa đường.
    for (const svc of Object.keys(ONEOFF)) await sh(['docker', 'rm', '-f', ONEOFF[svc].container]);
    for (const s of ['sender-api', 'relay', 'receiver-api', 'receiver-worker']) await compose('start', s);
    await setFault(null);
  }

  const failed = ctx.checks.filter((c) => !c.ok);
  const result = {
    id: def.id,
    title: def.title,
    expected: def.expected,
    ok: !error && failed.length === 0,
    error,
    checks: ctx.checks,
    notes: ctx.notes,
    snapshots: ctx.snapshots,
    ms: Date.now() - started,
  };
  emit({ type: 'done', result });
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function cli() {
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'list' || !cmd) {
    for (const c of caseList()) {
      console.log(`${c.id.padEnd(5)} ${c.kill ? '[kill thật]' : '           '} ${c.title}`);
    }
    return;
  }

  if (cmd === 'snapshot') {
    console.log(JSON.stringify(await snapshot(), null, 2));
    return;
  }

  if (cmd === 'reset') {
    await resetFixture();
    console.log('fixture đã reset');
    return;
  }

  if (cmd === 'case') {
    const r = await runCase(arg, (e) => {
      if (e.type === 'step') console.log(`  · ${e.msg}`);
      if (e.type === 'note') console.log(`    ${e.msg}`);
      if (e.type === 'check') {
        console.log(`  ${e.ok ? 'PASS' : 'FAIL'} ${e.name}`);
        if (!e.ok) console.log(`       mong đợi ${JSON.stringify(e.expected)} · quan sát ${JSON.stringify(e.observed)}`);
      }
      if (e.type === 'begin') console.log(`\n=== ${e.id}: ${e.title} ===`);
    });
    console.log(`\n${r.ok ? 'ĐẠT' : 'KHÔNG ĐẠT'} — ${r.checks.filter((c) => c.ok).length}/${r.checks.length} kiểm tra, ${Math.round(r.ms / 1000)}s`);
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'all') {
    const results = [];
    for (const c of CASES) {
      const r = await runCase(c.id, (e) => {
        if (e.type === 'begin') console.log(`\n=== ${e.id}: ${e.title} ===`);
        if (e.type === 'check' && !e.ok) console.log(`  FAIL ${e.name}: mong đợi ${JSON.stringify(e.expected)} · quan sát ${JSON.stringify(e.observed)}`);
      });
      results.push(r);
      console.log(`${r.ok ? 'ĐẠT     ' : 'KHÔNG ĐẠT'} ${r.id} — ${r.checks.filter((x) => x.ok).length}/${r.checks.length} kiểm tra, ${Math.round(r.ms / 1000)}s`);
    }
    const bad = results.filter((r) => !r.ok);
    console.log(`\n${results.length - bad.length}/${results.length} ca ĐẠT`);
    process.exit(bad.length === 0 ? 0 : 1);
  }

  console.error(`lệnh lạ: ${cmd}. Dùng: list | snapshot | reset | case <id> | all`);
  process.exit(2);
}

// Chạy CLI chỉ khi file này được gọi trực tiếp (pathToFileURL để đúng trên Windows).
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
