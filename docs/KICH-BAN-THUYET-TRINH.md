# Kịch bản thuyết trình — Block 9

Thứ tự theo đúng yêu cầu của đề: **vấn đề → giải pháp → demo → bằng chứng → đánh đổi**.

Bản đầy đủ **12 phút**. Mục §8 có bản rút gọn **6 phút** nếu bị cắt giờ.
Chữ in nghiêng là lời nói, khối lệnh là thao tác trên màn hình.

Chuẩn bị: `npm run up`, `npm run ui`, mở http://127.0.0.1:3100, mở sẵn
`docs/so-do-he-thong.svg` và bốn file mã ở §7 của `HUONG-DAN-DEMO.md`.

---

## Phút 0:00–1:30 — Vấn đề

**Màn hình: tab Sơ đồ.**

> *Block 8 kết thúc ở chỗ worker tóm tắt xong job J42 và lưu vào DB của dịch vụ
> tóm tắt. Nhưng ứng dụng khách hàng lại đọc danh sách video có bản tóm tắt từ
> một dịch vụ khác — receiver — có DB riêng, không đọc được DB của sender.*

Chỉ tay vào **vạch đỏ** giữa sơ đồ.

> *Nên sender phải chủ động báo sự kiện qua HTTP. Vấn đề nằm ở chỗ: ghi DB của
> sender và gửi HTTP là hai thao tác riêng. Không có transaction nào bắc qua
> vạch đỏ này. Đó là dual-write.*

> *Và đảo thứ tự hai thao tác không cứu được gì — chỉ đổi loại lỗi. Ghi DB rồi
> gửi: chết sau commit thì mất sự kiện. Gửi rồi ghi DB: chết sau khi gửi thì
> receiver có dữ liệu mà sender không biết. Chúng em sẽ cho thầy xem cả hai
> trường hợp bằng kill process thật.*

**Câu chốt:** *Mục tiêu không phải là không bao giờ hỏng. Mục tiêu là dù hỏng ở
bước nào, receiver cuối cùng vẫn có bản tóm tắt mới nhất và chỉ áp dụng mỗi sự
kiện một lần.*

---

## Phút 1:30–3:30 — Giải pháp

**Vẫn ở tab Sơ đồ.** Chỉ lần lượt bốn thứ:

**1. Outbox — chống mất sự kiện.** Chỉ vào khung T1 bên trái.

> *Đổi job sang DONE và ghi ý định gửi vào bảng outbox nằm trong **một**
> transaction. Commit thì có cả hai, rollback thì không có cả hai.*

> *Chỗ này chúng em không tin vào code. Trong DB có một constraint trigger kiểm
> tại thời điểm COMMIT: bất kỳ commit nào để lại job DONE mà không có dòng
> outbox đều bị từ chối.*

**2. Relay và lần gửi.** Chỉ vào T2, T3, T4.

> *Relay đọc outbox, gửi HTTP, rồi ghi kết quả. Điều quan trọng là **phân biệt
> sự kiện với lần gửi**: `event_id` không đổi qua mọi lần retry và replay,
> `attempt_id` đổi mỗi lần. Receiver nhận ra bản sao nhờ `event_id`.*

> *Và relay commit attempt STARTED **trước** khi gọi HTTP, không giữ transaction
> mở trong lúc chờ mạng.*

**3. Chữ ký.** Chỉ mũi tên xanh.

> *HMAC-SHA256 trên timestamp cộng raw body. Receiver kiểm cửa sổ 300 giây rồi
> kiểm chữ ký, **trước khi** parse JSON — vì parse rồi serialize lại có thể đổi
> byte và làm chữ ký sai.*

**4. Inbox.** Chỉ ô vàng bên phải.

> *Receiver ghi mỗi sự kiện thành một dòng inbox, có UNIQUE trên source và
> event_id, commit rồi **mới** trả 202. Worker xử lý sau, trong transaction
> riêng, chỉ cập nhật khi version mới lớn hơn.*

