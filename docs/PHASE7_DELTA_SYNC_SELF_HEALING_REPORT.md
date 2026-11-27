# PHASE 7 — DELTA SYNC AND SELF-HEALING (2.3.29)

## Kết luận cổng nghiệm thu
**ĐÃ HOÀN THIỆN VÀ KIỂM CHỨNG TRÊN HUB THẬT TRONG MỘT MÁY — CHƯA ĐƯỢC PASS RELEASE GATE.**
Cả bốn điều kiện gate đạt với Hub thật (HTTP federation, SQLite, ledger ký) chạy trong cùng một máy. Chưa có test nhiều máy / Internet công cộng / libp2p thật, và Phase 5–6 cũng đang ở cùng trạng thái, nên theo nguyên tắc 12 chưa đánh PASS.

| Gate | Kết quả | Bằng chứng |
|---|---|---|
| Không tải lại dữ liệu không thay đổi | đạt | sync ledger lần 2: 0 sự kiện, `duplicate=0`; bài mới = đúng 1 sự kiện; snapshot không đổi 146 B (so với ~52 KB); revalidate theo hash không tải thân bài |
| Không phục hồi bài viết đã xóa | đạt | tombstone bền; chặn create cũ re-deliver sau khi sự kiện xóa bị evict; offline→online; reindex/replay; replica không thể làm sống lại |
| Phát hiện dữ liệu sai lệch | đạt | ledger (chữ ký/chuỗi), view↔ledger, index↔posts, cache, head mismatch, rollback của origin — đều phát hiện **và** tự sửa |
| Tiếp tục đồng bộ sau khi Peer offline trở lại | đạt | cursor bền; back-off mũ + jitter, không retry-storm; bắt kịp đúng số sự kiện; anti-entropy tự chạy sau lỗi |

## Đo trước, sửa sau — khảo sát cho thấy
Đã có và đúng: sync ledger theo cursor, back-off+jitter, `fillGap`, phát hiện fork/gap. **Lỗ hổng thật** (đã sửa): (1) tombstone chỉ sống *trong cache* nên bài đã xóa có thể sống lại; (2) snapshot luôn tải lại toàn bộ; (3) `verifyAll()` chỉ chạy khi admin gọi; (4) cursor không còn đáng tin khi peer bị restore; (5) nội dung Explore chỉ lấy được từ Hub gốc và chỉ nằm trong RAM.

## Thiết kế
- **Delta:** `snapshot?after=` (oldest-first, resumable, giới hạn byte); mốc delta chỉ tiến khi *mọi* sự kiện trong lô xác minh được; origin có chuỗi ngắn hơn mốc → coi là rollback, bỏ cache dẫn xuất và tải lại.
- **Tombstone:** bảng bền + kiểm tra khi lưu, khi hiển thị, khi lấy nội dung Explore, khi phục vụ replica.
- **Anti-entropy:** so (actor, seq, id) cho các actor *đã* replicate; thiếu → lấy đúng khoảng thiếu; cùng seq khác id → ghi nhận và để ledger phán quyết (sequence_fork).
- **Supervisor:** detector → finding bền (`integrity_findings`) → healer. Dữ liệu gốc không bị xóa: sự kiện hỏng được thay bằng bản từ peer **đã xác minh và khớp chuỗi**, bản hỏng giữ trong `events_quarantine`; healer "chỉ dữ liệu dẫn xuất" bị vô hiệu hóa nếu làm đổi ledger. Backoff mũ + jitter, ngân sách retry toàn cục, chu kỳ có giới hạn thời gian và không chồng nhau.
- **Vòng đời peer (data-plane):** discovered → authenticated → syncing → synced; degraded / offline. Không bao giờ báo `synced` nếu chưa có sync thành công. Trạng thái tổng hợp: standalone / syncing / synced / degraded / offline.
- **Nội dung theo yêu cầu:** cache bền (đọc lại sau restart), làm mới theo hash, failover qua replica hợp lệ (sự kiện tự xác minh chữ ký; replica không thể giả mạo hay làm sống lại bài đã xóa).

