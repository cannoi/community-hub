# PHASE 5 — DISTRIBUTED INDEX COMPLETION (2.3.27)

## Kết luận cổng nghiệm thu
**ĐÃ HOÀN THIỆN VÀ KIỂM CHỨNG BẰNG MÔ PHỎNG — CHƯA ĐƯỢC PASS RELEASE GATE.**
Mọi hạng mục nghiệm thu đã có code + test + mutation test. Nhưng chưa có bằng chứng trên libp2p thật, nhiều máy thật hay Internet công cộng (môi trường build offline không cài được libp2p). Theo nguyên tắc 12 ("không tuyên bố P2P thật chỉ dựa trên mô phỏng") nên Phase 5 chỉ nên được đánh PASS sau khi chạy các bài test ở mục "Việc còn lại bắt buộc". Vì vậy tính năng **mặc định TẮT** (`P2P_INDEX_REPLICATION=1` để bật).

## Đối chiếu tiêu chuẩn nghiệm thu
(Số `#` = thứ tự test trong `tests/p2p-index-replication.test.js`.)

| Hạng mục | Cơ chế | Bằng chứng (mức) |
|---|---|---|
| Shard replication | Log có chữ ký (epoch,seq) → `append` batch tối đa 50 entry; follower kéo `fetch`/`snapshot` phân trang theo byte; giao thức `/cannoi/index/1.0.0` trên node libp2p hiện có | test #3, #11, #12, multi-process TCP (in-process + **multi-process simulation**) |
| Primary election | Bầu cử theo quorum; phiếu ký; mỗi epoch chỉ 1 phiếu, lưu bền *trước* khi trả lời; ứng viên phải có log mới nhất; chỉ ứng viên TRUSTED | #2, #8, #9, #10, #24, #25 |
| Replica management | `adoptPlan` (từ `planAssignments`), `invite` → learner không bỏ phiếu → so khớp digest → đổi thành viên bằng joint-quorum; thành viên bị loại được thông báo và chuyển RETIRED (giữ dữ liệu) | #16, #17, #26 |
| Failover | Replica im lặng > lease + độ trễ theo hạng → tự ứng cử; backoff có jitter; `release` khi tắt máy êm | #5, #6, #7, multi-process SIGKILL (#29) |
| Rebalance | Tối đa N di chuyển song song, cooldown, chỉ thay member *chết/không đủ điều kiện*, không bao giờ bắt đầu nửa chừng | #16, #17 |
| Integrity | Chữ ký origin trên từng tài liệu/tombstone + hash nội dung + digest shard + `verifyIntegrity` + anti-entropy | #4, #13, #14, #15, #27 |
| Recovery | Gap → pull log; log bị cắt → snapshot merge; mất kết nối lặp lại tự hội tụ; khởi động lại giữ phiếu | #10, #11, #12 |
| Resource control | Governor 3 bậc (máy yếu không host), áp lực CPU/RAM/disk/đầy index, concurrency thích ứng, backpressure, rate bucket theo trust, giới hạn payload/page, tick có ngân sách thời gian | #18, #19, #20, #21, #22 |
| Compatibility | Migration 11 chỉ thêm; API adapter cũ giữ nguyên; shard chưa quản lý hoạt động như cũ | #1, #23, #28; regression không-P2P giống hệt bản gốc |

## Điều kiện đặc biệt: không có hai Primary cùng ghi một Shard
Năm lớp độc lập (xem đầu `index-replication.js`):
1. **Epoch fencing token** — Primary epoch E chỉ tồn tại nếu có chứng chỉ quorum phiếu ký; không ai nhận ghi với epoch < max(epoch, voted_epoch).
2. **Một phiếu/epoch, lưu bền** (`wal_checkpoint(FULL)` vì DB dùng `synchronous=NORMAL`).
3. **Joint quorum** khi đổi thành viên: cần đa số của tập CŨ *và* MỚI ⇒ quorum mới luôn giao với quorum Primary cũ.
4. **Lease tự rào**: chỉ ghi khi quorum đã ack một thông điệp *gửi đi* chưa quá `leaseMs×0.6`; voter chờ đủ `leaseMs` kể từ lần nghe Primary cuối mới bỏ phiếu. Giả định duy nhất: *tốc độ* đồng hồ lệch có giới hạn (không cần đồng bộ giờ).
5. **Rào ở tầng lưu trữ**: `DistributedIndex` từ chối ghi tài liệu nguồn-ngoài vào shard đang được quản lý nếu không đi qua token của coordinator; ghi theo LWW + chữ ký + tombstone nên dù lỗi logic cũng không làm hỏng nội dung.

**Đánh đổi (trung thực):** ưu tiên an toàn hơn sẵn sàng. Mất đa số ⇒ shard chỉ-đọc (vẫn tìm kiếm được). Với 2 member không thể failover tự động — cần ≥3. Không chống được đa số member thông đồng, không phải Byzantine fault tolerance; index là cache có chữ ký, Hub gốc vẫn là nguồn sự thật và kiểm soát quyền truy cập.

