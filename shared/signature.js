import crypto from 'node:crypto';

// signed_bytes = UTF8(timestamp + ".") || raw_body_bytes
// signature    = hex(HMAC_SHA256(secret, signed_bytes))
//
// Ký trên RAW BODY, không trên object đã parse: parse rồi serialize lại có thể
// đổi byte (thứ tự khóa, khoảng trắng, escape) và làm chữ ký sai.
export function signedBytes(timestamp, rawBody) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody phải là Buffer');
  return Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
}

export function sign(secret, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret).update(signedBytes(timestamp, rawBody)).digest('hex');
}

// So sánh theo thời gian hằng: so bằng === sẽ thoát sớm ở byte đầu khác nhau
// và để lộ thông tin về chữ ký đúng.
export function verifySignature(secret, timestamp, rawBody, provided) {
  if (typeof provided !== 'string' || !/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = Buffer.from(sign(secret, timestamp, rawBody), 'hex');
  const got = Buffer.from(provided, 'hex');
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, got);
}

// Cửa sổ 300 giây, kiểm CẢ HAI phía: quá cũ và quá xa trong tương lai.
export function parseTimestampHeader(value) {
  if (typeof value !== 'string' || !/^\d{1,11}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function timestampWithinWindow(timestamp, windowS, nowS = Math.floor(Date.now() / 1000)) {
  if (!Number.isInteger(timestamp)) return false;
  return Math.abs(nowS - timestamp) <= windowS;
}
