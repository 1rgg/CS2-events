#!/usr/bin/env node
/**
 * 解析器测试：用真实抓取到的 Liquipedia wikitext 结构做 fixture。
 *
 * 之所以单独测：Liquipedia 不适合反复请求，解析逻辑必须在离线状态下可验证。
 * fixture 中的字段名与嵌套结构均来自实际页面（如 Intel Extreme Masters/2026/Cologne）。
 *
 * 运行： node tools/parser-test.js
 */

'use strict';

const S = require('../server.js');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (detail !== undefined ? '  \u2192 ' + detail : '')); }
}
function eq(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(label + ' = ' + e, a === e, '实得 ' + a);
}

/* ---------------- fixture 1：淘汰赛页面（含加时） ---------------- */

const PLAYOFFS = `==Results==
{{Bracket|Bracket/8|id=U9J2NxNQ87
<!-- Quarterfinals -->
|R1M1={{Match
	|opponent1={{TeamOpponent|spirit}}|opponent2={{TeamOpponent|g2}}
	|date=June 19, 2026 - 15:45 {{Abbr/CEST}} |finished=true
	|twitch=ESL CS |youtube=ESL CS |kick=ESL CS
	|map1={{Map|map=Overpass|finished=true
		|t1firstside=ct|t1t=2|t1ct=7|t2t=5|t2ct=8
		|stats=231751|vod=https://youtu.be/IrB3zQotMgs&t=27}}
	|map2={{Map|map=Dust II|finished=true
		|t1firstside=t|t1t=6|t1ct=6|t2t=6|t2ct=6
		|o1t1firstside=ct|o1t1t=2|o1t1ct=2|o1t2t=1|o1t2ct=1
		|stats=231755|vod=https://youtu.be/IrB3zQotMgs&t=3280}}
	|map3={{Map|map=Mirage|finished=true
		|t1firstside=ct|t1t=6|t1ct=7|t2t=6|t2ct=5
		|stats=231760|vod=https://youtu.be/IrB3zQotMgs&t=6000}}
	|hltv=
	}}
|R1M2={{Match
	|opponent1={{TeamOpponent|vitality}}|opponent2={{TeamOpponent|navi}}
	|date=June 19, 2026 - 19:00 {{Abbr/CEST}} |finished=true
	|map1={{Map|map=Inferno|finished=true
		|t1firstside=ct|t1t=6|t1ct=7|t2t=5|t2ct=7}}
	|map2={{Map|map=Nuke|finished=true
		|t1firstside=t|t1t=7|t1ct=6|t2t=5|t2ct=7}}
	|hltv=
	}}
|R1M3={{Match
	|opponent1={{TeamOpponent|}}|opponent2={{TeamOpponent|}}
	|date= |finished=
	|map1={{Map|map=|finished=}}
	|map2={{Map|map=|finished=}}
	|hltv=
	}}
}}`;

const CTX = {
  tournamentId: 'iem-cologne-major',
  tournamentName: 'IEM 科隆 Major',
  tournamentMeta: '科隆 · 德国',
  region: 'EU',
  utcOffset: 2,
  stage: 'Playoffs'
};

console.log('\n[1] 平衡括号与顶层参数解析');
{
  const nested = '{{Map|map=Dust II|finished=true|t1t=6|t2t=6|o1t1t=2}}';
  eq('extractBalanced 完整取出嵌套模板', S.extractBalanced(nested, 0).length, nested.length);

  const p = S.topLevelParams('{{Match|opponent1={{TeamOpponent|spirit}}|date=June 19, 2026|hltv=}}');
  eq('嵌套值不被内部竖线切断', p.opponent1, '{{TeamOpponent|spirit}}');
  eq('后续字段正常解析', p.date, 'June 19, 2026');
}

