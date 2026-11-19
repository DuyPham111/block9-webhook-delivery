import pg from 'pg';

// BIGINT (OID 20) trả về dạng số cho dễ đọc; id trong bài nhỏ.
pg.types.setTypeParser(20, (v) => Number(v));

// Mỗi phía mở pool riêng cho DB của mình. Không có hàm nào nhận hai pool:
// một transaction bao quanh cả hai DB phải là chuyện không viết được.
export function makeDb(connectionString, label) {
  if (!connectionString) throw new Error(`thiếu connection string cho DB ${label}`);
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (err) => console.error(`[${label}] pg pool error`, err.message));

  // Một transaction phải chạy trọn trên MỘT client lấy từ pool.connect().
  // Gọi pool.query rải rác thì BEGIN và COMMIT có thể rơi vào hai kết nối.
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return { pool, tx, label };
}
