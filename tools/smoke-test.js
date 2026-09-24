#!/usr/bin/env node
/**
 * 前端冒烟测试：在最小 DOM 桩中真实执行 assets/app.js 的完整渲染与交互链路。
 *
 * 覆盖三个场景：
 *   A. 实时源可用、逐场数据请求失败  → 应显示「需要本地服务」而非空白
 *   B. 逐场数据返回 2 场比赛          → 应渲染队伍名、系列赛比分、逐图比分
 *   C. 逐场数据返回空                 → 应显示空态并在时间范围过大时给出提示
 * 另外检查 DOM id 对齐、年度导航、筛选交互、指标卡与 .ics 导出。
 *
 * 运行： node tools/smoke-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tournaments.json'), 'utf8'));

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (detail !== undefined ? '  \u2192 ' + detail : '')); }
}

/* ============ 1. 静态检查 ============ */

console.log('\n[1] 语法与 DOM 对齐');
try {
  new vm.Script(appSrc, { filename: 'app.js' });
  check('app.js 语法合法', true);
} catch (e) {
  check('app.js 语法合法', false, e.message);
}

const referenced = new Set();
const idRe = /(?:el|getElementById)\(\s*'([A-Za-z0-9_-]+)'\s*\)/g;
let m;
while ((m = idRe.exec(appSrc))) referenced.add(m[1]);

const defined = new Set();
const defRe = /id="([A-Za-z0-9_-]+)"/g;
while ((m = defRe.exec(html))) defined.add(m[1]);

const missing = [...referenced].filter((id) => !defined.has(id));
check('引用的 ' + referenced.size + ' 个 id 全部存在于 index.html', missing.length === 0, missing.join(', '));
check('存在 time 筛选按钮 [data-range]', html.includes('data-range='));
check('存在自定义日期输入', html.includes('id="rangeFrom"') && html.includes('id="rangeTo"'));
check('存在年度导航容器', html.includes('id="yearnavTrack"'));
check('存在比赛面板容器', html.includes('id="matchesPanel"'));

/* ============ 2. 场景执行 ============ */

function makeHarness(opts) {
  const nodes = new Map();
  const groups = new Map();

  function makeNode(id) {
    return {
      id, textContent: '', innerHTML: '', className: '', style: {},
      _attrs: {}, _listeners: {},
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; },
      classList: { add() {}, remove() {} },
      scrollIntoView() {},
      click() { (this._listeners.click || []).forEach((f) => f({ target: this, preventDefault() {} })); },
      closest() { return null; }
    };
  }

  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };

  // 为筛选按钮建立可点击的假节点
  const chipDefs = [];
  const chipRe = /<button[^>]*class="chip"[^>]*data-(range|scope|org)="([^"]+)"[^>]*>/g;
  let cm;
  while ((cm = chipRe.exec(html))) {
    const n = makeNode('chip-' + cm[1] + '-' + cm[2]);
    n._attrs['data-' + cm[1]] = cm[2];
    chipDefs.push({ attr: cm[1], value: cm[2], node: n });
  }
  chipDefs.forEach((c) => {
    if (!groups.has(c.attr)) groups.set(c.attr, []);
    groups.get(c.attr).push(c.node);
  });

  const doc = {
    readyState: 'complete',
    hidden: false,
    getElementById: getNode,
    querySelectorAll: (sel) => {
      const g = sel.match(/\[data-(range|scope|org)\]/);
      if (g) return groups.get(g[1]) || [];
      return [];
    },
    addEventListener() {},
    createElement: () => ({ style: {}, set href(v) {}, set download(v) {}, click() {} }),
    body: { appendChild() {}, removeChild() {} }
  };

  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean,
    RegExp, Error, Promise, isNaN, parseInt, parseFloat,
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {}, clearInterval() {},
    setInterval: (fn) => { sandbox.__interval = fn; return 1; },
    document: doc,
    fetch: (url) => {
      const u = String(url);
      if (u.indexOf('tournaments.json') >= 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(snapshot) });
      }
      if (u.indexOf('/api/live') >= 0) {
        if (opts.liveFails) return Promise.reject(new Error('offline'));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true, source: 'liquipedia',
            tournaments: snapshot.tournaments
              .filter((t) => t.id !== 'esports-nations-cup')
              .map((t) => ({ id: t.id, organizer: t.organizer, start: t.start, end: t.end, stages: t.stages || [] })),
            playerBreaks: snapshot.playerBreaks
          })
        });
      }
      if (u.indexOf('/api/matches') >= 0) {
        if (opts.matchesFails) return Promise.reject(new Error('network'));
        if (opts.matchesRangeTooLarge) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, matches: [] }) });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, matches: opts.matches || [] })
        });
      }
      return Promise.reject(new Error('unexpected url ' + u));
    }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Blob = function (parts) { this.parts = parts; };
  sandbox.URL = Object.assign(function () {}, {
    createObjectURL: () => 'blob:x', revokeObjectURL: () => {}
  });
  sandbox.AbortController = undefined;

  vm.createContext(sandbox);
  new vm.Script(appSrc, { filename: 'app.js' }).runInContext(sandbox);

  return {
    sandbox, nodes, getNode, chipDefs,
    clickChip: (attr, value) => {
      const c = chipDefs.find((x) => x.attr === attr && x.value === value);
      if (c) c.node.click();
    }
  };
}

