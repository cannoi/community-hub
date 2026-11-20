# PHASE 6 — FEDERATED SEARCH AND GLOBAL EXPLORE (2.3.28)

## Kết luận cổng nghiệm thu
**ĐÃ HOÀN THIỆN VÀ KIỂM CHỨNG BẰNG MÔ PHỎNG — CHƯA ĐƯỢC PASS RELEASE GATE.**
Bốn điều kiện gate của Phase 6 đều đạt trong test trong-process và mô phỏng 5 process TCP. Chưa có bằng chứng trên libp2p thật / nhiều máy / Internet công cộng, và Phase 5 (nhân bản index) cũng chưa qua gate đó, nên theo nguyên tắc 12 Phase 6 chỉ nên đánh PASS sau khi chạy các bài test ở mục "Việc còn lại bắt buộc".

| Gate | Kết quả | Bằng chứng (mức) |
|---|---|---|
| Hub Việt Nam tìm được bài công khai từ Nhật Bản và châu Âu | đạt | test "GATE …" (in-process) + mô phỏng 5 process TCP (VN/VN/JP/DE/FR) |
| Không cần kết bạn / nhập địa chỉ Hub nguồn | đạt | request chỉ gồm `q`; Hub nguồn chỉ cần xuất hiện trong danh sách peer |
| Không giới hạn theo ngôn ngữ hay quốc gia | đạt | truy vấn vi/không dấu/en/ja tìm chéo cả ba ngôn ngữ; region/language chỉ đổi thứ tự |
| Không trả nội dung riêng tư | đạt | PostIndexer với ledger+posts thật; responder kiểm lại nguồn; origin từ chối followers/group/lạ |

## Thiết kế
**Luồng tìm kiếm:** Local (index của chính Hub + replica shard nếu có) → Regional (peer cùng khu vực) → Language → Topic → Global. Mỗi tầng hỏi tối đa `fanout` peer (+ thay thế khi lỗi); peer bị bỏ lại do giới hạn được chuyển xuống Global; tổng ≤ `maxPeers` (24). `scope=auto` dừng mở rộng khi đủ kết quả *và* đủ đa dạng (≥3 nguồn, ≥2 khu vực); `scope=global` luôn đi hết. Kết quả local hiện ngay, kết quả mạng đến dần (session + polling), không chờ toàn mạng.

**Xác minh:** mọi kết quả từ xa phải qua: hình dạng/giới hạn → hash nội dung → chữ ký origin Hub → lọc độ liên quan tính lại tại chỗ. Giả mạo bị loại, peer bị báo `abuse` cho Trust Engine; ngày tương lai bị loại (chống gaming freshness). Nội dung đầy đủ chỉ lấy từ Hub gốc dưới dạng sự kiện ledger đã ký, xác minh bằng `RemoteContent.cacheEvents` (tái sử dụng), cache 10 phút, tái xác nhận bằng hash (không tải lại nếu không đổi), xử lý sửa/xóa.

**Đa ngôn ngữ:** tiếng Việt có/không dấu (khôi phục độ chính xác bằng thưởng khớp đúng dấu khi xếp hạng), tiếng Anh (biến thể hình thái ở phía truy vấn), tiếng Nhật/Trung bằng bigram theo script-run (không cần từ điển), katakana↔hiragana, NFKC; nhận diện ngôn ngữ; từ điển ~21 nhóm đồng nghĩa/alias + ánh xạ chủ đề (mở rộng được); alias phải khớp nguyên cụm (không để "dong kinh" khớp chữ "đồng").

**Xếp hạng (trọng số khởi đầu của spec, không cố định):** relevance 40 · chất lượng nội dung 20 · độ mới 15 · hợp ngôn ngữ 10 · hợp khu vực 5 · đa dạng nguồn 10. Đa dạng áp dụng **theo từng trang** + trần theo nguồn. Trust/tài nguyên của node **không bao giờ** là đầu vào (có test kiểm tra mã nguồn).

**Chống lạm dụng:** responder xác thực peer + rate bucket theo trust + backpressure theo governor + giới hạn term/limit/kích thước *trước* khi đụng index; phía truy vấn có fan-out/thời gian/breaker/cache/giới hạn session mỗi user. Không module nào mở socket hay fetch URL (test tĩnh chống SSRF); văn bản từ xa render bằng `textContent`.

