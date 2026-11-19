-- =====================================================================
-- Kiểm các bất biến của schema Block 9 bằng chính DB, không qua service.
-- Chạy trên CẢ HAI database: sender rồi receiver (có kiểm current_database
-- sau mỗi \connect, nên chạy sai DB thì hỏng ngay thay vì âm thầm bỏ qua).
-- Mỗi ca FAIL thì RAISE EXCEPTION, nên exit code phản ánh kết quả.
--
--   psql -U app -d app -v ON_ERROR_STOP=1 -q -f tests/schema-invariants.sql
--
-- Chỉ chạy trên DB nháp: file reset dữ liệu về trạng thái fixture.
-- KHÔNG chạy trên DB đang giữ bằng chứng của một ca F.
-- =====================================================================

\set ON_ERROR_STOP on

-- =====================================================================
\connect sender
-- =====================================================================
DO $$
BEGIN
  IF current_database() <> 'sender' THEN
    RAISE EXCEPTION 'phần này phải chạy trên DB sender, đang ở %', current_database();
  END IF;
  RAISE NOTICE '--- DB sender ---';
END $$;

-- Reset fixture: TRUNCATE và việc đưa job về READY đều bị trigger chặn,
-- nên phải bật cờ thoát trong chính transaction này. Mã nghiệp vụ không
-- bao giờ bật cờ này.
BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE replays, delivery_attempts, outbox;
  UPDATE jobs SET status = 'READY', done_at = NULL;
COMMIT;

-- S1: tính nguyên tử ở sender. Commit để lại job DONE mà không có outbox
--     phải bị DB từ chối (constraint trigger deferred).
DO $$
BEGIN
  UPDATE jobs SET status = 'DONE', done_at = clock_timestamp() WHERE job_id = 'J42';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'FAIL S1: job DONE thiếu outbox vẫn được chấp nhận';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S1: job DONE thiếu outbox bị từ chối';
END $$;

-- S2: DONE và INSERT outbox trong cùng transaction thì commit được.
BEGIN;
  UPDATE jobs SET status = 'DONE', done_at = clock_timestamp() WHERE job_id = 'J42';
  INSERT INTO outbox (event_id, job_id, raw_body)
  VALUES ('E42', 'J42', convert_to('{"event_id":"E42","data":{"version":1}}', 'UTF8'));
COMMIT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM jobs WHERE job_id='J42' AND status='DONE')
     OR NOT EXISTS (SELECT 1 FROM outbox WHERE event_id='E42' AND status='PENDING') THEN
    RAISE EXCEPTION 'FAIL S2: thiếu job DONE hoặc outbox PENDING';
  END IF;
  RAISE NOTICE 'PASS S2: job DONE + outbox PENDING cùng commit';
END $$;

-- S3: một job tối đa một event.
DO $$
BEGIN
  INSERT INTO outbox (event_id, job_id, raw_body) VALUES ('E42b', 'J42', convert_to('x','UTF8'));
  RAISE EXCEPTION 'FAIL S3: tạo được event thứ hai cho cùng job';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS S3: outbox.job_id UNIQUE chặn event thứ hai';
END $$;

-- S4: mặt còn lại của bất biến S1 — xóa outbox của job đang DONE.
--     (Chạy trước khi có delivery_attempts, để không vướng khóa ngoại.)
DO $$
BEGIN
  DELETE FROM outbox WHERE event_id = 'E42';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'FAIL S4: xóa được outbox của job đang DONE';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S4: xóa outbox của job DONE bị từ chối';
END $$;

-- S5: TRUNCATE không kích hoạt trigger DELETE, nên phải chặn riêng.
--     Truncate cả ba bảng cùng lúc, nếu không Postgres chặn vì khóa ngoại
--     trước khi trigger kịp chạy, và ca kiểm sẽ không chứng minh được gì.
DO $$
BEGIN
  TRUNCATE outbox, delivery_attempts, replays;
  RAISE EXCEPTION 'FAIL S5: TRUNCATE outbox không bị chặn';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S5: TRUNCATE outbox bị chặn khi không bật cờ reset';
