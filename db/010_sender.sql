\connect sender

-- =====================================================================
-- DB SENDER: jobs + transactional outbox + lịch sử từng lần gửi
-- Thời gian dùng clock_timestamp() (giờ thật lúc chạy lệnh), không dùng
-- now() (giờ mở transaction), để khoảng chờ 1/3/9 s ở F8 đo được đúng.
-- =====================================================================

-- Chạy sai database thì phải hỏng ngay, không âm thầm tạo bảng ở DB 'app'.
DO $$
BEGIN
  IF current_database() <> 'sender' THEN
    RAISE EXCEPTION 'file này phải chạy trên database sender, đang ở %', current_database();
  END IF;
END $$;

-- Không cần extension nào: sha256(bytea) là hàm có sẵn của Postgres (>= 11).
-- pgcrypto chỉ cần nếu dùng digest()/crypt(); bài này không dùng.

-- ---------------------------------------------------------------------
-- Cửa thoát duy nhất cho harness khi reset fixture giữa các ca.
-- Các trigger bảo vệ bất biến bên dưới chỉ nhường đường khi transaction
-- bật cờ này:  SET LOCAL block9.fixture_reset = 'on';
-- Mã nghiệp vụ KHÔNG BAO GIỜ được bật cờ này.
-- ---------------------------------------------------------------------
CREATE FUNCTION block9_fixture_reset() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('block9.fixture_reset', true), 'off') = 'on'
$$;

CREATE FUNCTION block9_block_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF block9_fixture_reset() THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'TRUNCATE % bị chặn (TRUNCATE không kích hoạt trigger DELETE nên phải chặn riêng)', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'nếu đang reset fixture: BEGIN; SET LOCAL block9.fixture_reset = ''on''; ...';
END $$;

-- attempt_id đọc được trong snapshot: A1, A2, A3…
-- nextval KHÔNG thuộc transaction: một INSERT bị rollback vẫn tiêu một số,
-- nên dãy có thể nhảy. Đọc thứ tự theo (round, attempt_in_round).
CREATE SEQUENCE delivery_attempt_seq;

-- ---------------------------------------------------------------------
-- jobs: job tóm tắt. summary là fixture, lab không gọi LLM.
-- ---------------------------------------------------------------------
CREATE TABLE jobs (
  job_id   TEXT PRIMARY KEY,                         -- 'J42', 'J43'
  video_id TEXT NOT NULL,                            -- 'V7'
  version  INT  NOT NULL CHECK (version > 0),
  summary  TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('READY', 'DONE')),
  done_at  TIMESTAMPTZ,
  UNIQUE (video_id, version),
  CONSTRAINT jobs_done_at_matches_status CHECK (
    (status = 'READY' AND done_at IS NULL) OR
    (status = 'DONE'  AND done_at IS NOT NULL)
  )
);

-- ---------------------------------------------------------------------
-- outbox: ý định gửi, commit CÙNG transaction với jobs.status = 'DONE'.
--   event_id  sinh tại INSERT này, KHÔNG đổi qua retry và replay.
--   raw_body  serialize MỘT lần; mọi lần gửi dùng đúng các byte này
--             (chữ ký HMAC ký trên chính raw body).
--   round     vòng gửi. Vòng 1 là lần đầu; mỗi replay cấp một vòng mới,
--             tối đa 4 lần replay -> round cao nhất là 5.
-- Không có cột "đang gửi": relay chỉ đọc PENDING đã đến hạn, nên crash
-- giữa đường không làm dòng bị kẹt (quy tắc 2).
--
-- Hai hằng số của lab nằm thẳng trong CHECK: 4 lần mỗi vòng và 5 vòng.
-- Đổi MAX_ATTEMPTS_PER_ROUND hay MAX_REPLAYS trong .env mà không viết
-- migration mới thì DB sẽ từ chối — đó là ý muốn, không phải lỗi.
-- ---------------------------------------------------------------------
CREATE TABLE outbox (
  event_id          TEXT PRIMARY KEY,                -- 'E42'
  job_id            TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
  event_type        TEXT NOT NULL DEFAULT 'summary.completed',
  schema_version    INT  NOT NULL DEFAULT 1,
  raw_body          BYTEA NOT NULL,
  body_sha256       BYTEA GENERATED ALWAYS AS (sha256(raw_body)) STORED,
  status            TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'DELIVERED', 'DEAD')),
  round             INT  NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 5),
  attempts_in_round INT  NOT NULL DEFAULT 0 CHECK (attempts_in_round BETWEEN 0 AND 4),
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at      TIMESTAMPTZ,
  dead_at           TIMESTAMPTZ,
  CONSTRAINT outbox_terminal_time CHECK (
    (status = 'PENDING'   AND delivered_at IS NULL     AND dead_at IS NULL) OR
    (status = 'DELIVERED' AND delivered_at IS NOT NULL AND dead_at IS NULL) OR
    (status = 'DEAD'      AND delivered_at IS NULL     AND dead_at IS NOT NULL)
  )
);