**Câu chốt — hai ô vàng trên sơ đồ:**

> *Hai mốc này là chỗ dễ nói sai nhất. 202 nghĩa là **đã commit inbox**, không
> phải đã xử lý nghiệp vụ. DELIVERED nghĩa là relay **đã nhận 2xx**, không phải
> worker đã cập nhật xong. Lát nữa ca F10 sẽ cho thầy thấy đúng cái khoảng cách
> đó.*

---

## Phút 3:30–5:00 — Demo đường đi bình thường (H0)

**Chuyển sang tab Chạy tay.**

```
bấm "Reset fixture"
bấm "Hoàn tất J42"
```

Vừa bấm vừa nói, chờ khoảng 3 giây cho bảng tự cập nhật:

> *Sender trả 200 kèm `event_id` E42 — và chỉ trả **sau** khi commit. Outbox
> hiện PENDING… bây giờ relay nhặt lên, gửi đi, nhận 202, và chuyển sang
> DELIVERED. Bên phải: inbox RECEIVED, rồi worker xử lý thành PROCESSED, và
> `applied_count` bằng 1.*

Chỉ vào cột **body sha** ở cả hai bảng:

> *Thầy xem cột này — `body_sha256` ở outbox bên trái và ở inbox bên phải giống
> hệt nhau. Nghĩa là đúng các byte đã ký là các byte đã tới nơi, không ai
> serialize lại giữa đường.*

Chỉ vào bảng `delivery_attempts`:

> *Một lần gửi, một dòng. Đây là chỗ sau này nhìn ra được mọi thứ đã xảy ra.*

---

## Phút 5:00–9:30 — Bằng chứng: bốn ca kill thật

**Chuyển sang tab Ma trận kịch bản.**

> *Đề yêu cầu kill process thật tại marker, không phải ném exception giả. Marker
> là một điểm trong mã: khi bật, process in ra một dòng rồi dừng tại đó cho tới
> khi harness kill nó. Chúng em dùng `docker kill -s SIGKILL`.*

### F1 — kill sender trước khi INSERT outbox (~20 giây)

```
bấm "Chạy" ở dòng F1
```

Trong lúc chạy, đọc nhật ký bên phải:

> *Marker in ra rồi — SIGKILL. Snapshot ngay sau khi kill: J42 **vẫn READY**,
> outbox **rỗng**. Transaction chưa commit nên câu UPDATE cũng bị rollback
> theo. Client thì không nhận được response nào cả.*

> *Và gọi complete lại thì đạt đúng H0. Mất sự kiện không xảy ra, vì chưa có gì
> được hứa.*

### F2 — kill sender sau commit, trước response (~19 giây)

```
bấm "Chạy" ở dòng F2
```

> *Lần này ngược lại: DB đã có DONE **và** outbox PENDING, nhưng client không
> nhận được response. Từ góc client thì không biết job đã xong hay chưa.*

> *Hai điều cứu tình huống này. Một, relay không quan tâm client có nhận được
> response hay không — nó cứ đọc outbox và gửi. Hai, gọi complete lại trả về
> **cùng** event E42, `already_completed` là true, outbox vẫn **một** dòng —
> không sinh sự kiện thứ hai.*

### F7 — kill worker trước commit (~16 giây)

```
bấm "Chạy" ở dòng F7
```

**Đây là ca mạnh nhất, nói chậm.**

> *Worker đã ghi bản tóm tắt vào `video_summaries` rồi, nhưng chưa commit. Kill.*

> *Thầy xem snapshot sau kill: inbox **vẫn RECEIVED**, `video_summaries`
> **rỗng**, API bản tóm tắt trả 404. Cả thay đổi nghiệp vụ lẫn dấu PROCESSED
> cùng rollback, vì chúng nằm trong **cùng một commit**.*

> *Bật lại worker: nó đọc lại đúng dòng đó và áp dụng. `applied_count` bằng
> **1**, không phải 2. Đấy là ý nghĩa của "chống áp dụng lặp".*

