#!/usr/bin/env node
/**
 * 生成「本地赛事 id → 5EPlay tt_id」的映射表。
 *
 * 背景：站点赛历骨架来自 Liquipedia，5EPlay 作为第二数据源补充
 *       中文名、赛程、参赛战队、名次与奖金。两边要打通就需要一份 id 映射。
 *
 * 匹配算法（三道硬门槛 + 全局贪心去重）：
 *   门槛 1  日期：区间重叠，或起止各自相差 ≤10 天
 *   门槛 2  系列：本地赛事名里识别出的系列关键词（major/blast/iem/esl/pgl/…）
 *                必须与远端有交集；本地没识别出系列时此门槛跳过
 *   门槛 3  证据：城市命中 或 名称 token 重合 ≥1，否则丢弃（防纯日期误配）
 *   排序    日期接近度 + 区间包含 + 城市 + token 重合度
 *   贪心    所有候选对全局按分排序，逐个认领，已被占用的本地/远端都跳过
 *           （否则会出现两个本地赛事抢同一个 tt_id）
 *
 * 注意：**不要把 organizer 混进系列关键词**。IEM 赛事的 organizer 是 ESL，
 *       若把 organizer 计入，ESL 挑战者联赛的各种杯赛会压过真实配对。
 *
 * 运行： node tools/resolve-5eplay.js
 *   SNAPSHOT_DRY=1  只打印匹配结果，不写文件
 *
 * 5EPlay 接口未公开授权，本工具控制频率（每次请求间隔 600ms）。
 */

'use strict';

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', '5eplay-map.json');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tournaments.json'), 'utf8'));
const DRY = process.env.SNAPSHOT_DRY === '1';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GAP_MS = 600;
const MAX_DAY_DIFF = 10;      // 门槛 1
const MIN_SCORE = 30;         // 最终采纳门槛

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================
   1. 网络
   ================================================================ */

