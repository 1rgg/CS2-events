#!/usr/bin/env node
/**
 * 生成并校验「赛事 id → Liquipedia 页面名」的映射表。
 *
 * 思路：
 *   1. 请求 S-Tier Tournaments/Post 2023 的**渲染后 HTML**（不是 wikitext），
 *      其中的赛事列表模板会展开成真实链接 —— 一次请求就能拿到全部页面名。
 *   2. 用规则把链接匹配到 data/tournaments.json 里的赛事 id。
 *   3. 逐个抓取候选页面的 Infobox，比对 sdate / edate 与本地日期是否一致（±4 天容差），
 *      只有校验通过的才写入映射表。避免猜错页面。
 *
 * 运行： node tools/resolve-pages.js
 * 输出： data/page-map.json
 *
 * 注意：按 Liquipedia 接口条款，两次请求之间间隔 2.1 秒。
 */

'use strict';

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'page-map.json');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tournaments.json'), 'utf8'));

const UA = process.env.LIQUIPEDIA_UA ||
  'CS2EventsHub/1.0 (personal, non-commercial; page-map builder)';
const API = 'https://liquipedia.net/counterstrike/api.php';
const GAP_MS = 5000;

let lastAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 串行 + 最小间隔 + 429 退避 */
async function politeGet(urlStr, attempt) {
  const n = attempt || 1;
  const wait = Math.max(GAP_MS - (Date.now() - lastAt), 0);
  if (wait) await sleep(wait);
  lastAt = Date.now();
  try {
    return await getJSON(urlStr);
  } catch (e) {
    if (/^HTTP 429/.test(e.message) && n <= 3) {
      const backoff = 30000 * n;
      console.log('    被限流，等待 ' + Math.round(backoff / 1000) + ' 秒后重试（第 ' + n + ' 次）');
      await sleep(backoff);
      return politeGet(urlStr, n + 1);
    }
    throw e;
  }
}

