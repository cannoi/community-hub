'use strict';
/**
 * Community Hub adapter for the Universal AI Module.
 * knowledge / actions / getContext / executeAction / localReply
 * must stay free of secrets (no keys, tokens, passwords).
 */

const KNOWLEDGE = `
Community Hub is a lightweight, self-hosted, federated social network.
Users post, follow, join groups, share media, and connect Hubs over the network.
Identity is cryptographic (account id like hub1_…). English and Vietnamese UI.

Public address of THIS Hub:
- Format: http://PUBLIC_IP:HOST_PORT (SoloHost published host port, NOT the in-container 8080).
- Default host mapping for this app is port 28090 (docker: 127.0.0.1:28090:8080).
- GET /api/remote/info returns { publicUrl, publicIp, hostPort, lanUrls, source }.
- HUB_PUBLIC_URL env overrides discovery. Users can also save a public URL in settings.

Setup (first owner account):
- Creates the Hub owner identity and optional import of an existing key.
- After create, the UI shows the Hub public address.
- Optional "intro hub" / bootstrap peer field: paste another Hub URL or account@url.
- Value "default" means seed peer discovery with this Hub's own public URL (encrypted storage presentation; user may clear it).
- Connecting to a different blockchain/history: use start-fresh when history_pending so user history is new.

Network / federation:
- After first account creation, optional step connects to a Community Hub network.
- Default suggested peer is shown in the UI only as the label "default" (real seed URL is resolved server-side and never shown). User may clear empty or paste another invite/URL.
- Hub password on that step defaults empty; both are changeable later in Network settings.
- Connect methods: public IP:port, full http/https URL, or hub1_xxx@url to pin identity.
- This Hub public URL is shown on Network (owner only; auto-detect or override). Fake URL passwords were removed; use real network controls.
- Open Network to manage peers. Public posts sync; groups and restricted posts stay local.
- No need to set HUB_PUBLIC_URL env for basic use — remote info discovers IP + SoloHost host port (default 28090).

Security:
- Never ask for or echo passwords, private keys, export passphrases, API keys, or ingest tokens.
- Setup token (HUB_SETUP_TOKEN) only for first owner creation on public servers.
- Access password / Hub key passphrase are owner-controlled secrets.

AI:
- Built-in offline help always works (localReply).
- Optional external model via Universal AI Module providers (OpenAI, Gemini, DeepSeek, Anthropic, OpenRouter, Groq, Mistral, xAI, Custom, Local).
- Keys stored server-side only; masked in settings responses.

Assistant lives under More → Assistant (and desktop nav). It has four in-page tabs: Chat, Feedback, AI Settings, Logs. There is no floating FAB or overlay widget.

2.2 features:
- Chunked media upload sessions (5 MiB parts).
- SSRF-safe link unfurl and YouTube/Vimeo embeds.
- Federation connect/inbox for NAT-friendly sync; hello may use request Host when public URL unset.
- Per-user daily AI quota; offline helper covers setup, network, media, embeds, and more.
`.trim();

module.exports = {
  knowledge: KNOWLEDGE,

  actions: [
    { name: 'open_network', description: 'Open the Network screen to manage peers' },
    { name: 'open_settings', description: 'Open Settings' },
    { name: 'open_home', description: 'Open the Home timeline' },
    { name: 'copy_public_url', description: 'Copy this Hub public URL if available' },
  ],

  async getContext(ctx) {
    // ctx may be empty on server; avoid secrets
    return {
      app: 'Community Hub',
      version: (ctx && ctx.version) || '2.2.0',
      features: (ctx && ctx.features) || {},
      note: 'Group posts stay on this Hub. DMs are not available yet.',
    };
  },

  async executeAction({ name, args }) {
    const allowed = new Set(this.actions.map((a) => a.name));
    if (!allowed.has(name)) return { ok: false, error: 'action_not_allowed' };
    // Server-side execute is limited; real navigation is client-driven.
    return { ok: true, action: name, clientHint: name, args: args || {} };
  },

  async localReply(message, live) {
    const m = String(message || '').toLowerCase();
    const vi = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(message || '')
      || /\b(xin chao|toi|ban|giup|mang luoi|dia chi|cong khai)\b/i.test(m);

    if (/public|remote|qr|địa chỉ|dia chi|công khai|cong khai|ip/.test(m)) {
      return vi
        ? 'Địa chỉ công khai của Hub có dạng http://IP:PORT (port SoloHost, mặc định 28090). Xem trong Mạng lưới / Cài đặt → Remote access, hoặc gọi /api/remote/info. Có thể để trống nếu chưa muốn công khai.'
        : 'This Hub public address looks like http://IP:PORT (SoloHost host port, default 28090). See Network / Settings → Remote access, or GET /api/remote/info. You may leave it blank if you do not want to publish yet.';
    }
    if (/peer|network|bootstrap|mạng|mang luoi|kết nối|ket noi|federation/.test(m)) {
      return vi
        ? 'Sau khi tạo tài khoản, có bước kết nối mạng (tùy chọn). Mặc định gợi ý nhãn "default" — có thể xóa trống hoặc dán mã mời. Mật khẩu Hub mặc định để trống. Vào Mạng lưới để xem URL Hub máy này, thêm peer (IP:port / URL / hub1_…@url), và đổi mọi cài đặt sau.'
        : 'After account creation there is an optional network step. Default suggestion is the label "default" — clear it or paste an invite. Hub password defaults empty. Open Network to see this machine Hub URL, add peers (IP:port / URL / hub1_…@url), and change settings anytime.';
    }
    if (/setup|tạo tài khoản|tao tai khoan|owner|đăng ký|dang ky/.test(m)) {
      return vi
        ? 'Lần đầu mở app: tạo tài khoản chủ Hub. Sau khi tạo, app hiện địa chỉ công khai của Hub. Có thể yêu cầu kết nối mạng lưới Community Hub (mã Hub giới thiệu) và mật mã nếu chủ mạng cung cấp. Mọi cài đặt sau đó vẫn đổi được trong Cài đặt / Mạng lưới.'
        : 'On first open, create the Hub owner account. After creation the app shows this Hub public address. You may be asked to join the Community Hub network (intro Hub code) and a network password if the operator provides one. All of this can be changed later in Settings / Network.';
    }
    if (/ai|assistant|trợ lý|tro ly|model|provider/.test(m)) {
      return vi
        ? 'Trợ lý nằm trong tab Assistant trên thanh điều hướng (không phải nút nổi). Có thể cấu hình provider AI trong tab Settings của Assistant khi chủ Hub bật. Không có API key vẫn trả lời hướng dẫn offline.'
        : 'The assistant lives in the Assistant nav tab (not a floating button). Configure AI providers in the Assistant Settings section when the owner enables them. Without an API key you still get offline help.';
    }
    return vi
      ? 'Mình có thể giúp về: đăng bài, theo dõi, nhóm, media, quyền riêng tư, mạng lưới Hub, địa chỉ công khai, sao lưu và danh tính. Hỏi cụ thể một mục nhé.'
      : 'I can help with posting, following, groups, media, privacy, the Hub network, public address, backup and identity. Ask about one of these.';
  },
};