function req(hostname, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = https.request({
      hostname, path: p, method: body ? 'POST' : 'GET',
      headers: Object.assign({
        'User-Agent': UA, Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate', 'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: 'https://event.5eplay.com/'
      }, data ? { 'Content-Type': 'application/json' } : {}),
      timeout: 30000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        let b = Buffer.concat(c);
        const enc = String(res.headers['content-encoding'] || '');
        try { if (enc === 'gzip') b = zlib.gunzipSync(b); else if (enc === 'deflate') b = zlib.inflateSync(b); } catch (e) {}
        try { resolve(JSON.parse(b.toString('utf8'))); } catch (e) { reject(new Error('非 JSON')); }
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('超时')));
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

/* ================================================================
   2. 文本归一化与词典
   ================================================================ */

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // 去变音：Kraków → Krakow
    .toLowerCase()
    .replace(/[（(][^)）]*[)）]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

/** 赛事系列关键词。注意：不能用 organizer，只从赛事名里认。 */
const SERIES = [
  { k: 'major', words: ['major', '特级锦标赛'] },
  { k: 'blast', words: ['blast', '赏金赛', '对抗赛', '公开赛', 'bounty', 'rivals'] },
  { k: 'iem', words: ['iem', 'intel extreme masters', '英特尔极限大师'] },
  // 「职业联赛」太泛（XSE 职业联赛 / 欧洲职业联赛都会被误认成 ESL），只留英文标识
  { k: 'esl', words: ['esl', 'pro league', 'epl'] },
  { k: 'pgl', words: ['pgl'] },
  { k: 'fissure', words: ['fissure', 'playground', '裂变天地'] },
  { k: 'cac', words: ['cac', 'cs asia championships', '亚洲锦标赛', '亚洲邀请赛', '亚洲公开赛'] },
  { k: 'ewc', words: ['ewc', 'esports world cup', '电竞世界杯', '电竞世俱杯'] },
  { k: 'starladder', words: ['starladder', 'starseries', '星系列赛', 'stake ranked', 'stake 排位赛'] },
  { k: 'thunderpick', words: ['thunderpick', 'tp 世界锦标赛'] },
  { k: 'xse', words: ['xse'] },
  { k: 'extremesland', words: ['extremesland', '极限之地'] },
  { k: 'nations', words: ['nations cup', '国家杯', 'enc'] },
  { k: 'acl', words: ['acl', 'asian champions league', '亚洲冠军联赛'] },
  { k: 'cct', words: ['cct'] },
  { k: 'esea', words: ['esea'] }
];

/**
 * 5EPlay 会把 Major 拆成「第一阶段 / 第2阶段 / 封闭预选」等子赛事。
 * 本地赛历记的是主赛事，因此这些子条目要降权，否则会抢占主条目。
 */
const STAGE_RE = /第一阶段|第二阶段|第三阶段|第1阶段|第2阶段|第3阶段|封闭预选|公开预选|预选赛/;

function isStageName(s) { return STAGE_RE.test(String(s || '')); }

/** 城市别名表：同一城市的英文/中文写法归为一组 */
const CITY_GROUPS = [
  ['krakow', '克拉科夫'], ['cologne', '科隆'], ['rio', 'riodejaneiro', '里约热内卢', '里约'],
  ['atlanta', '亚特兰大'], ['rotterdam', '鹿特丹'], ['bucharest', '布加勒斯特'],
  ['cluj', 'clujnapoca', '克卢日'], ['astana', '阿斯塔纳'], ['porto', '波尔图'],
  ['suzhou', '苏州'], ['beijing', '北京'], ['shanghai', '上海'], ['guangzhou', '广州'],
  ['shenzhen', '深圳'], ['chengdu', '成都'],
  ['singapore', '新加坡'], ['hongkong', '香港', '赤鱲角'], ['macau', '澳门'],
  ['fortworth', '沃思堡'], ['warsaw', '华沙'], ['malta', '马耳他'], ['attard', '阿塔德'],
  ['paris', '巴黎'], ['riyadh', '利雅得'], ['belgrade', '贝尔格莱德'],
  ['katowice', '卡托维兹'], ['stockholm', '斯德哥尔摩'], ['copenhagen', '哥本哈根'],
  ['barcelona', '巴塞罗那'], ['madrid', '马德里'], ['london', '伦敦'],
  ['dallas', '达拉斯'], ['lasvegas', '拉斯维加斯'], ['arlington', '阿灵顿'],
  ['montreal', '蒙特利尔'], ['saopaulo', '圣保罗'], ['buenosaires', '布宜诺斯艾利斯'],
  ['moscow', '莫斯科'], ['istanbul', '伊斯坦布尔'], ['dubai', '迪拜'],
  ['seoul', '首尔'], ['tokyo', '东京'], ['bangkok', '曼谷'],
  ['online', '线上', '在线']
];

function citiesIn(text) {
  const t = norm(text);
  const hit = new Set();
  CITY_GROUPS.forEach((group, idx) => {
    if (group.some((w) => t.indexOf(norm(w)) >= 0)) hit.add(idx);
  });
  return hit;
}

function seriesIn(text) {
  const t = norm(text);
  const hit = new Set();
  SERIES.forEach((s) => {
    if (s.words.some((w) => t.indexOf(norm(w)) >= 0)) hit.add(s.k);
  });
  return hit;
}

/** 名称 token：排除纯数字（年份不能当匹配依据）与过短的词 */
function tokensOf(text) {
  return new Set(norm(text).split(' ').filter((x) => x.length >= 3 && !/^\d+$/.test(x)));
}

/**
 * 中文名子串判定。中文不分词，token 方式失效，改用整串包含。
 *   本地「极限之地」 ⊂ 远端「2026 极限之地CS亚洲公开赛」 → 命中
 * 要求至少 4 个中文字符，避免「职业联赛」这类泛词误命中。
 * 远端语序可能不同（「2026 极限之地…」），所以再做一次「只取中文部分」的退化比较。
 */
function zhContains(localZh, remoteName) {
  const a = norm(localZh), b = norm(remoteName);
  const ac = a.replace(/ /g, ''), bc = b.replace(/ /g, '');
  if (ac.length >= 4 && bc.indexOf(ac) >= 0) return true;
  const az = ac.replace(/[a-z0-9]/g, ''), bz = bc.replace(/[a-z0-9]/g, '');
  return az.length >= 4 && bz.indexOf(az) >= 0;
}

function dayDiff(a, b) { return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000); }

/* ================================================================
   3. 打分
   ================================================================ */

