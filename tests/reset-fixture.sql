-- =====================================================================
-- Đưa cả hai DB về trạng thái fixture, dùng giữa các ca kiểm.
-- KHÁC với tests/schema-invariants.sql: file này CHỈ reset, không chèn dòng
-- kiểm nào. Dùng nó để reset giữa các ca; dùng file kia để kiểm schema.
--
--   psql -U app -d app -v ON_ERROR_STOP=1 -q -f tests/reset-fixture.sql
--
-- Nên dừng relay và receiver-worker trước khi chạy: hai process đó đang quét
-- bảng và sẽ thấy dữ liệu biến mất giữa transaction của chúng.
-- =====================================================================

\set ON_ERROR_STOP on

\connect sender
DO $$
BEGIN
  IF current_database() <> 'sender' THEN
    RAISE EXCEPTION 'phần này phải chạy trên DB sender, đang ở %', current_database();
  END IF;
END $$;

BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE replays, delivery_attempts, outbox;
  UPDATE jobs SET status = 'READY', done_at = NULL;
COMMIT;

\connect receiver
DO $$
BEGIN
  IF current_database() <> 'receiver' THEN
    RAISE EXCEPTION 'phần này phải chạy trên DB receiver, đang ở %', current_database();
  END IF;
END $$;

BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE inbox, video_summaries;
COMMIT;

\echo '>>> Fixture đã reset: J42, J43 READY; outbox, attempts, replays, inbox, video_summaries rỗng.'
