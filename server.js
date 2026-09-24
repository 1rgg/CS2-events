#!/usr/bin/env node
/**
 * CS2 赛事实时看板 — 本地服务
 *
 * 职责：
 *   1. 托管静态站点（index.html / assets / data）
 *   2. /api/live    —— 代理 Liquipedia 的赛事时间轴（1 次请求 / 30 分钟）
 *   3. /api/matches —— 按赛事解析逐场比赛与比分（批量请求 + 磁盘缓存）
 *
 * ── 为什么需要代理 ──────────────────────────────────────────────
 * Liquipedia 的 api.php 不返回 Access-Control-Allow-Origin，浏览器直连会被
 * CORS 拦截；其接口条款同时要求使用可识别的 User-Agent，而浏览器不允许
 * 自定义该请求头。因此实时数据必须由服务端转发。
 *
 * ── 访问礼仪（重要）────────────────────────────────────────────
 * Liquipedia 对高频访问会临时封禁 IP，其条款明确表示不欢迎爬虫式访问。
 * 本服务为此做了四件事：
 *   · 全局最小请求间隔 MIN_GAP_MS（默认 3 秒）
 *   · 遇到 HTTP 429 立即进入全局冷却 COOLDOWN_MS（默认 30 分钟），期间不再发请求
 *   · 所有页面写入 .cache/ 磁盘缓存，默认 6 小时，重复访问不再请求
 *   · 逐场数据用批量接口（一次请求取多个页面），并把可查时间范围限制在 21 天内
 * 若你需要高频或大范围的赛事数据，请改用商业数据源（如 PandaScore），
 * 不要加大本服务的请求频率。
 *
 * 零第三方依赖，只用 Node 内置模块。
 * 启动： node server.js
 * 环境变量：
 *   PORT                监听端口，默认 5173
 *   LIQUIPEDIA_UA       请求 Liquipedia 的 User-Agent（建议换成自己的联系方式）
 *   CACHE_TTL_MS        赛事时间轴缓存时长，默认 30 分钟
 *   PAGE_TTL_MS         页面内容缓存时长，默认 6 小时
 *   MIN_GAP_MS          两次请求的最小间隔，默认 3000
 *   COOLDOWN_MS         被限流后的冷却时长，默认 1800000（30 分钟）
 */

'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000);
const PAGE_TTL_MS = Number(process.env.PAGE_TTL_MS || 6 * 60 * 60 * 1000);
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS || 3000);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 30 * 60 * 1000);
const MATCH_MAX_DAYS = 21;

const LIQUIPEDIA_UA = process.env.LIQUIPEDIA_UA ||
  'CS2EventsHub/1.0 (personal, non-commercial use)';

const WIKI_API = 'https://liquipedia.net/counterstrike/api.php';
const TIMELINE_PAGE = 'S-Tier Tournaments/Post 2023';
const CACHE_DIR = path.join(ROOT, '.cache');

/* ================================================================
   1. 访问节制层
   ================================================================ */

let lastRequestAt = 0;
let cooldownUntil = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inCooldown() {
  return Date.now() < cooldownUntil;
}

function cooldownLeftSec() {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

/** 串行化 + 最小间隔地发起一次 Liquipedia 请求 */
function politeGetJSON(urlStr) {
  const run = async () => {
    if (inCooldown()) {
      const e = new Error('Liquipedia 冷却中，' + cooldownLeftSec() + ' 秒后恢复');
      e.code = 'COOLDOWN';
      throw e;
    }
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    try {
      return await rawGetJSON(urlStr);
    } catch (err) {
      if (err.statusCode === 429) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        const e = new Error('Liquipedia 返回 429，已进入 ' +
          Math.round(COOLDOWN_MS / 60000) + ' 分钟冷却');
        e.code = 'RATELIMITED';
        throw e;
      }
      throw err;
    }
  };
  // 排队，避免并发打乱间隔
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

function rawGetJSON(urlStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: {
        'User-Agent': LIQUIPEDIA_UA,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en'
      },
      timeout: 25000
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('Liquipedia HTTP ' + res.statusCode);
        e.statusCode = res.statusCode;
        return reject(e);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) {
          return reject(new Error('解压 Liquipedia 响应失败：' + e.message));
        }
        try {
          resolve(JSON.parse(buf.toString('utf8')));
        } catch (e) {
          reject(new Error('Liquipedia 返回的不是合法 JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Liquipedia 请求超时')));
    req.on('error', reject);
  });
}

function apiUrl(params) {
  const u = new URL(WIKI_API);
  Object.keys(params).forEach((k) => u.searchParams.set(k, params[k]));
  u.searchParams.set('format', 'json');
  u.searchParams.set('formatversion', '2');
  return u.toString();
}

