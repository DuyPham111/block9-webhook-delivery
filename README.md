# Block 9 — Giao sự kiện tin cậy với outbox, inbox và webhook

Web Nâng Cao, tuần 7, block 9. Sender báo sự kiện `summary.completed` cho
receiver qua webhook, sao cho dù hỏng ở bước nào thì receiver cuối cùng vẫn có
bản tóm tắt mới nhất và **chỉ áp dụng mỗi sự kiện một lần**.

Thiết kế chốt trước khi viết code: [docs/SCHEMA.md](docs/SCHEMA.md).

## Trạng thái

| Phần | Trạng thái |
|---|---|
| Schema hai DB, migration, fixture | xong, 26/26 bất biến ĐẠT |
| Sender API (T1, `GET /events`, replay + giới hạn vòng) | xong, đã chạy thử |
| Relay (T2, T3, T4, phân loại, backoff, `Retry-After`) | xong, đã chạy thử |
| Receiver API (chữ ký, inbox, 202/409/401/400) | xong, đã chạy thử |
| Receiver worker (T6, version, applied_count) | xong, đã chạy thử |
| Ca đã chạy | **cả 11 ca H0 + F1…F10 đạt**, cộng ca thêm F3b |
| Harness tự động hóa 11 ca | **chưa làm** (đến giờ chạy bằng tay) |

Bốn chỗ code lệch với bản rà soát schema (L1–L4) **đã áp và đã kiểm** — chi
tiết kèm bằng chứng ở [docs/SCHEMA.md](docs/SCHEMA.md) §10. L1 là một lỗi thật:
relay chết và event kẹt vĩnh viễn nếu relay crash đúng trong lần gửi thứ 4 của
một vòng. Checklist trước khi làm Receiver ở §11.

Vì receiver chưa có, relay hiện gửi vào một địa chỉ không có ai nhận: đường đi
`RETRYABLE → DEAD → replay` chạy được, còn `DELIVERED` thì chưa.

## Chạy

```bash
npm install
npm run up          # postgres + 4 process
npm run ui          # UI demo: http://127.0.0.1:3100
```

UI demo có ba tab: **Sơ đồ** (hai DB, 6 transaction, chỗ trả 202 và chỗ đánh
dấu DELIVERED), **Chạy tay** (bấm nút, xem hai DB đổi theo thời gian thực), và
**Ma trận kịch bản** (12 ca, bấm Chạy rồi xem expected/observed). Thanh trên
cùng bật/tắt/kill từng process.

Chạy ca bằng dòng lệnh — cùng một engine với UI:

```bash
npm run lab list      # danh sách ca
npm run case F7       # một ca
npm run cases         # cả 12 ca, ~4 phút
```

Tài liệu demo: [docs/HUONG-DAN-DEMO.md](docs/HUONG-DAN-DEMO.md) và
[docs/KICH-BAN-THUYET-TRINH.md](docs/KICH-BAN-THUYET-TRINH.md).
Sơ đồ hệ thống: [docs/so-do-he-thong.svg](docs/so-do-he-thong.svg).

```bash
npm run ps
npm run logs
```

Postgres mở ở `127.0.0.1:15432` (không phải 55432: Windows giữ riêng dải
55377–55476 cho Hyper-V). Sender API mở ở `127.0.0.1:3000`. Mọi cổng chỉ publish
trên loopback.

Dừng và bật lại từng process — dùng cho các ca F:

```bash
npm run relay:stop     npm run relay:start     npm run relay:kill
npm run sender:stop    npm run sender:start    npm run sender:kill
```

Kiểm bất biến của schema trên cả hai DB (reset về trạng thái fixture):

```bash
npm run db:invariants
```

Trong Git Bash phải thêm `MSYS_NO_PATHCONV=1`, nếu không đường dẫn
`/app-tests/...` bị dịch thành đường dẫn Windows:

```bash
MSYS_NO_PATHCONV=1 docker compose exec -T postgres \
  psql -U app -d app -v ON_ERROR_STOP=1 -q -f /app-tests/schema-invariants.sql
```

