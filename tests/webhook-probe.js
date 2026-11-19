// Gõ thẳng vào receiver webhook để kiểm các đường 401 / 400 / 409 / 202 mà
// relay không tự tạo ra được. Chạy trên host (cổng đã publish ra 127.0.0.1):
//
//   node tests/webhook-probe.js
//
// Script KHÔNG chạm vào DB: nó chỉ gửi HTTP và so mã trạng thái. Kiểm trạng
// thái DB sau đó bằng snapshot như mọi ca khác.
import crypto from 'node:crypto';
import { sign } from '../shared/signature.js';

const SENDER = process.env.SENDER_URL ?? 'http://127.0.0.1:3000';
const RECEIVER = process.env.RECEIVER_URL ?? 'http://127.0.0.1:3001';
const SECRET = process.env.WEBHOOK_SECRET ?? 'lab-secret-khong-dung-that';
const EVENT_ID = process.env.EVENT_ID ?? 'E42';

const now = () => Math.floor(Date.now() / 1000);

async function post(rawBody, { timestamp = now(), signature, attempt = 'probe' } = {}) {
  const res = await fetch(`${RECEIVER}/webhooks/summaries`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': String(timestamp),
      'x-webhook-signature': signature ?? sign(SECRET, timestamp, rawBody),
      'x-delivery-attempt': attempt,
    },
    body: rawBody,
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const results = [];
function check(name, expected, got, note = '') {
  const ok = got.status === expected;
  results.push({ ok, name, expected, got: got.status, note: note || got.body?.error || '' });
}

// Lấy đúng các byte đã ký từ outbox của sender: mọi ca dưới đây dựa trên chúng.
const ev = await fetch(`${SENDER}/events/${EVENT_ID}`).then((r) => r.json());
if (!ev.outbox) throw new Error(`sender chưa có event ${EVENT_ID} — chạy /complete trước`);
const raw = Buffer.from(ev.outbox.raw_body, 'utf8');

// 1. Bản sao đúng từng byte -> 202, không tạo dòng inbox thứ hai.
check('bản sao đúng từng byte -> 202', 202, await post(raw));

// 2. Payload bị sửa, chữ ký của bản gốc -> 401.
{
  const good = sign(SECRET, now(), raw);
  const tampered = Buffer.from(raw.toString('utf8').replace('"version":1', '"version":9'), 'utf8');
  check('payload bị sửa, chữ ký cũ -> 401', 401, await post(tampered, { signature: good }));
}

// 3. Chữ ký rác -> 401.
check('chữ ký rác -> 401', 401, await post(raw, { signature: 'f'.repeat(64) }));

// 4. Thiếu header chữ ký -> 401.
check('thiếu chữ ký -> 401', 401, await post(raw, { signature: '' }));

// 5, 6. Timestamp lệch quá 300 s, kiểm CẢ HAI phía.
check('timestamp quá cũ (-400 s) -> 401', 401, await post(raw, { timestamp: now() - 400 }));
check('timestamp ở tương lai (+400 s) -> 401', 401, await post(raw, { timestamp: now() + 400 }));

// 7. Timestamp ngay sát mép trong cửa sổ -> vẫn qua được (202 vì là bản sao).
check('timestamp -290 s (trong cửa sổ) -> 202', 202, await post(raw, { timestamp: now() - 290 }));

// 8. JSON hỏng nhưng chữ ký đúng -> 400 (chữ ký kiểm TRƯỚC khi parse).
check('JSON hỏng, chữ ký đúng -> 400', 400, await post(Buffer.from('{khong phai json', 'utf8')));

// 9. JSON hợp lệ nhưng sai schema -> 400.
{
  const bad = Buffer.from(
    JSON.stringify({
      event_id: 'E777', type: 'summary.completed', schema_version: 1,
      occurred_at: new Date().toISOString(),
      data: { job_id: 'J777', video_id: 'V77', version: 0, summary: 'x' }, // version không dương
    }),
    'utf8',
  );
  check('version = 0 -> 400', 400, await post(bad));
}

// 10. Cùng event_id, payload khác, chữ ký hợp lệ -> 409, không ghi gì.
{
  const other = Buffer.from(raw.toString('utf8').replace('giả định', 'BỊ ĐỔI'), 'utf8');
  const got = await post(other);
  const differs = got.body?.stored_body_sha256 !== got.body?.incoming_body_sha256;
  check('cùng ID khác payload -> 409', 409, got, differs ? 'hash lệch đúng như mong đợi' : 'HASH KHÔNG LỆCH');
}

// 11. F6: 5 bản sao đồng thời -> cả 5 nhận 202, chỉ một dòng inbox.
{
  const five = await Promise.all([1, 2, 3, 4, 5].map(() => post(raw)));
  const all202 = five.every((r) => r.status === 202);
  check('5 bản sao đồng thời -> cả 5 nhận 202', 202, { status: all202 ? 202 : five.find((r) => r.status !== 202).status },
    `mã nhận được: ${five.map((r) => r.status).join(',')}`);
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ` (nhận ${r.got})`}${r.note ? `  — ${r.note}` : ''}`);
}
console.log(failed.length === 0 ? '\n>>> Tất cả ĐẠT.' : `\n>>> ${failed.length} ca KHÔNG ĐẠT.`);
process.exit(failed.length === 0 ? 0 : 1);
