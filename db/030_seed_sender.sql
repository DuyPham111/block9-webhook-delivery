\connect sender

DO $$
BEGIN
  IF current_database() <> 'sender' THEN
    RAISE EXCEPTION 'file này phải chạy trên database sender, đang ở %', current_database();
  END IF;
END $$;

-- Fixture của lab: hai job cùng video V7, version 1 và version 2.
-- Nội dung tóm tắt là văn bản giả định, lab không gọi LLM.
INSERT INTO jobs (job_id, video_id, version, summary, status) VALUES
  ('J42', 'V7', 1, 'Nội dung tóm tắt giả định của video V7.',            'READY'),
  ('J43', 'V7', 2, 'Nội dung tóm tắt giả định của video V7, bản sửa.',   'READY');
