# Block 9 — Chốt schema, ranh giới transaction, contract và kế hoạch tạo lỗi

Chốt ở bước 8 phút đầu, rà soát lại sau khi đã làm xong Sender API + Outbox +
Relay. Mọi quyết định dưới đây là **bất biến**: code viết sau phải khớp, không
sửa schema cho khớp code.

Nền tảng theo Block 8: Node 22 (ESM) + Express 5 + Postgres 17 + `pg`,
docker compose, mọi cổng chỉ mở trên `127.0.0.1`.

Phần §9 ghi những chỗ **code hiện tại chưa khớp** với bản rà soát này, kèm vị
trí và bản sửa tối thiểu. Phần §10 là checklist trước khi làm Receiver.

---

## 1. Mười quyết định nền tảng

| # | Quyết định | Lý do |
|---|---|---|
| 1 | **Hai database riêng** (`sender`, `receiver`) trên cùng một Postgres container, hai connection pool riêng | Không phải hai schema: hai database làm việc mở một transaction bao quanh cả hai **không thể xảy ra**, không có 2PC. Ràng buộc "không transaction xuyên hai DB" do hạ tầng bảo đảm, không do kỷ luật lập trình |
| 2 | `raw_body BYTEA` ở **cả hai** bên, kèm `body_sha256` là generated column | Chữ ký HMAC ký trên **byte**. Lưu BYTEA thì retry/replay không thể "serialize lại" làm đổi byte. `sha256` do DB tính nên so bản sao (F6) và đối chiếu hai bên chỉ cần một cột |
| 3 | Thời gian dùng `clock_timestamp()`, không `now()` | `now()` là giờ **mở transaction**; khoảng chờ 1/3/9 s ở F8 phải đo bằng giờ thật |
| 4 | `event_id` = `'E'` + số của job (J42 → E42), `attempt_id` từ sequence (A1, A2…) | Snapshot đọc được hệt slide. Yêu cầu thật chỉ là "ổn định và duy nhất"; production dùng UUIDv7. Dẫn xuất từ job khiến gọi lại `complete` trên job đã DONE **tự nhiên** trả về cùng event |
| 5 | Outbox **không có cột "đang gửi"** | Cờ đó sẽ kẹt sau crash. Relay chỉ đọc `PENDING`, đã đến hạn, **và còn lượt**; dòng dang dở tự quay lại lượt gửi (quy tắc 2) |
| 6 | `outbox.job_id UNIQUE` + `inbox UNIQUE (source, event_id)` | Hai ràng buộc chống lặp đặt ở **DB**, không ở code: một job tối đa một event, một (source, event) tối đa một inbox |
| 7 | `inbox.source` lấy từ **cấu hình gắn với secret**, không từ header | Nếu đọc từ header thì bên gửi chỉ cần đổi `source` là lách được UNIQUE và tạo được bản sao thứ hai |
| 8 | **Tối đa 4 lần replay**: vòng 1 là lần gửi đầu, replay cấp vòng 2…5 | Một event `DEAD` không được replay vô hạn. Cả `outbox.round` và `replays.round` đều có CHECK, nên không có đường nào vượt qua được bằng code |
| 9 | **Hai hằng số của lab nằm thẳng trong CHECK**: 4 lần mỗi vòng, 5 vòng | Đổi `MAX_ATTEMPTS_PER_ROUND` hay `MAX_REPLAYS` trong `.env` mà không viết migration thì DB từ chối. Đó là ý muốn: hằng số của bài không được đổi lặng lẽ qua biến môi trường |
| 10 | **Không cần extension nào.** `sha256(bytea)` là hàm có sẵn của Postgres (≥ 11) | `pgcrypto` chỉ cần nếu dùng `digest()` / `crypt()`; bài này không dùng. `gen_random_uuid()` cũng có sẵn từ PG 13 nếu sau này cần. Nếu nhóm thêm hàm của pgcrypto thì phải `CREATE EXTENSION pgcrypto` ở **cả hai** DB — extension không dùng chung được giữa hai database |

> Lưu ý về quyết định 4: `nextval` **không** thuộc transaction, nên một INSERT
> attempt bị rollback vẫn tiêu một số và dãy `attempt_id` có thể nhảy (A1, A3…).
> Điều này đã kiểm bằng thực nghiệm. `attempt_id` vẫn duy nhất và ổn định, chỉ
> không liên tục; khi trình bày thì đọc theo `(round, attempt_in_round)`, đừng
> đọc theo số trong `attempt_id`.

> Lưu ý về quyết định 8: câu "cấp vòng mới tối đa 4 lần" trong đề bài **nhiều
> khả năng** nói về *một vòng mới gồm tối đa 4 lần gửi* — tức là đúng cái giới
> hạn 4 lần mỗi vòng đã có. Giới hạn 4 lần **replay** là quyết định thêm của
> nhóm, không phải câu chữ của đề. Ghi rõ ở đây để khi trình bày không nói sai
> là đề yêu cầu.

### Bất biến do DB tự bảo đảm (không tin vào code)

Mỗi dòng dưới đây là một trigger thật, đã kiểm trong `tests/schema-invariants.sql`.

**DB `sender`**