-- Relay chỉ quét đúng tập dòng này. Điều kiện attempts_in_round < 4 nằm
-- trong chính index: một dòng đã hết lượt không bao giờ được nhặt lên gửi
-- lần thứ 5 (xem T4 trong docs/SCHEMA.md).
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at)
  WHERE status = 'PENDING' AND attempts_in_round < 4;

-- ---------------------------------------------------------------------
-- Tính nguyên tử ở sender, do DB tự bảo đảm:
-- commit nào để lại job DONE mà không có dòng outbox sẽ bị từ chối.
-- DEFERRABLE INITIALLY DEFERRED: kiểm tại COMMIT, nên thứ tự UPDATE jobs
-- rồi INSERT outbox trong cùng transaction vẫn hợp lệ.
-- ---------------------------------------------------------------------
CREATE FUNCTION assert_done_job_has_outbox() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'DONE'
     AND NOT EXISTS (SELECT 1 FROM outbox WHERE job_id = NEW.job_id) THEN
    RAISE EXCEPTION 'job % DONE nhưng không có outbox event', NEW.job_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER jobs_done_requires_outbox
  AFTER INSERT OR UPDATE ON jobs
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_done_job_has_outbox();

-- Mặt còn lại của cùng bất biến: xóa dòng outbox của một job đang DONE
-- cũng làm "job DONE luôn có sự kiện" sai. Kiểm tại COMMIT nên nếu cùng
-- transaction đưa job về READY thì vẫn hợp lệ.
CREATE FUNCTION assert_outbox_delete_keeps_invariant() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF block9_fixture_reset() THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM jobs WHERE job_id = OLD.job_id AND status = 'DONE') THEN
    RAISE EXCEPTION 'xóa outbox % làm job % DONE không còn sự kiện', OLD.event_id, OLD.job_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER outbox_delete_keeps_invariant
  AFTER DELETE ON outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_outbox_delete_keeps_invariant();

CREATE TRIGGER outbox_truncate_guard
  BEFORE TRUNCATE ON outbox
  FOR EACH STATEMENT EXECUTE FUNCTION block9_block_truncate();

-- ---------------------------------------------------------------------
-- Bất biến của sự kiện: event_id, job_id và raw_body KHÔNG đổi sau khi
-- commit. Đây là điều kiện để chữ ký tính lại được và để receiver nhận ra
-- bản sao. round chỉ tăng.
-- ---------------------------------------------------------------------
CREATE FUNCTION assert_outbox_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.raw_body IS DISTINCT FROM OLD.raw_body
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outbox %: event_id, job_id, raw_body, event_type, schema_version và created_at là bất biến', OLD.event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.round < OLD.round THEN
    RAISE EXCEPTION 'outbox %: round chỉ tăng (% -> %)', OLD.event_id, OLD.round, NEW.round
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_immutable
  BEFORE UPDATE ON outbox
  FOR EACH ROW EXECUTE FUNCTION assert_outbox_immutable();

