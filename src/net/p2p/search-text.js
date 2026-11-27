'use strict';
/**
 * Phase 6 — multilingual text analysis shared by the local index and the federated search.
 *
 *  - Tokenizer v2: Vietnamese with/without diacritics (unchanged Latin pipeline), English, Japanese/Chinese via script-run
 *    bigrams (no dictionary needed, katakana folded to hiragana so コミュニティ == こみゅにてぃ), NFKC (full-width / half-width).
 *  - Script/stop-word language detection (vi, en, ja, zh, ko, ru, th, ar + a few Latin languages) with a confidence value.
 *  - A small, editable lexicon: synonym/alias groups across languages and topic mapping. Query expansion adds those forms with a
 *    LOWER weight, so exact matches always outrank expansions.
 *  - Optional translation hook (off unless a translator is injected). Nothing here calls the network.
 */
const crypto = require('crypto');

const TOKENIZER_VERSION = 2;
const MAX_TERMS = 256;
const STOP = new Set(['the','and','for','with','that','this','from','you','your','are','was','were','have','has','not','but','to','of','in','on','at','is','a','an','va','cua','cho','mot','nhung','cac','duoc','trong','tren','khi','la','co','khong','toi','ban']);

const RE_HAN = /\p{Script=Han}/u, RE_HIRA = /\p{Script=Hiragana}/u, RE_KATA = /[\p{Script=Katakana}\u30fc\uff70]/u;
const cjkClass = (ch) => (RE_HAN.test(ch) ? 'han' : RE_HIRA.test(ch) ? 'hira' : RE_KATA.test(ch) ? 'kata' : null);
const kataToHira = (s) => s.replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Latin pipeline (identical to Phase 5 for Latin text) + NFKC so full-width forms fold to ASCII. */
function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[đĐ]/g, 'd').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}_#\u30fc-]+/gu, ' ').trim();
}

/** Split one whitespace-free chunk into CJK script runs (bigrammed) and ordinary words. */
function chunkTokens(chunk, out) {
  let run = '', cls = null, plain = '';
  const flushPlain = () => { if (plain) { if (plain.length >= 2 && plain.length <= 48 && !STOP.has(plain)) out.push(plain); plain = ''; } };
  const flushRun = () => {
    if (!run) return;
    const folded = kataToHira(run); const n = [...folded].length; const chars = [...folded];
    if (cls === 'han' && n === 1) out.push(folded);                              // single kanji is a real word (e.g. 猫, 本)
    else if (n >= 2) for (let i = 0; i < n - 1; i++) out.push(chars[i] + chars[i + 1]);
    run = ''; cls = null;                                                         // single kana = particle/okurigana noise
  };
  for (const ch of chunk) {
    const c = cjkClass(ch);
    if (c) { flushPlain(); if (cls && cls !== c) flushRun(); cls = c; run += ch; }
    else { flushRun(); plain += ch; }
  }
  flushRun(); flushPlain();
}

function tokenize(value) {
  const out = [];
  for (const chunk of normalizeText(value).split(/\s+/u)) if (chunk) chunkTokens(chunk, out);
  return [...new Set(out)].slice(0, MAX_TERMS);
}

