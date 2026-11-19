import { config } from '../../shared/config.js';
import { makeDb } from '../../shared/db.js';
import { marker } from '../../shared/markers.js';
import { sign } from '../../shared/signature.js';

const db = makeDb(config.senderDatabaseUrl, 'sender');
let stopping = false;

// ---------------------------------------------------------------------------
// T4 — khởi động lại: đóng attempt dang dở VÀ kết sổ vòng đã hết lượt.
//
// UNKNOWN nghĩa là "chưa biết receiver đã nhận hay chưa", và nó TÍNH một lượt
// (lượt đã trừ ở T2). Outbox không có cờ "đang gửi" nên không có gì bị kẹt:
// dòng vẫn PENDING và tự quay lại lượt gửi.
//
// Nhưng nếu relay chết đúng trong lần gửi THỨ 4 thì bước (a) đóng attempt mà
// dòng outbox vẫn PENDING với attempts_in_round = 4: lượt đã hết mà trạng thái
// chưa kết thúc. Thiếu bước (b) thì hoặc relay thử lần thứ 5 và CHECK làm
// transaction hỏng (relay crash, event kẹt PENDING vĩnh viễn), hoặc dòng đó
// không ai nhặt nữa và treo lặng lẽ. Bước (b) đóng vòng đúng như khi lần thứ 4
// chạy xong và thất bại.
//
// DEAD ở đây KHÔNG khẳng định receiver chưa nhận: lần gửi thứ 4 đã bay ra và
// kết quả là UNKNOWN. Replay vẫn an toàn vì inbox chống lặp theo event_id.
// ---------------------------------------------------------------------------
async function closeOrphanAttempts() {
  const res = await db.tx(async (c) => {
    const closed = await c.query(
      `UPDATE delivery_attempts
          SET outcome = 'UNKNOWN', finished_at = clock_timestamp()
        WHERE outcome = 'STARTED'`,
    );
    const dead = await c.query(
      `UPDATE outbox
          SET status = 'DEAD', dead_at = clock_timestamp()
        WHERE status = 'PENDING' AND attempts_in_round >= $1`,
      [config.maxAttemptsPerRound],
    );
    return { closed: closed.rowCount, dead: dead.rowCount };
  });
  if (res.closed > 0) console.log(`T4: đóng ${res.closed} attempt dang dở thành UNKNOWN`);
  if (res.dead > 0) console.log(`T4: kết sổ ${res.dead} event đã hết lượt thành DEAD`);
}