function getJSON(urlStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'en'
      },
      timeout: 25000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          resolve(JSON.parse(buf.toString('utf8')));
        } catch (e) { reject(new Error('解压/解析失败: ' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const api = (params) => {
  const u = new URL(API);
  Object.keys(params).forEach((k) => u.searchParams.set(k, params[k]));
  u.searchParams.set('format', 'json');
  return u.toString();
};

/* ---------- 规则：页面名 → 赛事 id ---------- */

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]/g, '');

const byCity = (city) => {
  const c = norm(city);
  return SNAPSHOT.tournaments.find((t) => norm(t.city) === c && t.id.indexOf('iem') === 0);
};

function ruleMatch(title) {
  const t = title.replace(/_/g, ' ');
  let m;

  if ((m = t.match(/^Intel Extreme Masters\/2026\/(.+)$/))) {
    const hit = byCity(m[1]);
    if (hit) return hit.id;
    if (/cologne/i.test(m[1])) return 'iem-cologne-major';
    if (/beijing/i.test(m[1])) return 'iem-beijing';
    if (/rio/i.test(m[1])) return 'iem-rio';
    if (/atlanta/i.test(m[1])) return 'iem-atlanta';
    if (/krak/i.test(m[1])) return 'iem-krakow';
    return null;
  }

  if ((m = t.match(/^ESL\/Pro League\/Season (\d+)$/))) {
    if (m[1] === '23') return 'esl-pro-league-s23';
    if (m[1] === '24') return 'esl-pro-league-s24';
    return null;
  }

  if ((m = t.match(/^BLAST\/Bounty\/2026\/(Winter|Summer)$/))) {
    return m[1] === 'Winter' ? 'blast-bounty-s1' : 'blast-bounty-s2';
  }
  if ((m = t.match(/^BLAST\/Open\/2026\/(Spring|Fall)$/))) {
    return m[1] === 'Spring' ? 'blast-open-rotterdam' : 'blast-open-porto';
  }
  if ((m = t.match(/^BLAST\/Rivals\/2026\/(Spring|Fall)$/))) {
    return m[1] === 'Spring' ? 'blast-rivals-s1' : 'blast-rivals-s2';
  }

  if ((m = t.match(/^PGL\/2026\/(.+)$/))) {
    const tail = m[1].toLowerCase();
    if (tail === 'cluj-napoca') return 'pgl-cluj-napoca';
    if (tail === 'astana') return 'pgl-astana';
    if (tail === 'singapore') return 'pgl-major-singapore';
    return '__pgl_unsure__:' + tail;   // Summer / Fall / Masters 需靠日期判定
  }

  if (/^FISSURE\/Playground\/\d+$/.test(t)) return '__fissure_unsure__';

  if (t === 'Esports World Cup/2026') return 'ewc-2026';
  if (t === 'CS Asia Championships/2026') return 'cac-2026';
  if (t === 'Thunderpick/World Championship/2026') return 'thunderpick-world-championship';
  if (t === 'StarLadder/StarSeries/2026/Fall') return 'starladder-starseries-20';

  return null;
}

/* ---------- 读 Infobox 日期（批量） ---------- */

function infoboxOf(wikitext) {
  const g = (k) => {
    const m = wikitext.match(new RegExp('\\|' + k + '=([0-9]{4}-[0-9]{2}-[0-9]{2})'));
    return m ? m[1] : null;
  };
  const gn = (k) => {
    const m = wikitext.match(new RegExp('\\|' + k + '=([^|\\n]+)'));
    return m ? m[1].trim() : null;
  };
  return {
    sdate: g('sdate'), edate: g('edate'),
    name: gn('name'), city: gn('city'), organizer: gn('organizer'),
    prize: gn('prizepoolusd')
  };
}

/**
 * 一次请求取多个页面的 wikitext。
 * 用 action=query&prop=revisions 而不是逐页 action=parse，
 * 是为了把请求数从「每个赛事一次」压到「每 10 个一次」。
 */
async function fetchInfoboxes(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 10) {
    const chunk = titles.slice(i, i + 10);
    const u = new URL(API);
    u.searchParams.set('action', 'query');
    u.searchParams.set('prop', 'revisions');
    u.searchParams.set('rvslots', 'main');
    u.searchParams.set('rvprop', 'content');
    u.searchParams.set('titles', chunk.join('|'));
    u.searchParams.set('format', 'json');
    u.searchParams.set('formatversion', '2');

    const j = await politeGet(u.toString());
    const pages = (j.query && j.query.pages) || [];
    pages.forEach((p) => {
      if (p.missing) { out[p.title] = null; return; }
      const rev = p.revisions && p.revisions[0];
      const wt = rev && rev.slots && rev.slots.main && rev.slots.main.content;
      out[p.title] = typeof wt === 'string' ? infoboxOf(wt) : null;
    });
    chunk.forEach((t) => {
      if (out[t] !== undefined) return;
      const norm = (s) => s.replace(/_/g, ' ');
      const hit = Object.keys(out).find((k) => norm(k) === norm(t));
      out[t] = hit ? out[hit] : null;
    });
    console.log('  已取 ' + Math.min(i + 10, titles.length) + ' / ' + titles.length + ' 个页面的 Infobox');
  }
  return out;
}

const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

/* ---------- 主流程 ---------- */