END $$;

-- S6, S7: raw_body và event_id bất biến — điều kiện để chữ ký tính lại
--         được và để receiver nhận ra bản sao.
DO $$
BEGIN
  UPDATE outbox SET raw_body = convert_to('{"event_id":"E42","data":{"version":99}}','UTF8') WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL S6: sửa được raw_body';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S6: raw_body bất biến';
END $$;
DO $$
BEGIN
  UPDATE outbox SET event_id = 'E999' WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL S7: sửa được event_id';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S7: event_id bất biến';
END $$;

-- S8, S9: tối đa 4 lần replay. Vòng 1 là lần gửi đầu, replay cấp vòng
--         2..5, nên round = 6 không tồn tại.
DO $$
BEGIN
  UPDATE outbox SET round = 6 WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL S8: outbox nhận round = 6';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS S8: outbox.round <= 5 (tối đa 4 lần replay)';
END $$;
DO $$
BEGIN
  INSERT INTO replays (event_id, round) VALUES ('E42', 6);
  RAISE EXCEPTION 'FAIL S9: replays nhận round = 6';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS S9: replays.round giữa 2 và 5';
END $$;
DO $$
BEGIN
  INSERT INTO replays (event_id, round) VALUES ('E42', 1);
  RAISE EXCEPTION 'FAIL S9b: replays nhận round = 1';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS S9b: không "replay" vòng đầu';
END $$;

-- S10, S11: job đã DONE thì trạng thái một chiều và nội dung bất biến
--           (raw_body được serialize TỪ nội dung này).
DO $$
BEGIN
  UPDATE jobs SET status = 'READY', done_at = NULL WHERE job_id='J42';
  RAISE EXCEPTION 'FAIL S10: job DONE quay lại được READY';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S10: job DONE không quay lại READY';
END $$;
DO $$
BEGIN
  UPDATE jobs SET summary = 'nội dung khác' WHERE job_id='J42';
  RAISE EXCEPTION 'FAIL S11: sửa được summary của job DONE';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS S11: nội dung job DONE bất biến';
END $$;

-- S12, S13: attempt đang mở <=> chưa có finished_at. Đây là cách nhìn thấy
--           một lần gửi dang dở sau crash.
DO $$
BEGIN
  INSERT INTO delivery_attempts (event_id, round, attempt_in_round, outcome, finished_at, request_timestamp)
  VALUES ('E42', 1, 1, 'STARTED', clock_timestamp(), 1794988800);
  RAISE EXCEPTION 'FAIL S12: attempt STARTED kèm finished_at được chấp nhận';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS S12: STARTED buộc finished_at NULL';
END $$;

INSERT INTO delivery_attempts (event_id, round, attempt_in_round, outcome, request_timestamp)
VALUES ('E42', 1, 1, 'STARTED', 1794988800);
DO $$
DECLARE a TEXT;
BEGIN
  SELECT attempt_id INTO a FROM delivery_attempts WHERE event_id='E42' AND outcome='STARTED';
  BEGIN
    UPDATE delivery_attempts SET outcome='ACKNOWLEDGED', http_status=202 WHERE attempt_id=a;
    RAISE EXCEPTION 'FAIL S13: đóng attempt mà không có finished_at';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS S13: đóng attempt buộc có finished_at';
  END;
  UPDATE delivery_attempts
     SET outcome='ACKNOWLEDGED', http_status=202, finished_at=clock_timestamp()
   WHERE attempt_id=a;
END $$;

-- S14: DELIVERED buộc có delivered_at (không đánh dấu suông).
DO $$
BEGIN
  UPDATE outbox SET status='DELIVERED' WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL S14: DELIVERED mà delivered_at NULL';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS S14: DELIVERED buộc có delivered_at';
END $$;

-- S15: tối đa 4 lần trong một vòng. Đây là CHECK đã chặn thật một lần gửi
--      thứ 5 sau khi relay crash ở lần thứ 4 (xem T4 trong docs/SCHEMA.md).
DO $$
BEGIN
  UPDATE outbox SET attempts_in_round = 5 WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL S15: attempts_in_round = 5 được chấp nhận';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS S15: attempts_in_round <= 4';