### F3 — kill relay sau 2xx, trước DELIVERED (~16 giây)

```
bấm "Chạy" ở dòng F3
```

> *Khoảng hở kinh điển: receiver **đã** nhận và đã lưu inbox, nhưng relay chết
> trước khi kịp ghi DELIVERED. Sender không biết gì.*

> *Sau restart, relay đóng attempt dang dở thành UNKNOWN — nghĩa là "chưa biết
> receiver có nhận hay không" — rồi gửi lại. Thầy xem: **cùng `event_id` E42**,
> nhưng `attempt_id` mới. Receiver thấy E42 đã có trong inbox, trả 202 mà
> **không** thêm dòng. Kết quả: một inbox, `applied_count` bằng 1.*

**Câu chốt cho cả bốn ca:**

> *Bốn ca này kiểm bốn quy tắc khác nhau, và không ca nào dựa vào log để chứng
> minh — tất cả đọc từ snapshot hai DB.*

---

## Phút 9:30–11:00 — Hai ca về giới hạn và thứ tự

### F10 — DELIVERED không phải là xử lý xong (~17 giây)

```
bấm "Chạy" ở dòng F10
```

> *Tắt worker, rồi hoàn tất J42. Sender báo **DELIVERED**. Inbox **RECEIVED**.
> Nhưng API bản tóm tắt trả **404** — ứng dụng khách hàng vẫn chưa thấy gì.*

> *Nếu nhóm em đồng nhất DELIVERED với "đã xử lý xong" thì ở đây sẽ báo sai cho
> người dùng. Bật worker lên thì bản tóm tắt mới xuất hiện.*

### F9 — sự kiện cũ đến sau sự kiện mới (~12 giây)

```
bấm "Chạy" ở dòng F9
```

> *E43 là version 2, E42 là version 1. Cho E43 tới trước, E42 tới sau. Cả hai
> inbox đều PROCESSED — nghĩa là cả hai đều được xử lý, không bỏ sót. Nhưng bản
> hiện tại **vẫn là version 2**, và `applied_count` **vẫn là 1**.*

> *Sự kiện version cũ được xét rồi bỏ qua, vì UPSERT chỉ cập nhật khi version
> mới lớn hơn. Version không bao giờ giảm.*

---

## Phút 11:00–12:00 — Đánh đổi và giới hạn

**Quay lại tab Sơ đồ**, hoặc nói chay.

> *Nhóm em kết lại bằng những gì bài này **không** bảo đảm, vì đấy là phần dễ
> nói quá lên nhất.*

| Bảo đảm | Không bảo đảm |
|---|---|
| Job DONE luôn đi kèm ý định gửi đã commit | Email hay lời gọi LLM chỉ xảy ra một lần |
| 202 và DELIVERED: inbox đã bền vững | Receiver ngừng vô thời hạn vẫn nhận được |
| Thay đổi trong DB receiver áp dụng một lần, version không giảm | Đúng khi chạy nhiều relay |

> *Ba đánh đổi cụ thể.*

> *Một — chống lặp chỉ nằm **trong DB receiver**. Nếu thay cập nhật DB bằng gửi
> email thì inbox không cứu được: worker gửi email rồi chết trước commit, lần
> sau gửi lại. Cần idempotency key phía nhà cung cấp.*

> *Hai — retry **hữu hạn**: 4 lần mỗi vòng, tối đa 4 lần replay. Hết thì sự
> kiện thành DEAD và cần người can thiệp. Đổi lại, hệ thống không dồn request
> vô hạn vào một receiver đang lỗi.*

> *Ba — lab chạy **một** relay nên không cần lease. Code có `SKIP LOCKED` sẵn
> nhưng nhóm em **không** tuyên bố là chạy nhiều relay sẽ đúng, vì chưa kiểm.*

**Câu kết:**

