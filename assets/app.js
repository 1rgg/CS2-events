/* ============================================================
   CS2 赛事实时看板 · 前端
   数据源优先级：/api/live + /api/matches（本地 Node 代理）
                 > data/tournaments.json（内置快照）
   所有状态均在运行时按当前时间计算，不依赖数据文件里的 status 字段。
   ============================================================ */
(function () {
  'use strict';

  var REFRESH_SEC = 60;
  var STALE_MIN = 30;
  var SNAPSHOT_URL = 'data/tournaments.json';
  var LIVE_URL = '/api/live';
  var MATCHES_URL = '/api/matches';

  /* 时间范围超过这个天数就不再请求逐场数据（避免把对方接口打爆） */
  var MATCH_LOOKAHEAD_DAYS = 21;

  var state = {
    data: null,
    snapshotRaw: null,
    source: 'snapshot',
    fetchedAt: null,
    scope: 'all',
    organizer: 'all',
    rangeKey: 'all',
    rangeFrom: null,      // Date
    rangeTo: null,        // Date
    matches: null,
    matchesState: 'idle', // idle | loading | ok | empty | unavailable
    matchesNote: '',
    matchesRangeKey: '',
    tick: REFRESH_SEC,
    timer: null,
    refreshing: false,
    highlight: null
  };

  /* ============================ 日期工具 ============================ */

  function parseDay(s) {
    if (!s) return null;
    var p = String(s).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / 86400000); }
  function isoDay(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function fmtRange(start, end, opts) {
    var s = parseDay(start), e = parseDay(end);
    if (!s) return '待定';
    var withYear = opts && opts.year;
    if (!e || +s === +e) {
      return (withYear ? s.getFullYear() + '年' : '') + (s.getMonth() + 1) + '月' + s.getDate() + '日';
    }
    if (s.getFullYear() !== e.getFullYear()) {
      return s.getFullYear() + '年' + (s.getMonth() + 1) + '月' + s.getDate() + '日 – ' +
        e.getFullYear() + '年' + (e.getMonth() + 1) + '月' + e.getDate() + '日';
    }
    if (s.getMonth() === e.getMonth()) {
      return (withYear ? s.getFullYear() + '年' : '') +
        (s.getMonth() + 1) + '月' + s.getDate() + '–' + e.getDate() + '日';
    }
    return (withYear ? s.getFullYear() + '年' : '') + (s.getMonth() + 1) + '月' + s.getDate() +
      '日 – ' + (e.getMonth() + 1) + '月' + e.getDate() + '日';
  }

  function fmtMonthLabel(d) { return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月'; }

  /* ============================ 状态计算 ============================ */

  function computeStatus(t, today) {
    var s = parseDay(t.start), e = parseDay(t.end) || s;
    if (!s) return { key: 'upcoming', daysUntil: null, progress: 0 };
    var dToStart = daysBetween(today, s);
    var dToEnd = daysBetween(today, e);

    if (dToEnd < 0) return { key: 'finished', daysUntil: dToStart, progress: 1 };
    if (dToStart <= 0 && dToEnd >= 0) {
      var total = daysBetween(s, e) + 1;
      var done = daysBetween(s, today) + 1;
      return {
        key: 'live', daysUntil: 0,
        progress: total > 0 ? Math.min(1, done / total) : 1,
        dayOf: done, dayTotal: total
      };
    }
    return { key: 'upcoming', daysUntil: dToStart, progress: 0 };
  }

  function isChinaRegion(t) {
    return t.region === 'CN' || t.region === 'HK' || t.region === 'SG';
  }

  var ORG_GROUPS = ['ESL', 'BLAST', 'PGL', 'StarLadder'];

  function orgGroup(name) {
    var s = String(name || '');
    for (var i = 0; i < ORG_GROUPS.length; i++) {
      if (s.indexOf(ORG_GROUPS[i]) === 0) return ORG_GROUPS[i];
    }
    return 'other';
  }

  function decorate(list, today) {
    return list.map(function (t) {
      var st = computeStatus(t, today);
      var s = parseDay(t.start);
      var e = parseDay(t.end) || s;
      return Object.assign({}, t, {
        _status: st.key,
        _daysUntil: st.daysUntil,
        _progress: st.progress,
        _dayOf: st.dayOf,
        _dayTotal: st.dayTotal,
        _startDate: s,
        _endDate: e,
        _isChina: isChinaRegion(t),
        _orgGroup: orgGroup(t.organizer)
      });
    });
  }

  /* ============================ 时间范围 ============================ */

  function resolveRange(key, today) {
    switch (key) {
      case 'today': return [today, today];
      case 'next7': return [today, addDays(today, 7)];
      case 'next30': return [today, addDays(today, 30)];
      case 'next90': return [today, addDays(today, 90)];
      case 'thisMonth':
        return [new Date(today.getFullYear(), today.getMonth(), 1),
                new Date(today.getFullYear(), today.getMonth() + 1, 0)];
      case 'custom': return [state.rangeFrom, state.rangeTo];
      default: return [null, null];
    }
  }

  function overlaps(t, from, to) {
    if (!from && !to) return true;
    var s = t._startDate, e = t._endDate;
    if (!s) return false;
    var lo = from || new Date(1900, 0, 1);
    var hi = to || new Date(2200, 0, 1);
    return s <= hi && e >= lo;
  }

  /* ============================ 渲染：状态条 ============================ */

  function el(id) { return document.getElementById(id); }

  /** 是否运行在 GitHub Pages 等纯静态托管上（此类环境无法运行 Node 代理） */
  function isStaticHost() {
    try {
      if (typeof location === 'undefined' || !location.hostname) return false;
      return /\.github\.io$/i.test(location.hostname) ||
        /\.netlify\.app$|\.vercel\.app$|\.pages\.dev$/i.test(location.hostname);
    } catch (e) { return false; }
  }

  function isFile() {
    try {
      return typeof location !== 'undefined' && location.protocol === 'file:';
    } catch (e) { return false; }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function money(n) {
    if (!n && n !== 0) return '—';
    if (n >= 1000000) return '$' + (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 2) + 'M';
    if (n >= 1000) return '$' + Math.round(n / 1000) + 'K';
    return '$' + n;
  }

  /** 地点显示：城市与国名相同时不重复（如「新加坡 · 新加坡」） */
  function loc(city, country, sep) {
    var s = sep === undefined ? ' · ' : sep;
    var c = String(city || '').trim();
    var k = String(country || '').trim();
    if (c && k && c === k) return c;
    if (c && k && (k.indexOf(c) === 0 || c.indexOf(k) === 0)) return c.length >= k.length ? c : k;
    return [c, k].filter(Boolean).join(s) || '待定';
  }

  function renderStatusBar() {
    var dot = el('srcDot'), label = el('srcLabel'), upd = el('lastUpdated');
    var mins = state.fetchedAt ? (Date.now() - state.fetchedAt) / 60000 : Infinity;

    dot.className = 'dot';
    if (state.source === 'live') {
      dot.className = 'dot ' + (mins > STALE_MIN ? 'stale' : 'live');
      label.textContent = mins > STALE_MIN ? '实时（缓存较旧）' : '实时 · Liquipedia';
    } else {
      dot.className = 'dot offline';
      label.textContent = isStaticHost() ? '静态快照 · 托管版'
        : (isFile() ? '内置快照 · 本地文件' : '内置快照');
    }
    label.title = state.source === 'live'
      ? '数据来自本地 Node 服务代理的 Liquipedia 赛事时间轴'
      : '未连接到本地 Node 服务，正在使用内置的 data/tournaments.json 快照';

    if (state.fetchedAt) {
      var d = new Date(state.fetchedAt);
      upd.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
      upd.title = '最近一次更新时间';
    } else {
      upd.textContent = '—';
    }
  }

  /* ============================ 渲染：年度导航 ============================ */

  function renderYearNav(rows, today) {
    var track = el('yearnavTrack');
    var year = today.getFullYear();
    var yStart = new Date(year, 0, 1);
    var yEnd = new Date(year, 11, 31);
    var span = daysBetween(yStart, yEnd) + 1;
    var MAX_LANES = 4;
    var LANE_H = 11;

    var positioned = rows.filter(function (t) {
      return t._startDate && t._endDate &&
        t._endDate.getFullYear() >= year && t._startDate.getFullYear() <= year;
    });

    // 纵向分层，避免同期赛事互相遮挡
    var laneRight = [];
    positioned.sort(function (a, b) { return a._startDate - b._startDate; });
    positioned.forEach(function (t) {
      var s = t._startDate < yStart ? yStart : t._startDate;
      var e = t._endDate > yEnd ? yEnd : t._endDate;
      var left = daysBetween(yStart, s) / span;
      var right = (daysBetween(yStart, e) + 1) / span;
      var lane = -1;
      for (var i = 0; i < MAX_LANES; i++) {
        if (laneRight[i] === undefined || laneRight[i] <= left) { lane = i; break; }
      }
      if (lane < 0) lane = MAX_LANES - 1;
      laneRight[lane] = Math.max(laneRight[lane] || 0, right);
      t._lane = lane;
    });

    var laneCount = 1;
    positioned.forEach(function (t) { laneCount = Math.max(laneCount, t._lane + 1); });
    track.style.height = (laneCount * LANE_H + 6) + 'px';
    var barH = Math.max(6, LANE_H - 4);

    var parts = [];
    for (var m = 1; m < 12; m++) {
      parts.push('<div class="yearnav-month' + (m % 3 === 0 ? ' major-line' : '') +
        '" style="left:' + (m / 12 * 100).toFixed(3) + '%"></div>');
    }
    var todayPct = daysBetween(yStart, today) / span * 100;
    if (todayPct >= 0 && todayPct <= 100) {
      parts.push('<div class="yearnav-today" style="left:' + todayPct.toFixed(3) + '%" title="今天"></div>');
    }

    positioned.forEach(function (t) {
      var s = t._startDate < yStart ? yStart : t._startDate;
      var e = t._endDate > yEnd ? yEnd : t._endDate;
      var left = daysBetween(yStart, s) / span * 100;
      var width = Math.max(0.5, (daysBetween(s, e) + 1) / span * 100);
      var plain = state.scope === 'all' && state.organizer === 'all';
      var cls = 'yearnav-bar' +
        (t.tier === 'Major' ? ' major' : '') +
        (t._isChina && t.tier !== 'Major' ? ' cn' : '') +
        (plain || matchesFilters(t) ? '' : ' dim');
      parts.push('<button type="button" class="' + cls + '" data-goto="' + esc(t.id) + '"' +
        ' aria-label="' + esc((t.nameZh || t.name) + ' ' + fmtRange(t.start, t.end)) + '"' +
        ' style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%;top:' +
        (3 + t._lane * LANE_H) + 'px;height:' + barH + 'px"' +
        ' title="' + esc((t.nameZh || t.name) + ' · ' + fmtRange(t.start, t.end)) + '"></button>');
    });

    track.innerHTML = parts.join('');

    var scale = el('yearnavScale');
    scale.innerHTML = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
      .map(function (n) { return '<span data-month="' + n + '">' + n + '</span>'; }).join('');
  }

  /* ============================ 渲染：指标 ============================ */

  function renderMetrics(rows, today) {
    var live = rows.filter(function (r) { return r._status === 'live'; });
    var soon = rows.filter(function (r) {
      return r._status === 'upcoming' && r._daysUntil !== null && r._daysUntil <= 30;
    });
    var remaining = rows.filter(function (r) { return r._status !== 'finished'; });

    el('mLive').textContent = live.length;
    el('mLiveSub').textContent = live.length
      ? (live[0].nameZh || live[0].name)
      : '当前没有赛事在打';

    el('mSoon').textContent = soon.length;
    el('mSoonSub').textContent = soon.length
      ? '最近一场 ' + (soon[0].nameZh || soon[0].name)
      : '30 天内无赛事';

    el('mRemaining').textContent = remaining.length;
    var nextMajor = remaining.filter(function (r) { return r.tier === 'Major'; })[0];
    el('mRemainingSub').textContent = nextMajor
      ? '下一个 Major：' + nextMajor.nameZh
      : '今年 Major 已全部结束';

    el('mChina').textContent = rows.filter(function (r) { return r._isChina; }).length;
    el('mChinaSub').textContent = '中国 / 中国香港 / 新加坡';
  }

  /* ============================ 渲染：比赛面板 ============================ */

  function renderMatches() {
    var host = el('matchesPanel');
    var sub = el('matchesSub');
    var today = startOfDay(new Date());

    var from = state.rangeFrom, to = state.rangeTo;
    var width = (from && to) ? (daysBetween(from, to) + 1) : null;

    if (width !== null && width > MATCH_LOOKAHEAD_DAYS) {
      sub.textContent = '时间范围需在 ' + MATCH_LOOKAHEAD_DAYS + ' 天以内';
      host.innerHTML = stateBlock(
        '时间范围太大，暂不拉取逐场数据',
        '逐场数据需要按赛事逐个抓取，范围过大会给对方接口造成压力。把上方时间范围缩小到 ' +
        MATCH_LOOKAHEAD_DAYS + ' 天以内即可查看。',
        [{ label: '看今天', action: 'range-today' }, { label: '看未来 7 天', action: 'range-next7' }]
      );
      return;
    }

    if (state.matchesState === 'loading') {
      host.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
      sub.textContent = '正在拉取…';
      return;
    }

    if (state.matchesState === 'unavailable') {
      sub.textContent = isStaticHost() ? '托管版不含逐场数据' : '逐场数据不可用';
      host.innerHTML = stateBlock(
        isStaticHost() ? '托管版只提供静态赛历' : '逐场数据需要本地服务',
        isStaticHost()
          ? 'GitHub Pages 只能托管静态文件，跑不了 Node 代理，所以这里用的是构建时烘焙进仓库的赛程快照。' +
            '想看到逐场对阵、实时比分与自动更新，把仓库克隆下来执行 <code>node server.js</code> 即可。'
          : '当前是静态快照模式。运行 <code>node server.js</code> 后刷新页面即可获取逐场比赛与比分。',
        isStaticHost()
          ? [{ label: '看赛历', action: 'focus-list' }, { label: '看完整赛历表', action: 'open-calendar' }]
          : [{ label: '看赛历', action: 'focus-list' }]
      );
      return;
    }

    var matches = state.matches || [];
    if (!matches.length) {
      var label = (from && to) ? fmtRange(isoDay(from), isoDay(to), { year: true }) : '该时段';
      var next = null;
      if (state.data) {
        var tmp = startOfDay(new Date());
        next = state.data.tournaments
          .map(function (t) { return { t: t, s: parseDay(t.start) }; })
          .filter(function (x) { return x.s && x.s >= tmp; })
          .sort(function (a, b) { return a.s - b.s; })[0];
      }
      var extra = next
        ? '下一场是「' + esc(next.t.nameZh || next.t.name) + '」，' + fmtRange(next.t.start, next.t.end) +
          ' 开赛，还有 ' + daysBetween(today, next.s) + ' 天。'
        : '';
      sub.textContent = label + ' 无比赛';
      host.innerHTML = stateBlock(
        label + '没有安排比赛',
        (state.matchesNote ? state.matchesNote + ' ' : '') + extra,
        [{ label: '看未来 30 天', action: 'range-next30' }]
      );
      return;
    }

    sub.textContent = matches.length + ' 场 · ' +
      fmtRange(isoDay(from || today), isoDay(to || today), { year: true });

    // 按赛事分组
    var groups = {};
    var order = [];
    matches.forEach(function (m) {
      if (!groups[m.tournamentId]) {
        groups[m.tournamentId] = { name: m.tournamentName, meta: m.tournamentMeta, items: [] };
        order.push(m.tournamentId);
      }
      groups[m.tournamentId].items.push(m);
    });

    host.innerHTML = order.map(function (id) {
      var g = groups[id];
      return '<div class="mgroup">' +
        '<div class="mgroup-head">' +
          '<span class="mgroup-name">' + esc(g.name) + '</span>' +
          (g.meta ? '<span class="mgroup-meta">' + esc(g.meta) + '</span>' : '') +
          '<span class="spacer"></span>' +
          '<span class="mgroup-meta">' + g.items.length + ' 场</span>' +
        '</div>' +
        g.items.map(renderMatch).join('') +
      '</div>';
    }).join('');
  }

  var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function renderMatch(m) {
    var s1 = m.score1, s2 = m.score2;
    var known = s1 !== null && s1 !== undefined && s2 !== null && s2 !== undefined;
    var win1 = known && s1 > s2, win2 = known && s2 > s1;

    // 时间由前端按访问者本地时区格式化
    var start = m.startUTC ? new Date(m.startUTC) : null;
    var timeText = start ? pad(start.getHours()) + ':' + pad(start.getMinutes()) : '—';
    var dayText = '';
    if (start) {
      var today = startOfDay(new Date());
      var diff = daysBetween(today, start);
      if (diff === 0) dayText = '今天';
      else if (diff === 1) dayText = '明天';
      else dayText = (start.getMonth() + 1) + '/' + start.getDate() + ' ' + WEEKDAYS[start.getDay()];
    }

    // 状态优先用服务端给出的，缺失时本地推算
    var st = m.state;
    if (!st) {
      if (m.finished) st = 'finished';
      else st = (m.startUTC && m.startUTC <= Date.now()) ? 'live' : 'upcoming';
    }
    var stateCls = st === 'live' ? 'live' : (st === 'finished' ? 'done' : 'next');
    var stateTxt = st === 'live' ? '进行中' : (st === 'finished' ? '已结束' : '未开始');

    var maps = (m.maps || []).filter(function (x) { return x.map; }).map(function (x) {
      var cls = 'mapchip';
      var a = x.s1, b = x.s2;
      if (a !== null && a !== undefined && b !== null && b !== undefined) {
        if (a > b) cls += ' win1'; else if (b > a) cls += ' win2';
      }
      var hasScore = (a !== null && a !== undefined) && (b !== null && b !== undefined);
      return '<span class="' + cls + '">' + esc(x.map) +
        (hasScore ? ' ' + a + ':' + b : '') + '</span>';
    }).join('');

    return '<div class="match">' +
      '<div class="match-time">' +
        '<b class="tnum">' + esc(timeText) + '</b>' +
        (dayText ? esc(dayText) : '') +
      '</div>' +
      '<div class="match-teams">' +
        '<div class="mteam' + (win1 ? ' win' : (known ? ' lose' : '')) + '">' +
          '<span class="nm">' + esc(m.team1 || '待定') + '</span>' +
          (known ? '<span class="spacer"></span><span class="mteam-score">' + s1 + '</span>' : '') +
        '</div>' +
        '<div class="mteam' + (win2 ? ' win' : (known ? ' lose' : '')) + '">' +
          '<span class="nm">' + esc(m.team2 || '待定') + '</span>' +
          (known ? '<span class="spacer"></span><span class="mteam-score">' + s2 + '</span>' : '') +
        '</div>' +
        (maps ? '<div class="match-maps">' + maps + '</div>' : '') +
      '</div>' +
      '<div class="match-side">' +
        '<span class="mstate ' + stateCls + '">' + stateTxt + '</span>' +
        (m.bo ? '<span class="match-bo">' + esc(m.bo) + '</span>' : '') +
      '</div>' +
    '</div>';
  }

  function stateBlock(title, desc, actions) {
    return '<div class="state">' +
      '<p class="state-title">' + esc(title) + '</p>' +
      '<p class="state-desc">' + (desc || '') + '</p>' +
      (actions && actions.length
        ? '<div class="state-actions">' + actions.map(function (a) {
            return '<button type="button" class="chip" data-action="' + a.action + '">' +
              esc(a.label) + '</button>';
          }).join('') + '</div>'
        : '') +
    '</div>';
  }

  /* ============================ 渲染：赛历列表 ============================ */

  function matchesFilters(t) {
    if (state.organizer !== 'all' && t._orgGroup !== state.organizer) return false;
    if (state.scope === 'major') return t.tier === 'Major';
    if (state.scope === 'china') return t._isChina;
    if (state.scope === 'upcoming') return t._status !== 'finished';
    if (state.scope === 'finished') return t._status === 'finished';
    return true;
  }

  function renderList(rows) {
    var host = el('list');
    var from = state.rangeFrom, to = state.rangeTo;

    var filtered = rows.filter(function (r) {
      return matchesFilters(r) && overlaps(r, from, to);
    }).sort(function (a, b) {
      if (!a._startDate) return 1;
      if (!b._startDate) return -1;
      return a._startDate - b._startDate;
    });

    renderSummary(filtered.length, rows.length, from, to);

    if (!filtered.length) {
      host.innerHTML = stateBlock(
        '没有符合条件的赛事',
        '试着放宽筛选条件，或把时间范围调回「全部」。',
        [{ label: '清空筛选', action: 'reset-filters' }]
      );
      return;
    }

    var breaks = (state.data && state.data.playerBreaks) || [];
    var out = [];
    var lastKey = '';

    filtered.forEach(function (t) {
      var key = t._startDate ? (t._startDate.getFullYear() + '-' + (t._startDate.getMonth() + 1)) : 'unknown';
      if (key !== lastKey) {
        if (lastKey !== '') out.push('</div>');
        var label = t._startDate ? fmtMonthLabel(t._startDate) : '日期待定';
        var inMonth = filtered.filter(function (x) {
          return x._startDate && (x._startDate.getFullYear() + '-' + (x._startDate.getMonth() + 1)) === key;
        }).length;
        var monthId = t._startDate ? (t._startDate.getFullYear() + '-' + pad(t._startDate.getMonth() + 1)) : 'unknown';
        out.push('<div class="month" id="m-' + monthId + '">');
        out.push('<div class="month-head"><span class="month-name">' + label +
          '</span><span class="month-meta">' + inMonth + ' 项</span></div>');
        lastKey = key;

        breaks.forEach(function (b) {
          var bs = parseDay(b.start);
          if (!bs || !t._startDate) return;
          if (bs.getFullYear() === t._startDate.getFullYear() && bs.getMonth() === t._startDate.getMonth()) {
            out.push('<div class="break-row">' +
              '<span class="break-line"></span><span>' + esc(b.label) + ' · ' +
              fmtRange(b.start, b.end) + '</span><span class="break-line"></span></div>');
          }
        });
      }
      out.push(renderEvent(t));
    });
    if (lastKey !== '') out.push('</div>');
    host.innerHTML = out.join('');
  }

  function renderSummary(shown, total, from, to) {
    var parts = [];
    parts.push('显示 <b>' + shown + '</b> / ' + total + ' 项赛事');
    if (from || to) {
      parts.push('区间 <b>' + (from ? isoDay(from) : '不限') + ' → ' + (to ? isoDay(to) : '不限') + '</b>');
    }
    el('toolbarSummary').innerHTML = parts.join(' &nbsp;·&nbsp; ') +
      ' &nbsp;<button type="button" class="reset-link" data-action="reset-filters">重置</button>';
  }

  function renderEvent(t) {
    var st = t._status;
    var cls = 'event' +
      (st === 'live' ? ' is-live' : '') +
      (t.tier === 'Major' ? ' is-major' : '') +
      (t._isChina ? ' is-china' : '');

    var badges = [];
    if (t.tier === 'Major') badges.push('<span class="badge major">Major</span>');
    else if (t.tier) badges.push('<span class="badge tier">' + esc(t.tier) + ' 级</span>');
    if (t._isChina) badges.push('<span class="badge cn">零时差</span>');
    if (st === 'live') badges.push('<span class="badge live">进行中</span>');
    else if (st === 'upcoming' && t._daysUntil !== null && t._daysUntil <= 14) {
      badges.push('<span class="badge soon">即将开始</span>');
    } else if (st === 'finished') badges.push('<span class="badge done">已结束</span>');

    var countdown = '';
    if (st === 'live') {
      countdown = '<div class="event-countdown ongoing">第 ' + t._dayOf + ' / ' + t._dayTotal + ' 天</div>';
    } else if (st === 'upcoming' && t._daysUntil !== null && t._daysUntil <= 120) {
      countdown = '<div class="event-countdown' + (t._daysUntil <= 14 ? ' soon' : '') + '">还有 ' +
        t._daysUntil + ' 天</div>';
    } else if (st === 'finished') {
      countdown = '<div class="event-countdown">已结束</div>';
    }

    var startYear = t._startDate ? t._startDate.getFullYear() : null;
    var sameYear = t._endDate && startYear === t._endDate.getFullYear();

    var facts = [];
    facts.push('<span class="fact"><span class="fact-k">地点</span>' +
      esc(loc(t.city, t.country)) + '</span>');
    facts.push('<span class="fact"><span class="fact-k">奖金</span>' + money(t.prizeUSD) + '</span>');
    if (t.teams) facts.push('<span class="fact"><span class="fact-k">队伍</span>' + t.teams + ' 支</span>');
    facts.push('<span class="fact"><span class="fact-k">主办</span>' + esc(t.organizer || '—') + '</span>');
    if (t.winner) facts.push('<span class="fact"><span class="fact-k">冠军</span>' + esc(t.winner) + '</span>');
    if (t.runnerUp) facts.push('<span class="fact"><span class="fact-k">亚军</span>' + esc(t.runnerUp) + '</span>');

    var stages = (t.stages || []).filter(function (s) { return s && s.label; }).map(function (s) {
      var warn = /官网|官方公告/.test(s.label);
      return '<span class="stage' + (warn ? ' warn' : '') + '">' + esc(s.label) + ' · ' +
        fmtRange(s.start, s.end) + '</span>';
    }).join('');

    var progress = st === 'live'
      ? '<div class="progress live"><span style="width:' + Math.round(t._progress * 100) + '%"></span></div>'
      : '';

    /* ---- 第二数据源（5EPlay）：赛程与参赛战队 ---- */
    var fiveE = (window.Hub5E && window.Hub5E.summaryFor) ? window.Hub5E.summaryFor(t.id) : null;
    var srcBlock = '';
    if (fiveE && fiveE.ttId) {
      var d = detailState[t.id];
      var open = d && d.open;
      var hint = [];
      if (fiveE.teamCount) hint.push('参赛 ' + fiveE.teamCount + ' 队');
      if (fiveE.winTeam) hint.push('冠军 ' + fiveE.winTeam);
      srcBlock =
        '<div class="event-src">' +
          '<button type="button" class="src-toggle' + (open ? ' open' : '') + '"' +
            ' data-tt="' + esc(fiveE.ttId) + '" data-local="' + esc(t.id) + '"' +
            ' aria-expanded="' + (open ? 'true' : 'false') + '"' +
            ' aria-controls="d-' + esc(t.id) + '">' +
            (open ? '收起赛程与战队' : '展开赛程与战队') +
            '<span class="src-caret" aria-hidden="true"></span>' +
          '</button>' +
          (hint.length ? '<span class="src-hint">' + esc(hint.join(' · ')) + '</span>' : '') +
          '<a class="src-link" href="https://event.5eplay.com/csgo/events/' + esc(fiveE.ttId) + '"' +
            ' target="_blank" rel="noopener">5EPlay ↗</a>' +
        '</div>';
    }

    return '<article class="' + cls + '" id="e-' + esc(t.id) + '">' +
      '<div class="event-dates">' +
        '<div class="range">' + fmtRange(t.start, t.end) + '</div>' +
        (!sameYear && startYear ? '<div class="year">' + startYear + ' 年起</div>' : '') +
        countdown +
      '</div>' +
      '<div class="event-main">' +
        '<div class="event-title-row">' +
          '<span class="event-name">' + esc(t.nameZh || t.name) + '</span>' +
          badges.join('') +
        '</div>' +
        (t.nameZh && t.name ? '<div class="event-en">' + esc(t.name) + '</div>' : '') +
        '<div class="event-facts">' + facts.join('') + '</div>' +
        (stages ? '<div class="event-stages">' + stages + '</div>' : '') +
        (t.note ? '<p class="event-note">' + esc(t.note) + '</p>' : '') +
        progress +
        srcBlock +
      '</div>' +
      (fiveE && fiveE.ttId && detailState[t.id] && detailState[t.id].open
        ? '<div class="event-detail" id="d-' + esc(t.id) + '">' + renderDetail(t.id) + '</div>'
        : '') +
    '</article>';
  }

  /* ============================ 渲染：5EPlay 详情 ============================ */

  var detailState = {};      // localId -> { open, tab, loading, data, error }

  function renderDetail(localId) {
    var d = detailState[localId];
    if (!d) return '';
    if (d.loading) {
      return '<div class="detail-tabs"><span class="detail-loading">正在从 5EPlay 加载…</span></div>' +
        '<div class="skeleton" style="height:44px"></div>' +
        '<div class="skeleton" style="height:44px"></div>';
    }
    if (d.error || !d.data) {
      return '<div class="detail-tabs"><span class="detail-loading">' +
        '5EPlay 数据暂时取不到（接口未公开授权，可能被限流或调整）。赛历部分不受影响。</span></div>';
    }

    var data = d.data;
    var matches = data.matches || [];
    var teams = data.teams || [];
    var ranks = data.ranks || [];
    var tab = d.tab || (matches.length ? 'matches' : (teams.length ? 'teams' : 'ranks'));

    var tabs = [];
    tabs.push(tabBtn(localId, 'matches', '赛程', matches.length));
    tabs.push(tabBtn(localId, 'teams', '参赛战队', teams.length));
    tabs.push(tabBtn(localId, 'ranks',
      data.ranksAreProjected ? '奖金分配' : '名次与奖金', ranks.length));

    var basic = data.basic;
    var head = '';
    if (basic && (basic.nameZh || basic.nameEn)) {
      var bits = [];
      if (basic.nameZh) bits.push('官方中文名：<b>' + esc(basic.nameZh) + '</b>');
      if (basic.nameEn) bits.push('英文名：' + esc(basic.nameEn));
      if (basic.bonus) bits.push('奖池：' + esc(basic.bonus));
      if (basic.city) bits.push('地点：' + esc(basic.city));
      head = '<div class="detail-head">' + bits.join(' <span class="dotsep">·</span> ') + '</div>';
    }

    var body;
    if (tab === 'teams') body = renderTeamGrid(teams);
    else if (tab === 'ranks') body = renderRanks(ranks, data.ranksAreProjected);
    else body = renderFiveEMatches(matches);

    return '<div class="detail-tabs">' + tabs.join('') + '</div>' + head + body;
  }

  function tabBtn(localId, key, label, n) {
    var d = detailState[localId];
    var active = (d.tab || '') === key;
    return '<button type="button" class="detail-tab' + (active ? ' active' : '') + '"' +
      ' data-tab="' + key + '" data-local="' + esc(localId) + '">' +
      label + (n ? '<span class="tab-n">' + n + '</span>' : '') + '</button>';
  }

  function renderFiveEMatches(matches) {
    if (!matches.length) {
      return '<div class="detail-empty">该赛事在 5EPlay 上还没有可展示的对阵（可能尚未开赛或为预选阶段）。</div>';
    }
    return '<div class="mlist">' + matches.map(matchLine).join('') + '</div>';
  }

  function matchLine(m) {
    var t = m.startTs ? new Date(m.startTs) : null;
    var timeText = t ? (pad(t.getMonth() + 1) + '-' + pad(t.getDate())) : '—';
    var subText = t ? (pad(t.getHours()) + ':' + pad(t.getMinutes()) + ' ' + WEEKDAYS[t.getDay()]) : '';

    var known = m.score1 !== null && m.score2 !== null;
    var win1 = known && m.score1 > m.score2;
    var win2 = known && m.score2 > m.score1;

    var cls = m.state === 'live' ? 'live' : (m.state === 'finished' ? 'done' : 'next');
    var txt = m.state === 'live' ? '进行中' : (m.state === 'finished' ? '已结束' : '未开始');

    var maps = (m.maps || []).map(function (x) {
      var c = 'mapchip';
      if (x.s1 !== null && x.s2 !== null && x.s1 !== x.s2) c += (x.s1 > x.s2 ? ' win1' : ' win2');
      var sc = (x.s1 !== null && x.s2 !== null) ? ' ' + x.s1 + ':' + x.s2 : '';
      return '<span class="' + c + '">' + esc(x.name) + sc + '</span>';
    }).join('');

    function team(name, logo, score, win, lose) {
      return '<div class="ml-team' + (win ? ' win' : (lose ? ' lose' : '')) + '">' +
        (logo ? '<img class="ml-logo" src="' + esc(logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
              : '<span class="ml-logo ml-logo-empty"></span>') +
        '<span class="ml-name">' + esc(name || '待定') + '</span>' +
        (known ? '<span class="ml-score">' + score + '</span>' : '') +
      '</div>';
    }

    return '<div class="mline">' +
      '<div class="ml-time"><b class="tnum">' + timeText + '</b><span>' + subText + '</span></div>' +
      '<div class="ml-body">' +
        '<div class="ml-round">' + esc([m.stage, m.round].filter(Boolean).join(' · ') || '对局') +
          (m.bo ? '<span class="ml-bo">' + esc(m.bo) + '</span>' : '') +
          (m.tags ? '<span class="ml-tag">' + esc(m.tags) + '</span>' : '') +
        '</div>' +
        team(m.team1, m.logo1, m.score1, win1, known && !win1) +
        team(m.team2, m.logo2, m.score2, win2, known && !win2) +
        (maps ? '<div class="match-maps">' + maps + '</div>' : '') +
      '</div>' +
      '<div class="ml-state"><span class="mstate ' + cls + '">' + txt + '</span></div>' +
    '</div>';
  }

  function renderTeamGrid(teams) {
    if (!teams.length) {
      return '<div class="detail-empty">5EPlay 尚未公布参赛战队名单（通常在开赛前陆续放出）。</div>';
    }
    return '<div class="tgrid">' + teams.map(function (t) {
      return '<div class="tcard" title="' + esc(t.name + (t.rank ? ' · 世界排名 #' + t.rank : '')) + '">' +
        (t.logo ? '<img src="' + esc(t.logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
                : '<span class="tlogo-empty"></span>') +
        '<span class="tname">' + esc(t.name) + '</span>' +
        (t.rank ? '<span class="trank">#' + esc(t.rank) + '</span>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function renderRanks(ranks, projected) {
    if (!ranks.length) {
      return '<div class="detail-empty">该赛事还没有名次与奖金数据。</div>';
    }
    var head = projected
      ? '<div class="detail-note">该赛事尚未结束，下面是<b>奖池分配方案</b>（名次待定）。</div>'
      : '';
    return head + '<div class="rlist">' + ranks.map(function (r) {
      var name = /^tbd$/i.test(String(r.name).trim()) ? '待定' : r.name;
      return '<div class="rline">' +
        '<span class="rrank">' + esc(r.rank) + '</span>' +
        (r.logo ? '<img class="ml-logo" src="' + esc(r.logo) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '') +
        '<span class="rname' + (/待定/.test(name) ? ' tbd' : '') + '">' + esc(name) + '</span>' +
        '<span class="rbonus">' + esc(r.bonus || '—') + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  /* ---- 交互：展开 / 切页 ---- */

  function toggleDetail(localId, ttId) {
    var d = detailState[localId];
    if (d && d.open) {
      d.open = false;
      render();
      return;
    }
    detailState[localId] = { open: true, tab: 'matches', loading: true, data: null, error: null };
    render();
    if (!window.Hub5E) {
      detailState[localId] = { open: true, loading: false, error: 'no-source' };
      render();
      return;
    }
    window.Hub5E.load(ttId).then(function (res) {
      var st = detailState[localId];
      if (!st || !st.open) return;
      st.loading = false;
      if (res && res.ok) { st.data = res; st.error = null; }
      else { st.error = (res && res.error) || 'failed'; }
      render();
    });
  }

  function switchTab(localId, tab) {
    var d = detailState[localId];
    if (!d) return;
    d.tab = tab;
    render();
  }

  /* ============================ 渲染入口 ============================ */

  function render() {
    if (!state.data) return;
    var today = startOfDay(new Date());
    var rows = decorate(state.data.tournaments, today);
    renderStatusBar();
    renderYearNav(rows, today);
    renderMetrics(rows, today);
    renderMatches();
    renderList(rows);
    syncControls();
  }

  function syncControls() {
    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-range') === state.rangeKey));
    });
    var cr = el('customRange');
    if (cr) cr.style.display = state.rangeKey === 'custom' ? 'flex' : 'none';
  }

  /* ============================ 数据获取 ============================ */

  function fetchJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = ac ? setTimeout(function () { ac.abort(); }, timeoutMs || 9000) : null;
      fetch(url, { cache: 'no-store', signal: ac ? ac.signal : undefined })
        .then(function (r) {
          if (timer) clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(resolve)
        .catch(function (e) { if (timer) clearTimeout(timer); reject(e); });
    });
  }

  function mergeAvail(snapshot, live) {
    var base = (snapshot && snapshot.tournaments) ? snapshot.tournaments.slice() : [];
    if (!live || !live.tournaments || !live.tournaments.length) {
      return {
        tournaments: base,
        playerBreaks: (snapshot && snapshot.playerBreaks) || [],
        cancelled: (snapshot && snapshot.cancelled) || []
      };
    }
    var byId = {};
    base.forEach(function (t) { byId[t.id] = t; });
    var merged = live.tournaments.map(function (lt) {
      var b = byId[lt.id] || {};
      return Object.assign({}, b, {
        id: lt.id || b.id,
        name: lt.name || b.name,
        nameZh: lt.nameZh || b.nameZh,
        organizer: lt.organizer || b.organizer,
        tier: lt.tier || b.tier,
        start: lt.start || b.start,
        end: lt.end || b.end,
        stages: (lt.stages && lt.stages.length) ? lt.stages : (b.stages || [])
      });
    });
    var liveIds = {};
    merged.forEach(function (t) { liveIds[t.id] = 1; });
    base.forEach(function (t) { if (!liveIds[t.id]) merged.push(t); });
    return {
      tournaments: merged,
      playerBreaks: (live.playerBreaks && live.playerBreaks.length)
        ? live.playerBreaks : ((snapshot && snapshot.playerBreaks) || []),
      cancelled: (snapshot && snapshot.cancelled) || []
    };
  }

  function refreshLive(force) {
    if (state.refreshing) return Promise.resolve();
    state.refreshing = true;
    return fetchJSON(LIVE_URL + (force ? '?force=1' : ''), 12000)
      .then(function (j) {
        if (j && j.tournaments && j.tournaments.length) {
          state.data = mergeAvail(state.snapshotRaw, j);
          state.source = 'live';
          state.fetchedAt = Date.now();
        }
        render();
      })
      .catch(function () {
        state.source = state.snapshotRaw ? 'snapshot' : state.source;
        render();
      })
      .then(function () { state.refreshing = false; });
  }

  function loadMatches(force) {
    var today = startOfDay(new Date());
    var r = resolveRange(state.rangeKey, today);
    var from = r[0] || today, to = r[1] || today;
    var key = isoDay(from) + '|' + isoDay(to);

    if (!force && key === state.matchesRangeKey && state.matchesState !== 'idle') {
      renderMatches();
      return Promise.resolve();
    }
    if (daysBetween(from, to) + 1 > MATCH_LOOKAHEAD_DAYS) {
      state.matchesState = 'idle';
      state.matches = null;
      renderMatches();
      return Promise.resolve();
    }

    state.matchesRangeKey = key;
    state.matchesState = 'loading';
    renderMatches();

    return fetchJSON(MATCHES_URL + '?from=' + isoDay(from) + '&to=' + isoDay(to) + (force ? '&force=1' : ''), 20000)
      .then(function (j) {
        if (j && j.ok) {
          state.matches = j.matches || [];
          state.matchesNote = j.note || '';
          state.matchesState = state.matches.length ? 'ok' : 'empty';
        } else {
          state.matchesState = 'empty';
          state.matchesNote = (j && j.hint) || '';
        }
      })
      .catch(function () {
        state.matchesState = 'unavailable';
        state.matches = null;
      })
      .then(renderMatches);
  }

  /* ============================ 交互 ============================ */

  function setRange(key) {
    state.rangeKey = key;
    var today = startOfDay(new Date());
    var r = resolveRange(key, today);
    state.rangeFrom = r[0];
    state.rangeTo = r[1];
    if (key === 'custom') {
      var fi = el('rangeFrom'), ti = el('rangeTo');
      if (fi && !fi.value) fi.value = isoDay(today);
      if (ti && !ti.value) ti.value = isoDay(addDays(today, 14));
      state.rangeFrom = fi && fi.value ? parseDay(fi.value) : today;
      state.rangeTo = ti && ti.value ? parseDay(ti.value) : addDays(today, 14);
      if (state.rangeFrom > state.rangeTo) {
        var tmp = state.rangeFrom; state.rangeFrom = state.rangeTo; state.rangeTo = tmp;
      }
    }
    render();
    loadMatches(false);
  }

  function scrollToEvent(id) {
    var node = document.getElementById('e-' + id);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(function () { node.classList.remove('flash'); }, 1400);
  }

  function handleAction(action) {
    if (action === 'reset-filters') {
      state.scope = 'all';
      state.organizer = 'all';
      state.rangeKey = 'all';
      state.rangeFrom = null;
      state.rangeTo = null;
      setRange('all');
      return;
    }
    if (action === 'range-today') return setRange('today');
    if (action === 'range-next7') return setRange('next7');
    if (action === 'range-next30') return setRange('next30');
    if (action === 'focus-list') {
      var t = el('list');
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'open-calendar') {
      try { window.open('calendar.html', '_blank', 'noopener'); } catch (e) { /* 忽略 */ }
      return;
    }
  }

  function wire() {
    document.querySelectorAll('[data-scope]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.scope = b.getAttribute('data-scope');
        document.querySelectorAll('[data-scope]').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
        render();
      });
    });

    document.querySelectorAll('[data-org]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.organizer = b.getAttribute('data-org');
        document.querySelectorAll('[data-org]').forEach(function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
        render();
      });
    });

    document.querySelectorAll('[data-range]').forEach(function (b) {
      b.addEventListener('click', function () { setRange(b.getAttribute('data-range')); });
    });

    ['rangeFrom', 'rangeTo'].forEach(function (id) {
      var n = el(id);
      if (n) n.addEventListener('change', function () { setRange('custom'); });
    });

    var rf = el('refreshNow');
    if (rf) rf.addEventListener('click', function () {
      state.tick = REFRESH_SEC;
      state.matchesRangeKey = '';
      refreshLive(true).then(function () { return loadMatches(true); });
    });

    var exp = el('exportIcs');
    if (exp) exp.addEventListener('click', exportICS);

    // 事件委托：年度导航跳转 + 5EPlay 展开/切页 + 空态按钮
    document.addEventListener('click', function (ev) {
      var cl = ev.target.closest ? ev.target.closest.bind(ev.target) : null;
      if (!cl) return;

      var toggle = cl('[data-tt]');
      if (toggle) {
        toggleDetail(toggle.getAttribute('data-local'), toggle.getAttribute('data-tt'));
        return;
      }

      var tab = cl('[data-tab]');
      if (tab) {
        switchTab(tab.getAttribute('data-local'), tab.getAttribute('data-tab'));
        return;
      }

      var target = cl('[data-goto]');
      if (target) {
        var id = target.getAttribute('data-goto');
        var t = null;
        if (state.data) t = state.data.tournaments.filter(function (x) { return x.id === id; })[0];
        if (t) {
          var today = startOfDay(new Date());
          var d = decorate([t], today)[0];
          if (!matchesFilters(d) || !overlaps(d, state.rangeFrom, state.rangeTo)) {
            state.scope = 'all'; state.organizer = 'all';
            state.rangeKey = 'all'; state.rangeFrom = null; state.rangeTo = null;
            render();
          }
        }
        setTimeout(function () { scrollToEvent(id); }, 60);
        return;
      }

      var act = cl('[data-action]');
      if (act) handleAction(act.getAttribute('data-action'));
    });

    var scale = el('yearnavScale');
    if (scale) scale.addEventListener('click', function (ev) {
      var sp = ev.target.closest ? ev.target.closest('[data-month]') : null;
      if (!sp) return;
      var m = parseInt(sp.getAttribute('data-month'), 10);
      var today = startOfDay(new Date());
      state.rangeKey = 'custom';
      state.rangeFrom = new Date(today.getFullYear(), m - 1, 1);
      state.rangeTo = new Date(today.getFullYear(), m, 0);
      var fi = el('rangeFrom'), ti = el('rangeTo');
      if (fi) fi.value = isoDay(state.rangeFrom);
      if (ti) ti.value = isoDay(state.rangeTo);
      render();
      loadMatches(false);
      setTimeout(function () {
        var node = document.getElementById('m-' + today.getFullYear() + '-' + pad(m));
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    });
  }

  /* ============================ .ics 导出 ============================ */

  function icsDate(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }

  function buildICS(rows) {
    var up = rows.filter(function (t) { return t._status !== 'finished'; });
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CS2 Events Hub//ZH//',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:CS2 2026 赛事赛历',
      'X-WR-TIMEZONE:Asia/Shanghai'
    ];
    up.forEach(function (t) {
      var s = parseDay(t.start), e = parseDay(t.end) || s;
      var endEx = addDays(e, 1);
      var summary = (t.nameZh || t.name) + (t.tier === 'Major' ? ' [Major]' : '');
      var desc = [t.name,
        t.city ? '地点：' + loc(t.city, t.country, ' ') : '',
        t.prizeUSD ? '奖金：$' + t.prizeUSD.toLocaleString('en-US') : '',
        t.note || ''].filter(Boolean).join('\\n');
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + t.id + '@cs2-events-hub');
      lines.push('DTSTAMP:' + new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''));
      lines.push('DTSTART;VALUE=DATE:' + icsDate(s));
      lines.push('DTEND;VALUE=DATE:' + icsDate(endEx));
      lines.push('SUMMARY:' + summary.replace(/[,;]/g, '\\$&'));
      if (desc) lines.push('DESCRIPTION:' + desc.replace(/[,;]/g, '\\$&'));
      if (t.city || t.country) {
        lines.push('LOCATION:' + loc(t.city, t.country, ', ').replace(/[,;]/g, '\\$&'));
      }
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function exportICS() {
    var today = startOfDay(new Date());
    var rows = decorate(state.data.tournaments, today).filter(function (r) {
      return matchesFilters(r) && overlaps(r, state.rangeFrom, state.rangeTo);
    });
    var blob = new Blob([buildICS(rows)], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'cs2-2026-calendar.ics';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ============================ 时钟 ============================ */

  function startClock() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(function () {
      state.tick -= 1;
      if (state.tick <= 0) {
        state.tick = REFRESH_SEC;
        refreshLive(false);
      }
      var cd = el('countdown');
      if (cd) cd.textContent = state.tick + 's';
      if (state.tick % 60 === 0) render();
    }, 1000);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        state.tick = REFRESH_SEC;
        refreshLive(false);
      }
    });
  }

  /* ============================ 启动 ============================ */

  function init() {
    wire();
    el('list').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';

    // 先取第二数据源的映射表（本地文件，不消耗外部请求），拿到后再渲染
    var mapReady = (window.Hub5E && window.Hub5E.getMap)
      ? window.Hub5E.getMap().catch(function () { return {}; })
      : Promise.resolve({});

    Promise.all([fetchJSON(SNAPSHOT_URL), mapReady])
      .then(function (r) {
        var j = r[0];
        state.snapshotRaw = j;
        state.data = mergeAvail(j, null);
        state.source = 'snapshot';
        state.fetchedAt = Date.now();
        setRange('all');
        render();
        return refreshLive(false);
      })
      .then(function () { return loadMatches(false); })
      .catch(function () {
        el('list').innerHTML = stateBlock(
          '无法加载赛程数据',
          '请通过 <code>node server.js</code> 启动本地服务，或确认 <code>data/tournaments.json</code> 存在。',
          []
        );
      })
      .then(startClock);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