| Trigger | Bảo đảm |
|---|---|
| `jobs_done_requires_outbox` (constraint, deferred) | Commit nào để lại `status='DONE'` mà không có dòng `outbox` thì **bị từ chối**. Kiểm tại COMMIT nên thứ tự UPDATE → INSERT trong transaction vẫn hợp lệ |
| `outbox_delete_keeps_invariant` (constraint, deferred) | **Mặt còn lại** của cùng bất biến: xóa dòng outbox của một job đang `DONE` cũng bị từ chối. Deferred nên nếu cùng transaction đưa job về `READY` thì vẫn hợp lệ |
| `outbox_truncate_guard`, `jobs_truncate_guard`, `delivery_attempts_truncate_guard`, `replays_truncate_guard` | `TRUNCATE` **không** kích hoạt trigger `DELETE`, nên phải chặn riêng bằng trigger `BEFORE TRUNCATE` |
| `outbox_immutable` | `event_id`, `job_id`, `raw_body`, `event_type`, `schema_version`, `created_at` là **bất biến**; `round` chỉ tăng |
| `jobs_stable_after_done` | Job đã `DONE` thì không quay lại `READY`, và `video_id` / `version` / `summary` bất biến — vì `raw_body` được serialize **từ** chúng |

**DB `receiver`**

| Trigger | Bảo đảm |
|---|---|
| `inbox_immutable` | Chỉ `status` và `processed_at` được đổi; `PROCESSED` là một chiều, không quay về `RECEIVED` để xử lý lại |
| `inbox_delete_blocked` | Không xóa được dòng inbox: dòng đó **chính là** bằng chứng chống lặp |
| `inbox_truncate_guard`, `video_summaries_truncate_guard` | như trên |
| `video_summaries_version_monotonic` | Không `UPDATE` nào hạ được `version` (F9) |

### Cửa thoát cho harness

Reset fixture giữa các ca cần `TRUNCATE` và cần đưa job về `READY` — đúng những
việc các trigger trên chặn. Nên có **một** cửa thoát, bật trong chính transaction
đang reset:

```sql
BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE replays, delivery_attempts, outbox;
  UPDATE jobs SET status = 'READY', done_at = NULL;
COMMIT;
```

Hàm `block9_fixture_reset()` (có ở **cả hai** DB) đọc cờ này. **Mã nghiệp vụ
không bao giờ được bật cờ này** — chỉ harness và script reset.

---

## 2. Schema

Migration chạy theo thứ tự tên file, nạp qua `/docker-entrypoint-initdb.d`:

```
db/000_databases.sql    CREATE DATABASE sender; CREATE DATABASE receiver;
db/010_sender.sql       \connect sender   -> jobs, outbox, delivery_attempts, replays
db/020_receiver.sql     \connect receiver -> inbox, video_summaries
db/030_seed_sender.sql  \connect sender   -> fixture J42 (V7 v1), J43 (V7 v2), cả hai READY
```

Mỗi file `010`/`020`/`030` mở đầu bằng một khối kiểm `current_database()`: chạy
sai DB thì **hỏng ngay**, không âm thầm tạo bảng ở database `app`. Đã kiểm sau
khi dựng lại từ volume trống: `sender` có 4 bảng, `receiver` có 2 bảng, `app`
có **0 bảng**.

### DB `sender`

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `jobs` | `job_id` PK, `video_id`, `version`, `summary`, `status` (`READY`/`DONE`), `done_at` | `UNIQUE (video_id, version)`; `done_at` buộc khớp `status` |
| `outbox` | `event_id` PK, `job_id` **UNIQUE** FK, `event_type`, `schema_version`, `raw_body`, `body_sha256`, `status` (`PENDING`/`DELIVERED`/`DEAD`), `round` (**1–5**), `attempts_in_round` (0–4), `next_attempt_at`, `created_at`, `delivered_at`, `dead_at` | `delivered_at`/`dead_at` buộc khớp `status` |
| `delivery_attempts` | `attempt_id` PK (`A1`, `A2`…), `event_id` FK, `round` (1–5), `attempt_in_round` (1–4), `started_at`, `finished_at`, `http_status`, `outcome`, `error_kind`, `retry_after_s`, `request_timestamp` | `UNIQUE (event_id, round, attempt_in_round)`; CHECK `finished_at IS NULL` **khi và chỉ khi** `outcome='STARTED'` |
| `replays` | `event_id` FK, `round` (**2–5**), `replayed_at`, `note` | `UNIQUE (event_id, round)` — mỗi replay cấp đúng một vòng mới |

Index mà relay quét — điều kiện "còn lượt" nằm trong **chính index**, nên một
dòng đã dùng hết 4 lượt không bao giờ được nhặt lên gửi lần thứ 5:

```sql
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at)
  WHERE status = 'PENDING' AND attempts_in_round < 4;
```

`outcome` ∈ `STARTED`, `ACKNOWLEDGED`, `RETRYABLE`, `REJECTED`, `UNKNOWN`.
`error_kind` ∈ `TIMEOUT`, `CONNECTION`, `HTTP`, `REDIRECT`.
`request_timestamp` là `X-Webhook-Timestamp` đã ký của lần gửi đó — bằng chứng
mỗi lần gửi ký lại timestamp mới trong khi `raw_body` không đổi (câu hỏi 3).

### DB `receiver`

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `inbox` | `id` PK, `source`, `event_id`, `event_type`, `schema_version`, `video_id`, `version`, `raw_body`, `body_sha256`, `status` (`RECEIVED`/`PROCESSED`), `received_at`, `processed_at` | **`UNIQUE (source, event_id)`**; partial index `(received_at) WHERE status='RECEIVED'`; `processed_at` buộc khớp `status` |
| `video_summaries` | `video_id` PK, `version`, `summary`, `applied_count`, `source_event_id`, `updated_at` | `applied_count` chỉ tăng khi version mới **thật sự** thay bản hiện tại |