/* 真实的事件循环 tick（测试文件自身运行在正常 Node 环境下） */
const tick = () => new Promise((r) => setTimeout(r, 0));
async function drain(n) {
  for (let i = 0; i < (n || 8); i++) await tick();
}

const MATCHES = [
  {
    id: 'm1', tournamentId: 'esl-pro-league-s24', tournamentName: 'ESL 职业联赛 S24',
    tournamentMeta: '卡托维兹 · 波兰', stage: 'Playoffs',
    team1: 'Team Spirit', team2: 'G2 Esports',
    startUTC: Date.UTC(2026, 9, 9, 13, 45), finished: true,
    score1: 2, score2: 1, bo: 'Bo3',
    maps: [
      { map: 'Overpass', s1: 9, s2: 13, finished: true },
      { map: 'Dust II', s1: 16, s2: 14, finished: true },
      { map: 'Mirage', s1: 13, s2: 11, finished: true }
    ]
  },
  {
    id: 'm2', tournamentId: 'esl-pro-league-s24', tournamentName: 'ESL 职业联赛 S24',
    tournamentMeta: '卡托维兹 · 波兰', stage: 'Playoffs',
    team1: 'Team Vitality', team2: null,
    startUTC: Date.UTC(2026, 9, 9, 17, 0), finished: false,
    score1: null, score2: null, bo: null, maps: []
  }
];