Xóa sạch kể cả volume: `npm run clean`.

## Thử bằng tay

```bash
# T1: một transaction, trả 200 SAU commit
curl -s -X POST http://127.0.0.1:3000/jobs/J42/complete
# -> {"job_id":"J42","event_id":"E42","already_completed":false,"outbox_status":"PENDING"}

# gọi lại job đã DONE: cùng event, không tạo event mới
curl -s -X POST http://127.0.0.1:3000/jobs/J42/complete
# -> {"job_id":"J42","event_id":"E42","already_completed":true,...}

# trạng thái outbox + lịch sử từng lần gửi
curl -s http://127.0.0.1:3000/events/E42

# replay: chỉ nhận event DEAD, giữ event_id và raw_body
curl -s -X POST http://127.0.0.1:3000/events/E42/replay -H 'content-type: application/json' -d '{"note":"go fault"}'
# event chưa DEAD -> 409; đã replay 4 lần -> 409 với lý do khác

# phía receiver
curl -s http://127.0.0.1:3001/inbox/E42
curl -s http://127.0.0.1:3001/videos/V7/summary
```

Reset fixture giữa các ca, và kiểm các đường 401 / 400 / 409 của webhook:

```powershell
npm run fixture:reset
```

```powershell
npm run probe
```

## Marker

Đặt `MARKER=<tên>` cho một service: process in `MARKER <tên> pid=<pid>` rồi
**dừng** tại đó cho tới khi harness tạo file `MARKER_RELEASE_FILE` hoặc kill nó.
Marker không bọc try/catch và không đổi đường đi của dữ liệu.

| Service | Marker | Ca |
|---|---|---|
| sender-api | `after_job_update_before_outbox` | F1 |
| sender-api | `after_sender_commit_before_response` | F2 |
| relay | `after_http_2xx_before_delivery_commit` | F3 |
| receiver-api | `after_inbox_commit_before_response` | F4 |
| receiver-worker | `after_projection_write_before_commit` | F7 |

Lỗi giả của receiver bật/gỡ qua route quản trị (chỉ mở trên loopback), không
cần khởi động lại process — ca F8 cần gỡ fault rồi replay:

```powershell
curl -s -X POST http://127.0.0.1:3001/admin/fault -H 'content-type: application/json' -d '{"fault":"respond_503_before_inbox"}'
curl -s -X POST http://127.0.0.1:3001/admin/fault -H 'content-type: application/json' -d '{"fault":null}'
```

| Fault | Dùng cho |
|---|---|
| `respond_503_before_inbox` | F8 — giữ cho tới khi gỡ |
| `close_after_inbox_commit` | F4 — commit inbox rồi cắt socket, một lần |

## Đã chạy thử được những gì

- `/complete` ghi `jobs DONE` + `outbox PENDING` trong một transaction, trả 200
  sau commit; gọi lại trả cùng `E42` và outbox vẫn một dòng.
- Relay: 4 lần mỗi vòng, chờ 1.02 / 3.05 / 9.04 s (đo từ `finished_at` của lần
  trước), hết lượt thì `DEAD`.
- **Kill thật giữa lúc đang gửi**: `SIGKILL` relay khi attempt đang `STARTED` →
  snapshot thấy `A5 STARTED` với `finished_at` NULL, outbox vẫn `PENDING`. Bật
  lại: T4 đóng `A5` thành `UNKNOWN` (tính một lượt) rồi gửi tiếp `A6`. Không có
  cờ nào kẹt, không mất sự kiện.
- Replay: `DEAD` → 202, vòng mới, `attempts_in_round` về 0, `body_sha256` **y
  nguyên**; chưa `DEAD` → 409; event lạ → 404.
- Phân loại lỗi: `ECONNREFUSED` / `ENOTFOUND` → `CONNECTION`; timeout 2 s →
  `TIMEOUT`; cả hai `RETRYABLE`.