---

## 3. Ranh giới transaction

Sáu transaction, không có cái nào bao quanh một lời gọi HTTP.

### T1 — Sender `POST /jobs/:job_id/complete`

```sql
BEGIN;
  SELECT * FROM jobs WHERE job_id = $1 FOR UPDATE;          -- khóa dòng job
  -- đã DONE: đọc outbox của job, COMMIT, trả 200 với event cũ (không tạo mới)
  UPDATE jobs SET status = 'DONE', done_at = clock_timestamp() WHERE job_id = $1;
  INSERT INTO outbox (event_id, job_id, raw_body) VALUES ($2, $1, $3);
COMMIT;                                                      -- trigger kiểm tại đây
-- chỉ SAU commit mới trả 200 { job_id, event_id }
```

Marker `after_job_update_before_outbox` nằm **giữa** UPDATE và INSERT → kill ở
đó thì cả hai mất (F1). Marker `after_sender_commit_before_response` nằm **sau**
COMMIT → kill ở đó thì DB có cả hai, client không nhận response (F2).

### T2 — Relay, trước khi gửi

```sql
BEGIN;
  SELECT * FROM outbox
   WHERE status = 'PENDING'
     AND next_attempt_at <= clock_timestamp()
     AND attempts_in_round < 4            -- CÒN LƯỢT: xem T4
   ORDER BY next_attempt_at
     FOR UPDATE SKIP LOCKED LIMIT 1;
  UPDATE outbox SET attempts_in_round = attempts_in_round + 1 WHERE event_id = $1;
  INSERT INTO delivery_attempts (event_id, round, attempt_in_round, outcome, request_timestamp)
  VALUES ($1, $2, $3, 'STARTED', $4);
COMMIT;                              -- commit TRƯỚC khi gọi HTTP (quy tắc 2)
```

Điều kiện `attempts_in_round < 4` là **bắt buộc**, không phải tối ưu: thiếu nó
thì relay sẽ thử lần thứ 5 và `CHECK (attempts_in_round BETWEEN 0 AND 4)` làm
transaction hỏng. Xem T4.

`SKIP LOCKED` không cần cho một relay, nhưng để sẵn thì chạy nhiều relay không
sai về khóa (vẫn **không** tuyên bố đúng khi nhiều relay: giới hạn đã công bố).

### T3 — Relay, sau khi gửi (HTTP nằm ngoài transaction: timeout 2 s, không theo redirect)

```sql
BEGIN;
  UPDATE delivery_attempts
     SET finished_at = clock_timestamp(), http_status = $2, outcome = $3,
         error_kind = $4, retry_after_s = $5
   WHERE attempt_id = $1;
  -- 2xx                 -> outbox DELIVERED, delivered_at
  -- retryable, còn lượt -> PENDING, next_attempt_at = clock_timestamp() + backoff
  -- retryable, hết 4    -> DEAD, dead_at
  -- 3xx / 4xx khác      -> DEAD, dead_at
COMMIT;
```

`backoff` = 1, 3, 9 s theo `attempts_in_round`; `Retry-After` xử lý ở §5. Marker
`after_http_2xx_before_delivery_commit` nằm giữa T2 và T3 (F3).

### T4 — Relay khởi động lại: đóng attempt dang dở **và kết sổ vòng đã hết lượt**

```sql
BEGIN;
  -- (a) đóng mọi attempt dang dở
  UPDATE delivery_attempts
     SET outcome = 'UNKNOWN', finished_at = clock_timestamp()
   WHERE outcome = 'STARTED';

  -- (b) kết sổ mọi vòng đã dùng hết 4 lượt mà vẫn còn PENDING
  UPDATE outbox
     SET status = 'DEAD', dead_at = clock_timestamp()
   WHERE status = 'PENDING' AND attempts_in_round >= 4;
COMMIT;
```

`UNKNOWN` **tính một lượt** — lượt đã trừ ở T2. Vì vậy nếu relay chết ngay
trong **lần thứ 4**, bước (a) đóng attempt nhưng dòng outbox vẫn `PENDING` với
`attempts_in_round = 4`: lượt đã hết mà trạng thái chưa kết thúc. Thiếu bước
(b) thì:

- hoặc relay thử lần thứ 5 → `CHECK` từ chối → transaction hỏng → **relay
  crash**, và event kẹt `PENDING` vĩnh viễn;
- hoặc, nếu T2 đã lọc `attempts_in_round < 4`, dòng đó không ai nhặt nữa và
  **lặng lẽ treo** — không `DELIVERED`, không `DEAD`, không ai biết.

Cả hai đều sai. Bước (b) đóng vòng đúng như khi lần thứ 4 chạy xong và thất bại:
`DEAD`, chờ người sửa rồi replay.

Trạng thái `DEAD` ở đây **không** khẳng định receiver chưa nhận được — lần gửi
thứ 4 đã bay ra và kết quả là `UNKNOWN`. Replay vẫn an toàn vì `inbox` chống
lặp theo `event_id`.

### T5 — Receiver `POST /webhooks/summaries`

Thứ tự kiểm: cửa sổ timestamp 300 s → HMAC trên raw body (so sánh thời gian
hằng) → parse + schema → mới ghi DB. Chi tiết cách giữ raw body ở §6.

