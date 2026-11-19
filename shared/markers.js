import fs from 'node:fs';
import { config } from './config.js';

// Marker là một điểm trong mã. Khi MARKER=<tên> thì process in một dòng nhận
// diện rồi DỪNG tại đó cho tới khi harness cho chạy tiếp (tạo file ở
// MARKER_RELEASE_FILE) hoặc kill process.
//
// Hai điều không được làm, vì sẽ làm ca kiểm vô nghĩa:
//   - không bọc try/catch quanh marker: process phải bị kill từ ngoài
//   - không thêm nhánh if (test) vào logic nghiệp vụ: marker là điểm dừng,
//     không đổi đường đi của dữ liệu
const fired = new Set();

export async function marker(name) {
  if (config.marker !== name) return;
  if (fired.has(name)) return; // mỗi marker chỉ bật một lần cho mỗi process (ca F4)
  fired.add(name);

  console.log(`MARKER ${name} pid=${process.pid}`);

  for (;;) {
    if (config.markerReleaseFile && fs.existsSync(config.markerReleaseFile)) {
      console.log(`MARKER ${name} released`);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
