/* ============================================================
   5EPlay 数据源客户端（第二数据源）
   ------------------------------------------------------------
   分工：
     Liquipedia  → 赛历骨架（一线赛事、起止日期）
     5EPlay      → 中文赛事名、逐场赛程与比分、参赛战队、名次奖金
   5EPlay 的接口返回 `Access-Control-Allow-Origin: *`，
   因此浏览器可以直连，无需经过本地 Node 代理——这意味着托管在
   GitHub Pages 的静态版同样能取到这些数据。

   对外暴露 window.Hub5E
   ============================================================ */
(function () {
  'use strict';

  var MAP_URL = 'data/5eplay-map.json';
  var API_BASE = 'https://esports-data.5eplaycdn.com';
  var SESSION_KEY = 'hub5e-cache-v1';
  var TTL_MS = 10 * 60 * 1000;      // 会话缓存 10 分钟
  var REQUEST_GAP_MS = 350;         // 两次请求之间的最小间隔，避免瞬发

  var mapCache = null;
  var mapPromise = null;
  var mem = {};                     // ttId -> { at, data }
  var lastReqAt = 0;
  var chain = Promise.resolve();

  /* ---------------- 缓存 ---------------- */

  function ssGet() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function ssSet(obj) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj)); } catch (e) { /* 配额满就放弃 */ }
  }

  function cacheGet(ttId) {
    var now = Date.now();
    if (mem[ttId] && now - mem[ttId].at < TTL_MS) return mem[ttId].data;
    var ss = ssGet();
    if (ss[ttId] && now - ss[ttId].at < TTL_MS) {
      mem[ttId] = ss[ttId];
      return ss[ttId].data;
    }
    return null;
  }

  function cacheSet(ttId, data) {
    var entry = { at: Date.now(), data: data };
    mem[ttId] = entry;
    var ss = ssGet();
    ss[ttId] = entry;
    // 只保留最近 40 个，避免 sessionStorage 膨胀
    var keys = Object.keys(ss);
    if (keys.length > 40) {
      keys.sort(function (a, b) { return ss[a].at - ss[b].at; });
      keys.slice(0, keys.length - 40).forEach(function (k) { delete ss[k]; });
    }
    ssSet(ss);
  }

  /* ---------------- 请求（串行 + 最小间隔） ---------------- */

  function fetchJSON(url) {
    var run = function () {
      var wait = REQUEST_GAP_MS - (Date.now() - lastReqAt);
      var p = wait > 0
        ? new Promise(function (r) { setTimeout(r, wait); })
        : Promise.resolve();
      return p.then(function () {
        lastReqAt = Date.now();
        var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ac ? setTimeout(function () { ac.abort(); }, 15000) : null;
        return fetch(url, {
          headers: { Accept: 'application/json, text/plain, */*' },
          signal: ac ? ac.signal : undefined
        }).then(function (r) {
          if (timer) clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).catch(function (e) {
          if (timer) clearTimeout(timer);
          throw e;
        });
      });
    };
    var p = chain.then(run, run);
    chain = p.catch(function () {});
    return p;
  }

  /* ---------------- 映射表 ---------------- */

  function getMap() {
    if (mapCache) return Promise.resolve(mapCache);
    if (mapPromise) return mapPromise;
    mapPromise = fetch(MAP_URL, { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        mapCache = (j && j.map) || {};
        return mapCache;
      })
      .catch(function () { mapCache = {}; return mapCache; })
      .then(function (m) { mapPromise = null; return m; });
    return mapPromise;
  }

  /** 取某本地赛事对应的 5EPlay 概要（不消耗请求，数据来自映射表） */
  function summaryFor(localId) {
    if (!mapCache) return null;
    return mapCache[localId] || null;
  }

  /* ---------------- 归一化 ---------------- */

  var STATUS = { '0': 'upcoming', '1': 'live', '2': 'finished' };

  function normMatch(m) {
    var i = m.mc_info || {};
    var s = m.state || {};
    var t1 = i.t1_info || {};
    var t2 = i.t2_info || {};

    var score1 = s.t1_score === '' || s.t1_score === undefined ? null : Number(s.t1_score);
    var score2 = s.t2_score === '' || s.t2_score === undefined ? null : Number(s.t2_score);
    if (score1 === null && score2 === null) { score1 = null; score2 = null; }
    if (score1 === 0 && score2 === 0 && s.status === '0') { score1 = null; score2 = null; }

    var state = 'upcoming';
    if (s.live_status === '1' || s.status === '1') state = 'live';
    else if (s.status === '2') state = 'finished';

    var maps = (s.bout_states || []).map(function (b) {
      var a = b.t1_score === '' || b.t1_score === undefined ? null : Number(b.t1_score);
      var c = b.t2_score === '' || b.t2_score === undefined ? null : Number(b.t2_score);
      return { name: b.map_name || '', s1: a, s2: c, status: STATUS[b.status] || null };
    }).filter(function (x) { return x.name; });

    var fmt = String(i.format || '');
    var bo = fmt === '5' ? 'Bo5' : (fmt === '3' ? 'Bo3' : (fmt === '1' ? 'Bo1' : ''));

    return {
      id: i.id,
      startTs: i.plan_ts ? Number(i.plan_ts) * 1000 : null,
      round: i.round_name || '',
      stage: i.tt_stage_desc || i.tt_stage || '',
      tags: i.tags || '',
      bo: bo,
      team1: t1.disp_name || null,
      team2: t2.disp_name || null,
      logo1: t1.logo || null,
      logo2: t2.logo || null,
      score1: score1,
      score2: score2,
      state: state,
      maps: maps
    };
  }

  /** 5EPlay 的奖金串会混入俱乐部分成，例如 "$125,000+club $170,000"，整理成可读形式 */
  function tidyBonus(s) {
    var t = String(s || '').trim();
    if (!t) return '';
    t = t.replace(/\+\s*club\s*/gi, ' + 俱乐部分成 ');
    t = t.replace(/\+\s*Club\s*/g, ' + 俱乐部分成 ');
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function normIntro(j) {
    var d = (j && j.data) || {};
    var basic = d.basic || {};
    var teams = (d.teams || []).map(function (t) {
      return { name: t.name || t.abbr, logo: t.logo || null, rank: t.global_rank || null, region: t.region_name || '' };
    });
    var ranks = (d.team_rank || []).map(function (r) {
      var t = r.team || {};
      return { rank: r.rank || '', name: t.name || t.abbr || '', logo: t.logo || null,
        bonus: tidyBonus(r.bonus), point: r.point || '', pointType: r.point_type || '' };
    }).filter(function (r) { return r.name; });

    // 未开赛的赛事，5EPlay 给的其实是「奖金分配表」而不是最终名次——名次列全是 TBD。
    // 判定出来交给界面换一个说法，避免把预估奖金说成成绩。
    var tbd = ranks.filter(function (r) { return /^tbd$/i.test(r.name.trim()); }).length;
    var ranksAreProjected = ranks.length > 0 && tbd >= Math.ceil(ranks.length / 2);

    return {
      nameZh: basic.name_zh || '',
      nameEn: basic.name_en || '',
      bonus: basic.bonus || '',
      city: basic.city_name || '',
      startTime: basic.start_time || '',
      endTime: basic.end_time || '',
      status: basic.status || '',
      grade: basic.grade || '',
      teams: teams,
      ranks: ranks,
      ranksAreProjected: ranksAreProjected
    };
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 加载某赛事的详情。返回 Promise<{matches, teams, ranks, basic, ok, error}>
   * 需要两次请求（比赛列表 + 赛事简介），结果会话级缓存。
   */
  function load(ttId) {
    if (!ttId) return Promise.resolve({ ok: false, error: 'no-tt-id' });
    var hit = cacheGet(ttId);
    if (hit) return Promise.resolve(hit);

    var matchesP = fetchJSON(API_BASE + '/v1/api/csgo/matches?tt_ids=' +
      encodeURIComponent(ttId) + '&limit=200&page=1')
      .then(function (j) {
        var d = (j && j.data) || {};
        var all = (d.live_matches || []).concat(d.matches || []);
        return all.map(normMatch);
      })
      .catch(function () { return null; });

    var introP = fetchJSON(API_BASE + '/v1/api/csgo/tournaments/' +
      encodeURIComponent(ttId) + '/introduction')
      .then(function (j) {
        if (!j || j.success === false) return null;
        return normIntro(j);
      })
      .catch(function () { return null; });

    return Promise.all([matchesP, introP]).then(function (r) {
      var matches = r[0];
      var intro = r[1];
      if (matches === null && intro === null) {
        var bad = { ok: false, error: 'network' };
        return bad;                       // 失败不缓存，允许重试
      }
      matches = matches || [];
      matches.sort(function (a, b) { return (a.startTs || 0) - (b.startTs || 0); });
      var out = {
        ok: true,
        matches: matches,
        basic: intro ? {
          nameZh: intro.nameZh, nameEn: intro.nameEn, bonus: intro.bonus,
          city: intro.city, startTime: intro.startTime, endTime: intro.endTime, status: intro.status
        } : null,
        teams: intro ? intro.teams : [],
        ranks: intro ? intro.ranks : [],
        ranksAreProjected: intro ? !!intro.ranksAreProjected : false
      };
      cacheSet(ttId, out);
      return out;
    });
  }

  window.Hub5E = {
    getMap: getMap,
    summaryFor: summaryFor,
    load: load,
    apiBase: API_BASE
  };
})();