END $$;

-- S16: body_sha256 là generated column, luôn khớp raw_body.
DO $$
DECLARE h BYTEA;
BEGIN
  SELECT body_sha256 INTO h FROM outbox WHERE event_id='E42';
  IF h IS DISTINCT FROM sha256(convert_to('{"event_id":"E42","data":{"version":1}}','UTF8')) THEN
    RAISE EXCEPTION 'FAIL S16: body_sha256 không khớp raw_body';
  END IF;
  RAISE NOTICE 'PASS S16: body_sha256 do DB tính, khớp raw_body';
END $$;

-- =====================================================================
\connect receiver
-- =====================================================================
DO $$
BEGIN
  IF current_database() <> 'receiver' THEN
    RAISE EXCEPTION 'phần này phải chạy trên DB receiver, đang ở %', current_database();
  END IF;
  RAISE NOTICE '--- DB receiver ---';
END $$;

BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE inbox, video_summaries;
COMMIT;

-- R1 + R2: nhận bền vững và chống bản sao bằng UNIQUE (source, event_id).
INSERT INTO inbox (source, event_id, event_type, schema_version, video_id, version, raw_body)
VALUES ('summary-service', 'E42', 'summary.completed', 1, 'V7', 1, convert_to('{"v":1}','UTF8'));
DO $$
BEGIN
  INSERT INTO inbox (source, event_id, event_type, schema_version, video_id, version, raw_body)
  VALUES ('summary-service', 'E42', 'summary.completed', 1, 'V7', 1, convert_to('{"v":1}','UTF8'));
  RAISE EXCEPTION 'FAIL R2: bản sao tạo được dòng inbox thứ hai';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'PASS R2: UNIQUE (source, event_id) chặn bản sao';
END $$;

-- R3: ON CONFLICT DO NOTHING ... RETURNING rỗng ở lần hai -> receiver phân
--     biệt được "mới nhận" (202 + ghi inbox) và "đã có" (so body_sha256:
--     trùng thì 202, khác thì 409). Đây là đường đi của F6.
DO $$
DECLARE inserted BIGINT; existing_hash BYTEA;
BEGIN
  INSERT INTO inbox (source, event_id, event_type, schema_version, video_id, version, raw_body)
  VALUES ('summary-service', 'E42', 'summary.completed', 1, 'V7', 1, convert_to('{"v":1}','UTF8'))
  ON CONFLICT (source, event_id) DO NOTHING
  RETURNING id INTO inserted;
  IF inserted IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL R3: ON CONFLICT DO NOTHING vẫn chèn dòng mới';
  END IF;

  SELECT body_sha256 INTO existing_hash FROM inbox
   WHERE source='summary-service' AND event_id='E42';
  IF existing_hash IS DISTINCT FROM sha256(convert_to('{"v":1}','UTF8')) THEN
    RAISE EXCEPTION 'FAIL R3: body cùng ID lại khác hash -> sẽ trả 409 sai';
  END IF;
  IF existing_hash = sha256(convert_to('{"v":999}','UTF8')) THEN
    RAISE EXCEPTION 'FAIL R3: body khác lại cùng hash -> bỏ sót 409';
  END IF;
  RAISE NOTICE 'PASS R3: bản sao cùng payload -> 202; cùng ID khác payload -> 409';
END $$;

-- R4: PROCESSED buộc có processed_at.
DO $$
BEGIN
  UPDATE inbox SET status='PROCESSED' WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL R4: PROCESSED mà processed_at NULL';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'PASS R4: PROCESSED buộc có processed_at';
END $$;

-- R5, R6: dòng inbox là bằng chứng chống lặp, không xóa và không sửa nội dung.
DO $$
BEGIN
  DELETE FROM inbox WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL R5: xóa được dòng inbox';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS R5: không xóa được dòng inbox';
