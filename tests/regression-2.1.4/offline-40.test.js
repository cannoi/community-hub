'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../src/assistant');

const PAIRS = [
  ['hello', 'en'], ['hi there', 'en'], ['xin chao', 'vi'], ['chao ban', 'vi'],
  ['how do I post', 'en'], ['dang bai the nao', 'vi'], ['viet bai', 'vi'], ['publish a post', 'en'],
  ['follow someone', 'en'], ['theo doi ban be', 'vi'],
  ['upload photo', 'en'], ['tai anh len', 'vi'], ['add video', 'en'],
  ['create a group', 'en'], ['tao nhom', 'vi'],
  ['who can see my posts', 'en'], ['ai co the xem', 'vi'], ['privacy settings', 'en'],
  ['connect to another hub', 'en'], ['ket noi mang luoi', 'vi'], ['bootstrap peer', 'en'],
  ['public url', 'en'], ['dia chi cong khai', 'vi'], ['solo host port', 'en'],
  ['backup my data', 'en'], ['sao luu', 'vi'], ['export key', 'en'],
  ['account id', 'en'], ['danh tinh', 'vi'],
  ['notifications', 'en'], ['thong bao', 'vi'],
  ['search hashtags', 'en'], ['tim kiem', 'vi'],
  ['bookmarks', 'en'], ['da luu', 'vi'],
  ['change language', 'en'], ['cai dat ngon ngu', 'vi'],
  ['create account setup', 'en'], ['tao hub lan dau', 'vi'],
  ['direct message', 'en'], ['tin nhan rieng', 'vi'],
  ['ai provider', 'en'], ['tro ly ai', 'vi'],
  ['send feedback', 'en'], ['gop y', 'vi'],
  ['quota limit', 'en'], ['gioi han ai', 'vi'],
  ['offline mode', 'en'], ['mat mang', 'vi'],
  ['youtube embed', 'en'], ['nhung video', 'vi'],
  ['large file chunk', 'en'], ['tep lon', 'vi'],
  ['thank you', 'en'], ['cam on', 'vi'],
  ['delete post', 'en'], ['xoa bai', 'vi'],
];

describe('2.2.0 offline helper ≥40 pairs', () => {
  it('covers many topics in EN and VI without empty fallback only', () => {
    assert.ok(PAIRS.length >= 40, 'need ≥40 pairs, got ' + PAIRS.length);
    let generic = 0;
    for (const [msg, lang] of PAIRS) {
      const reply = A.localReply(msg, lang);
      assert.ok(reply && reply.length > 20, 'weak: ' + msg);
      // language heuristic: VI replies often contain Vietnamese diacritics or common words
      if (lang === 'vi') {
        const hasVi = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]|bạn|của|được|không|trên|Hub/i.test(reply);
        assert.ok(hasVi, 'expected VI-ish reply for ' + msg);
      }
      if (/I can help you use Community Hub: posting/i.test(reply) || /Mình có thể giúp bạn dùng Community Hub: đăng bài/i.test(reply)) {
        generic++;
      }
    }
    // Most should match intents, not pure greet fallback
    assert.ok(generic < PAIRS.length * 0.35, 'too many generic replies: ' + generic);
  });
});
