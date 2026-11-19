# Hướng dẫn demo — Block 9

Mọi thứ trong tài liệu này chạy được trên một máy, không cần mạng ngoài.
Mọi cổng chỉ mở trên `127.0.0.1`.

---

## 1. Chuẩn bị trước giờ lên lớp

Làm **trước** khi vào lớp, vì bước build image mất vài phút:

```powershell
npm ci
```

```powershell
npm run up
```

```powershell
npm run ui
```

- `npm run up` dựng Postgres + 4 process và chờ tới khi khỏe.
- `npm run ui` mở trang demo ở **http://127.0.0.1:3100** (giữ cửa sổ này chạy suốt buổi).

Kiểm tra nhanh mọi thứ đã sẵn sàng:

```powershell
npm run db:invariants
```

Phải thấy **26/26 PASS**. Nếu có FAIL thì đừng demo tiếp — schema đang sai.

### Nếu máy hỏng giữa chừng

```powershell
npm run clean
```

```powershell
npm run up
```

`clean` xóa cả volume, nên DB dựng lại từ migration trống. Mất khoảng 40 giây.

---

## 2. Bản đồ màn hình

Trang demo có ba tab:

| Tab | Dùng để |
|---|---|
| **Sơ đồ** | Mở đầu buổi: hai DB, bốn process, sáu transaction, chỗ trả `202` và chỗ đánh dấu `DELIVERED` |
| **Chạy tay** | Bấm từng nút, xem hai DB đổi theo thời gian thực. Dùng cho H0 và khi thầy hỏi "thử cái này xem" |
| **Ma trận kịch bản** | 12 ca tự động. Bấm **Chạy**, xem nhật ký từng bước và bảng PASS/FAIL |

Thanh trên cùng luôn hiện **4 process** với nút `bật · tắt · kill`. Chấm xanh là
đang chạy, chấm đỏ là đã tắt. Đây là chỗ để tắt worker hay kill relay ngay
trước mặt thầy.

---

## 3. Ba cách chạy cùng một ca

Ba cách này **chạy đúng một đoạn mã** (`tools/lab.js`), chỉ khác vỏ:

| Cách | Lệnh | Khi nào dùng |
|---|---|---|
| UI | bấm **Chạy** ở tab Ma trận | lúc trình bày |
| CLI một ca | `npm run case F7` | khi debug |
| CLI tất cả | `npm run cases` | kiểm trước khi nộp (mất ~4 phút) |

Mỗi ca tự làm đủ: reset fixture → bật/tắt/kill process → chạy → so
expected với observed → **dọn về trạng thái sạch**, kể cả khi ca lỗi giữa chừng.
Nên chạy ca nào trước ca nào cũng được, không cần dọn tay.

---

## 4. Kịch bản demo 6 phút (bản rút gọn)

Nếu thầy chỉ cho ít thời gian, chạy đúng bốn ca này:

| Phút | Làm | Chỉ vào đâu |
|---|---|---|
| 0–1 | Tab **Sơ đồ** | vạch đỏ "không transaction nào bắc qua đây", hai ô vàng `202` và `DELIVERED` |
| 1–2 | Tab **Chạy tay** → **Hoàn tất J42** | outbox `PENDING` → `DELIVERED`, inbox `RECEIVED` → `PROCESSED`, `applied_count = 1`. Chỉ cột **body sha** giống nhau ở hai DB |
| 2–3.5 | Tab **Ma trận** → chạy **F7** | sau kill: inbox `RECEIVED` mà `video_summaries` **rỗng** → cả hai cùng rollback. Restart → `applied_count = 1`, **không phải 2** |
| 3.5–5 | chạy **F10** | sender `DELIVERED` nhưng API bản tóm tắt trả **404**. Đây là câu "DELIVERED không có nghĩa là đã xử lý" |
| 5–6 | chạy **F9** | E43 (v2) tới trước, E42 (v1) tới sau → bản hiện tại **vẫn v2**, `applied_count` **vẫn 1** |

Bốn ca trên chạy hết khoảng 60 giây máy, phần còn lại là lời nói.

---

## 5. Danh sách 12 ca

| Ca | Kill thật | Mất | Điều cần chỉ cho thầy thấy |
|---|---|---|---|
| H0 | | ~12s | đường đi bình thường, `applied_count = 1` |
| F1 | ✓ | ~20s | J42 vẫn `READY`, outbox **rỗng** — transaction chưa commit thì mất cả hai |
| F2 | ✓ | ~19s | DB có `DONE` + `PENDING` dù client **không nhận được response** |
| F3 | ✓ | ~16s | receiver đã có inbox mà sender chưa `DELIVERED`; gửi lại **cùng `event_id`**, attempt ID mới |
| F3b | ✓ | ~38s | kill đúng lần gửi thứ 4 → vòng kết sổ `DEAD`, **relay không crash** |
| F4 | | ~13s | receiver cắt kết nối sau commit → sender retry, inbox vẫn **một** dòng |
| F5 | | ~12s | 11 ca gõ thẳng webhook: 401 / 400 / 409 |
| F6 | | ~11s | 5 bản sao đồng thời → cả 5 nhận `202`, inbox **một** dòng |
| F7 | ✓ | ~16s | `PROCESSED` và nghiệp vụ **cùng commit**, kill thì cùng rollback |
| F8 | | ~26s | 4 lần `503`, chờ **1 / 3 / 9 giây**, `DEAD`, replay giữ nguyên `event_id` và `raw_body` |
| F9 | | ~12s | sự kiện version cũ đến sau là **no-op** |
| F10 | | ~17s | `DELIVERED` ở sender mà API bản tóm tắt vẫn **404** |