/* ================================================================
   2. 磁盘缓存
   ================================================================ */

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function cachePath(key) {
  return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
}

function cacheRead(key, ttlMs) {
  try {
    const raw = fs.readFileSync(cachePath(key), 'utf8');
    const obj = JSON.parse(raw);
    if (Date.now() - obj.at > ttlMs) return null;
    return obj.value;
  } catch (e) { return null; }
}

function cacheWrite(key, value) {
  try {
    ensureCacheDir();
    fs.writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), value }), 'utf8');
  } catch (e) { /* ignore */ }
}

/** 带缓存的页面内容读取（批量） */
async function getPageContents(titles, ttlMs) {
  const out = {};
  const missing = [];

  titles.forEach((t) => {
    const hit = cacheRead('page:' + t, ttlMs);
    if (hit !== null) out[t] = hit; else missing.push(t);
  });

  if (missing.length) {
    // 一次最多取 10 个标题，降低请求数
    for (let i = 0; i < missing.length; i += 10) {
      const chunk = missing.slice(i, i + 10);
      const json = await politeGetJSON(apiUrl({
        action: 'query',
        prop: 'revisions',
        rvslots: 'main',
        rvprop: 'content',
        titles: chunk.join('|')
      }));
      const pages = (json.query && json.query.pages) || [];
      const seen = {};
      pages.forEach((p) => {
        seen[p.title] = 1;
        if (p.missing) { out[p.title] = null; cacheWrite('page:' + p.title, null); return; }
        const rev = p.revisions && p.revisions[0];
        const content = rev && rev.slots && rev.slots.main && rev.slots.main.content;
        const val = typeof content === 'string' ? content : null;
        out[p.title] = val;
        cacheWrite('page:' + p.title, val);
      });
      // 标题被规范化导致键名不一致时做一次模糊回填
      chunk.forEach((t) => {
        if (out[t] !== undefined) return;
        const norm = (s) => s.replace(/_/g, ' ');
        const hit = Object.keys(seen).find((k) => norm(k) === norm(t));
        out[t] = hit ? out[hit] : null;
      });
    }
  }
  return out;
}

/* ================================================================
   3. 赛事时间轴（/api/live）
   ================================================================ */

const SLOT_MAP = {
  'Majors|2026-06-02': 'iem-cologne-major',
  'Majors|2026-11-25': 'pgl-major-singapore',

  'ESL|2026-01-28': 'iem-krakow',
  'ESL|2026-03-01': 'esl-pro-league-s23',
  'ESL|2026-03-13': 'esl-pro-league-s23',
  'ESL|2026-04-13': 'iem-rio',
  'ESL|2026-05-11': 'iem-atlanta',
  'ESL|2026-10-03': 'esl-pro-league-s24',
  'ESL|2026-11-02': 'iem-beijing',

  'BLAST|2026-01-13': 'blast-bounty-s1',
  'BLAST|2026-01-22': 'blast-bounty-s1',
  'BLAST|2026-03-18': 'blast-open-rotterdam',
  'BLAST|2026-04-29': 'blast-rivals-s1',
  'BLAST|2026-07-21': 'blast-bounty-s2',
  'BLAST|2026-07-30': 'blast-bounty-s2',
  'BLAST|2026-08-26': 'blast-open-porto',
  'BLAST|2026-11-11': 'blast-rivals-s2',

  'PGL|2026-02-14': 'pgl-cluj-napoca',
  'PGL|2026-04-04': 'pgl-bucharest',
  'PGL|2026-05-09': 'pgl-astana',
  'PGL|2026-10-24': 'pgl-masters-bucharest',

  'StarLadder|2026-04-01': 'stake-ranked-1',
  'StarLadder|2026-05-27': 'stake-ranked-2',
  'StarLadder|2026-07-15': 'stake-ranked-3',
  'StarLadder|2026-09-17': 'starladder-starseries-20',
  'StarLadder|2026-10-01': 'stake-ranked-4',
  'StarLadder|2026-10-27': 'stake-ranked-5',
  'StarLadder|2026-11-17': 'stake-ranked-6',

  'EWC Foundation|2026-08-12': 'ewc-2026',
  'GAM3RS_X|2026-09-17': 'logitech-g-play-connect',
  'GAM3RS_X|2026-10-14': 'thunderpick-world-championship',
  'Perfect World|2026-05-20': 'cac-2026',
  'FISSURE|2026-09-08': 'fissure-playground-3',
  'Hero Esports|2026-05-11': 'asian-champions-league',
  'XSE|2026-07-01': 'xse-pro-league',
  'BASED Esports|2026-09-25': '1win-private-club-1',
  'BASED Esports|2026-10-19': '1win-private-club-2',
  'eXTREMESLAND|2026-12-16': 'extremesland-2026'
};