-- Nội dung job đã DONE cũng bất biến: raw_body được serialize TỪ nó, nên
-- sửa job sau khi DONE sẽ làm sự kiện đã gửi không còn khớp dữ liệu.
CREATE FUNCTION assert_job_stable_after_done() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF block9_fixture_reset() THEN RETURN NEW; END IF;
  IF OLD.status = 'DONE' THEN
    IF NEW.status <> 'DONE' THEN
      RAISE EXCEPTION 'job % đã DONE, không quay lại %', OLD.job_id, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.video_id IS DISTINCT FROM OLD.video_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.summary IS DISTINCT FROM OLD.summary THEN
      RAISE EXCEPTION 'job % đã DONE: video_id, version và summary là bất biến', OLD.job_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER jobs_stable_after_done
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION assert_job_stable_after_done();

CREATE TRIGGER jobs_truncate_guard
  BEFORE TRUNCATE ON jobs
  FOR EACH STATEMENT EXECUTE FUNCTION block9_block_truncate();

-- ---------------------------------------------------------------------
-- delivery_attempts: một dòng cho MỘT lần gửi.
--   attempt_id đổi mỗi lần; event_id giữ nguyên  -> phân biệt sự kiện / lần gửi.
--   outcome 'STARTED' commit TRƯỚC khi gọi HTTP (quy tắc 2); restart đóng
--   mọi dòng STARTED thành 'UNKNOWN'.
--   request_timestamp là X-Webhook-Timestamp đã ký: bằng chứng mỗi lần gửi
--   ký lại timestamp mới trong khi raw body không đổi.
-- ---------------------------------------------------------------------
CREATE TABLE delivery_attempts (
  attempt_id        TEXT PRIMARY KEY DEFAULT ('A' || nextval('delivery_attempt_seq')),
  event_id          TEXT NOT NULL REFERENCES outbox(event_id),
  round             INT  NOT NULL CHECK (round BETWEEN 1 AND 5),
  attempt_in_round  INT  NOT NULL CHECK (attempt_in_round BETWEEN 1 AND 4),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  finished_at       TIMESTAMPTZ,
  http_status       INT,
  outcome           TEXT NOT NULL DEFAULT 'STARTED'
                    CHECK (outcome IN ('STARTED', 'ACKNOWLEDGED', 'RETRYABLE', 'REJECTED', 'UNKNOWN')),
  error_kind        TEXT CHECK (error_kind IN ('TIMEOUT', 'CONNECTION', 'HTTP', 'REDIRECT')),
  retry_after_s     INT,
  request_timestamp BIGINT NOT NULL,
  UNIQUE (event_id, round, attempt_in_round),
  CONSTRAINT attempt_open_iff_started CHECK (
    (outcome =  'STARTED' AND finished_at IS NULL) OR
    (outcome <> 'STARTED' AND finished_at IS NOT NULL)
  )
);
CREATE INDEX delivery_attempts_event_idx ON delivery_attempts (event_id, started_at);

-- Một process chỉ có thể có một attempt đang mở; dòng STARTED là bằng chứng
-- của ca (a) và (b) trên slide nên không được xóa.
CREATE TRIGGER delivery_attempts_truncate_guard
  BEFORE TRUNCATE ON delivery_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION block9_block_truncate();

-- ---------------------------------------------------------------------
-- replays: ghi nhận thao tác replay. round 2..5 -> tối đa 4 lần replay.
-- ---------------------------------------------------------------------
CREATE TABLE replays (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES outbox(event_id),
  round       INT  NOT NULL CHECK (round BETWEEN 2 AND 5),  -- vòng mới được cấp
  replayed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  note        TEXT,
  UNIQUE (event_id, round)
);

CREATE TRIGGER replays_truncate_guard
  BEFORE TRUNCATE ON replays
  FOR EACH STATEMENT EXECUTE FUNCTION block9_block_truncate();
