import express from 'express';
import { config } from '../../shared/config.js';
import { makeDb } from '../../shared/db.js';
import { marker } from '../../shared/markers.js';
import { buildRawBody, eventIdForJob } from '../../shared/event.js';

const db = makeDb(config.senderDatabaseUrl, 'sender');
const app = express();

// Sender API nhận JSON bình thường. (Receiver API thì KHÔNG dùng được
// middleware này: nó phải giữ raw body để kiểm chữ ký.)
app.use(express.json({ limit: '64kb' }));

// ---------------------------------------------------------------------------
// POST /jobs/:job_id/complete   (transaction T1)
//
// MỘT transaction: khóa job, đổi READY -> DONE, INSERT outbox. Trả 200 SAU
// commit. Gọi lại job đã DONE trả cùng event, không tạo event mới.
//
// Constraint trigger jobs_done_requires_outbox kiểm tại COMMIT: nếu transaction
// này chỉ UPDATE jobs mà không INSERT outbox thì DB từ chối commit.
// ---------------------------------------------------------------------------
app.post('/jobs/:job_id/complete', async (req, res) => {
  const jobId = req.params.job_id;

  const result = await db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT job_id, video_id, version, summary, status FROM jobs WHERE job_id = $1 FOR UPDATE`,
      [jobId],
    );
    const job = rows[0];
    if (!job) return { http: 404, body: { error: 'job không tồn tại', job_id: jobId } };

    // Đã DONE: đọc event cũ của job và trả về, không sinh event mới.
    if (job.status === 'DONE') {
      const { rows: ex } = await c.query(
        `SELECT event_id, status, round FROM outbox WHERE job_id = $1`,
        [jobId],
      );
      return {
        http: 200,
        body: { job_id: jobId, event_id: ex[0].event_id, already_completed: true, outbox_status: ex[0].status },
      };
    }

    await c.query(
      `UPDATE jobs SET status = 'DONE', done_at = clock_timestamp() WHERE job_id = $1`,
      [jobId],
    );

    // F1: kill ở đây thì transaction chưa commit -> job vẫn READY, không outbox.
    await marker('after_job_update_before_outbox');

    const eventId = eventIdForJob(jobId);
    const rawBody = buildRawBody({ eventId, job, occurredAt: new Date().toISOString() });
    await c.query(
      `INSERT INTO outbox (event_id, job_id, raw_body) VALUES ($1, $2, $3)`,
      [eventId, jobId, rawBody],
    );

    return { http: 200, body: { job_id: jobId, event_id: eventId, already_completed: false, outbox_status: 'PENDING' } };
  });

  // F2: kill ở đây thì DB đã có DONE + outbox PENDING nhưng client không nhận
  // response. Relay vẫn gửi được sau đó.
  if (result.http === 200) await marker('after_sender_commit_before_response');

  res.status(result.http).json(result.body);
});

// ---------------------------------------------------------------------------
// GET /events/:event_id
// Trạng thái outbox và lịch sử các lần gửi: vòng, attempt ID, thời gian, kết quả.
// ---------------------------------------------------------------------------
app.get('/events/:event_id', async (req, res) => {
  const eventId = req.params.event_id;

  const { rows: ob } = await db.pool.query(
    `SELECT event_id, job_id, event_type, schema_version, status, round, attempts_in_round,
            next_attempt_at, created_at, delivered_at, dead_at,
            encode(body_sha256, 'hex') AS body_sha256,
            convert_from(raw_body, 'UTF8') AS raw_body
       FROM outbox WHERE event_id = $1`,
    [eventId],
  );
  if (!ob.length) return res.status(404).json({ error: 'event không tồn tại', event_id: eventId });

  const { rows: attempts } = await db.pool.query(
    `SELECT attempt_id, round, attempt_in_round, started_at, finished_at, http_status,
            outcome, error_kind, retry_after_s, request_timestamp
       FROM delivery_attempts WHERE event_id = $1 ORDER BY started_at, attempt_id`,
    [eventId],
  );
  const { rows: replays } = await db.pool.query(
    `SELECT round, replayed_at, note FROM replays WHERE event_id = $1 ORDER BY replayed_at`,
    [eventId],
  );

  res.json({ outbox: ob[0], attempts, replays });
});

// ---------------------------------------------------------------------------
// POST /events/:event_id/replay
// Chỉ nhận event DEAD. Giữ event_id và raw_body, cấp vòng mới tối đa 4 lần,
// ghi nhận thao tác vào bảng replays. Event chưa DEAD trả 409.
// ---------------------------------------------------------------------------
app.post('/events/:event_id/replay', async (req, res) => {
  const eventId = req.params.event_id;
  const note = typeof req.body?.note === 'string' ? req.body.note : null;

  const result = await db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT event_id, status, round, encode(body_sha256, 'hex') AS body_sha256
         FROM outbox WHERE event_id = $1 FOR UPDATE`,
      [eventId],
    );
    const ev = rows[0];
    if (!ev) return { http: 404, body: { error: 'event không tồn tại', event_id: eventId } };
    if (ev.status !== 'DEAD') {
      return {
        http: 409,
        body: { error: 'chỉ replay được event DEAD', event_id: eventId, status: ev.status },
      };
    }
    // Hết lượt replay là một lý do 409 KHÁC với "chưa DEAD": hai chuyện khác
    // nhau nên phải phân biệt được trong response. Phép kiểm nằm trong
    // transaction, trên dòng outbox đang bị khóa FOR UPDATE ở trên, nên hai
    // request replay đồng thời không thể cùng cấp vòng mới.
    if (ev.round >= config.maxRound) {
      return {
        http: 409,
        body: {
          error: 'đã replay hết số lần cho phép',
          event_id: eventId,
          round: ev.round,
          max_round: config.maxRound,
          max_replays: config.maxReplays,
        },
      };
    }

    const newRound = ev.round + 1;
    // raw_body KHÔNG nằm trong câu UPDATE này: byte được gửi lại y nguyên.
    await c.query(
      `UPDATE outbox
          SET status = 'PENDING', round = $2, attempts_in_round = 0,
              next_attempt_at = clock_timestamp(), dead_at = NULL
        WHERE event_id = $1`,
      [eventId, newRound],
    );
    await c.query(`INSERT INTO replays (event_id, round, note) VALUES ($1, $2, $3)`, [eventId, newRound, note]);

    return {
      http: 202,
      body: {
        event_id: eventId,
        round: newRound,
        max_attempts_in_round: config.maxAttemptsPerRound,
        body_sha256: ev.body_sha256, // bằng chứng raw_body không đổi qua replay
      },
    };
  });

  res.status(result.http).json(result.body);
});

app.get('/healthz', async (_req, res) => {
  await db.pool.query('SELECT 1');
  res.json({ ok: true, service: 'sender-api' });
});

// Nghe trên 0.0.0.0 trong container; cổng chỉ được publish ra 127.0.0.1 của
// host (xem docker-compose.yml), nên route quản trị không ra khỏi máy.
const server = app.listen(config.port, () => {
  console.log(`sender-api nghe ở :${config.port} (marker=${config.marker || 'không'})`);
});

process.on('SIGTERM', () => server.close(() => db.pool.end()));