> *Nhóm em không tuyên bố exactly-once đầu cuối. Cái đạt được là: không mất sự
> kiện, không áp dụng lặp trong DB receiver, và mọi khẳng định đều chứng minh
> được bằng snapshot hai DB chứ không phải bằng log.*

---

## §8 — Bản rút gọn 6 phút

Nếu bị cắt giờ, bỏ F1, F2, F3 và phần giải pháp chi tiết:

| Phút | Nội dung |
|---|---|
| 0:00–1:00 | Vấn đề: dual-write, vạch đỏ trên sơ đồ |
| 1:00–2:00 | Giải pháp: outbox + inbox + chữ ký, hai ô vàng 202 / DELIVERED |
| 2:00–3:00 | H0 trên tab Chạy tay, chỉ cột `body sha` khớp hai bên |
| 3:00–4:15 | **F7** — kill worker, cùng rollback, `applied_count = 1` |
| 4:15–5:15 | **F10** — DELIVERED mà API trả 404 |
| 5:15–6:00 | Đánh đổi và giới hạn |

---

## §9 — Câu hỏi thầy hay hỏi, và câu trả lời ngắn

| Câu hỏi | Trả lời |
|---|---|
| "Sao không dùng 2PC cho hai DB?" | Hai database riêng, hai pool riêng — mở transaction bắc qua là chuyện **không viết ra được**. 2PC khóa tài nguyên qua mạng và kẹt khi coordinator chết; outbox đổi bài toán thành "ghi cùng một DB rồi gửi sau". |
| "Relay chết lúc đang gửi thì sao?" | Ca F3. Attempt đóng thành UNKNOWN, outbox vẫn PENDING nên được gửi lại, inbox chống lặp theo `event_id`. |
| "Sao biết receiver nhận đúng một lần?" | Không. Receiver **nhận** có thể nhiều lần, nhưng **áp dụng** đúng một lần: UNIQUE `(source, event_id)` cộng dấu PROCESSED. `applied_count` là bằng chứng bằng số. |
| "HMAC có chặn được gửi lại không?" | Không. HMAC chỉ chứng minh request do bên giữ secret tạo và chưa bị sửa. Bản sao nguyên vẹn trong cửa sổ 300 giây vẫn hợp lệ — inbox mới là chỗ chặn. |
| "Sao `event_id` lại là E42?" | Dẫn xuất từ job cho dễ đọc khi demo. Yêu cầu thật chỉ là ổn định và duy nhất; production dùng UUIDv7. |
| "Nếu thầy xóa một dòng outbox thì sao?" | DB từ chối: có constraint trigger ở `db/010_sender.sql` dòng 140. Sửa `raw_body` cũng bị chặn. Mở `npm run db:invariants` cho thầy xem 26 bất biến. |
| "Chạy hai relay được không?" | Về khóa thì `SKIP LOCKED` chịu được, nhưng nhóm em **chưa kiểm** nên không tuyên bố. Đây là giới hạn đã công bố. |
| "Lỡ receiver trả 500 mãi?" | 4 lần mỗi vòng, chờ 1/3/9 giây, rồi DEAD. Sửa xong thì replay — giữ nguyên `event_id` và `raw_body`, tối đa 4 lần replay. Ca F8. |

---

## §10 — Phân vai (nhóm 5 người)

| Vai | Làm gì |
|---|---|
| Người 1 | Phút 0:00–3:30: vấn đề và giải pháp trên sơ đồ |
| Người 2 | Phút 3:30–5:00: H0 trên tab Chạy tay |
| Người 3 | Phút 5:00–9:30: bốn ca kill thật |
| Người 4 | Phút 9:30–11:00: F10 và F9, hai ca về giới hạn |
| Người 5 | Phút 11:00–12:00: đánh đổi; và mở mã khi thầy hỏi (bảng ở `HUONG-DAN-DEMO.md` §7) |

Người 5 nên mở sẵn bốn file mã trong editor trước khi lên.