```sql
BEGIN;
  INSERT INTO inbox (source, event_id, event_type, schema_version, video_id, version, raw_body)
  VALUES (...) ON CONFLICT (source, event_id) DO NOTHING
  RETURNING id;
  -- không có RETURNING: đọc dòng cũ, so body_sha256
  --   trùng  -> 202 (bản sao)
  --   khác   -> 409, không ghi gì
COMMIT;
-- chỉ SAU commit mới trả 202
```

`ON CONFLICT DO NOTHING` là một câu lệnh nguyên tử nên 5 bản sao đồng thời (F6)
không cần khóa ngoài. Marker `after_inbox_commit_before_response` nằm giữa
COMMIT và response (F4).

### T6 — Receiver worker

```sql
BEGIN;
  SELECT * FROM inbox WHERE status = 'RECEIVED'
   ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1;      -- khóa dòng
  INSERT INTO video_summaries (video_id, version, summary, applied_count, source_event_id)
  VALUES ($1, $2, $3, 1, $4)
  ON CONFLICT (video_id) DO UPDATE
     SET version=EXCLUDED.version, summary=EXCLUDED.summary,
         source_event_id=EXCLUDED.source_event_id,
         applied_count=video_summaries.applied_count+1, updated_at=clock_timestamp()
   WHERE video_summaries.version < EXCLUDED.version;         -- chỉ khi version mới LỚN HƠN

  UPDATE inbox SET status = 'PROCESSED', processed_at = clock_timestamp()
   WHERE id = $5 AND status = 'RECEIVED';                    -- chỉ RECEIVED -> PROCESSED
  -- rowCount phải = 1, nếu không thì ROLLBACK
COMMIT;                              -- PROCESSED và thay đổi nghiệp vụ cùng commit
```

Hai điều kiện ở câu UPDATE cuối là bắt buộc:

- `AND status = 'RECEIVED'` — worker chỉ chuyển một chiều `RECEIVED → PROCESSED`,
  không bao giờ "đánh dấu lại" một dòng đã xử lý.
- **Kiểm `rowCount === 1`**, nếu không thì `throw` để cả transaction rollback.
  Dòng đang bị khóa trong chính transaction này, nên `rowCount = 0` không phải
  tranh chấp mà là **lỗi logic** (lấy sai dòng, hoặc đã `PROCESSED`). Lặng lẽ
  commit khi `rowCount = 0` sẽ ghi thay đổi nghiệp vụ mà không đánh dấu inbox —
  đúng cái bẫy mà quy tắc 6 cấm.

Mệnh đề `WHERE` trên `DO UPDATE` làm sự kiện version cũ thành **no-op**: F9 giữ
version 2 và `applied_count = 1`. Marker
`after_projection_write_before_commit` nằm giữa UPSERT và COMMIT (F7).

---

## 4. Replay: giới hạn và cách kiểm

Vòng 1 là lần gửi đầu. Mỗi replay cấp một vòng mới, **tối đa 4 lần** → vòng cao
nhất là 5. Toàn bộ phép kiểm nằm trong **một transaction**, trên dòng outbox
đang **bị khóa**, nên hai request replay đồng thời không thể cùng cấp vòng mới:

```sql
BEGIN;
  SELECT status, round FROM outbox WHERE event_id = $1 FOR UPDATE;   -- khóa dòng
  -- không có dòng          -> 404
  -- status <> 'DEAD'       -> 409  (chưa DEAD thì không replay)
  -- round >= 5             -> 409  (đã replay 4 lần)
  UPDATE outbox
     SET status = 'PENDING', round = round + 1, attempts_in_round = 0,
         next_attempt_at = clock_timestamp(), dead_at = NULL
   WHERE event_id = $1;
  INSERT INTO replays (event_id, round, note) VALUES ($1, round + 1, $2);
COMMIT;
```

`raw_body` **không** nằm trong câu UPDATE: byte được gửi lại y nguyên, và
trigger `outbox_immutable` sẽ từ chối nếu có ai thử sửa. Response trả về
`body_sha256` để đối chiếu trước/sau.

Hai lý do `409` khác nhau phải phân biệt được trong body response, vì chúng nói
hai chuyện khác nhau: *"chưa DEAD"* và *"đã hết lượt replay"*.

---

## 5. `Retry-After`: cả số giây và HTTP-date

Đề bài: *"429 có `Retry-After` hợp lệ thì chờ ít nhất thời gian đó"*. RFC 9110
cho phép hai dạng, phải nhận cả hai:

| Dạng | Ví dụ | Xử lý |
|---|---|---|
| delta-seconds | `Retry-After: 20` | 20 giây |
| HTTP-date | `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` | `ceil((date - now) / 1000)`, kẹp sàn về 0 |
| không hợp lệ / thiếu | `Retry-After: soon` | coi như **không có**, dùng backoff thường |

Hai quyết định thêm:

- **Kẹp trần `RETRY_AFTER_MAX_S` (mặc định 300 giây).** Một header lạ hoặc một
  mốc thời gian xa có thể treo cả ca kiểm. Giá trị ghi vào
  `delivery_attempts.retry_after_s` là giá trị **đã kẹp**, để bằng chứng khớp
  với thời gian chờ thật.
- Chờ thật là `max(backoff, retry_after)` — "ít nhất thời gian đó", nhưng cũng
  không ngắn hơn lịch 1/3/9 s. Áp dụng cho cả `429` và `5xx` nếu có header; đề
  chỉ nói về `429`, và cách này không trái với đề.

---

## 6. Receiver phải giữ raw body: `express.raw()`