## Kết quả test
- `tests/p2p-federated-search.test.js`: **32/32 PASS**, lặp 4 lần ổn định.
- Mutation testing: **15/15** đột biến an toàn bị phát hiện (bỏ xác minh chữ ký/hash, bỏ kiểm nguồn công khai, bỏ rate limit/trust gate, fan-out vô hạn, quên peer dư, breaker không mở, bỏ chặn ngày tương lai, ACL nội dung, index bài nhóm, bỏ trần đa dạng, bỏ dedup…). Lượt đầu 3 sống sót → đã bổ sung test.
- `npm run test:p2p`: 198 PASS / 6 FAIL (6 lỗi có sẵn, không đổi) / 6 SKIP. Test không-P2P: 60 PASS / 1 FAIL có sẵn (trước: 59/2; lỗi i18n `saved` đã được sửa).
- Lỗi thật tìm ra bằng test và đã sửa: fan-out một tầng không bị chặn; peer bị bỏ lại không được chuyển tầng; cap đa dạng tính tích lũy thay vì theo trang; bonus không dấu phạt nhầm người gõ không dấu.

## Benchmark (`node scripts/federated-search-bench.js 3000`, loopback, 3 Hub × 3.000 bài; KHÔNG đo độ trễ mạng)
| Chỉ số | Giá trị |
|---|---|
| Lập chỉ mục | ~455 bài/s |
| Dung lượng index/Hub | 10–16 MB (10–21 term/bài) |
| Tìm local | p50 6 ms · p95 10 ms |
| Tìm liên hợp 3 Hub (end-to-end, loopback) | p50 42 ms · p95 55 ms; ~12 KB/phản hồi |
| Tiếng Việt có dấu vs không dấu | top-20 trùng ≥90%: 5/5 truy vấn |
| RSS tiến trình | ~157 MB |

## Rủi ro còn lại / Việc còn lại bắt buộc trước khi PASS
1. **libp2p thật chưa kiểm** (giao thức `/cannoi/search/1.0.0` dùng chung `Libp2pIndexTransport` + `createLibp2pSigner` như Phase 5).
2. **Chưa có test nhiều máy / Internet công cộng** (VN–JP–EU thật, NAT/Relay). Mô phỏng 5 process chỉ dùng loopback.
3. **Định tuyến khu vực/ngôn ngữ phụ thuộc metadata của peer**: bản ghi registry hiện chưa mang region/languages, `setSearchPeerHints()` đã sẵn nhưng chưa có nguồn cấp (Directory Phase 4/presence chưa nối). Khi thiếu, mọi peer rơi vào tầng Global — vẫn đúng nhưng kém tối ưu chi phí.
4. **Độ phủ toàn cầu ở quy mô lớn chưa được chứng minh**: không có Phase 5 bật, mỗi peer chỉ trả tài liệu của chính nó; fan-out ≤24 nên phủ phụ thuộc replica/shard. Mô phỏng 100–1.000.000 Hub thuộc Phase 8.
5. **Quyền riêng tư truy vấn**: các peer được hỏi (≤24) thấy các term của truy vấn (không kèm danh tính user hay IP) — chưa có ẩn danh hóa/định tuyến qua relay.
6. **Dịch truy vấn tùy chọn** có hook nhưng KHÔNG nối vào AI module (mặc định tắt). Từ điển nhỏ (21 nhóm); không có stemming cho ngôn ngữ ngoài tiếng Anh; tiếng Nhật chỉ bigram (không phân tích hình thái).
7. Trọng số xếp hạng chưa được tinh chỉnh bằng dữ liệu đánh giá thật (chỉ có test tổng hợp).
8. Nội dung đầy đủ chỉ lấy được từ Hub gốc (chưa lấy từ bản sao hợp lệ); Hub gốc ngoại tuyến → thông báo, dùng cache nếu còn.
9. UI mới chỉ được kiểm bằng kiểm tra cú pháp + test API/i18n; **chưa kiểm bằng trình duyệt/ảnh chụp/mobile thật**.
10. 6 lỗi test P2P + 1 lỗi presence có sẵn và `package-lock.json` stub vẫn là blocker release chung.

## Khả năng tương thích SoloHost
Không thêm dependency; không Docker privileged/docker.sock; không cấu hình tay. Chi phí chạy nền: PostIndexer theo lô (≤200 dòng/lượt, 60 s hoặc khi có bài mới), rebuild term theo lô 200 bài/25 ms chỉ một lần khi nâng tokenizer; phía phục vụ bị chặn bởi governor (máy yếu: 2 yêu cầu song song, từ chối khi CPU > 0,85/core). `P2P_FEDERATED_SEARCH=0` tắt hẳn.

## Rollback
1. `P2P_FEDERATED_SEARCH=0` → không phục vụ/không gửi truy vấn; UI hiện "chưa hỗ trợ tìm kiếm toàn mạng"; mọi API cũ (`/api/search`, feed) không đổi.
2. Không có migration mới ở Phase 6 (chỉ tạo bảng phụ `p2p_index_meta` nếu chưa có). Quay về 2.3.27 an toàn: term được tính lại bởi tokenizer cũ khi cần (dữ liệu bài viết không bị chạm). Quay về trước 2.3.27 vẫn tuân theo hướng dẫn rollback migration 11 của Phase 5.