console.log('\n[2] 单图比分 = 分侧回合数求和');
{
  eq('T 侧 + CT 侧', S.mapSideScore({ t1t: '2', t1ct: '7' }, 1), 9);
  eq('含一次加时', S.mapSideScore({ t1t: '6', t1ct: '6', o1t1t: '2', o1t1ct: '2' }, 1), 16);
  eq('加时字段不污染总分（o1t1ct 属对方）',
    S.mapSideScore({ t1t: '6', t1ct: '6', o1t2t: '1', o1t2ct: '1' }, 1), 12);
  eq('无任何字段返回 null', S.mapSideScore({}, 1), null);
}

console.log('\n[3] 日期与时区');
{
  // June 19, 2026 15:45 CEST (UTC+2) → 13:45 UTC
  eq('月份名 + CEST（UTC+2）',
    S.parseMatchDate('June 19, 2026 - 15:45 {{Abbr/CEST}}', 0, 'EU'),
    Date.UTC(2026, 5, 19, 13, 45));
  eq('ISO 日期 + CET（UTC+1）',
    S.parseMatchDate('2026-10-03 - 12:00 {{Abbr/CET}}', 0, 'EU'),
    Date.UTC(2026, 9, 3, 11, 0));
  eq('CST 在亚洲赛区按 UTC+8',
    S.parseMatchDate('November 2, 2026 - 18:00 {{Abbr/CST}}', 0, 'CN'),
    Date.UTC(2026, 10, 2, 10, 0));
  eq('CST 在美洲赛区按 UTC-6',
    S.parseMatchDate('November 2, 2026 - 18:00 {{Abbr/CST}}', 0, 'NA'),
    Date.UTC(2026, 10, 3, 0, 0));
  eq('无时区标记时用赛事默认偏移',
    S.parseMatchDate('2026-08-14 - 20:00', 2, 'EU'),
    Date.UTC(2026, 7, 14, 18, 0));
  eq('无法解析时返回 null', S.parseMatchDate('TBD', 0, 'EU'), null);
}

console.log('\n[4] 队伍名映射');
{
  eq('收录的队伍', S.teamName('spirit'), 'Team Spirit');
  eq('the mongolz', S.teamName('mongolz'), 'The MongolZ');
  eq('未收录时取首字母大写', S.teamName('some-random-team'), 'Some Random Team');
  eq('去掉 esports 后缀再查', S.teamName('vitalityesports'), 'Team Vitality');
}

console.log('\n[5] 比赛解析');
{
  const ms = S.parseMatches(PLAYOFFS, CTX);
  eq('有效比赛数（占位空对阵被剔除）', ms.length, 2);

  const a = ms[0];
  eq('队名已映射', [a.team1, a.team2], ['Team Spirit', 'G2 Esports']);
  eq('开始时间为 UTC', a.startUTC, Date.UTC(2026, 5, 19, 13, 45));
  eq('比赛结束标记', a.finished, true);
  eq('逐图数量', a.maps.length, 3);
  eq('图1 Overpass 比分', [a.maps[0].s1, a.maps[0].s2], [9, 13]);
  eq('图2 Dust II 含加时比分', [a.maps[1].s1, a.maps[1].s2], [16, 14]);
  eq('图3 Mirage 比分', [a.maps[2].s1, a.maps[2].s2], [13, 11]);
  eq('系列赛比分', [a.score1, a.score2], [2, 1]);
  eq('Bo 制反推', a.bo, 'Bo3');
  eq('阶段名', a.stage, 'Playoffs');

  const b = ms[1];
  eq('第二场队名', [b.team1, b.team2], ['Team Vitality', 'Natus Vincere']);
  eq('第二场系列赛比分', [b.score1, b.score2], [2, 0]);

  // 占位空对阵应被跳过 —— ms.length 已为 3，其中第三场是 R1M3
  check('空对阵条目未被当成有效比赛',
    ms.every((m) => m.team1 && m.team2));
}