function pairScore(local, remote) {
  const rs = String(remote.start_time || '').slice(0, 10);
  const re = String(remote.end_time || '').slice(0, 10);
  if (!rs || !re) return null;

  const ds = dayDiff(local.start, rs);
  const de = dayDiff(local.end, re);

  /* 门槛 1：日期 */
  const overlaps = !(local.end < rs || local.start > re);
  if (!overlaps && Math.min(ds, de) > MAX_DAY_DIFF) return null;

  /* 门槛 2：系列。只用赛事名，不含 organizer */
  const lSeries = seriesIn([local.name, local.nameZh].join(' '));
  const rSeries = seriesIn([remote.name, remote.abbr].join(' '));
  let seriesHit = 0;
  lSeries.forEach((k) => { if (rSeries.has(k)) seriesHit++; });
  if (lSeries.size && seriesHit === 0) return null;

  /* 门槛 3：必须有实质证据（城市 / 名称 token / 中文名子串），否则丢弃。
     纯靠系列关键词 + 日期太容易被同系列的其他赛事骗到。 */
  const lCities = citiesIn([local.name, local.nameZh, local.city, local.country].join(' '));
  const rCities = citiesIn([remote.name, remote.abbr, remote.city].join(' '));
  let cityHit = 0;
  lCities.forEach((k) => { if (rCities.has(k)) cityHit++; });

  const lTok = tokensOf([local.name, local.nameZh].join(' '));
  const rTok = tokensOf([remote.name, remote.abbr].join(' '));
  let tokHit = 0;
  lTok.forEach((x) => { if (rTok.has(x)) tokHit++; });

  const zhHit = zhContains(local.nameZh, remote.name) || zhContains(local.nameZh, remote.abbr);
  if (!cityHit && !tokHit && !zhHit) return null;

  /* 打分 */
  let s = Math.max(0, 26 - Math.min(ds, de) * 1.6);          // 日期接近度
  if (overlaps) s += 10;
  if (local.start >= rs && local.end <= re) s += 8;           // 本地区间被完全包含
  else if (local.start <= rs && local.end >= re) s += 5;
  s += seriesHit * 24;                                        // 系列
  s += cityHit * 20;                                          // 城市
  s += tokHit * 7;                                            // 名称 token
  if (zhHit) s += 26;                                         // 中文名子串命中

  /* 子阶段降权：本地是主赛事时，不该配到「第一阶段」「封闭预选」 */
  const localIsStage = isStageName(local.name) || isStageName(local.nameZh);
  const remoteIsStage = isStageName(remote.name);
  if (remoteIsStage && !localIsStage) s -= 35;
  if (!remoteIsStage && localIsStage) s -= 35;

  return { score: Math.round(s * 10) / 10, ds: Math.round(ds), de: Math.round(de),
    seriesHit, cityHit, tokHit, zhHit, overlaps };
}

/* ================================================================
   4. 拉取 5EPlay 赛事（按本地赛事逐个开窄窗，规避接口结果上限）
   ================================================================ */

/**
 * 重要：`csgo_event_list_v1` **每次查询最多只返回约 21 条，翻页无效**
 * （page_token 回传后结果不变）。所以不能用一个全年窗口去捞——
 * 那样只会拿到时间窗末尾的 21 个事件，早半年的赛事全被截断。
 *
 * 改为：针对每个本地赛事，在它日期前后各开 15 天的窄窗查询，
 * 并按该赛事可能的等级分别查一次（grade 多值混用会返回空）。
 */

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 本地等级 → 5EPlay 可能的 grade 值 */
function gradesForTier(tier) {
  if (tier === 'Major') return ['1', '2'];
  if (tier === 'S') return ['7', '2', '1'];
  if (tier === 'A') return ['3', '2'];
  return ['3', '2'];
}

function normalizeRemote(x) {
  const b = x.basic_info || {};
  return {
    ttId: b.id,
    name: b.disp_name || '',
    abbr: b.abbr_zh || b.abbr_en || '',
    grade: b.grade || '',
    gradeLabel: b.grade_label || '',
    bonus: b.bonus || '',
    city: b.city_name || '',
    start_time: b.start_time || '',
    end_time: b.end_time || '',
    status: b.status || '',
    logo: b.logo || '',
    teamCount: (x.teams || []).length,
    winTeam: x.win_team ? (x.win_team.name || '') : ''
  };
}

async function queryEvents(timeValue, grade) {
  const j = await req('app.5eplay.com', '/api/csgo/tournament/csgo_event_list_v1', {
    tournaments_options: {
      cursor: '', player_id: '', team_id: '', time_type: 'self',
      time_value: timeValue, tt_series: [], grade: grade, tt_bonus: [], page_token: ''
    }
  });
  return (j.data && j.data.items) || [];
}

async function fetchEvents() {
  const pool = new Map();
  const locals = SNAPSHOT.tournaments;

  console.log('→ 按赛事逐窗查询 5EPlay（' + locals.length + ' 个本地赛事）…');

  for (const t of locals) {
    const from = addDays(t.start, -15) + ' 00:00:00';
    const to = addDays(t.end, 15) + ' 23:59:59';
    const tv = from + '_' + to;

    // 先按预期等级查，再不限等级兜底
    const gradeQueries = gradesForTier(t.tier).map((g) => [g]);
    gradeQueries.push([]);

    let got = 0;
    for (const g of gradeQueries) {
      await sleep(GAP_MS);
      let items;
      try {
        items = await queryEvents(tv, g);
      } catch (e) {
        console.log('    ' + t.id + ' 查询失败: ' + e.message);
        continue;
      }
      items.forEach((x) => {
        const r = normalizeRemote(x);
        if (r.ttId && !pool.has(r.ttId)) { pool.set(r.ttId, r); got++; }
      });
      // 已拿到归属该赛事的候选就够用了，减少请求
      if (got >= 12) break;
    }
  }

  const all = [...pool.values()];
  console.log('  累计去重 ' + all.length + ' 个 5EPlay 赛事');
  return all;
}