Chữ ký ký trên **byte đã nhận**. Parse JSON rồi serialize lại có thể đổi byte
(thứ tự khóa, khoảng trắng, escape Unicode) và làm chữ ký sai. Nên:

```js
// KHÔNG mount express.json() trên receiver app.
app.post('/webhooks/summaries',
  express.raw({ type: '*/*', limit: '64kb' }),
  handler);
```

Bốn chi tiết dễ sai:

1. **`type: '*/*'`**, không phải `'application/json'`. Nếu bên gửi đặt
   `Content-Type` khác thì `express.raw` sẽ bỏ qua body và `req.body` thành `{}`
   — lúc đó phép kiểm chữ ký làm việc trên byte rỗng, kết quả vô nghĩa.
2. `req.body` là `{}` (object rỗng) khi **không có** body, không phải `Buffer`.
   Chuẩn hóa trước khi dùng:
   `const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);`
3. **Không** `express.json()` ở mức app trên receiver. Nếu cần route khác nhận
   JSON thì mount `express.json()` riêng cho từng route đó.
4. `JSON.parse(raw)` bọc `try/catch` → `400`. Parse chỉ xảy ra **sau** khi
   timestamp và chữ ký đã qua.

Thứ tự đầy đủ của handler:

```
1. raw = Buffer của body
2. timestamp: phải là số nguyên, abs(now - ts) <= 300  -> sai: 401, không ghi gì
3. HMAC trên (timestamp + "." + raw), so sánh timingSafeEqual  -> sai: 401
4. JSON.parse(raw)                                     -> lỗi: 400
5. validateEvent(...)                                  -> sai: 400
6. T5: INSERT inbox ... ON CONFLICT DO NOTHING, COMMIT  -> 202 / 409
```

Sender API thì dùng `express.json()` bình thường — nó không xác minh chữ ký.

---

## 7. Bảng ánh xạ contract → schema

| Contract | Đọc / ghi |
|---|---|
| `POST /jobs/:job_id/complete` → `200 {job_id, event_id}` | T1: `jobs`, `outbox` |
| `GET /events/:event_id` | `outbox` (status, round, attempts_in_round, next_attempt_at) + `delivery_attempts` (attempt_id, round, thời gian, http_status, outcome) + `replays` |
| `POST /events/:event_id/replay` | §4. `404` không có event; `409` chưa `DEAD`; `409` đã replay 4 lần; `202` kèm `round` mới và `body_sha256` |
| `POST /webhooks/summaries` → `202` / `409` / `401` / `400` | §6 rồi T5: `inbox` (+ `body_sha256` để phân biệt 202 và 409) |
| `GET /inbox/:event_id` | `inbox.status`, `received_at`, `processed_at` |
| `GET /videos/:video_id/summary` → `404` khi chưa có | `video_summaries` (version, summary, applied_count) |
| Relay policy: timeout 2 s, không redirect | `delivery_attempts.error_kind`, `outbox.next_attempt_at`, `retry_after_s` |

Payload (`raw_body` đúng các byte này, serialize một lần):

```json
{"event_id":"E42","type":"summary.completed","schema_version":1,
 "occurred_at":"2026-11-18T08:00:00Z",
 "data":{"job_id":"J42","video_id":"V7","version":1,"summary":"..."}}
```

```
X-Webhook-Timestamp : giây Unix, số nguyên       -> delivery_attempts.request_timestamp
X-Webhook-Signature : 64 ký tự hex
X-Delivery-Attempt  : A2  (chỉ để đối chiếu log) -> delivery_attempts.attempt_id

signed_bytes = UTF8(timestamp + ".") || raw_body_bytes
signature    = hex(HMAC_SHA256(secret, signed_bytes))
```

---

## 8. Kế hoạch tạo lỗi: marker ↔ ca ↔ cột chứng minh

| Ca | Cách tạo | Cột chứng minh |
|---|---|---|
| F1 | kill sender tại `after_job_update_before_outbox` | `jobs.status='READY'`, `outbox` rỗng |
| F2 | tắt relay, kill sender tại `after_sender_commit_before_response` | `jobs.status='DONE'` + `outbox.status='PENDING'`, client không có response |
| F3 | kill relay tại `after_http_2xx_before_delivery_commit` | `outbox.status='PENDING'` + `delivery_attempts` A1 `STARTED` → sau restart `UNKNOWN`, A2 `ACKNOWLEDGED`; `inbox` **một** dòng |
| F4 | marker `after_inbox_commit_before_response`, bật một lần | `inbox` một dòng; A1 `RETRYABLE`/`UNKNOWN`, A2 `ACKNOWLEDGED`; `applied_count=1` |
| F5 | sửa payload / sai chữ ký / timestamp lệch ±300 s | mọi request `401`, `inbox` rỗng, `video_summaries` không đổi |
| F6 | 5 request đồng thời; thêm một request cùng ID khác body | `inbox` một dòng (UNIQUE), `409` cho body khác (`body_sha256` lệch), `applied_count=1` |
| F7 | kill worker tại `after_projection_write_before_commit` | sau kill `inbox.status='RECEIVED'` và `video_summaries` chưa đổi; sau restart `PROCESSED`, `applied_count=1` |
| F8 | receiver trả `503` trước khi lưu inbox, 4 lần | 4 `delivery_attempts` `RETRYABLE`, `outbox.status='DEAD'`; khoảng chờ đo bằng `finished_at → started_at`; replay → `round=2`, `DELIVERED` |
| F9 | gửi E43 (v2) rồi E42 (v1), chờ worker xử lý từng cái | hai `inbox` `PROCESSED`, `video_summaries.version=2`, `applied_count=1` |
| F10 | tắt worker rồi hoàn tất J42 | `outbox.status='DELIVERED'` + `inbox.status='RECEIVED'` + `GET /videos/V7/summary` → `404` |

