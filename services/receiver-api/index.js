import crypto from 'node:crypto';
import express from 'express';
import { config } from '../../shared/config.js';
import { makeDb } from '../../shared/db.js';
import { marker } from '../../shared/markers.js';
import { validateEvent } from '../../shared/event.js';
import { parseTimestampHeader, timestampWithinWindow, verifySignature } from '../../shared/signature.js';

const db = makeDb(config.receiverDatabaseUrl, 'receiver');
const app = express();

// Lỗi giả đang bật. Đổi được qua route quản trị để ca F8 gỡ fault rồi replay
// mà không phải khởi động lại process.
let fault = config.receiverFault;
const firedOnce = new Set();

// ---------------------------------------------------------------------------
// POST /webhooks/summaries   (transaction T5)
//
// express.raw với type '*/*': handler phải thấy ĐÚNG các byte đã nhận.
//   - KHÔNG mount express.json() ở mức app: parse rồi serialize lại có thể đổi
//     byte (thứ tự khóa, khoảng trắng, escape) và làm chữ ký sai.
//   - type '*/*' chứ không phải 'application/json': nếu bên gửi đặt
//     Content-Type khác thì express.raw sẽ bỏ qua body, req.body thành {} và
//     phép kiểm chữ ký chạy trên byte rỗng — kết quả vô nghĩa.
//
// Thứ tự kiểm (đề bài): timestamp -> HMAC -> parse -> schema -> ghi DB.
// ---------------------------------------------------------------------------
app.post('/webhooks/summaries', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
  // req.body là {} (object rỗng) khi không có body, không phải Buffer.
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  // (1) Cửa sổ thời gian, kiểm CẢ HAI phía: quá cũ và quá xa trong tương lai.
  const timestamp = parseTimestampHeader(req.get('x-webhook-timestamp'));
  if (timestamp === null || !timestampWithinWindow(timestamp, config.timestampWindowS)) {
    return res.status(401).json({ error: 'timestamp thiếu hoặc ngoài cửa sổ cho phép' });
  }

  // (2) HMAC trên raw body, so sánh theo thời gian hằng.
  if (!verifySignature(config.webhookSecret, timestamp, raw, req.get('x-webhook-signature'))) {
    return res.status(401).json({ error: 'chữ ký không hợp lệ' });
  }

  // Fault F8: 503 TRƯỚC khi lưu inbox. Đặt sau phép kiểm chữ ký để ca F8 vẫn
  // là "receiver lỗi tạm thời", không lẫn với ca 401.
  if (fault === 'respond_503_before_inbox') {
    return res.status(503).json({ error: 'receiver đang lỗi (fault của lab)' });
  }

  // (3) Parse. Chỉ xảy ra SAU khi timestamp và chữ ký đã qua.
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'body không phải JSON hợp lệ' });
  }

  // (4) Schema.
  const check = validateEvent(parsed);
  if (!check.ok) return res.status(400).json({ error: `sai schema: ${check.reason}` });
  const ev = check.event;

  // (5) T5: INSERT inbox, commit, RỒI MỚI trả 202.
  // source lấy từ cấu hình gắn với secret, KHÔNG từ header: đọc từ header thì
  // bên gửi chỉ cần đổi source là lách được UNIQUE và tạo bản sao thứ hai.
  const source = config.source;
  const outcome = await db.tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO inbox (source, event_id, event_type, schema_version, video_id, version, raw_body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source, event_id) DO NOTHING
       RETURNING id`,
      [source, ev.event_id, ev.type, ev.schema_version, ev.data.video_id, ev.data.version, raw],
    );
    if (rows.length) return { kind: 'stored', id: rows[0].id };

    // Đã có dòng cho (source, event_id): so hash để biết đây là bản sao thật
    // hay là một payload khác dùng lại cùng ID.
    const { rows: ex } = await c.query(
      `SELECT encode(body_sha256, 'hex') AS body_sha256, status
         FROM inbox WHERE source = $1 AND event_id = $2`,
      [source, ev.event_id],
    );
    return { kind: 'duplicate', existing: ex[0] };
  });

  if (outcome.kind === 'duplicate') {
    const incoming = crypto.createHash('sha256').update(raw).digest('hex');
    if (incoming !== outcome.existing.body_sha256) {
      // Cùng event_id, payload khác: không ghi gì, dữ liệu cũ không đổi.
      return res.status(409).json({
        error: 'event_id đã tồn tại với payload khác',
        event_id: ev.event_id,
        stored_body_sha256: outcome.existing.body_sha256,
        incoming_body_sha256: incoming,
      });
    }
  }

  // F4: dừng ở đây thì inbox đã commit nhưng client chưa có response.
  await marker('after_inbox_commit_before_response');

  // F4 (bản đóng kết nối): commit rồi cắt socket, một lần.
  if (fault === 'close_after_inbox_commit' && !firedOnce.has(fault)) {
    firedOnce.add(fault);
    console.log(`fault ${fault}: đã commit inbox ${ev.event_id}, đóng kết nối`);
    return res.socket.destroy();
  }

  res.status(202).json({
    event_id: ev.event_id,
    duplicate: outcome.kind === 'duplicate',
    inbox_status: outcome.kind === 'duplicate' ? outcome.existing.status : 'RECEIVED',
  });
});

// ---------------------------------------------------------------------------
// GET /inbox/:event_id — RECEIVED hoặc PROCESSED, thời điểm nhận và xử lý.
// ---------------------------------------------------------------------------
app.get('/inbox/:event_id', async (req, res) => {
  const { rows } = await db.pool.query(
    `SELECT source, event_id, event_type, schema_version, video_id, version,
            status, received_at, processed_at,
            encode(body_sha256, 'hex') AS body_sha256
       FROM inbox WHERE source = $1 AND event_id = $2`,
    [config.source, req.params.event_id],
  );
  if (!rows.length) return res.status(404).json({ error: 'chưa nhận event này', event_id: req.params.event_id });
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// GET /videos/:video_id/summary — version hiện tại, nội dung, applied_count.
// Chưa có bản tóm tắt thì 404: đây là điều ca F10 kiểm khi worker đang tắt.
// ---------------------------------------------------------------------------
app.get('/videos/:video_id/summary', async (req, res) => {
  const { rows } = await db.pool.query(
    `SELECT video_id, version, summary, applied_count, source_event_id, updated_at
       FROM video_summaries WHERE video_id = $1`,
    [req.params.video_id],
  );
  if (!rows.length) return res.status(404).json({ error: 'chưa có bản tóm tắt', video_id: req.params.video_id });
  res.json(rows[0]);
});

// ---------------------------------------------------------------------------
// Route quản trị: bật/gỡ lỗi giả. Cổng chỉ publish trên 127.0.0.1 của host.
// ---------------------------------------------------------------------------
const FAULTS = ['', 'respond_503_before_inbox', 'close_after_inbox_commit'];

app.get('/admin/fault', (_req, res) => res.json({ fault, available: FAULTS.filter(Boolean) }));

app.post('/admin/fault', express.json(), (req, res) => {
  const next = req.body?.fault ?? '';
  if (!FAULTS.includes(next)) {
    return res.status(400).json({ error: 'fault không hợp lệ', available: FAULTS.filter(Boolean) });
  }
  fault = next;
  firedOnce.delete(next);
  console.log(`fault = ${fault || 'không'}`);
  res.json({ fault });
});

app.get('/healthz', async (_req, res) => {
  await db.pool.query('SELECT 1');
  res.json({ ok: true, service: 'receiver-api', fault: fault || null });
});

const server = app.listen(config.port, () => {
  console.log(
    `receiver-api nghe ở :${config.port} (source=${config.source}, ` +
      `cửa sổ ${config.timestampWindowS}s, fault=${fault || 'không'}, marker=${config.marker || 'không'})`,
  );
});

process.on('SIGTERM', () => server.close(() => db.pool.end()));
