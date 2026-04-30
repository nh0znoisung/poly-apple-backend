# 🍎 Poly Apple - Backend

Đây là Máy chủ phân xử (Authoritative Server) của tựa game **Poly Apple**. Backend chịu trách nhiệm quản lý phòng chơi, tính điểm, xác định thắng thua và đồng bộ hóa trạng thái theo thời gian thực (Real-time) cho hàng ngàn người chơi cùng lúc.

## 🛠 Tech Stack & Versions

- **Core Runtime:** Node.js.
- **Web Framework:** Express.js (`^4.18.2`) - Phục vụ định tuyến (nếu cần mở rộng API sau này) và hỗ trợ middleware.
- **CORS:** Thư viện `cors` (`^2.8.6`) - Cho phép Frontend (chạy ở port khác hoặc Vercel) kết nối an toàn.
- **Real-time Engine:** Socket.io (`^4.6.1`) - Xử lý truyền tải dữ liệu đa chiều với độ trễ siêu thấp qua Websocket.

## 🚀 Cách chạy dự án (Local Development)

1. Mở Terminal tại thư mục `backend/`.
2. Cài đặt thư viện:
   ```bash
   npm install
   ```
3. Khởi động Server (chạy với Nodemon để tự reload khi lưu code):
   ```bash
   npm run dev
   ```
   *(Server sẽ mặc định chạy trên cổng `http://localhost:3000`)*

## 📂 Tổ chức File (File Structure)

```text
backend/
├── server.js        # File cấu hình chính chứa toàn bộ logic Server và Websocket.
├── package.json     # Quản lý thư viện phụ thuộc.
├── data/            # (Tự động sinh ra) Thư mục đóng vai trò như NoSQL Database nội bộ.
│   ├── players.json # Lưu trữ định danh (UUID) và thông tin cá nhân.
│   ├── rooms.json   # Lưu trữ trạng thái các phòng (Đang chờ, Đang chơi, Đã xong).
│   └── sessions.json# Lưu trữ toàn bộ Lịch sử các ván đấu (Phương trình đã nhập, số táo bị ăn).
└── README.md        # File tài liệu bạn đang đọc.
```

## ⚙️ Cách hoạt động của các Chức năng chính (Functionals)

- **NoSQL File-based System:** Tránh việc quá tải Database khi làm MVP, hệ thống dùng `Map()` nội bộ trong RAM Node.js để thao tác cực nhanh, và dùng `fs.writeFileSync` (2 giây/lần) để dump dữ liệu ra các file `.json` trong thư mục `data/` nhằm lưu trữ dài hạn (Backup).
- **Room Management (`roomsDb`):** Xử lý logic khởi tạo phòng, mã phòng random 6 chữ số, và xác nhận khi cả 2 người chơi đã Ready.
- **Authoritative State:** Mọi quyết định ăn táo, tính điểm, kết thúc trận đấu đều được tổng hợp lại tại Server (`sessionDb`) để chống hack từ Client. Server giữ vai trò làm "Trọng tài".
- **Garbage Collection (Cron Job):** Cứ mỗi 1 phút, Server tự động rà soát và xóa vĩnh viễn những phòng trống đã tồn tại quá 5 phút để giải phóng bộ nhớ RAM.
- **Spectator Mode (Khán giả):** Cho phép Client join vào xem game đang diễn ra. Server sẽ gửi xuống 1 object đồng bộ toàn bộ bối cảnh (`eatenApples`, `elapsedTime`, `history`) để Client của khán giả có thể hiển thị như đang xem trực tiếp từ đầu.