Sai số đo khoảng chờ ở F8 do nhóm công bố trước khi chạy.

Ngoài 11 ca của đề, nên thêm một ca cho T4 vì nó đã bắt được một lỗi thật:

| Ca thêm | Cách tạo | Kết quả bắt buộc |
|---|---|---|
| F3b | kill relay **trong lần gửi thứ 4** của một vòng | sau kill: `attempts_in_round=4`, attempt thứ 4 `STARTED`. Sau restart: attempt đó `UNKNOWN`, `outbox` `DEAD` (không thử lần thứ 5, relay **không** crash), replay được |

### Đo khoảng chờ cho đúng (đã kiểm bằng thực nghiệm)

Khoảng chờ tính từ **lúc kết thúc** lần gửi trước, không phải từ lúc bắt đầu.
Một lần gửi tự tốn thời gian của nó — tới 2 giây nếu timeout — nên nếu đo giữa
hai `started_at` thì kết quả là *thời lượng lần gửi + backoff*. Đo đã chạy:

| Loại lỗi | `started_at` tích lũy | giãn cách giữa hai `started_at` |
|---|---|---|
| lỗi kết nối (tức thời) | 0 / 1.07 / 4.12 / 13.17 s | 1.07 / 3.05 / 9.05 |
| timeout 2 s | 0 / 3.03 / 8.08 / 19.22 s | 3.03 / 5.05 / 11.14 |

Con số 0 / 1 / 4 / 13 s trên slide ứng với lỗi **tức thời** (503 hoặc từ chối
kết nối). Vì vậy truy vấn làm bằng chứng của F8 phải đo từ `finished_at`:

```sql
SELECT attempt_in_round,
       round(extract(epoch FROM started_at - lag(finished_at) OVER (ORDER BY started_at))::numeric, 2) AS cho_sau_lan_truoc
  FROM delivery_attempts WHERE event_id = $1 AND round = $2 ORDER BY started_at;
```

Cột này đo được 1.02 / 3.05 / 9.04 s — đúng lịch 1/3/9 bất kể lỗi loại nào.

### `TIMEOUT` và `CONNECTION` phân biệt thế nào

Đã kiểm trong container: `ECONNREFUSED` và `ENOTFOUND` nổi lên dưới dạng
`TypeError` → ghi `error_kind='CONNECTION'`. Nhưng một **tên service có trong
mạng compose mà không có container nào đang chạy** thì DNS nội bộ của Docker
*treo* chứ không trả NXDOMAIN, nên lỗi tới dưới dạng `TimeoutError` → ghi
`TIMEOUT`. Cả hai đều `RETRYABLE` nên outcome không đổi; chỉ cần biết điều này
để khỏi đọc sai bằng chứng khi receiver chưa bật.

---

## 9. Bộ kiểm bất biến của schema

`tests/schema-invariants.sql` kiểm trực tiếp trên DB, không cần service nào, và
chạy trên **cả hai** database (có kiểm `current_database()` sau mỗi `\connect`).
Mỗi ca sai thì `RAISE EXCEPTION`, nên exit code phản ánh kết quả:

```bash
npm run db:invariants
```

Đã chạy sau khi dựng lại từ volume trống trên Postgres 17: **26/26 ĐẠT**, exit 0.

| Ca | Kiểm điều gì |
|---|---|
| S1 | commit để lại job `DONE` **không** có outbox → DB từ chối |
| S2 | `DONE` + INSERT outbox cùng transaction → commit được |
| S3 | `outbox.job_id UNIQUE` chặn event thứ hai cho cùng job |
| S4 | **xóa** outbox của job đang `DONE` → DB từ chối |
| S5 | `TRUNCATE` outbox → bị chặn khi không bật cờ reset |
| S6, S7 | `raw_body` và `event_id` bất biến |
| S8, S9, S9b | `outbox.round <= 5`, `replays.round` giữa 2 và 5 |
| S10, S11 | job `DONE` không về `READY`; nội dung job `DONE` bất biến |
| S12, S13 | `outcome='STARTED'` ⇔ `finished_at IS NULL` |
| S14 | `DELIVERED` buộc có `delivered_at` — không đánh dấu suông |
| S15 | `attempts_in_round <= 4` (chính CHECK đã chặn thật lần gửi thứ 5) |
| S16 | `body_sha256` do DB tính, luôn khớp `raw_body` |
| R2 | `UNIQUE (source, event_id)` chặn bản sao |
| R3 | `ON CONFLICT DO NOTHING ... RETURNING` rỗng ở lần hai → đường phân biệt `202` và `409` của F6 |
| R4 | `PROCESSED` buộc có `processed_at` |
| R5, R6 | không xóa được dòng inbox; `raw_body` của inbox bất biến |
| R7 | `PROCESSED` không quay lại `RECEIVED` |
| R8, R9 | E43 (v2) rồi E42 (v1) → `version=2`, `applied_count=1`; bản sao cùng version không tăng |
| R10 | trigger chặn mọi UPDATE hạ `version` |

Hai điều học được khi viết bộ kiểm này, ghi lại để khỏi mắc lại:

