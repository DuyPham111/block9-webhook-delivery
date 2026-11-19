\connect receiver

-- =====================================================================
-- DB RECEIVER: inbox (nhận bền vững) + video_summaries (nghiệp vụ)
-- Receiver API chỉ ghi inbox rồi trả 202. Worker đọc inbox và cập nhật
-- nghiệp vụ trong một transaction KHÁC.
-- =====================================================================

-- Chạy sai database thì phải hỏng ngay.
DO $$
BEGIN
  IF current_database() <> 'receiver' THEN
    RAISE EXCEPTION 'file này phải chạy trên database receiver, đang ở %', current_database();
  END IF;
END $$;

-- Không cần extension nào: sha256(bytea) có sẵn trong Postgres (>= 11).
-- pgcrypto chỉ cần nếu dùng digest()/crypt(); bài này không dùng.
-- Hai hàm dưới đây phải tạo lại ở DB này: function không dùng chung được
-- giữa hai database, dù cùng một server.

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

-- ---------------------------------------------------------------------
-- inbox: mỗi sự kiện đã nhận là một dòng.
--   UNIQUE (source, event_id) là cơ chế nhận ra bản sao (quy tắc 5).
--   source gắn với secret trong cấu hình, KHÔNG lấy từ header tùy ý:
--   nếu lấy từ header thì bên gửi tự đổi source là qua được UNIQUE.
--   raw_body giữ nguyên byte đã nhận; body_sha256 để so bản sao cùng ID
--   khác payload -> 409 mà không cần so chuỗi dài.
-- ---------------------------------------------------------------------
CREATE TABLE inbox (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source         TEXT NOT NULL,
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  schema_version INT  NOT NULL CHECK (schema_version > 0),
  video_id       TEXT NOT NULL,
  version        INT  NOT NULL CHECK (version > 0),
  raw_body       BYTEA NOT NULL,
  body_sha256    BYTEA GENERATED ALWAYS AS (sha256(raw_body)) STORED,
  status         TEXT NOT NULL DEFAULT 'RECEIVED'
                 CHECK (status IN ('RECEIVED', 'PROCESSED')),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processed_at   TIMESTAMPTZ,
  CONSTRAINT inbox_source_event_uniq UNIQUE (source, event_id),
  CONSTRAINT inbox_processed_at_matches_status CHECK (
    (status = 'RECEIVED'  AND processed_at IS NULL) OR
    (status = 'PROCESSED' AND processed_at IS NOT NULL)
  )
);

-- Worker chỉ quét đúng tập dòng này, theo thứ tự nhận.
CREATE INDEX inbox_pending_idx ON inbox (received_at) WHERE status = 'RECEIVED';

-- ---------------------------------------------------------------------
-- Dòng inbox là chính bằng chứng chống lặp: xóa một dòng PROCESSED thì sự
-- kiện đó áp dụng được lần thứ hai. Nội dung đã nhận cũng bất biến —
-- receiver không được "sửa lại" payload đã ký.
-- ---------------------------------------------------------------------
CREATE FUNCTION assert_inbox_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.raw_body IS DISTINCT FROM OLD.raw_body
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
     OR NEW.video_id IS DISTINCT FROM OLD.video_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'inbox %: chỉ status và processed_at được đổi', OLD.event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- PROCESSED là một chiều: không quay về RECEIVED để xử lý lại.
  IF OLD.status = 'PROCESSED' AND NEW.status <> 'PROCESSED' THEN
    RAISE EXCEPTION 'inbox %: PROCESSED không quay lại %', OLD.event_id, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER inbox_immutable
  BEFORE UPDATE ON inbox
  FOR EACH ROW EXECUTE FUNCTION assert_inbox_immutable();

CREATE FUNCTION assert_inbox_delete_blocked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF block9_fixture_reset() THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'xóa inbox % làm mất bằng chứng chống lặp', OLD.event_id
    USING ERRCODE = 'integrity_constraint_violation';
END $$;

CREATE TRIGGER inbox_delete_blocked
  BEFORE DELETE ON inbox
  FOR EACH ROW EXECUTE FUNCTION assert_inbox_delete_blocked();

CREATE TRIGGER inbox_truncate_guard
  BEFORE TRUNCATE ON inbox
  FOR EACH STATEMENT EXECUTE FUNCTION block9_block_truncate();

-- ---------------------------------------------------------------------
-- video_summaries: bản tóm tắt hiện tại của mỗi video.
--   applied_count CHỈ tăng khi version mới thật sự thay bản hiện tại,
--   nên nó là bộ đếm "số lần áp dụng nghiệp vụ": chứng minh chống lặp
--   bằng số, không bằng log.
-- ---------------------------------------------------------------------
CREATE TABLE video_summaries (
  video_id        TEXT PRIMARY KEY,
  version         INT  NOT NULL CHECK (version > 0),
  summary         TEXT NOT NULL,
  applied_count   INT  NOT NULL DEFAULT 1 CHECK (applied_count >= 1),
  source_event_id TEXT NOT NULL,                    -- event đang giữ bản hiện tại
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------------
-- Lưới an toàn cho "version không giảm": UPSERT của worker đã có điều kiện
-- version lớn hơn, trigger này chặn cả đường ghi sai khác (F9).
-- ---------------------------------------------------------------------
CREATE FUNCTION assert_version_never_decreases() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'video % : version % thấp hơn bản hiện tại %',
      OLD.video_id, NEW.version, OLD.version
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER video_summaries_version_monotonic
  BEFORE UPDATE ON video_summaries
  FOR EACH ROW EXECUTE FUNCTION assert_version_never_decreases();

CREATE TRIGGER video_summaries_truncate_guard
  BEFORE TRUNCATE ON video_summaries
  FOR EACH STATEMENT EXECUTE FUNCTION block9_block_truncate();
