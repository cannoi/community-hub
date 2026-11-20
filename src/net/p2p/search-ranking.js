'use strict';
/**
 * Phase 6 — ranking for federated search / Global Explore.
 *
 * Starting weights from the specification (a benchmark baseline, NOT fixed values — override via cfg):
 *   relevance 40 · content/source quality 20 · freshness 15 · language fit 10 · region fit 5 · source diversity 10
 *
 * Deliberate rules:
 *  - NODE trust / node resources are NEVER an input (trust gates quotas, not visibility; a big Hub earns no ranking boost).
 *  - Region and language are soft signals: they reorder, they never remove a result.
 *  - Diversity is a greedy re-rank (each extra result from the same origin is discounted) plus a per-page cap, so one Hub cannot
 *    take over Explore while other matching sources exist.
 *  - Relevance is recomputed locally from the verified text; numbers claimed by remote peers are ignored.
 */
const ST = require('./search-text');

const DEFAULT_WEIGHTS = Object.freeze({ relevance: 0.40, quality: 0.20, freshness: 0.15, language: 0.10, region: 0.05, diversity: 0.10 });
const HALF_LIFE_MS = 14 * 86400000;

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Query/doc relevance in [0,1]: primary-term coverage (morph variants count 0.85), alias GROUP hits (0.7), title, adjacency, exact diacritics. */
function relevance(analysis, item) {
  const forms = analysis.forms || [];
  if (!analysis.terms.length) return 0.5;                                        // browse mode: neutral
  const body = ST.tokenize((item.title || '') + ' ' + (item.text || '')); const bodySet = new Set(body);
  const titleSet = new Set(ST.tokenize(item.title || ''));
  const has = (f, set) => f.toks.every((t) => set.has(t));
  const prim = forms.filter((f) => f.kind === 'p');
  const groups = [...new Set(forms.filter((f) => f.kind === 'a').map((f) => f.group))];
  const hitScore = (set) => {
    let s = 0; for (const f of prim) { if (has(f, set)) s += 1; else if (forms.some((m) => m.kind === 'm' && m.of === f.toks[0] && has(m, set))) s += 0.85; }
    return s;
  };
  const primCov = prim.length ? hitScore(bodySet) / prim.length : 0;
  const groupsHit = groups.filter((g) => forms.some((f) => f.kind === 'a' && f.group === g && has(f, bodySet))).length;
  const aliasCov = groups.length ? groupsHit / groups.length : 0;
  const cov = Math.max(primCov, 0.7 * aliasCov);
  if (cov <= 0) return 0;
  const titleCov = prim.length ? hitScore(titleSet) / prim.length : 0;
  let r = 0.75 * cov + 0.13 * Math.max(titleCov, groups.some((g) => forms.some((f) => f.kind === 'a' && f.group === g && has(f, titleSet))) ? 0.7 : 0);
  const pt = prim.map((f) => f.toks[0]);
  if (pt.length >= 2 && (' ' + body.join(' ') + ' ').includes(' ' + pt.join(' ') + ' ')) r += 0.12;      // adjacent phrase
  if (analysis.rawWords.length) {                                                // Vietnamese precision (accents were stripped for recall)
    const low = (String(item.title || '') + ' ' + String(item.text || '')).normalize('NFC').toLocaleLowerCase('und');
    const accented = analysis.rawWords.filter((w) => /[^\u0000-\u007f]/.test(w));
    if (accented.length) r += 0.08 * (accented.filter((w) => low.includes(w)).length / accented.length);
    else if (analysis.rawWords.some((w) => ST.normalizeText(low).includes(w))) r += 0.04;   // typed without accents: accent-bearing posts are not penalised
  }
  return clamp01(r);
}

/** Content quality independent of WHO serves it: length sanity, spam markers, language clarity. */
function quality(item) {
  const text = String(item.text || ''); const n = text.length;
  let q = 0.5;
  if (n >= 40 && n <= 2500) q += 0.2; else if (n < 15) q -= 0.3; else if (n > 2500) q -= 0.05;
  if (item.title) q += 0.05;
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length) {
    const tags = words.filter((w) => w.startsWith('#')).length, links = words.filter((w) => /^https?:/i.test(w)).length;
    if ((tags + links) / words.length > 0.4) q -= 0.25;
    const uniq = new Set(words.map((w) => w.toLowerCase())).size;
    if (words.length >= 6 && uniq / words.length < 0.4) q -= 0.25;               // repeated-word spam
    const letters = text.replace(/[^\p{L}]/gu, ''); const caps = letters.replace(/[^\p{Lu}]/gu, '');
    if (letters.length > 20 && caps.length / letters.length > 0.7) q -= 0.15;       // SHOUTING
  }
  const det = ST.detectLanguage(text); if (det.lang !== 'und' && det.confidence > 0.5) q += 0.1;
  return clamp01(q);
}