- `TRUNCATE outbox` một mình **không** chạm tới trigger: Postgres chặn trước vì
  khóa ngoại từ `delivery_attempts`. Phải truncate cả ba bảng cùng lúc thì ca
  kiểm mới chứng minh được điều nó định chứng minh.
- Trigger `DEFERRABLE INITIALLY DEFERRED` kiểm tại COMMIT, nên trong một `DO`
  block phải `SET CONSTRAINTS ALL IMMEDIATE` để nó chịu chạy.

Chạy trên DB nháp: file reset dữ liệu về trạng thái fixture (qua cờ
`block9.fixture_reset`) và dọn lại sau khi xong, nên **đừng** chạy trên DB đang
giữ bằng chứng của một ca F.

> **Phải dừng relay và receiver-worker trước khi chạy bộ kiểm này.** Bộ kiểm
> *chèn* một dòng `outbox E42` ở trạng thái `PENDING` và một dòng
> `delivery_attempts (E42, 1, 1)`. Relay đang chạy sẽ nhặt đúng dòng outbox đó
> lên, tăng lượt rồi INSERT `(E42, 1, 1)` — trùng khóa, transaction hỏng, relay
> thoát. Đã gặp thật một lần. Vì vậy `npm run db:invariants` tự `stop` rồi
> `start` hai process đó.
>
> Để reset fixture giữa các ca, dùng `npm run fixture:reset`
> (`tests/reset-fixture.sql`): file đó **chỉ** reset, không chèn dòng kiểm nào.

Chưa kiểm được ở mức DB (cần service): thứ tự kiểm chữ ký trước khi parse,
timeout 2 s, lịch chờ 1/3/9 s, `Retry-After`, và các marker.

---

## 10. Bốn chỗ lệch đã áp vào code (L1–L4)

Sender API + Outbox + Relay làm xong **trước** bản rà soát này, nên có bốn chỗ
lệch. Cả bốn đã áp và đã chạy kiểm bằng lỗi thật.

### L1 — T4 không kết sổ vòng đã hết lượt (lỗi thật)

`services/relay/index.js` — `closeOrphanAttempts()` chỉ làm bước (a).

**Trước khi sửa**, đã dựng lại tình huống: `SIGKILL` relay đúng trong lần gửi
thứ 4. Snapshot sau kill: `attempts_in_round=4`, attempt thứ 4 `STARTED`. Bật
lại relay:

```
T4: đóng 1 attempt dang dở thành UNKNOWN
error: new row for relation "outbox" violates check constraint
       "outbox_attempts_in_round_check"   (code 23514, attempts_in_round = 5)
Node.js v22.23.5      <- relay thoát
```

Relay **chết**, container exited, event kẹt `PENDING` với `attempts_in_round=4`
— không bao giờ gửi nữa, cũng không bao giờ `DEAD`. `CHECK` đã làm đúng việc
của nó; chỗ thiếu là phần xử lý.

**Đã sửa**: T4 chạy hai bước trong một transaction (xem §3 T4).

**Kiểm lại** với đúng cách tạo lỗi đó, sau khi sửa:

```
T4: đóng 1 attempt dang dở thành UNKNOWN
T4: kết sổ 1 event đã hết lượt thành DEAD
```

Relay ở trạng thái `running`; attempt thứ 4 `UNKNOWN` đã đóng; outbox `DEAD`
có `dead_at`. Không thử lần thứ 5, không crash.

### L2 — T2 không lọc "còn lượt"

**Đã sửa**: mệnh đề `WHERE` của T2 thêm `AND attempts_in_round < $1` với
`$1 = config.maxAttemptsPerRound`, khớp đúng partial index `outbox_due_idx`.
Đây là lưới an toàn: một dòng hết lượt sót lại từ bản chạy cũ cũng không làm
relay crash nữa.

### L3 — `Retry-After` chưa nhận HTTP-date

**Đã sửa** `parseRetryAfter`: nhận cả delta-seconds và HTTP-date, kẹp trần
`RETRY_AFTER_MAX_S` (mặc định 300).

**Kiểm** bằng một container trả `429` thật với bốn dạng header, trên cùng một
vòng gửi:

| lần | header nhận được | `retry_after_s` ghi | chờ thật đo được |
|---|---|---|---|
| 1 | `Thu, 19 Nov 2026 03:23:09 GMT` (now + 5 s) | 5 | 5.07 s |
| 2 | `4` | 4 | 4.06 s |
| 3 | `soon` (không hợp lệ) | *NULL* | 9.13 s (backoff) |
| 4 | `Thu, 19 Nov 2026 03:40:03 GMT` (now + ~1000 s) | **300** (kẹp trần) | — hết lượt → `DEAD` |

Chờ thật là `max(backoff, retry_after)`: lần 1 chờ 5 s thay vì 1 s, lần 2 chờ
4 s thay vì 3 s, lần 3 không có header hợp lệ nên về đúng lịch 9 s.

### L4 — Replay chưa chặn khi hết lượt replay

**Đã sửa**: thêm phép kiểm `ev.round >= config.maxRound` ngay sau phép kiểm
`status`, trong cùng transaction, trên dòng outbox đã bị khóa `FOR UPDATE`.

**Kiểm** bằng 4 vòng replay thật (relay gửi vào một cổng đóng cho lỗi tức thì):