// ---------------------------------------------------------------------------
// T2 — trước khi gửi: lấy một dòng PENDING đã đến hạn, tăng lượt, commit
// attempt STARTED. COMMIT xong mới gọi HTTP (quy tắc 2).
// ---------------------------------------------------------------------------
async function claimNextDue() {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      // attempts_in_round < $1 là BẮT BUỘC, không phải tối ưu: thiếu nó thì
      // relay thử lần thứ 5 và CHECK (attempts_in_round BETWEEN 0 AND 4) làm
      // transaction hỏng. Điều kiện này khớp với partial index outbox_due_idx.
      `SELECT event_id, raw_body, round, attempts_in_round
         FROM outbox
        WHERE status = 'PENDING'
          AND next_attempt_at <= clock_timestamp()
          AND attempts_in_round < $1
        ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [config.maxAttemptsPerRound],
    );
    const ev = rows[0];
    if (!ev) return null;

    const attemptInRound = ev.attempts_in_round + 1;
    const requestTimestamp = Math.floor(Date.now() / 1000);

    await c.query(`UPDATE outbox SET attempts_in_round = $2 WHERE event_id = $1`, [ev.event_id, attemptInRound]);
    const { rows: ins } = await c.query(
      `INSERT INTO delivery_attempts (event_id, round, attempt_in_round, outcome, request_timestamp)
       VALUES ($1, $2, $3, 'STARTED', $4)
       RETURNING attempt_id`,
      [ev.event_id, ev.round, attemptInRound, requestTimestamp],
    );

    return {
      eventId: ev.event_id,
      rawBody: ev.raw_body,
      round: ev.round,
      attemptInRound,
      attemptId: ins[0].attempt_id,
      requestTimestamp,
    };
  });
}

// ---------------------------------------------------------------------------
// Gửi: NGOÀI transaction. Timeout 2 giây, không theo redirect.
// Mỗi lần gửi ký lại timestamp mới; raw_body và event_id không đổi.
// ---------------------------------------------------------------------------
async function postWebhook(job) {
  const signature = sign(config.webhookSecret, job.requestTimestamp, job.rawBody);
  try {
    const res = await fetch(config.webhookUrl, {
      method: 'POST',
      redirect: 'manual', // 3xx là kết quả, không phải đường đi
      signal: AbortSignal.timeout(config.httpTimeoutMs),
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': String(job.requestTimestamp),
        'x-webhook-signature': signature,
        'x-delivery-attempt': job.attemptId,
      },
      body: job.rawBody,
    });
    // undici với redirect:'manual' có thể trả type 'opaqueredirect' (status 0).
    if (res.type === 'opaqueredirect' || res.status === 0) return { redirected: true };
    return { status: res.status, retryAfterS: parseRetryAfter(res.headers.get('retry-after')) };
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return { errorKind: 'TIMEOUT' };
    return { errorKind: 'CONNECTION', detail: err.message };
  }
}

// Retry-After theo RFC 9110 có hai dạng, nhận cả hai:
//   delta-seconds  "20"
//   HTTP-date      "Wed, 21 Oct 2026 07:28:00 GMT"  -> số giây còn lại, sàn 0
// Giá trị lạ hoặc thiếu coi như không có, và dùng backoff thường.
// Kẹp trần retryAfterMaxS để một header lạ không treo cả ca kiểm.
function parseRetryAfter(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v === '') return null;

  let secs = null;
  if (/^\d{1,6}$/.test(v)) {
    secs = Number(v);
  } else {
    const at = Date.parse(v);
    if (!Number.isNaN(at)) secs = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  if (secs === null) return null;

  return Math.min(secs, config.retryAfterMaxS);
}

// ---------------------------------------------------------------------------
// Phân loại phản hồi (slide C):
//   2xx                                  -> ACKNOWLEDGED, DELIVERED
//   timeout, lỗi kết nối, 429, 5xx       -> RETRYABLE, retry theo lịch
//   3xx và 4xx khác                      -> REJECTED, DEAD
// ---------------------------------------------------------------------------
function classify(result) {
  if (result.errorKind) return { outcome: 'RETRYABLE', errorKind: result.errorKind, httpStatus: null, retryAfterS: null };
  if (result.redirected) return { outcome: 'REJECTED', errorKind: 'REDIRECT', httpStatus: null, retryAfterS: null };

  const s = result.status;
  if (s >= 200 && s < 300) return { outcome: 'ACKNOWLEDGED', errorKind: null, httpStatus: s, retryAfterS: null };
  if (s >= 300 && s < 400) return { outcome: 'REJECTED', errorKind: 'REDIRECT', httpStatus: s, retryAfterS: null };
  if (s === 429 || s >= 500) return { outcome: 'RETRYABLE', errorKind: 'HTTP', httpStatus: s, retryAfterS: result.retryAfterS };
  return { outcome: 'REJECTED', errorKind: 'HTTP', httpStatus: s, retryAfterS: null };
}

// ---------------------------------------------------------------------------
// T3 — sau khi gửi: ghi kết quả attempt CÙNG trạng thái và next_attempt_at của
// outbox trong một transaction.
// ---------------------------------------------------------------------------
async function recordOutcome(job, verdict) {
  const retryable = verdict.outcome === 'RETRYABLE';
  const hasBudgetLeft = job.attemptInRound < config.maxAttemptsPerRound;

  // Lịch chờ theo lượt vừa dùng: lần 1 -> 1 s, lần 2 -> 3 s, lần 3 -> 9 s.
  // 429 có Retry-After hợp lệ thì chờ ít nhất thời gian đó.
  const backoffS = (config.retryDelaysMs[job.attemptInRound - 1] ?? config.retryDelaysMs.at(-1)) / 1000;
  const waitS = Math.max(backoffS, verdict.retryAfterS ?? 0);

  await db.tx(async (c) => {
    await c.query(
      `UPDATE delivery_attempts
          SET finished_at = clock_timestamp(), http_status = $2, outcome = $3,
              error_kind = $4, retry_after_s = $5
        WHERE attempt_id = $1`,
      [job.attemptId, verdict.httpStatus, verdict.outcome, verdict.errorKind, verdict.retryAfterS],
    );

    if (verdict.outcome === 'ACKNOWLEDGED') {
      await c.query(
        `UPDATE outbox SET status = 'DELIVERED', delivered_at = clock_timestamp() WHERE event_id = $1`,
        [job.eventId],
      );
    } else if (retryable && hasBudgetLeft) {
      // Lịch chờ nằm trong DB, không trong RAM: relay restart vẫn giữ đúng hẹn.
      await c.query(
        `UPDATE outbox
            SET next_attempt_at = clock_timestamp() + make_interval(secs => $2::double precision)
          WHERE event_id = $1`,
        [job.eventId, waitS],
      );
    } else {
      // Hết 4 lượt, hoặc 3xx / 4xx khác: DEAD, chờ sửa rồi replay.
      await c.query(
        `UPDATE outbox SET status = 'DEAD', dead_at = clock_timestamp() WHERE event_id = $1`,
        [job.eventId],
      );
    }
  });

  const tail = verdict.outcome === 'RETRYABLE' && hasBudgetLeft ? `, chờ ${waitS}s` : '';
  console.log(
    `${job.eventId} vòng ${job.round} lần ${job.attemptInRound}/${config.maxAttemptsPerRound} ` +
      `${job.attemptId}: ${verdict.outcome}` +
      `${verdict.httpStatus ? ` http=${verdict.httpStatus}` : ''}` +
      `${verdict.errorKind ? ` (${verdict.errorKind})` : ''}${tail}`,
  );
}

async function tick() {
  const job = await claimNextDue();
  if (!job) return false;

  const result = await postWebhook(job);
  const verdict = classify(result);

  // F3: kill ở đây thì receiver đã có inbox, sender chưa DELIVERED.
  if (verdict.outcome === 'ACKNOWLEDGED') await marker('after_http_2xx_before_delivery_commit');

  await recordOutcome(job, verdict);
  return true;
}

async function main() {
  if (!config.webhookUrl) throw new Error('thiếu biến môi trường WEBHOOK_URL');
  config.webhookSecret; // bắt lỗi thiếu secret ngay khi khởi động
  console.log(
    `relay chạy: ${config.webhookUrl}, timeout ${config.httpTimeoutMs}ms, ` +
      `tối đa ${config.maxAttemptsPerRound} lần/vòng, chờ ${config.retryDelaysMs.join('/')}ms ` +
      `(marker=${config.marker || 'không'})`,
  );

  await closeOrphanAttempts();

  while (!stopping) {
    const didWork = await tick();
    if (!didWork) await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
  await db.pool.end();
}

process.on('SIGTERM', () => {
  stopping = true;
});

await main();
