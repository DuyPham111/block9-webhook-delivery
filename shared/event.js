// Hình dạng của sự kiện summary.completed, dùng chung cho hai phía:
// sender serialize MỘT lần ở đây, receiver kiểm schema cũng ở đây.

export const EVENT_TYPE = 'summary.completed';
export const SCHEMA_VERSION = 1;

// event_id dẫn xuất từ job: J42 -> E42.
// Chỉ cần "ổn định và duy nhất"; dẫn xuất từ job làm cho việc gọi lại
// /complete trên job đã DONE tự nhiên trả về cùng event, và snapshot đọc được
// hệt slide. Production nên dùng UUIDv7.
export function eventIdForJob(jobId) {
  const m = /^J(\d+)$/.exec(jobId);
  if (!m) throw new Error(`job_id không theo dạng J<số>: ${jobId}`);
  return `E${m[1]}`;
}

// Serialize đúng MỘT lần. Buffer trả về là thứ được lưu vào outbox.raw_body và
// là thứ được ký; mọi retry và replay gửi lại chính các byte này.
export function buildRawBody({ eventId, job, occurredAt }) {
  const payload = {
    event_id: eventId,
    type: EVENT_TYPE,
    schema_version: SCHEMA_VERSION,
    occurred_at: occurredAt,
    data: {
      job_id: job.job_id,
      video_id: job.video_id,
      version: job.version,
      summary: job.summary,
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

// Kiểm kiểu dữ liệu, trường bắt buộc, type, schema_version và version nguyên
// dương. Trả { ok: true, event } hoặc { ok: false, reason } -> 400.
export function validateEvent(value) {
  const bad = (reason) => ({ ok: false, reason });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('body không phải object');

  const { event_id, type, schema_version, occurred_at, data } = value;
  if (typeof event_id !== 'string' || event_id === '') return bad('event_id phải là string không rỗng');
  if (type !== EVENT_TYPE) return bad(`type phải là '${EVENT_TYPE}'`);
  if (schema_version !== SCHEMA_VERSION) return bad(`schema_version phải là ${SCHEMA_VERSION}`);
  if (typeof occurred_at !== 'string' || Number.isNaN(Date.parse(occurred_at))) return bad('occurred_at phải là thời điểm ISO-8601');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return bad('data phải là object');

  const { job_id, video_id, version, summary } = data;
  if (typeof job_id !== 'string' || job_id === '') return bad('data.job_id phải là string không rỗng');
  if (typeof video_id !== 'string' || video_id === '') return bad('data.video_id phải là string không rỗng');
  if (!Number.isInteger(version) || version <= 0) return bad('data.version phải là số nguyên dương');
  if (typeof summary !== 'string' || summary === '') return bad('data.summary phải là string không rỗng');

  return { ok: true, event: { event_id, type, schema_version, occurred_at, data } };
}
