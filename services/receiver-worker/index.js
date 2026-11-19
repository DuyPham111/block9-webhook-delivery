import { config } from '../../shared/config.js';
import { makeDb } from '../../shared/db.js';
import { marker } from '../../shared/markers.js';

const db = makeDb(config.receiverDatabaseUrl, 'receiver');
let stopping = false;

// ---------------------------------------------------------------------------
// T6 — một transaction cho MỘT dòng inbox.
//
// Khóa dòng RECEIVED, cập nhật nghiệp vụ nếu version mới lớn hơn, đánh
// PROCESSED, rồi commit. Dấu PROCESSED và thay đổi nghiệp vụ nằm trong CÙNG
// một commit: crash giữa đường thì cả hai cùng rollback (F7).
//
// Không có lời gọi HTTP nào trong transaction này.
// ---------------------------------------------------------------------------
async function processOne() {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT id, event_id, video_id, version, raw_body
         FROM inbox
        WHERE status = 'RECEIVED'
        ORDER BY received_at
          FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;

    // summary nằm trong raw_body — các byte y nguyên như đã ký.
    const summary = JSON.parse(row.raw_body.toString('utf8')).data.summary;

    // Chỉ cập nhật khi version mới LỚN HƠN bản hiện tại. Mệnh đề WHERE trên
    // DO UPDATE làm sự kiện version cũ thành no-op, nên applied_count không
    // tăng và version không giảm (F9).
    const applied = await c.query(
      `INSERT INTO video_summaries (video_id, version, summary, applied_count, source_event_id)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (video_id) DO UPDATE
          SET version = EXCLUDED.version,
              summary = EXCLUDED.summary,
              source_event_id = EXCLUDED.source_event_id,
              applied_count = video_summaries.applied_count + 1,
              updated_at = clock_timestamp()
        WHERE video_summaries.version < EXCLUDED.version
       RETURNING version, applied_count`,
      [row.video_id, row.version, summary, row.event_id],
    );
    // rowCount = 0 nghĩa là sự kiện này cũ hơn bản hiện tại: bỏ qua, nhưng
    // vẫn đánh PROCESSED vì nó đã được xét xong.
    const changed = applied.rowCount === 1;

    // F7: kill ở đây thì cả thay đổi nghiệp vụ và dấu PROCESSED cùng rollback.
    await marker('after_projection_write_before_commit');

    // Chỉ chuyển một chiều RECEIVED -> PROCESSED.
    const done = await c.query(
      `UPDATE inbox SET status = 'PROCESSED', processed_at = clock_timestamp()
        WHERE id = $1 AND status = 'RECEIVED'`,
      [row.id],
    );
    // Dòng này đang bị khóa trong chính transaction này, nên rowCount <> 1
    // không phải tranh chấp mà là lỗi logic. Lặng lẽ commit sẽ ghi thay đổi
    // nghiệp vụ mà không đánh dấu inbox — đúng cái bẫy quy tắc 6 cấm.
    if (done.rowCount !== 1) {
      throw new Error(
        `T6: UPDATE inbox id=${row.id} đổi ${done.rowCount} dòng, phải là 1 — rollback`,
      );
    }

    return { eventId: row.event_id, videoId: row.video_id, version: row.version, changed };
  });
}

async function main() {
  console.log(`receiver-worker chạy (marker=${config.marker || 'không'})`);

  while (!stopping) {
    const done = await processOne();
    if (!done) {
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
      continue;
    }
    console.log(
      `${done.eventId}: ${done.videoId} version ${done.version} -> ` +
        (done.changed ? 'đã áp dụng' : 'bỏ qua (version cũ hơn bản hiện tại)'),
    );
  }
  await db.pool.end();
}

process.on('SIGTERM', () => {
  stopping = true;
});

await main();