function stageLabel(comment, index, total) {
  const c = String(comment || '').trim();
  if (/ONLINE/i.test(c)) return '线上阶段';
  if (/FINALS/i.test(c)) return '线下决赛';
  if (/Playoffs/i.test(c)) return '淘汰赛';
  if (total > 1) return index === 0 ? '第一阶段' : '第二阶段';
  return c || '正赛';
}

function breakLabel(start) {
  const m = Number(String(start).slice(5, 7));
  if (m >= 11 || m <= 1) return '冬季休赛期';
  if (m >= 5 && m <= 8) return '夏季休赛期';
  return '选手休赛期';
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
}

function parseTimeline(wikitext) {
  const start = wikitext.indexOf('{{Timeline');
  if (start < 0) throw new Error('未找到 {{Timeline}} 模板，页面结构可能已变化');
  const block = wikitext.slice(start);

  const names = {};
  const nameRe = /\|organizer(\d+)=([^|\n]+?)\s*\|organizer\1color=([^\s|]+)/g;
  let m;
  while ((m = nameRe.exec(block))) names[m[1]] = { name: m[2].trim(), color: m[3].trim() };

  const slots = [];
  const slotRe = /\|organizer(\d+)start(\d+)=(\d{4}-\d{2}-\d{2})\|organizer\1end\2=(\d{4}-\d{2}-\d{2})\s*(?:<!--\s*([^>]*?)\s*-->)?/g;
  while ((m = slotRe.exec(block))) {
    slots.push({
      organizer: (names[m[1]] && names[m[1]].name) || ('Organizer ' + m[1]),
      start: m[3], end: m[4], comment: (m[5] || '').trim()
    });
  }
  if (!slots.length) throw new Error('时间轴解析结果为空，页面结构可能已变化');
  return slots;
}

function slotsToTournaments(slots) {
  const breaks = [];
  const grouped = new Map();
  const order = [];

  slots.forEach((s) => {
    if (/player break/i.test(s.organizer)) {
      breaks.push({ label: breakLabel(s.start), start: s.start, end: s.end });
      return;
    }
    const id = SLOT_MAP[s.organizer + '|' + s.start];
    const key = id || ('__auto__' + s.organizer + '|' + s.start);
    if (!grouped.has(key)) { grouped.set(key, { id, organizer: s.organizer, slots: [] }); order.push(key); }
    grouped.get(key).slots.push(s);
  });

  const tournaments = [];
  const extra = [];

  order.forEach((key) => {
    const g = grouped.get(key);
    if (!g.id) {
      const s = g.slots[0];
      const label = s.comment ? g.organizer + ' ' + s.comment : g.organizer + ' 赛事';
      extra.push({
        id: 'auto-' + slug(g.organizer + '-' + s.start) + '-' + s.start,
        name: label, nameZh: label, organizer: g.organizer,
        start: s.start, end: s.end, stages: []
      });
      return;
    }
    const total = g.slots.length;
    let start = g.slots[0].start, end = g.slots[0].end;
    const stages = [];
    g.slots.forEach((s, i) => {
      if (s.start < start) start = s.start;
      if (s.end > end) end = s.end;
      if (total > 1) stages.push({ label: stageLabel(s.comment, i, total), start: s.start, end: s.end });
    });
    tournaments.push({ id: g.id, organizer: g.organizer, start, end, stages });
  });

  return { tournaments: tournaments.concat(extra), playerBreaks: breaks };
}

let liveCache = { at: 0, payload: null };

async function getLive(force) {
  if (!force && liveCache.payload && Date.now() - liveCache.at < CACHE_TTL_MS) {
    return { ...liveCache.payload, cached: true };
  }
  const wikitext = await (async () => {
    const hit = cacheRead('timeline', CACHE_TTL_MS);
    if (hit && !force) return hit;
    const json = await politeGetJSON(apiUrl({
      action: 'parse', page: TIMELINE_PAGE, prop: 'wikitext'
    }));
    if (json.error) throw new Error('Liquipedia: ' + (json.error.info || json.error.code));
    const wt = json.parse && json.parse.wikitext && json.parse.wikitext['*'];
    if (!wt) throw new Error('页面结构变化：未找到 wikitext');
    cacheWrite('timeline', wt);
    return wt;
  })();

  const norm = slotsToTournaments(parseTimeline(wikitext));
  const payload = {
    ok: true,
    source: 'liquipedia',
    sourcePage: TIMELINE_PAGE,
    fetchedAt: new Date().toISOString(),
    tournaments: norm.tournaments,
    playerBreaks: norm.playerBreaks
  };
  liveCache = { at: Date.now(), payload };
  return { ...payload, cached: false };
}