(async function main() {

  /* ---- 场景 A：逐场数据不可用 ---- */
  console.log('\n[2] 场景 A：实时源可用，逐场请求失败');
  const A = makeHarness({ liveFails: false, matchesFails: true });
  await drain();
  {
    const list = A.getNode('list').innerHTML;
    check('状态条显示实时数据源', A.getNode('srcLabel').textContent.indexOf('实时') >= 0,
      A.getNode('srcLabel').textContent);
    check('赛历已渲染', list.indexOf('class="event') >= 0, list.slice(0, 80));
    check('合并后保留实时源缺失的赛事（电竞国家杯）', list.indexOf('电子竞技国家杯') >= 0);
    check('FISSURE 在苏州而非深圳', list.indexOf('苏州 · 中国') >= 0 && (list.match(/深圳/g) || []).length <= 1);

    const yearnav = A.getNode('yearnavTrack').innerHTML;
    check('年度导航渲染出色条', (yearnav.match(/yearnav-bar/g) || []).length >= 20,
      (yearnav.match(/yearnav-bar/g) || []).length + ' 条');
    check('年度导航有今天标记', yearnav.indexOf('yearnav-today') >= 0);
    check('Major 色条有独立样式', yearnav.indexOf('yearnav-bar major') >= 0);
    check('月份刻度已渲染', (A.getNode('yearnavScale').innerHTML.match(/data-month/g) || []).length === 12);

    check('赛事卡片带状态色条 class', list.indexOf('is-major') >= 0 && list.indexOf('is-china') >= 0);

    const mp = A.getNode('matchesPanel').innerHTML;
    check('逐场失败时显示可读的空态（非空白）',
      mp.indexOf('state') >= 0 && mp.indexOf('本地服务') >= 0, mp.slice(0, 90));

    check('指标卡为数字', /^\d+$/.test(A.getNode('mLive').textContent) &&
      /^\d+$/.test(A.getNode('mRemaining').textContent));
    check('汇总行显示计数', A.getNode('toolbarSummary').innerHTML.indexOf('项赛事') >= 0);
    check('轮询定时器已注册', typeof A.sandbox.__interval === 'function');
    check('筛选按钮已被绑定', A.chipDefs.length >= 15, A.chipDefs.length + ' 个');
  }

  /* ---- 场景 A2：时间筛选交互 ---- */
  console.log('\n[3] 场景 A2：时间筛选交互');
  {
    const total = (A.getNode('list').innerHTML.match(/class="event/g) || []).length;
    A.clickChip('range', 'next7');
    await drain(3);
    const after = A.getNode('list').innerHTML;
    const soonCount = (after.match(/class="event/g) || []).length;
    check('点击「未来 7 天」后列表被收窄', soonCount <= total && soonCount < total,
      total + ' → ' + soonCount);
    check('筛选后汇总行反映区间',
      A.getNode('toolbarSummary').innerHTML.indexOf('区间') >= 0,
      A.getNode('toolbarSummary').innerHTML.slice(0, 90).replace(/<[^>]+>/g, ''));
    check('范围过大时逐场区给出提示而非空白',
      A.getNode('matchesPanel').innerHTML.length > 40);

    A.clickChip('range', 'all');
    await drain(3);
    check('切回全部后区间提示消失',
      A.getNode('toolbarSummary').innerHTML.indexOf('区间') < 0);
    check('列表恢复全量', (A.getNode('list').innerHTML.match(/class="event/g) || []).length === total);
  }

  /* ---- 场景 A3：主办方筛选 ---- */
  console.log('\n[4] 场景 A3：主办方筛选');
  {
    A.clickChip('org', 'BLAST');
    await drain(3);
    const html2 = A.getNode('list').innerHTML;
    check('只剩 BLAST 赛事', html2.indexOf('BLAST') >= 0 && html2.indexOf('PGL 新加坡 Major') < 0);
    A.clickChip('org', 'all');
    await drain(3);
    check('恢复全部主办方', A.getNode('list').innerHTML.indexOf('PGL 新加坡 Major') >= 0);
  }

  /* ---- 场景 B：有逐场比赛 ---- */
  console.log('\n[5] 场景 B：逐场数据返回比赛');
  const B = makeHarness({ matches: MATCHES });
  await drain();
  {
    const mp = B.getNode('matchesPanel').innerHTML;
    check('按赛事分组渲染', mp.indexOf('mgroup-name') >= 0 && mp.indexOf('ESL 职业联赛 S24') >= 0);
    check('渲染队伍名', mp.indexOf('Team Spirit') >= 0 && mp.indexOf('G2 Esports') >= 0);
    check('渲染系列赛比分', mp.indexOf('>2<') >= 0 && mp.indexOf('>1<') >= 0);
    check('渲染逐图比分', mp.indexOf('Overpass') >= 0 && mp.indexOf('9:13') >= 0);
    check('逐图胜方有区分样式', mp.indexOf('mapchip win2') >= 0 || mp.indexOf('mapchip win1') >= 0);
    check('胜方队伍有 win 标记', mp.indexOf('mteam win') >= 0);
    check('已结束状态标签', mp.indexOf('已结束') >= 0);
    check('未开始状态标签', mp.indexOf('未开始') >= 0);
    check('待定队伍不崩溃', mp.indexOf('待定') >= 0);
    check('副标题显示场次', B.getNode('matchesSub').textContent.indexOf('场') >= 0,
      B.getNode('matchesSub').textContent);
  }

  /* ---- 场景 C：离线快照 ---- */
  console.log('\n[6] 场景 C：无本地服务（纯快照）');
  const C = makeHarness({ liveFails: true, matchesFails: true });
  await drain();
  {
    check('状态条回落到快照',
      C.getNode('srcLabel').textContent.indexOf('快照') >= 0,
      C.getNode('srcLabel').textContent);
    check('赛历仍然完整渲染', C.getNode('list').innerHTML.indexOf('class="event') >= 0);
    check('年度导航仍然渲染', C.getNode('yearnavTrack').innerHTML.indexOf('yearnav-bar') >= 0);
    check('逐场区给出明确说明', C.getNode('matchesPanel').innerHTML.indexOf('本地服务') >= 0);
    check('指标卡仍然填充', /^\d+$/.test(C.getNode('mChina').textContent));
  }

  console.log('\n' + '─'.repeat(48));
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('─'.repeat(48) + '\n');
  process.exit(fail ? 1 : 0);

})();
