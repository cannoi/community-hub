'use strict';
// Built-in assistant. Two layers:
//  1. A local, offline, rule-based helper (always available, answers in the user's language: Vietnamese or English).
//  2. An OPTIONAL external language model via any OpenAI-compatible endpoint configured by the Hub owner
//     (AI_BASE_URL / AI_MODEL / AI_API_KEY). Nothing is sent anywhere unless the owner configures it.
const http = require('http');
const https = require('https');

const VI_CHARS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const VI_WORDS = /\b(xin chao|chao ban|toi|ban|minh|lam sao|lam the nao|giup|dang bai|theo doi|cam on|ung dung|nhom|tin nhan|bao mat|sao luu|khong|duoc|nhu the nao|cach)\b/i;

function detectLang(text, hint) {
  const t = String(text || '');
  if (VI_CHARS.test(t)) return 'vi';
  if (VI_WORDS.test(t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) return 'vi';
  if (/[a-z]{3,}/i.test(t)) return 'en';
  return hint === 'vi' ? 'vi' : 'en';
}

const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
const INTENTS = [
  ['greet', /\b(hi|hello|hey|xin chao|chao|good morning|good evening)\b/],
  ['thanks', /\b(thanks|thank you|cam on|cam ơn|cảm ơn)\b/],
  ['post', /(post|tweet|publish|dang bai|viet bai|bai viet|hashtag|composer)/],
  ['edit_delete', /(edit post|delete post|sua bai|xoa bai|tombstone)/],
  ['follow', /(follow|friend|theo doi|ban be|ket ban|unfollow)/],
  ['media', /(photo|image|video|audio|upload|media|anh|tai len|am thanh|file|tep|attachment)/],
  ['groups', /(group|community|nhom|cong dong)/],
  ['privacy', /(privacy|private|public|visib|who can see|rieng tu|cong khai|ai co the xem|an toan|bao mat|security)/],
  ['network', /(peer|federat|network|sync|bootstrap|decentral|lien ket|dong bo|mang luoi|ket noi|invite)/],
  ['remote', /(public url|remote access|dia chi cong khai|public address|solo.?host|host port|28090)/],
  ['backup', /(backup|restore|export|sao luu|khoi phuc|xuat)/],
  ['identity', /(identity|key|account id|danh tinh|khoa|tai khoan|hub1_)/],
  ['notifications', /(notification|thong bao|bell|badge unread)/],
  ['search', /(search|tim kiem|explore|kham pha|trending|hashtag)/],
  ['bookmarks', /(bookmark|da luu|saved)/],
  ['settings', /(settings|cai dat|language|ngon ngu|password change|doi mat khau)/],
  ['setup', /(setup|first run|onboarding|tao hub|create account|dang ky)/],
  ['dm', /(message|dm|chat|inbox|tin nhan|nhan tin)/],
  ['ai', /(\bai\b|assistant|tro ly|tri tue|provider|api key)/],
  ['feedback', /(feedback|gop y|bao loi|bug report|donate|ung ho)/],
  ['quota', /(quota|gioi han|rate limit|too many requests)/],
  ['offline', /(offline|ngoai tuyen|no internet|mat mang)/],
  ['embeds', /(youtube|tiktok|vimeo|embed|unfurl|link preview|xem truoc lien ket)/],
  ['chunked', /(chunk|large file|tep lon|tai len theo manh|upload in parts)/],
];
const T = {
  greet: { en: 'Hello! I can help you use Community Hub: posting, following people, groups, media, privacy and your Hub network. What would you like to do?', vi: 'Xin chào! Mình có thể giúp bạn dùng Community Hub: đăng bài, theo dõi, nhóm, ảnh/video, quyền riêng tư và mạng lưới Hub. Bạn muốn làm gì?' },
  post: { en: 'To post: open Home, type in the box (up to 2000 characters), add #hashtags or media, choose who can see it (Public, Followers or a Group) and press Post. You can edit or delete your own posts from the ⋯ menu. Public posts are signed with your Hub identity and shared with connected peers; deletions are published as tombstones, but copies other Hubs already received cannot be force-erased.', vi: 'Để đăng bài: vào Trang chủ, gõ nội dung (tối đa 2000 ký tự), thêm #hashtag hoặc ảnh/video, chọn ai được xem (Công khai, Người theo dõi hoặc Nhóm) rồi bấm Đăng. Bạn có thể sửa/xóa bài của mình ở menu ⋯. Bài công khai được ký bằng danh tính Hub của bạn và chia sẻ với các peer đã kết nối; việc xóa được phát đi dưới dạng "tombstone", nhưng bản sao mà Hub khác đã nhận thì không thể ép xóa.' },
  follow: { en: 'Open a profile and press Follow. Two people who follow each other count as friends. You can also mute or block an account from its profile; blocking is private to your Hub.', vi: 'Mở hồ sơ của một người và bấm Theo dõi. Hai người theo dõi lẫn nhau được tính là bạn bè. Bạn cũng có thể tắt tiếng hoặc chặn từ trang hồ sơ; việc chặn chỉ áp dụng riêng trên Hub của bạn.' },
  media: { en: 'Use the image/attachment button in the composer. Images, MP4/WebM video, MP3/OGG/WAV/M4A audio, PDF and a few document types are supported (default limit 50 MB). Videos support seeking. Restricted posts keep their media private.', vi: 'Dùng nút ảnh/đính kèm trong khung soạn bài. Hỗ trợ ảnh, video MP4/WebM, âm thanh MP3/OGG/WAV/M4A, PDF và một số tài liệu (mặc định tối đa 50 MB). Video có thể tua. Bài đăng hạn chế sẽ giữ media ở chế độ riêng tư.' },
  groups: { en: 'Groups are communities on this Hub. Open Groups, create one or join an open group. Group posts and files stay on this Hub only (they are not shared with other Hubs). Admins can add members and change roles.', vi: 'Nhóm là các cộng đồng trên Hub này. Vào mục Nhóm để tạo nhóm hoặc tham gia nhóm mở. Bài viết và tệp trong nhóm chỉ nằm trên Hub này (không chia sẻ sang Hub khác). Quản trị viên có thể thêm thành viên và đổi vai trò.' },
  privacy: { en: 'Public posts are visible to anyone and are shared with peers. Followers-only and group posts stay on this Hub and are never sent to peers or shown in search for people without access. Direct messages are not enabled yet because end-to-end encryption still needs a reviewed implementation.', vi: 'Bài công khai ai cũng xem được và được chia sẻ với các peer. Bài chỉ-người-theo-dõi và bài trong nhóm chỉ nằm trên Hub này, không gửi cho peer và không hiện trong tìm kiếm với người không có quyền. Tin nhắn riêng chưa được bật vì mã hóa đầu-cuối cần một triển khai đã được rà soát.' },
  network: { en: 'After setup you can connect to the Community Hub network (default suggestion the built-in "default" seed (address hidden in UI) — clear or replace with an invite; password optional empty). Open Network to see this Hub public URL (auto IP:28090), set an optional public-URL password, and add peers via public IP:port, http/https URL, or hub1_…@url. All of this is changeable in Network settings. Public posts sync between Hubs; groups stay local.', vi: 'Sau setup có thể kết nối mạng Community Hub (gợi ý mặc định the built-in "default" seed (address hidden in UI) — xóa hoặc dán mã mời; mật khẩu tùy chọn để trống). Vào Mạng lưới để xem URL công khai Hub này (tự IP:28090), đặt mật khẩu URL tùy chọn, và thêm peer bằng IP:port, URL http/https, hoặc hub1_…@url. Đổi được trong Cài đặt mạng lưới. Bài công khai đồng bộ giữa các Hub; nhóm chỉ cục bộ.' },
  backup: { en: 'Back up the whole data folder, or run: node scripts/backup.js <folder>. A backup contains your encrypted identity key — store it privately. You can also export your identity key in Settings (password required).', vi: 'Hãy sao lưu toàn bộ thư mục dữ liệu, hoặc chạy: node scripts/backup.js <thư mục>. Bản sao lưu chứa khóa danh tính đã mã hóa — hãy giữ riêng tư. Bạn cũng có thể xuất khóa danh tính trong Cài đặt (cần mật khẩu).' },
  identity: { en: 'Your account ID (hub1_…) is derived from a cryptographic key stored on this Hub, not from your IP address, so it stays the same if your address changes. Export the key in Settings and keep it safe: without it you cannot prove ownership of the account elsewhere.', vi: 'Mã tài khoản (hub1_…) được tạo từ khóa mật mã lưu trên Hub này, không phụ thuộc địa chỉ IP, nên không đổi khi địa chỉ thay đổi. Hãy xuất khóa trong Cài đặt và cất giữ cẩn thận: mất khóa thì không thể chứng minh quyền sở hữu tài khoản ở nơi khác.' },
  dm: { en: 'Private messages are not available yet: they need audited end-to-end encryption and I will not pretend ordinary encryption is end-to-end. Use public or followers-only posts meanwhile.', vi: 'Tin nhắn riêng chưa khả dụng: tính năng này cần mã hóa đầu-cuối đã được kiểm định, và mình sẽ không gọi mã hóa thông thường là đầu-cuối. Tạm thời hãy dùng bài công khai hoặc bài chỉ-người-theo-dõi.' },
  ai: { en: 'I am the built-in helper. Without an AI model configured I answer from a fixed set of help topics. The Hub owner can connect any OpenAI-compatible model (even a local one) with AI_BASE_URL and AI_MODEL to unlock rewriting, translation and free-form answers.', vi: 'Mình là trợ lý tích hợp. Khi chưa cấu hình mô hình AI, mình chỉ trả lời theo các chủ đề trợ giúp có sẵn. Chủ Hub có thể kết nối bất kỳ mô hình tương thích OpenAI (kể cả chạy cục bộ) qua AI_BASE_URL và AI_MODEL để mở khóa viết lại, dịch và trả lời tự do.' },
  thanks: { en: 'You are welcome! Ask anytime about posting, network, privacy, or your identity key.', vi: 'Không có gì! Bạn cứ hỏi về đăng bài, mạng lưới, quyền riêng tư hoặc khóa danh tính nhé.' },
  edit_delete: { en: 'Open the ⋯ menu on your own post to edit or delete. Deletes publish a tombstone to peers; copies already stored elsewhere cannot be force-removed.', vi: 'Mở menu ⋯ trên bài của bạn để sửa hoặc xóa. Xóa sẽ phát tombstone tới peer; bản sao đã lưu ở Hub khác không thể ép xóa.' },
  remote: { en: 'Your Hub public address is under Network (owner). Prefer setting PUBLIC_URL or an override; SoloHost host port defaults to 28090, not container 8080. Only the owner can view remote info.', vi: 'Địa chỉ công khai của Hub nằm trong Mạng lưới (chủ Hub). Nên đặt PUBLIC_URL hoặc ghi đè; cổng SoloHost mặc định 28090, không phải 8080 trong container. Chỉ chủ Hub xem được remote info.' },
  notifications: { en: 'Open Notifications from the nav to see follows, replies and reactions. Unread counts refresh in the background.', vi: 'Vào Thông báo trên thanh điều hướng để xem theo dõi, trả lời và cảm xúc. Số chưa đọc được làm mới nền.' },
  search: { en: 'Use Explore or the search box to find people, posts and #tags. Trends show popular tags on this Hub.', vi: 'Dùng Khám phá hoặc ô tìm kiếm để tìm người, bài và #tag. Xu hướng hiện tag phổ biến trên Hub này.' },
  bookmarks: { en: 'Save a post with the bookmark control, then open Bookmarks under More to find it later. Bookmarks stay on this Hub only.', vi: 'Lưu bài bằng nút đánh dấu, rồi mở Đã lưu trong menu Thêm. Dấu trang chỉ nằm trên Hub này.' },
  settings: { en: 'Settings let you change language (English/Vietnamese), profile, password and export your identity key. AI provider settings are under Assistant → AI Settings (owner only).', vi: 'Cài đặt cho phép đổi ngôn ngữ (Anh/Việt), hồ sơ, mật khẩu và xuất khóa danh tính. Provider AI nằm trong Trợ lý → Cài đặt AI (chỉ chủ Hub).' },
  setup: { en: 'First launch is two steps: (1) create the owner account, (2) optionally connect to the network with the label "default" or an invite URL. You can skip network and change it later under Network.', vi: 'Lần đầu có hai bước: (1) tạo tài khoản chủ, (2) tùy chọn kết nối mạng với nhãn "default" hoặc URL mời. Có thể bỏ qua mạng và đổi sau trong Mạng lưới.' },
  feedback: { en: 'Open Assistant → Feedback to send a bug, improvement or question. Notices from the Feedback Hub appear there. You must be signed in; donate details come only from the Hub when available.', vi: 'Mở Trợ lý → Góp ý để gửi lỗi, cải tiến hoặc câu hỏi. Thông báo từ Feedback Hub hiện ở đó. Cần đăng nhập; thông tin ủng hộ chỉ lấy từ Hub khi có.' },
  quota: { en: 'External AI replies are limited per user per day so the Hub stays fair offline-first. When the quota is reached you still get the built-in offline guide.', vi: 'Trả lời AI ngoài bị giới hạn theo ngày cho mỗi người để Hub ưu tiên offline. Hết hạn mức vẫn còn hướng dẫn tích hợp.' },
  embeds: { en: 'Paste a YouTube or Vimeo link in a post to show a safe embedded player. Other links get a privacy-preserving preview (no private-network fetches).', vi: 'Dán link YouTube hoặc Vimeo trong bài để hiện trình phát an toàn. Link khác được xem trước có bảo vệ (không gọi mạng nội bộ).' },
  chunked: { en: 'Large files can be uploaded in 5 MiB parts via media sessions (create session → upload chunks → complete). Small files still use a single upload.', vi: 'Tệp lớn có thể tải theo mảnh 5 MiB (tạo phiên → gửi mảnh → hoàn tất). Tệp nhỏ vẫn tải một lần.' },
  offline: { en: 'The Hub keeps working offline for composing posts (outbox) and local help. Federation and external AI need connectivity.', vi: 'Hub vẫn soạn bài (outbox) và trợ giúp cục bộ khi offline. Federation và AI ngoài cần mạng.' },
  fallback: { en: 'I can help with: posting, following, groups, media, privacy, the Hub network, backup and your identity. Try asking about one of these. (Free-form AI answers need a model configured by the Hub owner.)', vi: 'Mình có thể giúp về: đăng bài, theo dõi, nhóm, ảnh/video, quyền riêng tư, mạng lưới Hub, sao lưu và danh tính. Hãy hỏi về một trong các mục này. (Trả lời tự do bằng AI cần chủ Hub cấu hình mô hình.)' },
  unavailable: { en: 'The AI model is not reachable right now. Here is what I can say from my built-in help:', vi: 'Hiện chưa kết nối được mô hình AI. Đây là phần trợ giúp có sẵn của mình:' },
  noai: { en: 'This needs an AI model, which the Hub owner has not configured.', vi: 'Tính năng này cần mô hình AI nhưng chủ Hub chưa cấu hình.' },
};

function localReply(message, lang) {
  const n = norm(message);
  for (const [k, re] of INTENTS) if (re.test(n)) return T[k][lang];
  return T.fallback[lang];
}

function callModel(cfg, messages) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(cfg.baseUrl + '/chat/completions'); } catch { return reject(new Error('bad_ai_url')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('bad_ai_url'));
    const body = Buffer.from(JSON.stringify({ model: cfg.model, messages, max_tokens: 700, temperature: 0.4 }));
    const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers, timeout: cfg.timeoutMs }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 512 * 1024) res.destroy(new Error('ai_response_too_large')); else chunks.push(c); });
      res.on('end', () => {
        try {
          if (res.statusCode >= 300) return reject(new Error('ai_http_' + res.statusCode));
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const t = j.choices?.[0]?.message?.content;
          if (typeof t !== 'string' || !t.trim()) return reject(new Error('ai_empty'));
          resolve(t.trim().slice(0, 6000));
        } catch { reject(new Error('ai_bad_response')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('ai_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const systemPrompt = (lang) => `You are the built-in assistant of "Community Hub", a lightweight self-hosted social network. Reply in the SAME language as the user's latest message (Vietnamese or English; default ${lang === 'vi' ? 'Vietnamese' : 'English'}). Be concise, friendly and practical. Never ask for passwords, private keys or recovery files. Do not claim features that are not available: direct messages are disabled and group/followers-only posts are not shared with other Hubs. Public address uses SoloHost host port (default mapping 28090), not container 8080. Assistant is in the main nav tab, not a floating widget.`;

const STOP = new Set('the and for with that this from have are was were you your our not but can will just about into over very các và của cho với một những trong được không này khi là có để'.split(' '));
function localHashtags(text) {
  const counts = new Map();
  for (const w of norm(text).split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 5).map(([w]) => '#' + w);
}

module.exports = { detectLang, localReply, callModel, systemPrompt, localHashtags, T };