### Mutation testing (chứng minh test có "răng")
10 đột biến cố ý phá cơ chế an toàn — **10/10 bị test phát hiện**: bỏ fence theo `voted_epoch`, bỏ chờ lease khi bỏ phiếu, cho bỏ phiếu hai lần cùng epoch, bỏ lease self-fence, bỏ yêu cầu quorum tập cũ, bỏ kiểm chữ ký origin, coi `stale_epoch` là ack, bỏ kiểm chuỗi thành viên, bỏ chặn tombstone, bỏ rào tầng lưu trữ. (Lần chạy đầu 4 đột biến sống sót → đã bổ sung test nhắm đúng cơ chế rồi chạy lại.)

## Kết quả test
- `tests/p2p-index-replication.test.js`: **29/29 PASS**, lặp 5 lần ổn định, gồm mô phỏng đa tiến trình (3 process OS, socket TCP 127.0.0.1, `kill -9` Primary).
- `tests/p2p-distributed-index.test.js`: 7/7 PASS (sửa 1 assertion flaky có sẵn: so sánh `expires_at = Date.now()+ttl`).
- `npm run test:p2p`: **166 PASS / 6 FAIL / 6 SKIP** (baseline 137/6/6 + 29 test mới). 6 FAIL là **các lỗi có sẵn, không đổi**: 3 test mong P2P tắt mặc định, mô tả bootstrap, đăng ký bootstrap cần probe, đăng ký seed độc lập.
- Test không-P2P (62 test): kết quả **giống hệt** zip gốc (2 FAIL có sẵn: i18n EN/VI lệch key; mã lỗi presence-sync).

## Benchmark (`node scripts/index-replication-bench.js N`, loopback trong 1 process — đo chi phí CPU/disk, KHÔNG đo độ trễ mạng)
| Tài liệu (~1 KB) | Ghi + nhân bản 3 Hub | Dung lượng/replica (gồm WAL, oplog) | Snapshot cho Hub mới |
|---|---|---|---|
| 1.000 | 3,7 s (~270 doc/s), giống hệt | ~9,3 MB | 0,9 s |
| 3.000 | 10,0 s (~300 doc/s), giống hệt | ~16,9 MB | 6,1 s |
RSS tiến trình ~110–145 MB. Lưu ý: oplog giữ tối đa 2.000 entry/shard (cấu hình `oplogRetention`) nên nhân đôi dung lượng nội dung gần nhất.

**Lỗi hiệu năng có sẵn đã sửa:** `_refreshShard` quét và băm lại cả shard mỗi lần ghi (O(n²)) — 3.000 ghi mất ~23 s, chặn event loop và làm lease Primary hết hạn. Nay digest được gộp theo lô (100 ms).

## Rủi ro còn lại / Việc còn lại bắt buộc trước khi PASS
1. **libp2p thật chưa được kiểm**: `createLibp2pSigner` (xác minh bằng `peerId.publicKey`) và `Libp2pIndexTransport` (half-close `closeWrite`, `dialProtocol` signal) chỉ được kiểm bằng fake/nguyên lý; cần chạy với libp2p 3.5.1 thật. Lỗi xác minh *fail-closed* (không replicate), không làm hỏng dữ liệu.
2. **Chưa có test nhiều máy / Internet công cộng** (Hub VN–JP–EU, NAT/Relay thật, đổi IP). Cần chạy tối thiểu 3 máy thật với failover và partition thật.
3. **Ứng viên gán shard tự động chưa nối vào Directory Phase 4**: hiện `adoptIndexAssignments(plans)` / `rebalanceIndex(candidates)` nhận danh sách đã xác minh + TRUSTED; Directory chưa quảng bá capacity nên chưa có vòng lặp tự động lấy ứng viên. Hub không đủ tài nguyên sẽ từ chối `invite` (`no_capacity`) nên không gây hại.
4. Node chậm hơn ≥2 lần đổi thành viên phải được đa số thành viên đã biết xác nhận chứng chỉ (`state_query`); chưa có test nhiều lần đổi liên tiếp với node lạc hậu.
5. Digest/anti-entropy so cả shard (O(n)); đủ cho shard vài nghìn tài liệu; chưa chia nhỏ (split/merge shard thuộc Phase sau).
6. Chưa test tải 100–1.000.000 Hub (Phase 8); phần nhân bản mới chỉ kiểm tới 3–4 Hub.
7. 6+2 lỗi test có sẵn (liệt kê ở trên) và `package-lock.json` còn là stub vẫn là blocker release chung.

## Khả năng tương thích SoloHost
Không thêm dependency, không Docker privileged/docker.sock, không cần cấu hình tay. Governor giới hạn: tick có ngân sách thời gian, tối đa 8 shard (máy trung bình)/0 (máy yếu), tự ngừng nhận replica khi tải CPU > 0,85/core, RSS vượt trần, disk trống < 512 MB hoặc index ≥ 90% hạn mức. Mặc định tắt.

## Rollback
1. Đặt `P2P_INDEX_REPLICATION` về 0 (mặc định) và khởi động lại: coordinator không chạy, mọi API cũ hoạt động như 2.3.26.
2. Quay về code 2.3.26: migration 11 chỉ thêm cột/bảng (`origin_sig`, `p2p_index_tombstones`, `p2p_index_shard_state`, `p2p_index_oplog`) — bản cũ bỏ qua. Lưu ý: bản cũ kiểm tra "migration lạ" và sẽ **từ chối khởi động** trên DB đã lên migration 11; vì vậy hãy khôi phục bản sao lưu trước nâng cấp (`npm run backup`) khi hạ cấp. Dữ liệu người dùng (users, posts, groups…) không bị chạm.