- **Kill thật trong lần gửi thứ 4**: sau restart, attempt thứ 4 thành `UNKNOWN`
  và vòng được kết sổ `DEAD` — relay không thử lần thứ 5, không crash (L1, L2).
- **Giới hạn 4 lần replay**: vòng 2→5 trả `202`, lần replay thứ 5 trả `409`;
  `body_sha256` y nguyên qua cả 5 vòng (L4).
- **`Retry-After`**: dạng số giây, dạng HTTP-date, giá trị không hợp lệ và giá
  trị vượt trần — cả bốn ghi đúng vào `retry_after_s` và chờ đúng (L3).

### Các ca đã chạy end-to-end

| Ca | Kết quả quan sát được |
|---|---|
| **H0** | job `DONE`, một outbox `DELIVERED` (một attempt, 202), một inbox `PROCESSED`, V7 version 1, `applied_count = 1` |
| **F1** | kill sender tại `after_job_update_before_outbox`: transaction chưa commit → J42 vẫn `READY`, `done_at` NULL, outbox **rỗng**, client nhận HTTP 000. Gọi `/complete` lại → đạt đúng H0 |
| **F2** | relay tắt, kill sender tại `after_sender_commit_before_response`: DB có `DONE` + outbox `PENDING` **dù client không nhận response**. Gọi lại → `already_completed: true`, cùng `E42`, outbox vẫn **một** dòng. Bật relay → H0 |
| **F3** | kill relay tại marker `after_http_2xx_before_delivery_commit`: sau kill inbox đã có dòng, outbox còn `PENDING`, A50 `STARTED`. Restart → A50 `UNKNOWN`, A51 `ACKNOWLEDGED` 202 **cùng `event_id`**, `DELIVERED`, **một** inbox, `applied_count = 1` |
| **F4** | receiver commit inbox rồi cắt socket: A48 `CONNECTION`, A49 `ACKNOWLEDGED` 202, **một** inbox, `applied_count = 1` |
| **F7** | kill worker tại `after_projection_write_before_commit`: sau kill inbox `RECEIVED`, `video_summaries` **rỗng**, API 404 — cả thay đổi nghiệp vụ và dấu `PROCESSED` cùng rollback. Restart → `PROCESSED`, `applied_count = 1`, API 200 |
| **F8** | 4 lần `503`, tích lũy **0 / 1.03 / 4.10 / 13.25 s** (đúng slide), outbox `DEAD`, **inbox rỗng**. Gỡ fault + replay → vòng 2, `DELIVERED`, `PROCESSED`, `applied_count = 1` |
| **F9** | E43 (v2) trước, E42 (v1) sau: cả hai inbox `PROCESSED`, V7 **vẫn version 2**, `applied_count = 1`, worker log `bỏ qua (version cũ hơn bản hiện tại)` |
| **F10** | worker tắt: outbox `DELIVERED` + inbox `RECEIVED` + `GET /videos/V7/summary` → **404**. Bật worker → `PROCESSED`, API → **200** |
| **F3b** (ca thêm) | kill relay **trong lần gửi thứ 4**: sau restart attempt đó thành `UNKNOWN`, vòng được kết sổ `DEAD`, relay không thử lần thứ 5 và không crash |
| **F5** | `npm run probe`: 11/11 ĐẠT — payload sửa / chữ ký rác / thiếu chữ ký → 401; timestamp ±400 s → 401; −290 s (trong cửa sổ) → 202; JSON hỏng → 400; `version = 0` → 400; cùng ID khác payload → 409; **5 bản sao đồng thời → cả 5 nhận 202**. Sau 16 request: inbox vẫn **một** dòng, `applied_count` vẫn 1 |

Bốn ca kill thật mà đề bài yêu cầu (F1, F2, F3, F7) đều dùng
`docker kill -s SIGKILL` tại marker, không phải exception giả.

Còn lại: harness tự động hóa 11 ca (đến giờ chạy bằng tay) và bảng
expected/observed để nộp.