function freshness(item, now) { const age = Math.max(0, now - (Number(item.updated_at) || 0)); return Math.pow(0.5, age / HALF_LIFE_MS); }
function langFit(item, langs) { if (!langs.length) return 0.6; if (langs.includes(item.language)) return 1; return item.language === 'und' ? 0.5 : 0.3; }
function regionFit(item, region) { if (!region) return 0.6; if (item.region === region) return 1; return item.region === 'ZZ' ? 0.5 : 0.3; }

/** Score the parts that do not depend on the other results. */
function baseScore(item, ctx) {
  const w = ctx.weights;
  const parts = { relevance: ctx.rel ? ctx.rel(item) : relevance(ctx.analysis, item), quality: quality(item), freshness: freshness(item, ctx.now), language: langFit(item, ctx.langs), region: regionFit(item, ctx.region) };
  return { parts, base: w.relevance * parts.relevance + w.quality * parts.quality + w.freshness * parts.freshness + w.language * parts.language + w.region * parts.region };
}

/**
 * Greedy diversity re-rank. Picks `count` items from `candidates` (each {item, base}) so that each origin's k-th pick
 * gets diversity 1/(1+k); at most `capPerOrigin` per origin until nothing else is left to show.
 */
function rerank(scored, count, { weights = DEFAULT_WEIGHTS, capPerOrigin } = {}) {
  const pool = scored.slice().sort((a, b) => b.base - a.base || (b.item.updated_at - a.item.updated_at) || (a.item.content_id < b.item.content_id ? -1 : 1));
  const cap = capPerOrigin || Math.max(2, Math.ceil(count * 0.3));
  const used = new Map(); const out = [];
  const take = (respectCap) => {
    while (out.length < count && pool.length) {
      let bi = -1, bs = -1;
      for (let i = 0; i < pool.length; i++) {
        const k = used.get(pool[i].item.origin_peer) || 0;
        if (respectCap && k >= cap) continue;
        const s = pool[i].base + weights.diversity * (1 / (1 + k));
        if (s > bs) { bs = s; bi = i; }
      }
      if (bi < 0) return;
      const [pick] = pool.splice(bi, 1); const k = used.get(pick.item.origin_peer) || 0;
      used.set(pick.item.origin_peer, k + 1);
      out.push({ ...pick, score: bs, parts: { ...pick.parts, diversity: 1 / (1 + k) } });
    }
  };
  take(true); take(false);                                                      // relax the cap only when nothing else matches
  return out;
}

/** De-duplicate by (origin, content_id) keeping the newest valid version, and by content hash across origins. */
function dedupe(items) {
  const byKey = new Map();
  for (const it of items) {
    const k = it.origin_peer + '\t' + it.content_id; const cur = byKey.get(k);
    if (!cur) { byKey.set(k, { ...it, served_by: [...new Set(it.served_by || [])] }); continue; }
    cur.served_by = [...new Set([...(cur.served_by || []), ...(it.served_by || [])])];
    if ((it.updated_at || 0) > (cur.updated_at || 0)) Object.assign(cur, { ...it, served_by: cur.served_by });
  }
  const byHash = new Map(); const out = [];
  for (const it of [...byKey.values()].sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0))) {   // oldest first = canonical
    const h = it.content_hash; const first = byHash.get(h);
    if (first && first.origin_peer !== it.origin_peer && String(it.text || '').length > 20) { first.duplicates = (first.duplicates || 0) + 1; continue; }
    byHash.set(h, it); out.push(it);
  }
  return out;
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function encodeCursor(o) { return b64u(o); }
function decodeCursor(c) { try { const o = JSON.parse(Buffer.from(String(c), 'base64url').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; } }

module.exports = { DEFAULT_WEIGHTS, HALF_LIFE_MS, relevance, quality, freshness, baseScore, rerank, dedupe, encodeCursor, decodeCursor };
