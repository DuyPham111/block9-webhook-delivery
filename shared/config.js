// Cấu hình đọc một lần khi process khởi động. Không có giá trị nào đọc lại
// giữa đường, để hành vi của một lần chạy là xác định.

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`thiếu biến môi trường ${name}`);
  return v;
}

function int(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} phải là số nguyên, nhận '${v}'`);
  return n;
}

function intList(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n)) throw new Error(`${name} phải là danh sách số nguyên, nhận '${v}'`);
    return n;
  });
}

export const config = {
  // Hai DB logic độc lập: mỗi process chỉ mở pool cho DB của phía mình.
  senderDatabaseUrl: process.env.DATABASE_URL_SENDER,
  receiverDatabaseUrl: process.env.DATABASE_URL_RECEIVER,

  // Webhook
  webhookUrl: process.env.WEBHOOK_URL,
  get webhookSecret() {
    return required('WEBHOOK_SECRET');
  },
  // Tên nguồn gắn với secret trong cấu hình. Receiver KHÔNG đọc source từ
  // header: đọc từ header thì bên gửi đổi source là lách được UNIQUE.
  source: process.env.WEBHOOK_SOURCE ?? 'summary-service',

  // Chính sách của relay (slide: tối đa 4 lần mỗi vòng, chờ 1, 3, 9 giây)
  httpTimeoutMs: int('HTTP_TIMEOUT_MS', 2000),
  maxAttemptsPerRound: int('MAX_ATTEMPTS_PER_ROUND', 4),
  retryDelaysMs: intList('RETRY_DELAYS_MS', [1000, 3000, 9000]),
  pollIntervalMs: int('POLL_INTERVAL_MS', 200),

  // Trần cho Retry-After: một header lạ hoặc một mốc thời gian xa không được
  // treo cả ca kiểm. Giá trị ghi vào delivery_attempts.retry_after_s là giá
  // trị ĐÃ kẹp, để bằng chứng khớp với thời gian chờ thật.
  retryAfterMaxS: int('RETRY_AFTER_MAX_S', 300),

  // Vòng 1 là lần gửi đầu; replay cấp vòng 2..5 -> tối đa 4 lần replay.
  // Hai hằng số này cũng nằm trong CHECK của DB: đổi ở đây mà không viết
  // migration mới thì DB sẽ từ chối.
  maxReplays: int('MAX_REPLAYS', 4),
  get maxRound() {
    return 1 + this.maxReplays;
  },

  // Policy của lab: cửa sổ timestamp 300 giây, kiểm cả hai phía
  timestampWindowS: int('TIMESTAMP_WINDOW_S', 300),

  port: int('PORT', 3000),

  // Lỗi giả của receiver, bật bằng biến môi trường hoặc route quản trị
  // (chỉ mở trên loopback). KHÔNG phải nhánh if (test) trong logic nghiệp vụ:
  // mỗi fault là một điểm trả về sớm, không đổi đường đi của dữ liệu.
  //   respond_503_before_inbox      -> 503 trước khi lưu inbox, giữ cho tới khi gỡ (F8)
  //   close_after_inbox_commit      -> commit inbox rồi đóng kết nối, một lần (F4)
  receiverFault: process.env.RECEIVER_FAULT ?? '',

  // Marker: tên một điểm dừng trong mã. Rỗng thì không có marker nào bật.
  marker: process.env.MARKER ?? '',
  markerReleaseFile: process.env.MARKER_RELEASE_FILE ?? '',
};
