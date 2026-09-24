#!/usr/bin/env node
/**
 * 构建期刷新赛程快照（best-effort）。
 *
 * 用途：GitHub Pages 只能托管静态文件，无法运行 server.js 的实时代理。
 * 本脚本在 CI 构建时尝试拉取一次 Liquipedia 的赛事时间轴，把最新的日期合并进
 * data/tournaments.json，让托管版的数据不至于完全静止。
 *
 * 设计原则：
 *   · 只更新「日期与阶段」，人工整理的奖金、冠亚军、备注、场馆一律保留
 *   · 只发一次请求，遵守 Liquipedia 的访问礼仪
 *   · 失败时**不报错退出**（exit 0），保留仓库里已有的快照，让构建继续
 *
 * 运行： node tools/build-snapshot.js
 *   SNAPSHOT_DRY=1  只打印差异，不写文件
 */

'use strict';

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(ROOT, 'data', 'tournaments.json');
const WIKI_API = 'https://liquipedia.net/counterstrike/api.php';
const TIMELINE_PAGE = 'S-Tier Tournaments/Post 2023';
const DRY = process.env.SNAPSHOT_DRY === '1';

const UA = process.env.LIQUIPEDIA_UA ||
  'CS2EventsHub/1.0 (static build; https://github.com/1rgg/CS2-events)';

const S = require(path.join(ROOT, 'server.js'));

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
      if (res.statusCode !== 200) {
        res.resume();
        const e = new Error('HTTP ' + res.statusCode);
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
          resolve(JSON.parse(buf.toString('utf8')));
        } catch (e) { reject(new Error('解压/解析失败: ' + e.message)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

(async function main() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
  const before = JSON.stringify(snapshot.tournaments.map((t) => [t.id, t.start, t.end]));

  const u = new URL(WIKI_API);
  u.searchParams.set('action', 'parse');
  u.searchParams.set('page', TIMELINE_PAGE);
  u.searchParams.set('prop', 'wikitext');
  u.searchParams.set('format', 'json');

  console.log('→ 拉取赛事时间轴…');
  const json = await getJSON(u.toString());
  if (json.error) throw new Error('Liquipedia: ' + (json.error.info || json.error.code));
  const wt = json.parse && json.parse.wikitext && json.parse.wikitext['*'];
  if (!wt) throw new Error('页面结构变化：未找到 wikitext');

  const norm = S.slotsToTournaments(S.parseTimeline(wt));
  const byId = {};
  norm.tournaments.forEach((t) => { byId[t.id] = t; });

  let changed = 0;
  const diffs = [];

  snapshot.tournaments.forEach((t) => {
    const live = byId[t.id];
    if (!live) return;                       // 实时源没覆盖的赛事保持原样
    if (live.start !== t.start || live.end !== t.end) {
      diffs.push('  ' + t.id + ': ' + t.start + '~' + t.end +
        '  →  ' + live.start + '~' + live.end);
      t.start = live.start;
      t.end = live.end;
      changed++;
    }
    if (live.stages && live.stages.length) {
      const a = JSON.stringify(t.stages || []);
      const b = JSON.stringify(live.stages);
      if (a !== b) { t.stages = live.stages; changed++; }
    }
  });

  // 休赛期也一并更新
  if (norm.playerBreaks && norm.playerBreaks.length) {
    snapshot.playerBreaks = norm.playerBreaks;
  }

  if (diffs.length) {
    console.log('  发现的差异：');
    diffs.forEach((d) => console.log(d));
  }

  const after = JSON.stringify(snapshot.tournaments.map((t) => [t.id, t.start, t.end]));

  if (before === after && !diffs.length) {
    console.log('  快照已是最新，无需更新。');
    return;
  }

  snapshot.meta.generatedAt = new Date().toISOString();
  snapshot.meta.refreshedBy = 'tools/build-snapshot.js';

  if (DRY) {
    console.log('  [dry-run] 共 ' + changed + ' 处变更，未写入。');
    return;
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log('  已更新 data/tournaments.json（' + changed + ' 处变更）');
})().catch((err) => {
  // 关键：失败不阻断构建
  console.log('  刷新快照失败，保留仓库内已有数据。原因：' + (err.message || err));
  if (err.statusCode === 429) {
    console.log('  被 Liquipedia 限流（HTTP 429）。CI 使用的数据中心 IP 较易被限，属预期情况。');
  }
  process.exit(0);
});