/* ================================================================
   4. 逐场比赛（/api/matches）
   ================================================================ */

const PAGE_MAP = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'page-map.json'), 'utf8'));
    return { pages: j.pages || {}, unmatched: j.unmatched || {}, unverified: j.unverified || {} };
  } catch (e) {
    return { pages: {}, unmatched: {}, unverified: {} };
  }
})();

/* 内置快照：提供赛事中文名、地区、时区等解析比赛时需要的上下文 */
const SNAPSHOT = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tournaments.json'), 'utf8'));
  } catch (e) {
    return { tournaments: [], playerBreaks: [], cancelled: [] };
  }
})();

const SNAPSHOT_BY_ID = (() => {
  const m = {};
  (SNAPSHOT.tournaments || []).forEach((t) => { m[t.id] = t; });
  return m;
})();

/* 队伍 slug → 显示名。未收录的按 slug 推测，可能不够准确。 */
const TEAM_NAMES = {
  spirit: 'Team Spirit', vitality: 'Team Vitality', navi: 'Natus Vincere',
  g2: 'G2 Esports', faze: 'FaZe Clan', mouz: 'MOUZ', mongolz: 'The MongolZ',
  furia: 'FURIA', falcons: 'Team Falcons', astralis: 'Astralis',
  liquid: 'Team Liquid', heroic: 'Heroic', big: 'BIG', mibr: 'MIBR',
  tyloo: 'TYLOO', legacy: 'Legacy', pain: 'paiN Gaming', '9z': '9z Team',
  gamerlegion: 'GamerLegion', betboom: 'BetBoom', parivision: 'PARIVISION',
  aurora: 'Aurora', virtuspro: 'Virtus.pro', vp: 'Virtus.pro', monte: 'Monte',
  b8: 'B8', alliance: 'Alliance', magic: 'Magic', nemiga: 'Nemiga',
  fnatic: 'Fnatic', cloud9: 'Cloud9', complexity: 'Complexity',
  eternalfire: 'Eternal Fire', apeks: 'Apeks', og: 'OG', ence: 'ENCE',
  'natus-vincere': 'Natus Vincere', 'team-spirit': 'Team Spirit',
  'the-mongolz': 'The MongolZ', 'g2-esports': 'G2 Esports',
  'faze-clan': 'FaZe Clan', 'team-vitality': 'Team Vitality',
  'team-falcons': 'Team Falcons', 'team-liquid': 'Team Liquid',
  'virtus-pro': 'Virtus.pro', 'paiN': 'paiN Gaming', 'gamerlegion': 'GamerLegion',
  imperials: 'Imperial', imperial: 'Imperial', sharks: 'Sharks',
  fluxo: 'Fluxo', oddik: 'ODDIK', saw: 'SAW', gl: 'GamerLegion',
  'nouns': 'Nouns', m80: 'M80', wildcard: 'Wildcard', elevate: 'Elevate',
  'red-canine': 'RED Canids', redcanids: 'RED Canids',
  'ninjas-in-pyjamas': 'Ninjas in Pyjamas', nip: 'Ninjas in Pyjamas',
  'amkal': 'AMKAL', '3dmax': '3DMAX', 'sangal': 'Sangal',
  'passion-ua': 'Passion UA', 'passionua': 'Passion UA',
  'endpoint': 'Endpoint', 'rebels': 'Rebels', 'zerance': 'Zerance',
  'jambo': 'Jambo', 'tricked': 'Tricked', 'metizport': 'Metizport',
  'sinners': 'Sinners', 'falcons-esports': 'Team Falcons',
  'dynamo-eclot': 'Dynamo Eclot', 'ecstatic': 'ECSTATIC',
  'insilio': 'Insilio', 'betclic': 'Betclic', 'apogee': 'Apogee',
  'aurora-gaming': 'Aurora', 'legacy-esports': 'Legacy',
  'tyloo': 'TYLOO', 'rarebear': 'Rare Atom', 'rare-atom': 'Rare Atom',
  'lvg': 'Lynn Vision', 'lynn-vision': 'Lynn Vision',
  'the-huns': 'The Huns', 'atox': 'ATOX', 'just-player': 'Just Player',
  '5star': '5star', 'nomad': 'Nomad', 'chinggis-warriors': 'Chinggis Warriors',
  'nexvoid': 'NEXVOID', 'hsg': 'HSG', 'steel-helmet': 'Steel Helmet',
  'wings-up': 'Wings Up', 'newhappy': 'Newhappy', 'gateron': 'GATERON'
};