---

## 6. Thao tác tay hay dùng

Tất cả đều có nút trên UI, nhưng khi thầy muốn xem lệnh thật:

```powershell
curl -s -X POST http://127.0.0.1:3000/jobs/J42/complete
```

```powershell
curl -s http://127.0.0.1:3000/events/E42
```

```powershell
curl -s http://127.0.0.1:3001/videos/V7/summary
```

```powershell
curl -s -X POST http://127.0.0.1:3000/events/E42/replay -H "content-type: application/json" -d "{\"note\":\"demo\"}"
```

Bật và gỡ lỗi giả của receiver:

```powershell
curl -s -X POST http://127.0.0.1:3001/admin/fault -H "content-type: application/json" -d "{\"fault\":\"respond_503_before_inbox\"}"
```

```powershell
curl -s -X POST http://127.0.0.1:3001/admin/fault -H "content-type: application/json" -d "{\"fault\":null}"
```

Dừng, bật, kill từng process:

```powershell
npm run worker:stop
```

```powershell
npm run relay:kill
```

```powershell
npm run worker:start
```

Reset fixture giữa hai lần demo tay:

```powershell
npm run fixture:reset
```

Xem snapshot hai DB dưới dạng JSON:

```powershell
npm run lab snapshot
```

---

## 7. Mở mã ở đâu — bốn chỗ đề bài bắt buộc

Mở sẵn bốn file này trong editor trước khi lên trình bày.

| Thầy hỏi | File | Dòng |
|---|---|---|
| **Transaction của outbox** | `services/sender-api/index.js` | 28 khóa job · 47 `UPDATE jobs … DONE` · 57 `INSERT INTO outbox` — cả ba trong một `db.tx` |
| **Chỗ lưu inbox trước khi trả 202** | `services/receiver-api/index.js` | 65–80 `INSERT … ON CONFLICT DO NOTHING` rồi mới `res.status(202)` ở cuối handler |
| **Transaction của worker** | `services/receiver-worker/index.js` | 20–70: khóa dòng (24) → UPSERT theo version (39) → `UPDATE inbox … PROCESSED` + kiểm `rowCount` (65) |
| **Phép kiểm chữ ký** | `shared/signature.js` | 8 `signedBytes` · 19 `verifySignature` với `timingSafeEqual` (24). Nơi gọi: `services/receiver-api/index.js` 35 (timestamp) và 40 (HMAC) |

Hai chỗ nên mở thêm vì hay bị hỏi:

| Câu hỏi | File | Dòng |
|---|---|---|
| "Làm sao chắc job DONE luôn có outbox?" | `db/010_sender.sql` | 121 — constraint trigger kiểm tại COMMIT, không tin vào code |
| "Sao bản sao không áp dụng hai lần?" | `db/020_receiver.sql` | `inbox UNIQUE (source, event_id)` và trigger `inbox_immutable` dòng 95 |

---

## 8. Hỏng giữa demo thì làm gì

| Triệu chứng | Cách xử |
|---|---|
| Một process chấm đỏ mà không cố ý | bấm **bật** trên thanh chip, hoặc `npm run relay:start` |
| Ca chạy mãi không xong | đổi sang ca khác; engine tự dọn khi ca kết thúc hoặc lỗi |
| Số liệu không khớp slide | `npm run fixture:reset` rồi chạy lại ca đó |
| UI trắng trang | tải lại trang; nếu vẫn trắng, xem cửa sổ đang chạy `npm run ui` |
| Nghi schema sai | `npm run db:invariants` — phải 26/26 |
| Mọi thứ rối | `npm run clean` rồi `npm run up` (~40 giây) |

---

## 9. Điều **không** được nói khi demo

Ba câu này sai với chính thiết kế của nhóm, đừng lỡ miệng:

- ❌ "Hệ thống bảo đảm exactly-once." → Chỉ **chống áp dụng lặp trong DB receiver**.
- ❌ "`DELIVERED` nghĩa là receiver đã cập nhật xong." → Chỉ nghĩa là **đã commit inbox**. Ca F10 chứng minh ngược lại.
- ❌ "Chạy nhiều relay cũng đúng." → Lab chạy **một** relay. `SKIP LOCKED` có sẵn nhưng nhóm **không** tuyên bố đúng khi nhiều relay.