/* ================================================================
   5. 主流程
   ================================================================ */

(async function main() {
  const remote = await fetchEvents();

  console.log('\n→ 全局贪心匹配（避免多对一）…');
  const pairs = [];
  SNAPSHOT.tournaments.forEach((t) => {
    remote.forEach((r) => {
      const sc = pairScore(t, r);
      if (sc && sc.score >= MIN_SCORE) pairs.push({ local: t, remote: r, sc });
    });
  });
  pairs.sort((a, b) => b.sc.score - a.sc.score);

  const usedLocal = new Set();
  const usedRemote = new Set();
  const map = {};
  pairs.forEach((p) => {
    if (usedLocal.has(p.local.id) || usedRemote.has(p.remote.ttId)) return;
    usedLocal.add(p.local.id);
    usedRemote.add(p.remote.ttId);
    map[p.local.id] = {
      ttId: p.remote.ttId,
      nameZh: p.remote.name,
      nameEn: p.remote.abbr,
      grade: p.remote.grade,
      gradeLabel: p.remote.gradeLabel,
      bonus: p.remote.bonus,
      city: p.remote.city,
      start_time: p.remote.start_time,
      end_time: p.remote.end_time,
      status: p.remote.status,
      logo: p.remote.logo,
      teamCount: p.remote.teamCount,
      winTeam: p.remote.winTeam || null,
      match: { score: p.sc.score, ds: p.sc.ds, de: p.sc.de,
        series: p.sc.seriesHit, city: p.sc.cityHit, tokens: p.sc.tokHit,
        zh: !!p.sc.zhHit, overlaps: p.sc.overlaps }
    };
  });

  console.log('');
  SNAPSHOT.tournaments.forEach((t) => {
    const m = map[t.id];
    if (m) {
      const mark = m.match.score >= 70 ? '✓✓' : (m.match.score >= 50 ? '✓ ' : '? ');
      console.log('  ' + mark + ' ' + t.id.padEnd(30) + ' → ' + m.ttId.padEnd(28) +
        (m.nameZh || '').padEnd(30) +
        '[分 ' + String(m.match.score).padStart(5) + ' 系' + m.match.series + ' 城' + m.match.city +
        ' 词' + m.match.tokens + (m.match.zh ? ' 中✓' : '    ') +
        ' 日' + m.match.ds + '/' + m.match.de + ']');
    } else {
      console.log('  ✗  ' + t.id.padEnd(30) + '   未匹配');
    }
  });

  const unmatched = SNAPSHOT.tournaments.filter((t) => !map[t.id]).map((t) => ({
    id: t.id, name: t.nameZh || t.name, start: t.start, end: t.end
  }));
  const remoteOnly = remote.filter((r) => !usedRemote.has(r.ttId));

  console.log('\n' + '─'.repeat(78));
  console.log('  匹配成功 ' + Object.keys(map).length + ' / ' + SNAPSHOT.tournaments.length);
  const weak = Object.entries(map).filter(([, v]) => v.match.score < 40);
  if (weak.length) {
    console.log('  分数偏低、建议人工复核（' + weak.length + ' 个）：');
    weak.forEach(([k, v]) => console.log('    ' + k + ' → ' + v.ttId + ' ' + v.nameZh + ' (' + v.match.score + ')'));
  }
  console.log('  5EPlay 独有赛事：' + remoteOnly.length + ' 个');
  console.log('─'.repeat(78));

  if (DRY) { console.log('\n[dry-run] 未写入。'); return; }

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'POST app.5eplay.com/api/csgo/tournament/csgo_event_list_v1',
    note: '本地赛事 id → 5EPlay tt_id。三道硬门槛（日期/系列/证据）+ 全局贪心去重。' +
      'match 字段记录匹配依据，便于人工复核。',
    howToRefresh: 'node tools/resolve-5eplay.js',
    thresholds: { maxDayDiff: MAX_DAY_DIFF, minScore: MIN_SCORE },
    map: map,
    unmatched: unmatched,
    remoteOnlyCount: remoteOnly.length
  }, null, 2) + '\n', 'utf8');
  console.log('\n已写入 data/5eplay-map.json（' + Object.keys(map).length + ' 条）');
})().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