function teamName(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  const k = key.toLowerCase();
  if (TEAM_NAMES[k]) return TEAM_NAMES[k];
  // 去掉常见后缀后再查一次
  const stripped = k.replace(/[_-]?(esports?|gaming|team|clan|organization|org)$/, '');
  if (TEAM_NAMES[stripped]) return TEAM_NAMES[stripped];
  // 推测：连字符/下划线转空格并首字母大写
  return key.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const TZ = {
  UTC: 0, GMT: 0, BST: 1,
  CET: 1, CEST: 2, EET: 2, EEST: 3, MSK: 3, WEZ: 0, WEST: 1,
  EST: -5, EDT: -4, CST_US: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7,
  BRT: -3, ART: -3, ALMT: 5, SGT: 8, HKT: 8, KST: 9, JST: 9,
  AST: 3, GST: 4, IRST: 3.5, PKT: 5, IST: 5.5
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * 解析 Liquipedia 的日期字符串，返回 UTC 时间戳。
 * 形如： "June 19, 2026 - 15:45 {{Abbr/CEST}}"  或  "2026-10-03 - 12:00 {{Abbr/CET}}"
 * region 用于消歧义（CST 在中国区按 UTC+8 解释）
 */
function parseMatchDate(raw, fallbackOffset, region) {
  if (!raw) return null;
  const s = String(raw);

  // 时区
  let offset = fallbackOffset || 0;
  const tzm = s.match(/\{\{\s*Abbr\/([A-Za-z]{2,6})\s*\}\}/);
  if (tzm) {
    const abbr = tzm[1].toUpperCase();
    if (abbr === 'CST') {
      offset = (region === 'CN' || region === 'HK' || region === 'SG' || region === 'TW') ? 8 : -6;
    } else if (TZ[abbr] !== undefined) {
      offset = TZ[abbr];
    }
  }

  // 时间
  let hh = 0, mm = 0;
  const tm = s.match(/(\d{1,2}):(\d{2})/);
  if (tm) { hh = +tm[1]; mm = +tm[2]; }

  // 日期
  let y = null, mo = null, d = null;
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { y = +iso[1]; mo = +iso[2]; d = +iso[3]; }
  else {
    const nm = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (nm) {
      const idx = MONTHS.indexOf(nm[1].toLowerCase());
      if (idx < 0) {
        const i2 = MONTHS.findIndex((x) => x.slice(0, 3) === nm[1].toLowerCase().slice(0, 3));
        if (i2 >= 0) { mo = i2 + 1; }
      } else mo = idx + 1;
      if (mo) { d = +nm[2]; y = +nm[3]; }
    }
  }
  if (!y || !mo || !d) return null;

  const utc = Date.UTC(y, mo - 1, d, hh, mm, 0, 0) - offset * 3600000;
  return utc;
}

/** 取出从 start 处开始的平衡 {{...}} 片段 */
function extractBalanced(str, start) {
  let depth = 0, i = start;
  while (i < str.length) {
    if (str[i] === '{' && str[i + 1] === '{') { depth++; i += 2; continue; }
    if (str[i] === '}' && str[i + 1] === '}') { depth--; i += 2; if (depth === 0) return str.slice(start, i); continue; }
    i++;
  }
  return str.slice(start);
}

/** 拆出模板的顶层 |key=value */
function topLevelParams(block) {
  const inner = block.slice(2, -2);
  const parts = [];
  let depth = 0, cur = '', i = 0;
  while (i < inner.length) {
    const two = inner.substr(i, 2);
    if (two === '{{') { depth++; cur += two; i += 2; continue; }
    if (two === '}}') { depth--; cur += two; i += 2; continue; }
    if (inner[i] === '|' && depth === 0) { parts.push(cur); cur = ''; i++; continue; }
    cur += inner[i]; i++;
  }
  parts.push(cur);

  const out = {};
  let name = null;
  parts.forEach((p, idx) => {
    const eq = p.indexOf('=');
    if (idx === 0 && eq < 0) { name = p.trim(); return; }
    if (eq < 0) return;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (!k) return;
    if (out[k] === undefined) out[k] = v;
  });
  out.__name = name;
  return out;
}

/**
 * 计算单张地图上某一方的总回合数。
 * Liquipedia 的 Map 模板里 t1t / t1ct 分别是该方的 T 侧与 CT 侧回合数，
 * 不是总分；加时局的回合记在 o1t1t / o1t1ct（o{第几次加时}t{队伍}{side}）。
 */
function mapSideScore(mp, side) {
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  let total = 0, any = false;
  const t = num(mp['t' + side + 't']);
  if (t !== null) { total += t; any = true; }
  const ct = num(mp['t' + side + 'ct']);
  if (ct !== null) { total += ct; any = true; }
  for (let n = 1; n <= 4; n++) {
    const ot = num(mp['o' + n + 't' + side + 't']);
    if (ot !== null) { total += ot; any = true; }
    const oct = num(mp['o' + n + 't' + side + 'ct']);
    if (oct !== null) { total += oct; any = true; }
  }
  return any ? total : null;
}

/** 从一段 wikitext 中解析全部 {{Match}} */
function parseMatches(wikitext, ctx) {
  const out = [];
  let idx = 0;
  while ((idx = wikitext.indexOf('{{Match', idx)) >= 0) {
    const nextChar = wikitext[idx + 7];
    if (nextChar && !/[\s|}]/.test(nextChar)) { idx += 7; continue; }

    const block = extractBalanced(wikitext, idx);
    idx += block.length;
    if (block.length < 20) continue;

    const p = topLevelParams(block);

    const opp = (v) => {
      if (!v) return null;
      const m = v.match(/\{\{\s*TeamOpponent\s*\|\s*([^|}\s]+)/);
      return m ? m[1] : null;
    };

    const t1 = opp(p.opponent1), t2 = opp(p.opponent2);
    if (!t1 && !t2) continue;   // 空对阵（占位赛程）

    const utc = parseMatchDate(p.date, ctx.utcOffset, ctx.region);
    const finished = /true/i.test(p.finished || '');

    // 逐图比分
    const maps = [];
    let score1 = 0, score2 = 0, hasScore = false;
    for (let i = 1; i <= 5; i++) {
      const mv = p['map' + i];
      if (!mv) continue;
      const start = mv.indexOf('{{');
      if (start < 0) continue;
      const mblock = extractBalanced(mv, start);
      const mp = topLevelParams(mblock);
      const name = (mp.map || '').trim();
      const a = mapSideScore(mp, 1);
      const b = mapSideScore(mp, 2);
      maps.push({
        map: name || null,
        s1: a,
        s2: b,
        finished: /true/i.test(mp.finished || '')
      });
      if (a !== null && b !== null && a !== b) {
        hasScore = true;
        if (a > b) score1++; else score2++;
      }
    }

    // Bo 制无法从比赛模板直接读出，按胜局数反推
    const winMax = hasScore ? Math.max(score1, score2) : 0;
    const bo = winMax >= 3 ? 'Bo5' : (winMax === 2 ? 'Bo3' : null);

    out.push({
      id: ctx.tournamentId + ':' + (ctx.stage || '') + ':' + (utc || 'x') + ':' + (t1 || '') + ':' + (t2 || ''),
      tournamentId: ctx.tournamentId,
      tournamentName: ctx.tournamentName,
      tournamentMeta: ctx.tournamentMeta,
      stage: ctx.stage || null,
      team1: teamName(t1),
      team2: teamName(t2),
      startUTC: utc,
      finished: finished,
      score1: hasScore ? score1 : null,
      score2: hasScore ? score2 : null,
      bo: bo,
      maps: maps
    });
  }
  return out;
}

/** 列出某赛事页面的子阶段页 */
async function getSubpages(root, ttlMs) {
  const cached = cacheRead('subpages:' + root, ttlMs);
  if (cached) return cached;

  const json = await politeGetJSON(apiUrl({
    action: 'query', list: 'allpages', apprefix: root, aplimit: 50, apnamespace: 0
  }));
  const all = ((json.query && json.query.allpages) || []).map((p) => p.title);
  // 只要子页面，排除自身与明显的非阶段页
  const subs = all.filter((t) => t !== root && t.length > root.length + 1)
    .filter((t) => !/\/(Players|Statistics|Viewership|Trivia|Media|References|Results)$/i.test(t));
  cacheWrite('subpages:' + root, subs);
  return subs;
}

async function getMatches(fromDay, toDay, force) {
  const today = new Date();
  const rangeDays = Math.round((toDay - fromDay) / 86400000) + 1;
  if (rangeDays > MATCH_MAX_DAYS) {
    return {
      ok: false, reason: 'range_too_large',
      hint: '逐场数据仅支持 ' + MATCH_MAX_DAYS + ' 天以内的时间范围。'
    };
  }
  if (inCooldown()) {
    return {
      ok: false, reason: 'cooldown',
      hint: 'Liquipedia 处于冷却期（还剩 ' + cooldownLeftSec() + ' 秒）。这是访问过于频繁后的自我保护，稍后会自动恢复。'
    };
  }

  // 1. 找出与时间范围重叠、且在映射表里的赛事
  let live;
  try {
    live = await getLive(false);
  } catch (err) {
    return {
      ok: false,
      reason: err.code === 'RATELIMITED' ? 'cooldown' : 'source_error',
      hint: String(err.message || err)
    };
  }

  const iso = (d) => d.toISOString().slice(0, 10);
  const fromS = iso(fromDay), toS = iso(toDay);

  const overlapping = live.tournaments.filter((t) => t.start <= toS && t.end >= fromS);
  const withPage = overlapping.filter((t) => PAGE_MAP.pages[t.id]);
  const skipped = overlapping.filter((t) => !PAGE_MAP.pages[t.id]).map((t) => ({
    tournamentId: t.id,
    reason: PAGE_MAP.unmatched[t.id]
      ? '该赛事在数据源上没有独立的比赛页'
      : '未配置该赛事的页面映射'
  }));

  const matches = [];
  const sources = [];
  const errors = [];
  const nowMs = Date.now();

  // 2. 逐个赛事抓取（上限 2 个，避免一次请求过多页面）
  for (const t of withPage.slice(0, 2)) {
    const root = PAGE_MAP.pages[t.id];
    try {
      let subs = await getSubpages(root, force ? 0 : PAGE_TTL_MS);
      if (!subs.length) subs = [root];
      const contents = await getPageContents(subs, force ? 0 : PAGE_TTL_MS);

      let count = 0;
      const snap = SNAPSHOT_BY_ID[t.id] || {};
      const ctxBase = {
        tournamentId: t.id,
        tournamentName: snap.nameZh || snap.name || t.id,
        tournamentMeta: snap.city ? [snap.city, snap.country].filter(Boolean).join(' · ') : null,
        region: snap.region,
        utcOffset: snap.utcOffset || 0
      };

      subs.forEach((sub) => {
        const wt = contents[sub];
        if (!wt) return;
        const stage = sub.slice(root.length + 1) || null;
        const parsed = parseMatches(wt, Object.assign({}, ctxBase, { stage }));
        parsed.forEach((m) => {
          if (!m.startUTC) return;
          const day = new Date(m.startUTC).toISOString().slice(0, 10);
          if (day < fromS || day > toS) return;
          // 比赛状态：已结束 / 进行中 / 未开始
          m.state = m.finished ? 'finished'
            : (m.startUTC <= nowMs ? 'live' : 'upcoming');
          matches.push(m);
          count++;
        });
      });

      sources.push({ tournamentId: t.id, page: root, subpages: subs.length, matches: count });
    } catch (err) {
      errors.push({ tournamentId: t.id, page: root, error: String(err.message || err) });
      if (err.code === 'RATELIMITED' || err.code === 'COOLDOWN') break;
    }
  }

  matches.sort((a, b) => a.startUTC - b.startUTC);

  return {
    ok: true,
    from: fromS,
    to: toS,
    matches: matches,
    sources: sources,
    skipped: skipped,
    errors: errors,
    cooldownSec: inCooldown() ? cooldownLeftSec() : 0,
    note: buildNote(matches, skipped, errors)
  };
}

function buildNote(matches, skipped, errors) {
  if (errors.length) return '部分赛事数据获取失败：' + errors.map((e) => e.error).join('；');
  if (!matches.length && skipped.length) return skipped[0].reason + '。';
  return '';
}

/* ================================================================
   5. 静态文件
   ================================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.ics': 'text/calendar; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const full = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  if (full.startsWith(CACHE_DIR)) { res.writeHead(403).end('Forbidden'); return; }

  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    const ext = path.extname(full).toLowerCase();
    const noCache = /\.(html|json)$/.test(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(full).pipe(res);
  });
}

/* ================================================================
   6. 路由
   ================================================================ */

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const force = u.searchParams.get('force') === '1';

  if (u.pathname === '/api/live') {
    try {
      json(res, 200, await getLive(force));
    } catch (err) {
      json(res, 502, {
        ok: false,
        reason: err.code || 'error',
        error: String(err.message || err),
        hint: '实时源不可用，前端会自动回落到 data/tournaments.json 快照。'
      });
    }
    return;
  }

  if (u.pathname === '/api/matches') {
    const qFrom = u.searchParams.get('from');
    const qTo = u.searchParams.get('to');
    const today = new Date();
    const d0 = /^\d{4}-\d{2}-\d{2}$/.test(qFrom || '') ? new Date(qFrom + 'T00:00:00Z') : today;
    const d1 = /^\d{4}-\d{2}-\d{2}$/.test(qTo || '') ? new Date(qTo + 'T00:00:00Z') : d0;
    const from = d0 <= d1 ? d0 : d1;
    const to = d0 <= d1 ? d1 : d0;

    try {
      const out = await getMatches(from, to, force);
      json(res, out.ok ? 200 : 200, out);
    } catch (err) {
      json(res, 200, {
        ok: false,
        reason: err.code || 'error',
        error: String(err.message || err),
        hint: '逐场数据获取失败，赛历部分不受影响。'
      });
    }
    return;
  }

  if (u.pathname === '/api/health') {
    json(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      liveCacheAgeSec: liveCache.at ? Math.round((Date.now() - liveCache.at) / 1000) : null,
      cooldown: inCooldown() ? cooldownLeftSec() + 's' : null,
      minGapMs: MIN_GAP_MS,
      pageTtlHours: Math.round(PAGE_TTL_MS / 3600000),
      pageMapEntries: Object.keys(PAGE_MAP.pages).length
    });
    return;
  }

  serveStatic(req, res, u.pathname);
});