## Kết quả test
- `tests/p2p-delta-sync-healing.test.js`: **30/30 PASS**, lặp ổn định.
- Mutation testing: **22/22** đột biến an toàn bị phát hiện (bỏ tombstone ở lưu/hiển thị/replica, bỏ phát hiện rollback, mốc delta vượt sự kiện bị từ chối, mở rộng phạm vi anti-entropy, không thực thi quarantine, bỏ guard dữ liệu gốc, bỏ retry budget/backoff, bỏ lưu bản hỏng/kiểm tra bản thay thế/kiểm tra chuỗi, nhận replica không khai báo, và 4 đột biến của index audit). Lượt đầu 5 đột biến sống sót → đã bổ sung test nhắm đúng.
- `npm run test:p2p`: 228 PASS / 6 FAIL (6 lỗi có sẵn, không đổi) / 6 SKIP. Không-P2P: 60 PASS / 1 FAIL có sẵn.
- **Lỗi thật phát hiện bằng test và đã sửa:** mốc delta tiến qua sự kiện bị từ chối (làm hỏng test presence có sẵn); quarantine không có tác dụng với peer `trusted` (`syncAllowed` bỏ qua cờ `sync_content`) → thay bằng cơ chế cách ly riêng; `status()` chưa phản ánh peer đang bị cách ly; hard-code "11 migration" ở test Phase 5.

## Benchmark (`node scripts/delta-sync-bench.js 2000`, 2 Hub thật, loopback — KHÔNG đo độ trễ WAN)
| Chỉ số | Giá trị |
|---|---|
| Sync đầu 2.000 sự kiện | 621 ms, ~1,16 MB |
| Sync lần 2 (không đổi) | 4,7 ms, ~0,7 KB, `duplicate=0` |
| 1 sự kiện mới | 3,2 ms, ~0,6 KB |
| Snapshot profile | đầy đủ 52 KB → không đổi 146 B |
| Chu kỳ tự chữa (audit 200 sự kiện + mẫu view/cache) | ~100 ms, ~1.900 sự kiện/s trong chu kỳ |
| Anti-entropy (1 actor) | 4,6 ms, 252 B |
| RSS | ~97 MB |

## Rủi ro còn lại / Việc còn lại bắt buộc trước khi PASS
1. Chưa test nhiều máy / Internet công cộng / libp2p thật (như Phase 5–6). Các Hub trong test cùng một máy.
2. **Tốc độ kiểm toán mặc định thấp cho sổ cái lớn:** 200 sự kiện/chu kỳ 60 s ≈ 12.000 sự kiện/giờ; ledger hàng triệu sự kiện cần nhiều ngày để audit một vòng (chỉnh `HUB_HEAL_BUDGET_MS`/`auditBatch`). Chưa có tự điều chỉnh theo tải.
3. `chain_broken` do mất *sự kiện tiền nhiệm* được phát hiện và báo critical nhưng **chưa tự sửa** (cần kéo lại sự kiện bị mất); finding sẽ `abandoned` sau 8 lần, dữ liệu không bị mất.
4. Sửa lệch view dùng `ledger.reindex()` (O(sổ cái), cooldown 1 giờ): nhiều lệch liên tiếp trong cooldown phải chờ.
5. Ngưỡng cách ly peer (≥10 bị từ chối và ≥50%) chưa được tinh chỉnh bằng dữ liệu thật.
6. Tombstone TTL 30 ngày: sau đó, một create cũ re-deliver có thể hiện lại trong cache tạm (ledger vẫn đúng).
7. Anti-entropy chỉ so các actor đã replicate; không phát hiện "thiếu cả actor"; không thay thế sync theo cursor.
8. Trạng thái REACHABLE/CONNECTED ở tầng truyền tải vẫn thuộc `SelfHealEngine` (Phase 2); Phase 7 chỉ bổ sung vòng đời tầng dữ liệu và chưa đổi giao diện người dùng (chỉ Developer Diagnostics).
9. Sức khỏe replica index (Phase 5) mới được *hiển thị* trong `status()`, chưa có healer tự cân bằng lại (cần ứng viên từ Directory — vẫn chưa nối).
10. 6 lỗi test P2P + 1 lỗi presence có sẵn và `package-lock.json` stub vẫn là blocker release chung.

## Khả năng tương thích SoloHost
Không thêm dependency; không Docker privileged/docker.sock; không cần cấu hình tay. Chi phí nền: một chu kỳ ≤ ~250 ms mỗi 60 s (có thể tắt bằng `HUB_HEAL_INTERVAL_MS=0`), anti-entropy mỗi 10 phút (vài trăm byte/actor), cache có giới hạn sẵn của `RemoteContent`.

## Rollback
1. `HUB_HEAL_INTERVAL_MS=0` tắt supervisor; `HUB_ANTI_ENTROPY_MS` rất lớn tắt anti-entropy; client cũ không gửi `after` nên snapshot hoạt động như cũ (tương thích ngược hai chiều: origin cũ bỏ qua `after`, client nhận toàn bộ).
2. Migration 12 chỉ thêm bảng/cột. Quay về bản cũ phải khôi phục bản sao lưu trước nâng cấp (bản cũ từ chối khởi động trên DB có migration lạ — cùng quy tắc với migration 11).