```
replay -> vòng 2: 202 {"round":2,...,"body_sha256":"f838d6e1..."}
replay -> vòng 3: 202 {"round":3,...,"body_sha256":"f838d6e1..."}
replay -> vòng 4: 202 {"round":4,...,"body_sha256":"f838d6e1..."}
replay -> vòng 5: 202 {"round":5,...,"body_sha256":"f838d6e1..."}
replay lần thứ 5: 409 {"error":"đã replay hết số lần cho phép","round":5,"max_round":5,"max_replays":4}
```

`delivery_attempts` có đúng 20 dòng (5 vòng × 4 lần), và `body_sha256` **y
nguyên** qua cả 5 vòng — `raw_body` không đổi qua replay.

### Còn tồn tại: relay thoát khi gặp lỗi DB bất ngờ

`tick()` không bọc try/catch, nên một lỗi DB bất ngờ làm `main()` reject và
process thoát. Với `restart: "no"` trong compose thì relay **nằm im** cho tới
khi có người bật lại.

Đã gặp thật một lần, do bộ kiểm invariants chạy song song với relay (xem §9).
Nguyên nhân đó đã xử lý ở mức script, nhưng câu hỏi thiết kế vẫn còn:

| Chọn | Được | Mất |
|---|---|---|
| Thoát (hiện tại) | lỗi lạ không bị che; dừng ngay thay vì chạy sai | một hiccup của DB làm cả ca kiểm đứng mà không rõ lý do |
| Log rồi chạy tiếp | ca kiểm chạy qua được hiccup | lỗi thật dễ bị trôi trong log |

Chưa chọn. Nếu chọn "chạy tiếp" thì sửa tối thiểu là bọc thân vòng lặp trong
`main()`: log lỗi, chờ `pollIntervalMs`, rồi `continue`. Hai lỗi đã biết là
**không** thuộc loại "bất ngờ" và không nên bị che: chúng đã được xử lý đúng
chỗ (L1, L2).

### Không còn lệch nào khác

`express.json()` ở `services/sender-api/index.js` là đúng chỗ (sender không xác
minh chữ ký), T1 và T3 khớp bản rà soát. Sau khi áp L1–L4:

- `npm run db:invariants`: 26/26 ĐẠT, exit 0
- đường bình thường "hết 4 lượt → `DEAD`" vẫn chạy, 0 lỗi trigger trong log
- `/complete` vẫn idempotent, DB về trạng thái fixture sạch

## 11. Checklist trước khi làm Receiver

- [x] **L1 và L2 (relay) — đã áp và đã kiểm** bằng kill thật trong lần gửi thứ 4
- [x] **L4 (sender replay) — đã áp và đã kiểm** bằng 4 vòng replay thật, lần thứ 5 trả 409
- [x] **L3 (`Retry-After` HTTP-date) — đã áp và đã kiểm** bằng responder trả 429 thật, bốn dạng header
- [x] `receiver-api` và `receiver-worker` trong `docker-compose.yml`; receiver publish `127.0.0.1:3001`
- [x] Receiver API: `express.raw({ type: '*/*' })`, **không** `express.json()` ở mức app (§6)
- [x] Receiver API: thứ tự timestamp → HMAC → parse → schema → INSERT inbox → COMMIT → 202 (§6)
- [x] Receiver API: `source` lấy từ cấu hình, không từ header
- [x] Receiver worker: `AND status='RECEIVED'` và kiểm `rowCount === 1` ở câu UPDATE cuối (T6)
- [x] Marker `after_inbox_commit_before_response` (F4) và `after_projection_write_before_commit` (F7)
- [x] Fault "503 trước khi lưu inbox" bật/tắt được cho F8, qua `POST /admin/fault`
- [x] **H0 ĐẠT**: job `DONE`, một outbox `DELIVERED`, một inbox `PROCESSED`, V7 version 1, `applied_count = 1`

### Còn lại trước khi nộp

- [x] **Cả 11 ca H0 + F1…F10 đã chạy và đạt**, cộng ca thêm F3b. Bốn ca kill thật (F1, F2, F3, F7) dùng `SIGKILL` tại marker
- [ ] F5 — đã kiểm bằng `tests/webhook-probe.js`, còn phải lưu thành bảng expected/observed
- [ ] Harness tự động hóa 11 ca + ca F3b, mỗi ca reset fixture riêng và snapshot cả hai DB
- [ ] Sơ đồ hai DB, ranh giới transaction, vị trí trả 202 và vị trí đánh dấu DELIVERED
- [ ] Quyết định: relay có nên thoát khi gặp lỗi DB bất ngờ hay log rồi chạy tiếp (xem §10, "Còn tồn tại")

---

## 12. Giới hạn ghi ngay trong schema

- `DELIVERED` **không** chứng minh nghiệp vụ đã đổi: trạng thái đó nằm ở
  `inbox.status` và `video_summaries` của DB receiver (F10).
- `DEAD` **không** chứng minh receiver chưa nhận: nếu relay chết trong lần gửi
  cuối, attempt đó là `UNKNOWN` và vòng vẫn bị kết sổ `DEAD` (T4).
- `applied_count` chỉ bảo vệ thay đổi **trong DB receiver** cùng transaction.
  Gửi email hay gọi LLM trong T6 thì schema này không chặn được lặp.
- Lab chạy **một** relay; `SKIP LOCKED` có sẵn nhưng không tuyên bố đúng khi
  chạy nhiều relay.
- Retry hữu hạn: 4 lần mỗi vòng, tối đa 4 lần replay. Receiver ngừng vô thời hạn
  thì event thành `DEAD` và hết đường tự động.
- Không tuyên bố exactly-once đầu cuối.