/* ================================================================
   7. 启动（含端口占用处理）
   ================================================================ */

const LINE = '─'.repeat(58);

function banner(port, moved) {
  console.log(LINE);
  console.log('  CS2 赛事实时看板');
  console.log(LINE);
  if (moved) {
    console.log('  注意       端口 ' + PORT + ' 已被占用，已自动改用 ' + port);
    console.log('             想固定端口：PORT=8080 node server.js');
    console.log(LINE);
  }
  console.log('  本地地址   http://localhost:' + port);
  console.log('  赛事时间轴 /api/live      （缓存 ' + Math.round(CACHE_TTL_MS / 60000) + ' 分钟）');
  console.log('  逐场比赛   /api/matches   （缓存 ' + Math.round(PAGE_TTL_MS / 3600000) + ' 小时，最多 ' + MATCH_MAX_DAYS + ' 天范围）');
  console.log(LINE);
  console.log('  访问节制   最小间隔 ' + MIN_GAP_MS + 'ms · 429 冷却 ' + Math.round(COOLDOWN_MS / 60000) + ' 分钟 · 页面映射 ' + Object.keys(PAGE_MAP.pages).length + ' 条');
  console.log('  数据来源   Liquipedia（赛历）+ 5EPlay（赛程与战队，浏览器直连）');
  console.log(LINE);
  console.log('  提示：/api/live?force=1 与 /api/matches?force=1 可强制刷新。');
  console.log('       Liquipedia 对高频访问会封禁 IP，请保持默认的请求频率。');
  console.log('  按 Ctrl+C 停止。');
  console.log('');
}