// ---------------------------------------------------------------------------------------------------------------- language
const VI_CHARS = /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/giu;
const SW = {
  en: ['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'this', 'are', 'was', 'you', 'have', 'it', 'on', 'my', 'we', 'our', 'from', 'about', 'hello'],
  vi: ['va', 'cua', 'cho', 'mot', 'nhung', 'cac', 'duoc', 'trong', 'khong', 'toi', 'ban', 'nguoi', 'dang', 'nay', 'nhu', 'cung', 'xin', 'chao', 'viet', 'nam', 'cong', 'dong', 'nhat', 'rat', 'va', 'minh', 'het', 'voi', 'khi', 'cung'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'hola', 'comunidad'],
  fr: ['le', 'la', 'les', 'des', 'et', 'est', 'une', 'un', 'pour', 'dans', 'que', 'bonjour', 'avec', 'communaute'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'fur', 'auf', 'hallo', 'gemeinschaft'],
  id: ['yang', 'dan', 'di', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'dari', 'saya', 'halo', 'komunitas'],
  pt: ['o', 'os', 'as', 'de', 'que', 'e', 'um', 'uma', 'para', 'com', 'nao', 'ola', 'comunidade'],
};
const SW_SETS = Object.fromEntries(Object.entries(SW).map(([k, v]) => [k, new Set(v)]));

/** @returns {{lang:string, confidence:number}} lang is an ISO-639-1 style code or 'und'. */
function detectLanguage(text) {
  const s = String(text || '').normalize('NFKC').slice(0, 2000);
  if (!s.trim()) return { lang: 'und', confidence: 0 };
  let han = 0, kana = 0, hangul = 0, cyr = 0, thai = 0, arab = 0, latin = 0, total = 0;
  for (const ch of s) {
    if (/\s|\p{P}|\p{N}|\p{S}/u.test(ch)) continue;
    total++;
    if (RE_HAN.test(ch)) han++; else if (RE_HIRA.test(ch) || RE_KATA.test(ch)) kana++;
    else if (/\p{Script=Hangul}/u.test(ch)) hangul++; else if (/\p{Script=Cyrillic}/u.test(ch)) cyr++;
    else if (/\p{Script=Thai}/u.test(ch)) thai++; else if (/\p{Script=Arabic}/u.test(ch)) arab++;
    else if (/\p{Script=Latin}/u.test(ch)) latin++;
  }
  if (!total) return { lang: 'und', confidence: 0 };
  const share = (n) => n / total;
  if (kana > 0 && share(kana + han) > 0.4) return { lang: 'ja', confidence: Math.min(1, 0.6 + share(kana)) };
  if (share(han) > 0.4) return { lang: 'zh', confidence: Math.min(1, 0.5 + share(han) / 2) };
  if (share(hangul) > 0.4) return { lang: 'ko', confidence: 0.9 };
  if (share(cyr) > 0.4) return { lang: 'ru', confidence: 0.8 };
  if (share(thai) > 0.4) return { lang: 'th', confidence: 0.9 };
  if (share(arab) > 0.4) return { lang: 'ar', confidence: 0.8 };
  if (share(latin) < 0.4) return { lang: 'und', confidence: 0.1 };
  const viMarks = (s.match(VI_CHARS) || []).length;
  const words = normalizeText(s).split(/\s+/u).filter(Boolean);
  if (!words.length) return { lang: 'und', confidence: 0 };
  const score = {}; for (const [k, set] of Object.entries(SW_SETS)) score[k] = words.filter((w) => set.has(w)).length / words.length;
  // Vietnamese-only letters (ă ơ ư đ + stacked tone marks) are decisive even for short strings.
  const viSpecific = (s.match(/[ăâđêôơưạảãấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏõốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]/giu) || []).length;
  if (viSpecific >= 2 || (viMarks >= 1 && score.vi > 0.15) || score.vi > 0.3) return { lang: 'vi', confidence: Math.min(1, 0.55 + viSpecific / Math.max(8, words.length * 2) + score.vi) };
  let best = 'und', bs = 0; for (const [k, v] of Object.entries(score)) if (v > bs) { bs = v; best = k; }
  if (bs >= 0.08) return { lang: best, confidence: Math.min(0.95, 0.4 + bs * 2) };
  return { lang: words.length >= 3 ? 'en' : 'und', confidence: words.length >= 3 ? 0.3 : 0.1 };   // Latin text with no signal: weak English prior
}

// ---------------------------------------------------------------------------------------------------------------- lexicon
/**
 * Synonym / alias groups. Every member is an equivalent phrase (any language). Matching is on the normalized, tokenized form,
 * so "Cộng đồng", "cong dong", "community" and "コミュニティ" all resolve to the same group. Extend freely (or load from config).
 */
const GROUPS = [
  { id: 'community', topic: null, forms: ['cong dong', 'community', 'communities', 'コミュニティ', '共同体', 'communaute', 'comunidad', 'gemeinschaft', 'komunitas'] },
  { id: 'japan', topic: null, forms: ['nhat ban', 'nhat', 'japan', 'nihon', 'japanese', '日本', 'にほん', 'にっぽん'] },
  { id: 'vietnam', topic: null, forms: ['viet nam', 'vietnam', 'vietnamese', 'ベトナム', '越南'] },
  { id: 'tokyo', topic: 'travel', forms: ['tokyo', 'dong kinh', '東京', 'とうきょう', 'トウキョウ'] },
  { id: 'europe', topic: null, forms: ['chau au', 'europe', 'european', 'ヨーロッパ', '欧州'] },
  { id: 'food', topic: 'food', forms: ['am thuc', 'mon an', 'food', 'cuisine', 'recipe', '料理', 'グルメ', '食べ物', 'レシピ'] },
  { id: 'travel', topic: 'travel', forms: ['du lich', 'travel', 'trip', 'tourism', '旅行', '観光'] },
  { id: 'technology', topic: 'tech', forms: ['cong nghe', 'technology', 'tech', '技術', 'テクノロジー'] },
  { id: 'music', topic: 'music', forms: ['am nhac', 'music', 'song', '音楽', 'ミュージック'] },
  { id: 'education', topic: 'education', forms: ['giao duc', 'hoc tap', 'education', 'study', 'learning', '教育', '勉強'] },
  { id: 'news', topic: 'news', forms: ['tin tuc', 'news', 'ニュース', '報道'] },
  { id: 'health', topic: 'health', forms: ['suc khoe', 'health', 'healthy', '健康'] },
  { id: 'finance', topic: 'finance', forms: ['tai chinh', 'finance', 'money', 'investment', '金融', '投資'] },
  { id: 'sports', topic: 'sports', forms: ['the thao', 'sports', 'sport', 'football', 'bong da', 'サッカー', 'スポーツ'] },
  { id: 'art', topic: 'art', forms: ['nghe thuat', 'art', 'design', 'アート', '芸術'] },
  { id: 'hello', topic: null, forms: ['xin chao', 'hello', 'hi', 'こんにちは', 'bonjour', 'hola'] },
  { id: 'friend', topic: null, forms: ['ban be', 'friend', 'friends', '友達', 'ともだち'] },
  { id: 'photo', topic: 'art', forms: ['hinh anh', 'anh', 'photo', 'photography', 'picture', '写真'] },
  { id: 'weather', topic: null, forms: ['thoi tiet', 'weather', '天気'] },
  { id: 'job', topic: 'career', forms: ['viec lam', 'job', 'career', 'work', '仕事', '求人'] },
  { id: 'pi', topic: 'finance', forms: ['pi network', 'pi coin', 'pi'] },
];
const TOPICS = ['tech', 'travel', 'food', 'music', 'education', 'news', 'health', 'finance', 'sports', 'art', 'career'];

const phraseKey = (s) => tokenize(s).join(' ');
const INDEX = new Map();            // normalized phrase -> group
for (const g of GROUPS) { g.keys = g.forms.map(phraseKey).filter(Boolean); for (const k of g.keys) if (!INDEX.has(k)) INDEX.set(k, g); }

/** Light Latin morphology (plural/-ing/-ed) as QUERY expansion only, so the index stays raw and compact. */
function morphVariants(word) {
  if (!/^[a-z]{4,}$/.test(word)) return [];
  const v = new Set();
  if (word.endsWith('ies') && word.length > 4) v.add(word.slice(0, -3) + 'y');
  else if (word.endsWith('es') && word.length > 4) { v.add(word.slice(0, -2)); v.add(word.slice(0, -1)); }
  else if (word.endsWith('s') && !word.endsWith('ss')) v.add(word.slice(0, -1));
  if (word.endsWith('ing') && word.length > 5) v.add(word.slice(0, -3));
  if (word.endsWith('ed') && word.length > 4) v.add(word.slice(0, -2));
  if (word.endsWith('y')) v.add(word.slice(0, -1) + 'ies'); else if (!word.endsWith('s')) v.add(word + 's');
  v.delete(word); return [...v];
}

/** Topic ids a piece of text maps to (used for indexing hooks and for the topic stage of routing). */
function mapTopics(text) {
  const toks = tokenize(text); const hay = ' ' + toks.join(' ') + ' '; const out = new Set();
  for (const g of GROUPS) if (g.topic && g.keys.some((k) => hay.includes(' ' + k + ' '))) out.add(g.topic);
  return [...out].slice(0, 6);
}

/**
 * Analyse a user query into weighted terms.
 * @param {string} q
 * @param {{languages?:string[], translator?:null}} opt
 * @returns {{raw:string, lang:string, terms:{t:string,w:number}[], expansions:string[], topics:string[], groups:string[], rawWords:string[]}}
 */
function analyzeQuery(q, opt = {}) {
  const raw = String(q || '').normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  const det = detectLanguage(raw);
  const base = tokenize(raw);
  const terms = new Map(); const expansions = [];
  for (const t of base) terms.set(t, 1);
  const norm = ' ' + base.join(' ') + ' ';
  const groups = [];
  for (const g of GROUPS) {
    if (!g.keys.some((k) => norm.includes(' ' + k + ' ') || (k.length >= 2 && base.length === 1 && base[0] === k))) continue;
    groups.push(g.id);
    for (const key of g.keys) for (const t of key.split(' ')) if (!terms.has(t) && t.length >= 1) { terms.set(t, 0.6); expansions.push(t); }
  }
  for (const w of base) for (const m of morphVariants(w)) if (!terms.has(m)) { terms.set(m, 0.5); expansions.push(m); }
  const list = [...terms].map(([t, w]) => ({ t, w })).slice(0, 24);
  // Ranking forms: alias forms must match as a WHOLE phrase (so alias "dong kinh" never fires on the unrelated word "dong").
  const forms = base.map((t) => ({ toks: [t], w: 1, kind: 'p' }));
  for (const g of GROUPS) {
    if (!groups.includes(g.id)) continue;
    for (const key of g.keys) { const toks = key.split(' '); if (toks.length === 1 && base.includes(toks[0])) continue; if (base.length && key === base.join(' ')) continue; forms.push({ toks, w: 0.6, kind: 'a', group: g.id }); }
  }
  for (const w of base) for (const m of morphVariants(w)) forms.push({ toks: [m], w: 0.5, kind: 'm', of: w });
  const topics = mapTopics(raw);
  const rawWords = raw.toLocaleLowerCase('und').split(/[^\p{L}\p{N}#]+/u).filter((w) => w.length >= 2);
  return { raw, lang: det.lang, langConfidence: det.confidence, terms: list, forms: forms.slice(0, 60), expansions: expansions.slice(0, 16), topics, groups, rawWords };
}

/** Optional translation-based expansion. The translator is injected (e.g. the Hub's AI module); default: none. Bounded + non-fatal. */
async function translateExpand(analysis, translator, targets, { timeoutMs = 1500 } = {}) {
  if (typeof translator !== 'function' || !analysis.raw) return analysis;
  try {
    const out = await Promise.race([Promise.resolve(translator(analysis.raw, targets.filter((x) => x !== analysis.lang).slice(0, 3))), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), timeoutMs))]);
    const have = new Set(analysis.terms.map((x) => x.t)); const add = [];
    for (const s of (Array.isArray(out) ? out : [out]).slice(0, 3)) for (const t of tokenize(String(s || '').slice(0, 200))) if (!have.has(t) && add.length < 8) { have.add(t); add.push({ t, w: 0.5 }); }
    return { ...analysis, terms: analysis.terms.concat(add).slice(0, 28), forms: (analysis.forms || []).concat(add.map((x) => ({ toks: [x.t], w: 0.5, kind: 'a', group: 'tr' }))), translated: add.length > 0 };
  } catch { return analysis; }
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
module.exports = { TOKENIZER_VERSION, MAX_TERMS, STOP, normalizeText, tokenize, detectLanguage, analyzeQuery, mapTopics, translateExpand, morphVariants, GROUPS, TOPICS, sha };