(async function main() {
  console.log('→ 抓取赛事页面索引（渲染后 HTML）…');
  const htmlResp = await politeGet(api({ action: 'parse', page: 'S-Tier Tournaments/Post 2023', prop: 'text' }));
  if (htmlResp.error) throw new Error(htmlResp.error.info);
  const html = htmlResp.parse.text['*'];

  const links = [...new Set(
    (html.match(/href="\/counterstrike\/([^"#?]+)"/g) || [])
      .map((s) => decodeURIComponent(s.slice('href="/counterstrike/'.length, -1)))
  )].filter((l) => !/^(Category|File|Template|Special|Help|Portal|Liquipedia|Main_Page)/i.test(l));

  console.log('  发现 ' + links.length + ' 个链接');

  // 规则匹配
  const candidates = [];
  const unsure = [];
  links.forEach((title) => {
    const id = ruleMatch(title);
    if (!id) return;
    if (id.indexOf('__') === 0) unsure.push({ title, kind: id });
    else candidates.push({ title, id });
  });
  console.log('  规则直接命中 ' + candidates.length + ' 个，待定 ' + unsure.length + ' 个');

  // 待定项与候选项一起批量取 Infobox，用于判定与校验
  const allTitles = [...new Set(candidates.map((c) => c.title).concat(unsure.map((u) => u.title)))];
  console.log('\n→ 批量获取 Infobox（' + allTitles.length + ' 个页面，预计 ' +
    Math.ceil(allTitles.length / 10) + ' 次请求）…');
  const infos = await fetchInfoboxes(allTitles);

  // 待定项：按日期落到本地赛事
  unsure.forEach((u) => {
    const info = infos[u.title];
    if (!info || !info.sdate) { console.log('  待定 ' + u.title + ' → 无 sdate，跳过'); return; }
    const hit = SNAPSHOT.tournaments.find((t) =>
      dayDiff(t.start, info.sdate) <= 4 && dayDiff(t.end, info.edate || info.sdate) <= 4);
    if (hit) {
      console.log('  待定 ' + u.title + '（' + info.sdate + '~' + info.edate + '，' +
        (info.name || '') + '）→ ' + hit.id);
      candidates.push({ title: u.title, id: hit.id });
    } else {
      console.log('  待定 ' + u.title + '（' + info.sdate + '~' + info.edate + '）→ 未匹配本地赛事，跳过');
    }
  });

  // 校验
  console.log('\n→ 校验候选页面…');
  const map = {};
  const rejected = [];

  candidates.forEach((c) => {
    const info = infos[c.title];
    const t = SNAPSHOT.tournaments.find((x) => x.id === c.id);
    if (!t) { rejected.push([c.title, c.id, '本地无此赛事']); return; }
    if (!info || !info.sdate) { rejected.push([c.title, c.id, '页面无 sdate']); return; }

    // 日期校验
    const ds = dayDiff(t.start, info.sdate);
    const de = info.edate ? dayDiff(t.end, info.edate) : 0;
    if (ds > 4 || de > 4) {
      rejected.push([c.title, c.id,
        '日期不符 本地 ' + t.start + '~' + t.end + ' vs 页面 ' + info.sdate + '~' + info.edate]);
      console.log('  ✗ ' + c.id.padEnd(28) + ' ' + c.title + '   日期不符');
      return;
    }
    // 主办方校验：避免仅凭日期就近误配（例如 PGL 的赛事被配到 ESL 页面）
    const orgTarget = String(info.organizer || info.name || '').toLowerCase();
    const orgLocal = String(t.organizer || '').toLowerCase();
    const token = orgLocal.split(/[\s\/]+/)[0];
    if (token && orgTarget && orgTarget.indexOf(token) < 0 && token.indexOf(orgTarget) < 0) {
      rejected.push([c.title, c.id,
        '主办方不符 本地「' + t.organizer + '」vs 页面「' + (info.organizer || info.name) + '」']);
      console.log('  ✗ ' + c.id.padEnd(28) + ' ' + c.title + '   主办方不符（' +
        t.organizer + ' vs ' + (info.organizer || info.name) + '）');
      return;
    }

    map[c.id] = c.title.replace(/_/g, ' ');
    console.log('  ✓ ' + c.id.padEnd(28) + ' → ' + c.title + '   [' + info.sdate + ' ~ ' + info.edate + ']');
  });

  const unmatched = SNAPSHOT.tournaments.filter((t) => !map[t.id]).map((t) => t.id);

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'Liquipedia S-Tier Tournaments/Post 2023（渲染 HTML）',
    note: '每个条目均经 Infobox 的 sdate/edate（±4 天容差）与 organizer 双重校验。',
    pages: map,
    unmatched: unmatched,
    rejected: rejected
  }, null, 2), 'utf8');

  console.log('\n' + '─'.repeat(64));
  console.log('  已写入 ' + Object.keys(map).length + ' 条映射 → data/page-map.json');
  console.log('  未匹配（无逐场数据来源）：' + unmatched.length + ' 个');
  console.log('    ' + unmatched.join(', '));
  if (rejected.length) {
    console.log('  校验未通过：');
    rejected.forEach((r) => console.log('    ' + r[0] + ' → ' + r[1] + '  (' + r[2] + ')'));
  }
  console.log('─'.repeat(64));
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