function portHelp(port) {
  console.log('');
  console.log(LINE);
  console.log('  端口 ' + port + ' 已被占用，无法启动。');
  console.log(LINE);
  console.log('  最常见的原因是上一次运行的服务还开着。三种解决办法：');
  console.log('');
  console.log('    1) 换个端口（最省事）：');
  console.log('       PORT=8080 node server.js          # macOS / Linux / Git Bash');
  console.log('       $env:PORT=8080; node server.js    # Windows PowerShell');
  console.log('');
  console.log('    2) 找出占用端口的进程再结束它：');
  console.log('       netstat -ano | findstr :' + port + '     # 看最后一列的 PID');
  console.log('       taskkill /PID <PID> /F             # Windows');
  console.log('       lsof -ti:' + port + ' | xargs kill        # macOS / Linux');
  console.log('');
  console.log('    3) 切回之前跑着这个服务的终端窗口，按 Ctrl+C。');
  console.log(LINE);
  console.log('');
}

if (require.main === module) {
  const explicitPort = Boolean(process.env.PORT);
  const MAX_FALLBACK = 10;
  let listenPort = PORT;
  let moved = false;
  let starting = true;

  server.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
    // 用户显式指定了 PORT → 尊重它，给排查指引而不是偷偷换端口
    if (explicitPort) {
      portHelp(listenPort);
      process.exit(1);
    }
    // 用的是默认端口 → 自动往后找一个空闲端口，别让用户对着堆栈发愣
    if (listenPort - PORT >= MAX_FALLBACK) {
      portHelp(PORT);
      process.exit(1);
    }
    listenPort += 1;
    moved = true;
    starting = true;
    setImmediate(() => server.listen(listenPort));
  });

  server.listen(listenPort, () => {
    if (starting) { starting = false; banner(server.address().port, moved); }
  });

  process.on('SIGINT', () => {
    console.log('\n已停止。');
    process.exit(0);
  });
}

/* 供测试引用 */
module.exports = {
  extractBalanced,
  topLevelParams,
  parseMatchDate,
  mapSideScore,
  parseMatches,
  teamName,
  parseTimeline,
  slotsToTournaments,
  PAGE_MAP,
  MATCH_MAX_DAYS
};