console.log('\n[6] 空对阵与无比分');
{
  const blank = `{{Match|opponent1={{TeamOpponent|}}|opponent2={{TeamOpponent|}}|date=|finished=}}`;
  eq('空对阵被过滤', S.parseMatches(blank, CTX).length, 0);

  const nos = `{{Match|opponent1={{TeamOpponent|furia}}|opponent2={{TeamOpponent|legacy}}
	|date=October 10, 2026 - 12:00 {{Abbr/CEST}} |finished=
	|map1={{Map|map=|finished=}}}}`;
  const r = S.parseMatches(nos, CTX);
  eq('未开打的比赛也解析出对阵', r.length, 1);
  eq('未开打时无系列赛比分', [r[0].score1, r[0].score2], [null, null]);
  eq('未开打时 Bo 制为空', r[0].bo, null);
}

/* ---------------- fixture 2：赛事时间轴 ---------------- */

const TIMELINE = `{{Timeline|key=organizer|startYear=2026|endYear=2027
	|organizer1=Majors|organizer1color=#ff9b00
		|organizer1start1=2026-06-02|organizer1end1=2026-06-21 <!-- Cologne -->
		|organizer1start2=2026-11-25|organizer1end2=2026-12-13 <!-- Singapore -->
	|organizer2=Player Breaks|organizer2color=#323639
		|organizer2start1=2026-06-22|organizer2end1=2026-07-19
		|organizer2start2=2026-12-14|organizer2end2=2027-01-10
	|organizer3=ESL|organizer3color=#ffff09
		|organizer3start1=2026-01-28|organizer3end1=2026-02-08 <!-- IEM Kraków -->
		|organizer3start2=2026-03-01|organizer3end2=2026-03-10 <!-- ESL Pro League (ONLINE) -->
		|organizer3start3=2026-03-13|organizer3end3=2026-03-15 <!-- ESL Pro League -->
	|organizer4=FISSURE|organizer4color=#d6f758
		|organizer4start1=2026-09-08|organizer4end1=2026-09-13 <!-- FISSURE Playground #3 -->
}}`;

console.log('\n[7] 赛事时间轴解析');
{
  const slots = S.parseTimeline(TIMELINE);
  eq('档位总数（含休赛期）', slots.length, 8);
  const norm = S.slotsToTournaments(slots);
  eq('休赛期不进入赛事列表', norm.playerBreaks.length, 2);
  eq('夏季休赛期命名', norm.playerBreaks[0].label, '夏季休赛期');
  eq('冬季休赛期命名', norm.playerBreaks[1].label, '冬季休赛期');

  const cologne = norm.tournaments.find((t) => t.id === 'iem-cologne-major');
  eq('科隆 Major 起止日', [cologne.start, cologne.end], ['2026-06-02', '2026-06-21']);

  const epl = norm.tournaments.find((t) => t.id === 'esl-pro-league-s23');
  eq('EPL S23 合并两个档位后取最外层区间', [epl.start, epl.end], ['2026-03-01', '2026-03-15']);
  eq('EPL S23 分阶段数', epl.stages.length, 2);
  eq('线上阶段标签', epl.stages[0].label, '线上阶段');

  const fis = norm.tournaments.find((t) => t.id === 'fissure-playground-3');
  eq('FISSURE 苏州站被正确识别', [fis.start, fis.end], ['2026-09-08', '2026-09-13']);

  const singapore = norm.tournaments.find((t) => t.id === 'pgl-major-singapore');
  eq('新加坡 Major 为单档位（无多余阶段）', singapore.stages.length, 0);
}

console.log('\n[8] 页面映射表');
{
  eq('映射条目数', Object.keys(S.PAGE_MAP.pages).length, 23);
  eq('苏州站页面', S.PAGE_MAP.pages['fissure-playground-3'], 'FISSURE/Playground/3');
  check('无逐场数据的赛事被单独记录',
    Object.keys(S.PAGE_MAP.unmatched).length > 0 &&
    !!S.PAGE_MAP.unmatched['xse-pro-league']);
}

console.log('\n' + '─'.repeat(48));
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('─'.repeat(48) + '\n');
process.exit(fail ? 1 : 0);