END $$;
DO $$
BEGIN
  UPDATE inbox SET raw_body = convert_to('{"v":999}','UTF8') WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL R6: sửa được raw_body của inbox';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS R6: raw_body của inbox bất biến';
END $$;

-- R7: PROCESSED là một chiều, không quay về RECEIVED để xử lý lại.
UPDATE inbox SET status='PROCESSED', processed_at=clock_timestamp() WHERE event_id='E42';
DO $$
BEGIN
  UPDATE inbox SET status='RECEIVED', processed_at=NULL WHERE event_id='E42';
  RAISE EXCEPTION 'FAIL R7: PROCESSED quay lại được RECEIVED';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS R7: PROCESSED không quay lại RECEIVED';
END $$;

-- R8 + R9: F9. E43 (version 2) tới trước, E42 (version 1) tới sau.
--          Bản hiện tại giữ version 2 và applied_count không tăng.
DO $$
DECLARE v INT; c INT; src TEXT;
BEGIN
  INSERT INTO video_summaries (video_id, version, summary, applied_count, source_event_id)
  VALUES ('V7', 2, 'ban moi', 1, 'E43')
  ON CONFLICT (video_id) DO UPDATE
     SET version=EXCLUDED.version, summary=EXCLUDED.summary,
         source_event_id=EXCLUDED.source_event_id,
         applied_count=video_summaries.applied_count+1, updated_at=clock_timestamp()
   WHERE video_summaries.version < EXCLUDED.version;

  INSERT INTO video_summaries (video_id, version, summary, applied_count, source_event_id)
  VALUES ('V7', 1, 'ban cu', 1, 'E42')
  ON CONFLICT (video_id) DO UPDATE
     SET version=EXCLUDED.version, summary=EXCLUDED.summary,
         source_event_id=EXCLUDED.source_event_id,
         applied_count=video_summaries.applied_count+1, updated_at=clock_timestamp()
   WHERE video_summaries.version < EXCLUDED.version;

  SELECT version, applied_count, source_event_id INTO v, c, src
    FROM video_summaries WHERE video_id='V7';
  IF v <> 2 OR c <> 1 OR src <> 'E43' THEN
    RAISE EXCEPTION 'FAIL R8: sau E43 rồi E42 -> version=% applied_count=% source=%', v, c, src;
  END IF;
  RAISE NOTICE 'PASS R8: sự kiện version cũ là no-op, version=2, applied_count=1';

  -- bản sao của chính E43: cũng phải là no-op
  INSERT INTO video_summaries (video_id, version, summary, applied_count, source_event_id)
  VALUES ('V7', 2, 'ban moi', 1, 'E43')
  ON CONFLICT (video_id) DO UPDATE
     SET applied_count=video_summaries.applied_count+1
   WHERE video_summaries.version < EXCLUDED.version;
  SELECT applied_count INTO c FROM video_summaries WHERE video_id='V7';
  IF c <> 1 THEN
    RAISE EXCEPTION 'FAIL R9: bản sao cùng version làm applied_count = %', c;
  END IF;
  RAISE NOTICE 'PASS R9: bản sao cùng version không tăng applied_count';
END $$;

-- R10: không đường nào hạ được version.
DO $$
BEGIN
  UPDATE video_summaries SET version = 1 WHERE video_id='V7';
  RAISE EXCEPTION 'FAIL R10: hạ được version';
EXCEPTION WHEN integrity_constraint_violation THEN
  RAISE NOTICE 'PASS R10: trigger chặn mọi UPDATE hạ version';
END $$;

-- Dọn về trạng thái trống để ca F chạy sau không thấy dữ liệu của bộ kiểm.
BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE inbox, video_summaries;
COMMIT;

\connect sender
BEGIN;
  SET LOCAL block9.fixture_reset = 'on';
  TRUNCATE replays, delivery_attempts, outbox;
  UPDATE jobs SET status='READY', done_at=NULL;
COMMIT;

\echo '>>> Tất cả bất biến schema ĐẠT trên cả hai DB (sender, receiver).'
