/* ============================================================
   山东地名志 — 交互逻辑
   依赖：echarts.min.js / sd-geo.js / toponymy.js
   ============================================================ */
(function () {
  'use strict';

  var SERIF = '"Source Han Serif SC","Noto Serif SC","Songti SC",SimSun,serif';
  var SANS = '"PingFang SC","Microsoft YaHei",sans-serif';

  var TYPES = window.TYPES;
  var TB = {};
  TYPES.forEach(function (t) { TB[t.key] = t; });

  var CITY_FEATS = window.SD_CITY.features;
  var COUNTY_FEATS = window.SD_COUNTY.features;
  var CITY_INFO = window.CITIES;

  /* ============================================================
     地图活动范围锁定
     ------------------------------------------------------------
     ECharts 的 roam 只给缩放配了 scaleLimit，平移完全没有边界：
     朝一个方向死拖，整幅地图就被推出画框，只剩一片空白。

     坐标系内部有两层变换：
       _rawTransformable  —— 投影（经纬度 → 原始坐标），静态
       _roamTransformable —— 漫游（拖动改 x/y，滚轮改 scaleX/originX）
     最终矩阵 cs.transform = roam ∘ raw，拖动的净效果全部记在 roam.x / roam.y 上。
     所以边界只需要夹 roam.x / roam.y，再让 ECharts 重算矩阵即可：
     一次算准，不迭代逼近，不会自激抖动。
     ============================================================ */
  function bindRoamLimit(chart, o) {
    /* COVER：地图至少要盖住画框的这个比例（0~1）。
       取 0.7 表示地图可以拖到只剩 70% 覆盖画框，再拖就顶住不动；
       既能自由挪动，又不可能把地图整块拖出画框。 */
    var COVER = o.cover == null ? 0.7 : o.cover;
    var OVER = 1 - COVER;

    /* 取当前地图坐标系（series 或 geo） */
    function sys() {
      var m = chart.getModel();
      if (!m) return null;
      var g = o.geo ? m.getComponent('geo', o.geoIndex || 0)
                    : m.getSeriesByIndex(o.seriesIndex || 0);
      var cs = g && g.coordinateSystem;
      return cs && cs._rect && cs.transform && cs._roamTransformable ? cs : null;
    }

    /* cs._rect 在当前变换下落在画布的哪里 */
    function boxOf(cs) {
      var M = cs.transform, r = cs._rect;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var i = 0; i < 4; i++) {
        var px = r.x + (i & 1 ? r.width : 0);
        var py = r.y + (i & 2 ? r.height : 0);
        var sx = M[0] * px + M[2] * py + M[4];
        var sy = M[1] * px + M[3] * py + M[5];
        if (sx < x0) x0 = sx;
        if (sx > x1) x1 = sx;
        if (sy < y0) y0 = sy;
        if (sy > y1) y1 = sy;
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* 一维上的合法位移：给定「地图这一维的起止位置 pos / len」，
       返回还需要挪多少像素才能回到允许范围内。0 表示已经合法。 */
    function shiftX(pos, len, H) {
      var lo, hi;
      if (len <= H) {                      /* 地图比画框窄：最多贴住画框边 */
        lo = 0;
        hi = H - len;
      } else {                             /* 比画框宽：至少盖住 COVER 比例 */
        lo = H * COVER - len;
        hi = H * OVER;
      }
      return Math.min(hi, Math.max(lo, pos)) - pos;
    }

    function clamp() {
      var cs = sys();
      if (!cs) return;
      var H = chart.getWidth(), Vh = chart.getHeight();
      if (!H || !Vh) return;
      var ro = cs._roamTransformable;
      if (!(ro.scaleX > 0)) return;

      /* 缩放上下限交给 option 里的 scaleLimit —— ECharts 的 roamController
         在 sT() 里已经夹过了，这里再插手反而会破坏滚轮缩放的锚点。
         本函数只管平移。 */

      var b = boxOf(cs);
      var dx = shiftX(b.x, b.w, H);
      var dy = shiftX(b.y, b.h, Vh);
      if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return;

      if (o.geo) {
        /* geo 组件只有 render，没有 updateTransform。
           geoRoam 走 updateTransform 阶段，只改坐标系矩阵，底图那块 group
           不会重排（表现为点位在、底图消失）；setOption 只改 model 再走 render，
           又会在 updateTransform 阶段被坐标系矩阵覆盖回去，两头都不收敛。
           所以分两步：先把坐标系矩阵按官方 geoRoam 的算法摆正并重算矩阵，
           再让组件 render 一次排底图、让系列 updateTransform 一次排点位。 */
        var M = cs._roamTransformable;
        M.x += dx;
        M.y += dy;
        cs._updateTransform();

        var ecModel = chart.getModel();
        var model = ecModel.getComponent('geo', o.geoIndex || 0);
        var api = chart._api || {
          getWidth: function () { return chart.getWidth(); },
          getHeight: function () { return chart.getHeight(); }
        };
        var view = chart.getViewOfComponentModel(model);
        if (view && view.render) view.render(model, ecModel, api);

        /* 系列（点位 scatter）自己记着旧坐标，必须再走一次 updateTransform */
        chart.getZr().refreshImmediately();
        ecModel.eachSeries(function (s) {
          var sv = chart.getViewOfSeriesModel(s);
          if (sv && sv.updateTransform) sv.updateTransform(s, ecModel, api);
        });
        chart.getZr().refreshImmediately();
      } else {
        /* series.map 走 action 就够了，底图会跟着动 */
        chart.dispatchAction({
          type: 'geoRoam',
          componentType: 'series',
          seriesIndex: o.seriesIndex || 0,
          dx: dx, dy: dy,
          animation: { duration: 0 }
        });
      }
    }

    /* 拖动是连续的 mousemove，合并到下一帧统一校正一次 */
    var pending = false, busy = false;
    function schedule() {
      if (busy || pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        busy = true;
        try { clamp(); } finally { busy = false; }
      });
    }

    chart.on('georoam', schedule);
    /* 切层级 / 换类型 / resize 之后也校一次 */
    schedule.remeasure = schedule;
    return schedule;
  }

  /* ---------- 记录表 ---------- */
  var REC = {};
  var CITY_COUNT = {};
  var META = window.COUNTY_META || {};
  COUNTY_FEATS.forEach(function (f) {
    var p = f.properties;
    var info = window.COUNTIES[p.name] || ['renwen', ''];
    REC[p.name] = {
      name: p.name, base: p.base, city: p.city, cityCode: p.cityCode,
      type: info[0], origin: info[1], color: TB[info[0]].color,
      meta: META[p.name] || null
    };
    CITY_COUNT[p.city] = (CITY_COUNT[p.city] || 0) + 1;
  });

  /* 同源词根 / 共用字组的反查索引，只保留成组的（≥2 个） */
  var FAMILY = {}, CHARGRP = {};
  Object.keys(META).forEach(function (k) {
    if (!REC[k]) return;
    var m = META[k];
    if (m.f) (FAMILY[m.f] = FAMILY[m.f] || []).push(k);
    if (m.c) (CHARGRP[m.c] = CHARGRP[m.c] || []).push(k);
  });

  /* 各类型统计 */
  var STAT = TYPES.map(function (t) { return { key: t.key, name: t.name, color: t.color, n: 0 }; });
  var STAT_MAP = {};
  STAT.forEach(function (s) { STAT_MAP[s.key] = s; });
  Object.keys(REC).forEach(function (k) { STAT_MAP[REC[k].type].n++; });
  var TOTAL = Object.keys(REC).length;
  STAT.forEach(function (s) { s.pct = Math.round(s.n / TOTAL * 1000) / 10; });

  /* 侧栏“占比最高的三类” */
  (function () {
    var ol = document.getElementById('sideRank');
    if (!ol) return;
    STAT.slice().sort(function (a, b) { return b.n - a.n; }).slice(0, 3).forEach(function (s, i) {
      var li = document.createElement('li');
      li.innerHTML = '<span class="rk">' + (i + 1) + '</span>' +
        '<span class="rn" style="color:' + s.color + '">' + s.name + '</span>' +
        '<b>' + s.n + '</b><em>' + s.pct + '%</em>';
      ol.appendChild(li);
    });
  })();

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function shortCity(n) { return n.replace(/市$/, ''); }
  function shortCounty(n) { return n.replace(/（.*）$/, ''); }

  /* ============================================================
     书法字接口
     data-calli 元素会自动尝试换成 AI 生成的字图；
     未登记、加载失败时保持原有文字排版，不做任何降级处理。
     ============================================================ */
  function applyCalli(root) {
    var C = window.CALLI;
    if (!C || !C.items) return;
    var base = C.base || 'assets/calli/';
    var ext = C.ext || 'webp';
    var nodes = (root || document).querySelectorAll('[data-calli]');
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.getAttribute('data-calli-state')) return;
      var text = (el.textContent || '').trim();
      var f = C.items[text];
      if (!f) { el.setAttribute('data-calli-state', 'none'); return; }
      var token = el.getAttribute('data-calli-token') || '0';
      var img = new Image();
      img.alt = text;
      img.className = 'calli-img';
      img.onload = function () {
        if ((el.getAttribute('data-calli-token') || '0') !== token) return;
        el.textContent = '';
        el.appendChild(img);
        el.setAttribute('data-calli-state', 'ok');
      };
      img.onerror = function () {
        if ((el.getAttribute('data-calli-token') || '0') !== token) return;
        el.setAttribute('data-calli-state', 'fail');
      };
      img.src = base + f + '.' + ext;
    });
  }

  /* 动态文字（详情卡标题）：每次都重试一遍 */
  function setCalliText(el, text) {
    if (!el) return;
    el.setAttribute('data-calli-token', String(Number(el.getAttribute('data-calli-token') || 0) + 1));
    el.removeAttribute('data-calli-state');
    el.textContent = text;
    applyCalli(el.parentNode || document);
  }

  /* 首屏静态元素（站点标题、章节标题）先跑一遍——之前漏了这一步，
     导致只有美名卡/详情卡这类主动调用 applyCalli 的地方才生效 */
  applyCalli(document);

  /* ---------- 书法字预热 ----------
     图片按需加载会有半秒空白。这里在空闲时把「最可能被点到的」先塞进缓存：
     页面稳定后预热 16 个设区市；点开某个市时预热该市全部县区。
     只走浏览器缓存，不插入 DOM。 */
  var WARMED = {};
  function warmCalli(names) {
    var C = window.CALLI;
    if (!C || !C.items) return;
    names.forEach(function (n) {
      var f = C.items[n];
      if (!f || WARMED[f]) return;
      WARMED[f] = 1;
      var img = new Image();
      img.decoding = 'async';
      img.src = C.base + f + '.' + C.ext;
    });
  }

  function warmCities() {
    warmCalli(Object.keys(window.CITIES || {}).map(function (n) { return n.replace(/市$/, ''); }));
  }

  function warmCityCounties(cityCode) {
    var code = String(cityCode);
    warmCalli(COUNTY_FEATS.filter(function (f) {
      return String(f.properties.cityCode) === code;
    }).map(function (f) { return shortCounty(f.properties.name); }));
  }

  /* 地图在容器里的填充比例：窄屏用小值，避免威海、菏泽被裁掉 */
  function fitSize(cityLevel) {
    var w = document.getElementById('map1').clientWidth || 700;
    if (cityLevel) return w < 520 ? '96%' : '99%';
    return w < 640 ? '104%' : '118%';
  }

  /* ============================================================
     01 主地图：省市 → 县级 下钻
     ============================================================ */
  var map1 = echarts.init(document.getElementById('map1'), null, { renderer: 'canvas' });
  var registered = {};

  echarts.registerMap('sd-city', window.SD_CITY);
  registered['sd-city'] = true;

  var current = { level: 'province', city: null, cityCode: null, selected: null };

  /* 在 click 事件里直接 setOption 会让画布被清空且不再重绘，
     统一放到下一帧并强制一次 resize 重排，规避该重入问题。 */
  var rafId = 0;
  var kickMap1 = null;   /* bindRoamLimit 注册的校正器，setOption 之后叫一次 */
  function renderMap(opt) {
    var my = ++rafId;
    requestAnimationFrame(function () {
      if (my !== rafId) return;
      map1.setOption(opt, true);
      map1.resize();
      if (kickMap1) kickMap1();
    });
  }

  var elBack = document.getElementById('btnBack');
  var elCrumb = document.getElementById('crumbNow');
  var elCount = document.getElementById('crumbCount');
  var elHint = document.getElementById('mapHint');
  var elEmpty = document.getElementById('sideEmpty');
  var elDetail = document.getElementById('sideDetail');
  var elBadge = document.getElementById('dBadge');
  var elCity = document.getElementById('dCity');
  var elName = document.getElementById('dName');
  var elText = document.getElementById('dText');
  var elFoot = document.getElementById('dFoot');
  var elStrip = document.getElementById('countyStrip');

  elStrip.addEventListener('click', function (e) {
    var b = e.target.closest('.strip-chip');
    if (b) pickCounty(b.dataset.n);
  });

  function tooltipBase() {
    return {
      trigger: 'item',
      confine: true,
      backgroundColor: 'rgba(255,253,247,.97)',
      borderColor: '#e2d8c4',
      borderWidth: 1,
      padding: [10, 13],
      /* ECharts 默认 white-space:nowrap，会让内层的 max-width 失效、文字顶出气泡，这里显式放开 */
      extraCssText: 'box-shadow:0 10px 26px -14px rgba(60,45,25,.55);border-radius:3px;white-space:normal;max-width:266px;',
      textStyle: { color: '#211d18', fontSize: 12.5, fontFamily: SANS }
    };
  }

  function provinceOption() {
    return {
      animationDuration: 520,
      animationEasing: 'cubicOut',
      tooltip: Object.assign(tooltipBase(), {
        formatter: function (p) {
          var c = CITY_INFO[p.name] || {};
          var n = CITY_COUNT[p.name] || 0;
          return '<div style="font-family:' + SERIF + ';font-weight:700;font-size:15px;letter-spacing:.04em;margin-bottom:3px">' + shortCity(p.name) + '</div>' +
            '<div style="color:#a8322a;font-size:11.5px;letter-spacing:.1em;margin-bottom:6px">' + (c.tag || '') + '</div>' +
            '<div style="color:#6f6759;font-size:11.5px">辖 ' + n + ' 个县级政区 · 点击展开</div>';
        }
      }),
      series: [{
        type: 'map',
        map: 'sd-city',
        roam: true,
        zoom: 1,
        layoutCenter: ['50%', '50%'],
        layoutSize: fitSize(false),
        scaleLimit: { min: 1, max: 3.2 },
        selectedMode: false,
        itemStyle: {
          areaColor: '#e7dcc3',
          borderColor: '#fbf8f0',
          borderWidth: 1.6,
          shadowBlur: 18,
          shadowColor: 'rgba(80,60,30,.12)',
          shadowOffsetY: 7
        },
        label: {
          show: true,
          color: '#4a443a',
          fontFamily: SERIF,
          fontSize: 12.5,
          formatter: function (p) { return shortCity(p.name); }
        },
        emphasis: {
          label: { color: '#fff', fontSize: 13.5, fontWeight: 700 },
          itemStyle: { areaColor: '#a8322a', borderColor: '#fff' }
        },
        data: CITY_FEATS.map(function (f) {
          return { name: f.properties.name, value: CITY_COUNT[f.properties.name] || 0 };
        })
      }]
    };
  }

  function countyOption(cityCode, selected) {
    var code = String(cityCode);
    var feats = COUNTY_FEATS.filter(function (f) { return String(f.properties.cityCode) === code; });
    var key = 'city-' + code;
    if (!registered[key]) {
      echarts.registerMap(key, { type: 'FeatureCollection', features: feats });
      registered[key] = true;
    }
    /* 中心城区的区面积极小，标注必然互相压字：
       低于本市中位面积 33% 的区不再画标签，靠下辖快捷条与 tooltip 兜底 */
    var areas = feats.map(function (f) { return f.properties.area || 0; })
      .sort(function (a, b) { return a - b; });
    var med = areas[Math.floor(areas.length / 2)] || 0;
    var thr = med * 0.33;
    return {
      animationDuration: 480,
      animationEasing: 'cubicOut',
      tooltip: Object.assign(tooltipBase(), {
        formatter: function (p) {
          var r = REC[p.name];
          if (!r) return p.name;
          return '<div style="font-family:' + SERIF + ';font-weight:700;font-size:15px;letter-spacing:.04em;margin-bottom:3px">' + r.base + '</div>' +
            '<div style="color:' + r.color + ';font-size:11.5px;letter-spacing:.1em;margin-bottom:6px">' + TB[r.type].name + '</div>' +
            '<div style="color:#6f6759;font-size:11.5px;max-width:230px;line-height:1.7">' + r.origin.slice(0, 46) + '…</div>';
        }
      }),
      series: [{
        type: 'map',
        map: key,
        roam: true,
        zoom: 1,
        layoutCenter: ['50%', '50%'],
        layoutSize: fitSize(true),
        scaleLimit: { min: 0.9, max: 4 },
        selectedMode: false,
        itemStyle: {
          borderColor: '#fbf8f0',
          borderWidth: 1.4,
          shadowBlur: 12,
          shadowColor: 'rgba(80,60,30,.10)',
          shadowOffsetY: 4
        },
        label: {
          show: true,
          color: '#2a241c',
          fontFamily: SERIF,
          fontSize: 11,
          textBorderColor: 'rgba(255,255,255,.92)',
          textBorderWidth: 2.6,
          formatter: function (p) { return shortCounty(p.name); }
        },
        labelLayout: { hideOverlap: true },
        emphasis: {
          label: { fontSize: 12.5, fontWeight: 700, color: '#211d18' },
          itemStyle: { borderColor: '#211d18', borderWidth: 2 }
        },
        data: feats.map(function (f) {
          var r = REC[f.properties.name];
          var isSel = selected === f.properties.name;
          var tiny = (f.properties.area || 0) < thr;
          return {
            name: f.properties.name,
            value: 1,
            label: { show: isSel || !tiny },
            itemStyle: {
              areaColor: rgba(r.color, isSel ? 1 : 0.8),
              borderColor: isSel ? '#a8322a' : '#fbf8f0',
              borderWidth: isSel ? 2.6 : 1.4
            }
          };
        })
      }]
    };
  }

  function showCityInfo(name) {
    var c = CITY_INFO[name] || {};
    elEmpty.hidden = true;
    elDetail.hidden = false;
    elBadge.textContent = '设区市';
    elBadge.style.background = '#2f4f5f';
    elCity.textContent = '山东省 · ' + shortCity(name);
    setCalliText(elName, shortCity(name));
    elText.textContent = c.note || '';
    elFoot.innerHTML = '<b>辖 ' + (CITY_COUNT[name] || 0) + ' 个县级政区</b> · 点击地图中的县区，看各自的由来';
    elDetail.style.animation = 'none';
    void elDetail.offsetWidth;
    elDetail.style.animation = '';
  }

  /* 同族 / 同字的可点击小标签 */
  function sibHTML(label, list, cur) {
    if (!list || list.length < 2) return '';
    var others = list.filter(function (n) { return n !== cur; });
    if (!others.length) return '';
    var show = others.slice(0, 6);
    var rest = others.length - show.length;
    return '<div class="d-sib"><b>' + label + '</b>' +
      show.map(function (n) {
        return '<button type="button" class="d-sib-a" data-n="' + n + '">' + shortCounty(n) + '</button>';
      }).join('') +
      (rest > 0 ? '<span class="d-sib-more">+' + rest + '</span>' : '') +
      '</div>';
  }

  var elFootBound = false;
  function bindFoot() {
    if (elFootBound || !elFoot) return;
    elFootBound = true;
    elFoot.addEventListener('click', function (e) {
      var a = e.target.closest('.d-sib-a');
      if (a && window.__focusCounty) { window.__focusCounty(a.dataset.n); return; }
      var t = e.target.closest('.d-src');
      if (t) t.classList.toggle('open');
    });
  }

  function showCountyInfo(name) {
    var r = REC[name];
    if (!r) return;
    elEmpty.hidden = true;
    elDetail.hidden = false;
    elBadge.textContent = TB[r.type].name;
    elBadge.style.background = r.color;
    elCity.textContent = shortCity(r.city) + ' · 县级政区';
    setCalliText(elName, r.base);
    elText.textContent = r.origin;

    var m = r.meta || {};
    var bits = [];
    if (m.y) bits.push(m.y);
    bits.push(TB[r.type].name + ' · 全省 ' + STAT_MAP[r.type].n + ' 个');
    var html = '<p class="d-meta">' + bits.join(' · ') + '</p>';
    html += sibHTML('同族', FAMILY[m.f], name);
    html += sibHTML('同字', CHARGRP[m.c], name);
    if (m.s) {
      html += '<div class="d-src"><b>出处</b><p>' + m.s + '</p></div>';
    }
    elFoot.innerHTML = html;
    bindFoot();

    elDetail.style.animation = 'none';
    void elDetail.offsetWidth;
    elDetail.style.animation = '';
  }

  function toProvince() {
    current.level = 'province';
    current.city = null;
    current.cityCode = null;
    current.selected = null;
    elBack.hidden = true;
    elCrumb.textContent = '山东省';
    elCount.textContent = '16 个设区市 · 点击展开';
    elHint.textContent = '点击城市 · 展开县级地图';
    elEmpty.hidden = false;
    elDetail.hidden = true;
    elStrip.hidden = true;
    elStrip.innerHTML = '';
    renderMap(provinceOption());
  }

  function buildStrip(cityCode, cityName) {
    var code = String(cityCode);
    var feats = COUNTY_FEATS.filter(function (f) { return String(f.properties.cityCode) === code; });
    elStrip.hidden = false;
    elStrip.innerHTML = '<span class="strip-label">' + shortCity(cityName) + '下辖</span>' +
      feats.map(function (f) {
        var r = REC[f.properties.name];
        return '<button class="strip-chip" data-n="' + f.properties.name + '">' +
          '<i style="background:' + r.color + '"></i>' + shortCounty(f.properties.name) + '</button>';
      }).join('');
  }

  function toCity(name, cityCode) {
    current.level = 'city';
    current.city = name;
    current.cityCode = cityCode;
    current.selected = null;
    elBack.hidden = false;
    elCrumb.textContent = shortCity(name);
    elCount.textContent = (CITY_COUNT[name] || 0) + ' 个县级政区';
    elHint.textContent = '点击县区 · 查看地名由来';
    showCityInfo(name);
    buildStrip(cityCode, name);
    renderMap(countyOption(cityCode, null));
    warmCityCounties(cityCode);
  }

  function pickCounty(name) {
    if (current.level !== 'city') return;
    current.selected = name;
    renderMap(countyOption(current.cityCode, name));
    showCountyInfo(name);
    document.querySelectorAll('#countyStrip .strip-chip').forEach(function (b) {
      b.classList.toggle('on', b.dataset.n === name);
    });
  }

  map1.on('click', function (p) {
    if (current.level === 'province') {
      var feat = CITY_FEATS.filter(function (f) { return f.properties.name === p.name; })[0];
      if (feat) toCity(p.name, feat.properties.adcode);
    } else {
      pickCounty(p.name);
    }
  });

  elBack.addEventListener('click', toProvince);

  /* 供 02 区卡片跳转调用 */
  window.__focusCounty = function (name) {
    var feat = COUNTY_FEATS.filter(function (f) { return f.properties.name === name; })[0];
    if (!feat) return;
    toCity(feat.properties.city, feat.properties.cityCode);
    pickCounty(name);
    document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  map1.setOption(provinceOption(), true);
  /* map1 在省/市两级来回换布局，给较松的边界：贴边余量 4%，最小占屏 70% */
  kickMap1 = bindRoamLimit(map1, { seriesIndex: 0, cover: 0.7 });

  /* ============================================================
     02 分布图 + 条形图 + 类型卡片
     ============================================================ */
  var map2 = echarts.init(document.getElementById('map2'), null, { renderer: 'canvas' });
  echarts.registerMap('sd-county-all', window.SD_COUNTY);
  var activeType = null;

  var elNote = document.getElementById('map2Note');
  var elReset = document.getElementById('btnReset');

  function countyAllOption() {
    return {
      animationDuration: 480,
      tooltip: Object.assign(tooltipBase(), {
        formatter: function (p) {
          var r = REC[p.name];
          if (!r) return p.name;
          return '<div style="font-family:' + SERIF + ';font-weight:700;font-size:14.5px;margin-bottom:3px">' + r.base + '</div>' +
            '<div style="color:' + r.color + ';font-size:11.5px;letter-spacing:.1em;margin-bottom:4px">' + TB[r.type].name + '</div>' +
            '<div style="color:#8a8175;font-size:11px">' + shortCity(r.city) + '</div>';
        }
      }),
      series: [{
        type: 'map',
        map: 'sd-county-all',
        roam: true,
        zoom: 1.02,
        scaleLimit: { min: 0.9, max: 4 },
        selectedMode: false,
        itemStyle: { borderColor: '#fbf8f0', borderWidth: 0.9 },
        label: { show: false },
        emphasis: {
          label: {
            show: true,
            fontFamily: SERIF,
            fontSize: 11.5,
            color: '#211d18',
            textBorderColor: 'rgba(255,255,255,.95)',
            textBorderWidth: 2.6,
            formatter: function (p) { return shortCounty(p.name); }
          },
          itemStyle: { borderColor: '#211d18', borderWidth: 1.6, areaColor: '#a8322a' }
        },
        data: COUNTY_FEATS.map(function (f) {
          var r = REC[f.properties.name];
          var off = activeType && r.type !== activeType;
          return {
            name: f.properties.name,
            value: 1,
            itemStyle: { areaColor: off ? '#e9e2d2' : rgba(r.color, off ? 1 : 0.84) }
          };
        })
      }]
    };
  }
  map2.setOption(countyAllOption(), true);
  var kickMap2 = bindRoamLimit(map2, { seriesIndex: 0, cover: 0.72 });

  var bar = echarts.init(document.getElementById('bar'), null, { renderer: 'canvas' });

  function barOption() {
    var data = STAT.slice().sort(function (a, b) { return a.n - b.n; });
    return {
      animationDuration: 620,
      grid: { left: 0, right: 46, top: 6, bottom: 4, containLabel: true },
      xAxis: {
        type: 'value',
        max: Math.max.apply(null, STAT.map(function (s) { return s.n; })) * 1.15,
        splitLine: { show: false },
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { show: false }
      },
      yAxis: {
        type: 'category',
        data: data.map(function (s) { return s.name; }),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          color: '#4a443a',
          fontSize: 11.5,
          fontFamily: SANS,
          margin: 10
        }
      },
      series: [{
        type: 'bar',
        barWidth: 13,
        data: data.map(function (s) {
          return {
            value: s.n,
            itemStyle: {
              color: s.color,
              borderRadius: [0, 2, 2, 0],
              opacity: (activeType && activeType !== s.key) ? 0.28 : 1
            }
          };
        }),
        label: {
          show: true,
          position: 'right',
          color: '#6f6759',
          fontSize: 11,
          fontFamily: SANS,
          formatter: function (p) { return p.value + ' · ' + data[p.dataIndex].pct + '%'; }
        },
        emphasis: { itemStyle: { opacity: 1 } }
      }]
    };
  }
  bar.setOption(barOption(), true);

  bar.on('click', function (p) {
    var key = STAT.filter(function (s) { return s.name === p.name; })[0].key;
    setActiveType(activeType === key ? null : key);
  });

  function setActiveType(key) {
    activeType = key;
    map2.setOption(countyAllOption(), true);
    if (kickMap2) kickMap2();
    bar.setOption(barOption(), true);
    document.querySelectorAll('#legend2 .legend-item').forEach(function (el) {
      el.classList.toggle('active', el.dataset.key === key);
      el.classList.toggle('dim', !!key && el.dataset.key !== key);
    });
    if (key) {
      elNote.innerHTML = '只看 <b style="color:' + TB[key].color + '">' + TB[key].name + '</b> · 共 ' + STAT_MAP[key].n + ' 个';
      elReset.hidden = false;
    } else {
      elNote.textContent = '按得名类型着色';
      elReset.hidden = true;
    }
  }

  elReset.addEventListener('click', function () { setActiveType(null); });

  /* 图例：01 与 02 两处 */
  function buildLegend(el, interactive) {
    TYPES.forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'legend-item';
      d.dataset.key = t.key;
      d.innerHTML = '<i class="legend-dot" style="background:' + t.color + '"></i><span>' + t.name + '</span>';
      if (interactive) {
        d.addEventListener('click', function () {
          setActiveType(activeType === t.key ? null : t.key);
        });
      } else {
        d.addEventListener('click', function () {
          setActiveType(t.key);
          document.getElementById('origin').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
      el.appendChild(d);
    });
  }
  buildLegend(document.getElementById('legend'), false);
  buildLegend(document.getElementById('legend2'), true);

  /* 类型卡片 */
  var cardBox = document.getElementById('typeCards');
  TYPES.forEach(function (t) {
    var s = STAT_MAP[t.key];
    var card = document.createElement('article');
    card.className = 'tcard';
    card.style.setProperty('--tc', t.color);
    card.innerHTML =
      '<div class="tcard-top">' +
        '<span class="tcard-name">' + t.name + '</span>' +
        '<span class="tcard-count">' + s.n + '<small>个 / ' + s.pct + '%</small></span>' +
      '</div>' +
      '<p class="tcard-desc">' + t.desc + '</p>' +
      '<div class="tcard-eg">' + t.eg.map(function (n) {
        return '<button class="eg-chip" data-n="' + n + '">' + shortCounty(n) + '</button>';
      }).join('') + '</div>';
    card.addEventListener('click', function (e) {
      var b = e.target.closest('.eg-chip');
      if (b) {
        window.__focusCounty(b.dataset.n);
      } else {
        setActiveType(activeType === t.key ? null : t.key);
        document.getElementById('origin').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    cardBox.appendChild(card);
  });

  /* ============================================================
     03 读音墙 + 趣味卡片
     ============================================================ */
  var rdBox = document.getElementById('readings');
  window.READINGS.forEach(function (r) {
    var d = document.createElement('div');
    d.className = 'rd-card hidden';
    d.setAttribute('role', 'button');
    d.setAttribute('tabindex', '0');
    d.setAttribute('aria-label', r.n + ' 的读音，点击查看');
    d.innerHTML =
      '<div class="rd-name">' + r.n + '</div>' +
      '<div class="rd-py">' + r.p + '</div>' +
      '<div class="rd-note">' + r.note + '</div>';
    function toggle() {
      d.classList.toggle('hidden');
      d.classList.toggle('revealed');
    }
    d.addEventListener('click', toggle);
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    rdBox.appendChild(d);
  });

  var funBox = document.getElementById('funGrid');
  var chipBox = document.getElementById('chips');
  var tags = ['全部'].concat(window.FUN.map(function (f) { return f.tag; }).filter(function (v, i, a) { return a.indexOf(v) === i; }));

  tags.forEach(function (tag, i) {
    var b = document.createElement('button');
    b.className = 'chip' + (i === 0 ? ' on' : '');
    b.textContent = tag === '全部' ? '全部 ' + window.FUN.length : tag;
    b.addEventListener('click', function () {
      document.querySelectorAll('#chips .chip').forEach(function (c) { c.classList.remove('on'); });
      b.classList.add('on');
      renderFun(tag);
    });
    chipBox.appendChild(b);
  });

  function renderFun(tag) {
    funBox.innerHTML = '';
    var list = window.FUN.filter(function (f) { return tag === '全部' || f.tag === tag; });
    list.forEach(function (f, i) {
      var d = document.createElement('article');
      d.className = 'fcard';
      d.style.animationDelay = (i * 0.035) + 's';
      d.innerHTML = '<span class="fcard-tag">' + f.tag + '</span>' +
        '<h4>' + f.title + '</h4>' +
        '<p>' + f.body + '</p>';
      funBox.appendChild(d);
    });
  }
  renderFun('全部');

  /* ============================================================
     导航进度 + 入场动画
     ============================================================ */
  var navEl = document.getElementById('nav');
  var barEl = document.getElementById('progressBar');
  function onScroll() {
    var y = window.scrollY || document.documentElement.scrollTop;
    navEl.classList.toggle('solid', y > 40);
    var h = document.documentElement.scrollHeight - window.innerHeight;
    barEl.style.width = (h > 0 ? Math.min(100, y / h * 100) : 0) + '%';
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }

  /* ============================================================
     03 名字有多美
     ============================================================ */
  (function () {
    var mapEl = document.getElementById('beautyMap');
    var sideEl = document.getElementById('bmapSide');
    var catsEl = document.getElementById('beautyCats');
    var legendEl = document.getElementById('bmapLegend');
    if (!mapEl || !window.BEAUTIFUL) return;

    var BS = window.BEAUTIFUL;
    var CATS = ['山水意象', '泉园巷陌', '风物闲美', '古城春秋'];
    var CAT_COLOR = {
      '山水意象': '#2f6f9e',
      '泉园巷陌': '#2f6b4f',
      '风物闲美': '#b03a2e',
      '古城春秋': '#6e5aa8'
    };
    var DIM_LABEL = ['音', '象', '形', '空', '误'];

    /* beautiful 的坐标是 GCJ02（高德系），底图 sd-geo 是 WGS84，必须先转 */
    function gcj2wgs(lng, lat) {
      var A = 6378245.0, EE = 0.00669342162296594323;
      var x = lng - 105, y = lat - 35;
      var dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      dLat += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      dLat += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
      dLat += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
      var dLng = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      dLng += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      dLng += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
      dLng += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
      var rad = lat / 180 * Math.PI;
      var m = 1 - EE * Math.sin(rad) * Math.sin(rad);
      var sm = Math.sqrt(m);
      dLat = dLat * 180 / ((A * (1 - EE)) / (m * sm) * Math.PI);
      dLng = dLng * 180 / (A / sm * Math.cos(rad) * Math.PI);
      return [lng - dLng, lat - dLat];
    }

    var PTS = BS.map(function (b, i) {
      var w = gcj2wgs(b.x, b.y);
      return {
        name: b.n, idx: i,
        value: [w[0], w[1], i],
        itemStyle: { color: CAT_COLOR[b.cat] || '#a8322a' }
      };
    });

    var bmap = echarts.init(mapEl, null, { renderer: 'canvas' });
    if (!echarts.getMap || !echarts.getMap('sd-county-all')) {
      echarts.registerMap('sd-county-all', window.SD_COUNTY);
    }

    var sel = -1;
    function sizeFn(v, p) { return (p && p.data && p.data.idx === sel) ? 16 : 9; }

    bmap.setOption({
      animationDuration: 600,
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: 'rgba(255,253,247,.97)',
        borderColor: '#e2d8c4',
        borderWidth: 1,
        padding: [8, 11],
        extraCssText: 'box-shadow:0 10px 26px -14px rgba(60,45,25,.55);border-radius:3px;',
        textStyle: { color: '#211d18', fontSize: 12, fontFamily: SANS },
        formatter: function (p) {
          if (!p.data || p.data.idx == null) return p.name;
          var b = BS[p.data.idx];
          return '<div style="font-family:' + SERIF + ';font-weight:700;font-size:14px;letter-spacing:.04em">' + b.n + '</div>' +
            '<div style="color:' + (CAT_COLOR[b.cat] || '#a8322a') + ';font-size:11px;margin-top:2px">' + b.cat + ' · ' + b.k + '</div>' +
            '<div style="color:#8a8175;font-size:11px;margin-top:4px">' + b.belong + '</div>';
        }
      },
      geo: {
        map: 'sd-county-all',
        roam: true,
        zoom: 1,
        layoutCenter: ['50%', '50%'],
        layoutSize: '94%',
        scaleLimit: { min: 0.85, max: 8 },
        itemStyle: { areaColor: '#f0e9d9', borderColor: '#fbf8f0', borderWidth: 0.8 },
        emphasis: { disabled: true },
        select: { disabled: true }
      },
      series: [{
        type: 'scatter',
        coordinateSystem: 'geo',
        data: PTS,
        symbolSize: sizeFn,
        label: {
          show: true, position: 'right', distance: 5,
          formatter: '{b}',
          fontSize: 11, fontFamily: SERIF, color: '#3b342a',
          textBorderColor: 'rgba(251,248,240,.92)', textBorderWidth: 2.6
        },
        labelLayout: function (p) {
            var east = p.data && p.data.value && p.data.value[0] > 121.6;
            return { hideOverlap: !east };
          },
        emphasis: {
          scale: 1.5,
          label: { fontSize: 13, fontWeight: 700, color: '#211d18' }
        },
        z: 10
      }]
    }, true);

    function showEmpty() {
      sideEl.innerHTML =
        '<div class="bsel-empty">' +
          '<p class="bsel-k">三十二个名字</p>' +
          '<h3>点地图上的任意一个</h3>' +
          '<p>这里收录的名字，既有山川湖泉，也有街巷等地名。它们分布在山东各地，有些地方比较集中，比如济南老城一带，就能找到六个。</p>' +
          '<p class="bsel-fine">也可以往下，按四类慢慢看</p>' +
        '</div>';
    }

    function show(i) {
      var b = BS[i];
      if (!b) return;
      sel = i;
      var col = CAT_COLOR[b.cat] || '#a8322a';
      sideEl.innerHTML =
        '<div class="bsel" style="--bc:' + col + '">' +
          '<div class="bsel-top">' +
            '<span class="bsel-kind">' + b.k + '</span>' +
            '<span class="bsel-cat">' + b.cat + '</span>' +
          '</div>' +
          '<h3 class="bsel-n" data-calli>' + b.n + '</h3>' +
          '<div class="bsel-py">' + b.py + '</div>' +
          '<p class="bsel-line">' + b.line + '</p>' +
          '<ul class="bsel-dims">' + b.dims.map(function (d, k) {
            return '<li><b>' + (DIM_LABEL[k] || '') + '</b>' + d + '</li>';
          }).join('') + '</ul>' +
          '<p class="bsel-belong">' + b.belong + '</p>' +
        '</div>';
      applyCalli(sideEl);
      bmap.setOption({ series: [{ symbolSize: sizeFn }] });
    }

    bmap.on('click', function (p) {
      if (p && p.data && p.data.idx != null) show(p.data.idx);
    });
    /* 美名点位地图：geo 组件，roam 时改的是 center / zoom */
    var kickBmap = bindRoamLimit(bmap, { geo: true, geoIndex: 0, cover: 0.7 });

    showEmpty();

    CATS.forEach(function (c) {
      var d = document.createElement('span');
      d.className = 'bmap-lg';
      d.innerHTML = '<i style="background:' + CAT_COLOR[c] + '"></i>' + c;
      legendEl.appendChild(d);
    });

    function makeCard(idx) {
      var b = BS[idx];
      var col = CAT_COLOR[b.cat] || '#a8322a';
      var card = document.createElement('article');
      card.className = 'bcard';
      card.style.setProperty('--bc', col);
      card.innerHTML =
        '<div class="bcard-top">' +
          '<span class="bcard-kind">' + b.k + '</span>' +
          '<span class="bcard-cat">' + b.cat + '</span>' +
        '</div>' +
        '<div class="bcard-name" data-calli>' + b.n + '</div>' +
        '<div class="bcard-py">' + b.py + '</div>' +
        '<p class="bcard-line">' + b.line + '</p>' +
        '<div class="bcard-dims"><ul>' +
          b.dims.map(function (d, k) {
            return '<li><b>' + (DIM_LABEL[k] || '') + '</b>' + d + '</li>';
          }).join('') +
        '</ul></div>' +
        '<div class="bcard-foot">' +
          '<button class="bcard-toggle" type="button">它美在哪</button>' +
          '<span class="bcard-belong">' + b.belong + '</span>' +
        '</div>';

      var btn = card.querySelector('.bcard-toggle');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = card.classList.toggle('open');
        btn.textContent = open ? '收起' : '它美在哪';
      });
      card.addEventListener('click', function () {
        show(idx);
        var g = catsEl.parentNode.querySelector('.bmap-grid');
        if (g) g.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return card;
    }

    CATS.forEach(function (cat) {
      var list = [];
      BS.forEach(function (b, i) { if (b.cat === cat) list.push(i); });
      if (!list.length) return;

      var g = document.createElement('div');
      g.className = 'bcat';
      var h = document.createElement('div');
      h.className = 'bcat-h';
      h.innerHTML = '<i style="background:' + CAT_COLOR[cat] + '"></i>' +
        '<h3>' + cat + '</h3><span>' + list.length + ' 个</span>';
      g.appendChild(h);

      var grid = document.createElement('div');
      grid.className = 'beauty-grid';
      list.forEach(function (idx) { grid.appendChild(makeCard(idx)); });
      g.appendChild(grid);
      catsEl.appendChild(g);
    });

    applyCalli(catsEl);

    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { bmap.resize(); kickBmap(); }, 180);
    });
  })();

  /* ============================================================
     04 名字怎么变
     ============================================================ */
  (function () {
    var sumBox = document.getElementById('chgSummary');
    var listBox = document.getElementById('chgList');
    var wallBox = document.getElementById('vanishedWall');
    if (!window.CHANGES) return;

    var DESC = {
      '回归': '把千年古名找回来',
      '让位': '县城名让给港口、工矿或新城',
      '合并': '撤市设区，强市代管',
      '消逝': '撤销后再没有回来'
    };
    var byKind = {};
    window.CHANGES.forEach(function (c) {
      (byKind[c.kind] = byKind[c.kind] || []).push(c);
    });

    if (sumBox) {
      ['回归', '让位', '合并', '消逝'].forEach(function (k) {
        var n = (byKind[k] || []).length;
        var d = document.createElement('div');
        d.className = 'chg-stat' + (k === '消逝' ? ' is-gone' : '');
        d.innerHTML = '<b>' + n + '</b><span>' + k + '</span><em>' + DESC[k] + '</em>';
        sumBox.appendChild(d);
      });
    }

    if (listBox) {
      ['回归', '让位', '合并'].forEach(function (k) {
        var arr = byKind[k] || [];
        if (!arr.length) return;
        var g = document.createElement('div');
        g.className = 'chg-group';
        g.innerHTML =
          '<div class="chg-gh"><h3>' + k + '</h3><p>' + DESC[k] + '</p></div>' +
          '<div class="chg-rows">' +
          arr.map(function (c) {
            return '<div class="chg-row">' +
              '<span class="chg-year">' + c.year + '</span>' +
              '<span class="chg-name">' + c.from + '<i>→</i>' + c.to + '</span>' +
              (c.note ? '<span class="chg-note">' + c.note + '</span>' : '') +
            '</div>';
          }).join('') +
          '</div>';
        listBox.appendChild(g);
      });
    }

    if (wallBox) {
      (byKind['消逝'] || []).forEach(function (c) {
        var d = document.createElement('div');
        d.className = 'vname';
        d.innerHTML =
          '<b data-calli>' + c.from + '</b>' +
          '<span>' + c.year + ' 撤销' + (c.into ? ' · 分入' + c.into : '') + '</span>';
        wallBox.appendChild(d);
      });
      applyCalli(wallBox);
    }
  })();

  /* ============================================================
     06 测一测：最像你的山东地名
     ============================================================ */
  (function () {
    var box = document.getElementById('quizBox');
    if (!box || !window.QUIZ) return;
    var Q = window.QUIZ;
    var answers = [null, null, null];

    /* 每个类型的代表作，按顺序取，避免三类撞同一个县 */
    var PICK = {
      guguo: ['曲阜市', '邹城市', '滕州市'],
      shui: ['泗水县', '微山县', '临清市'],
      shan: ['五莲县', '乳山市', '泰山区'],
      fangwei: ['海阳市', '蒙阴县', '沂南县'],
      jixiang: ['招远市', '寿光市', '庆云县'],
      juluo: ['周村区', '坊子区', '台儿庄区'],
      renwen: ['环翠区', '天桥区', '钢城区'],
      caomu: ['牡丹区', '槐荫区', '栖霞市']
    };

    function calc() {
      var score = {};
      answers.forEach(function (oi, qi) {
        if (oi == null) return;
        var w = Q.questions[qi].opts[oi].w;
        Object.keys(w).forEach(function (k) { score[k] = (score[k] || 0) + w[k]; });
      });
      var top = Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }).slice(0, 3);
      /* 每个类型有若干备选，随机取一个——避免反复测总落到同一批地名 */
      return top.map(function (t) {
        var cand = PICK[t] || [];
        var name = cand.length ? cand[Math.floor(Math.random() * cand.length)] : '';
        return { type: t, name: name };
      });
    }

    function render() {
      var done = answers.every(function (a) { return a != null; });
      var html = '';

      Q.questions.forEach(function (q, qi) {
        html += '<div class="q-item' + (answers[qi] != null ? ' is-done' : '') + '">' +
          '<p class="q-k">第 ' + (qi + 1) + ' 问</p>' +
          '<h3 class="q-t">' + q.q + '</h3>' +
          '<div class="q-opts">' +
          q.opts.map(function (o, oi) {
            return '<button type="button" class="q-opt' + (answers[qi] === oi ? ' on' : '') +
              '" data-q="' + qi + '" data-o="' + oi + '">' + o.t + '</button>';
          }).join('') +
          '</div></div>';
      });

      if (done) {
        var res = calc();
        html += '<div class="q-result">' +
          '<p class="q-rk">最像你的三个山东地名</p>' +
          '<div class="q-cards">' +
          res.map(function (r) {
            var info = REC[r.name];
            var tn = TB[r.type] ? TB[r.type].name : '';
            var col = info ? info.color : '#a8322a';
            var city = info ? shortCity(info.city) : '';
            return '<div class="q-card" style="--qc:' + col + '">' +
              '<span class="q-card-t">' + tn + '</span>' +
              '<h4 class="q-card-n" data-calli>' + (info ? info.base : r.name) + '</h4>' +
              '<p class="q-card-c">' + city + '</p>' +
              '<p class="q-card-l">' + (Q.typeLine[r.type] || '') + '</p>' +
              (function () {
                var o = info ? String(info.origin || '') : '';
                var first = o.split('。')[0];
                if (!first) return '';
                if (first.length > 68) first = first.slice(0, 68) + '…';
                return '<p class="q-card-o"><b>它的名字</b>' + first + '。</p>';
              })() +
              '<button type="button" class="q-card-go" data-n="' + r.name + '">在地图上打开</button>' +
            '</div>';
          }).join('') +
          '</div>' +
          '<button type="button" class="q-again">重新选一次</button>' +
          '</div>';
      }

      box.innerHTML = html;

      Array.prototype.forEach.call(box.querySelectorAll('.q-opt'), function (b) {
        b.addEventListener('click', function () {
          answers[+b.dataset.q] = +b.dataset.o;
          render();
          applyCalli(box);
        });
      });
      Array.prototype.forEach.call(box.querySelectorAll('.q-card-go'), function (b) {
        b.addEventListener('click', function () {
          if (window.__focusCounty) window.__focusCounty(b.dataset.n);
        });
      });
      var again = box.querySelector('.q-again');
      if (again) again.addEventListener('click', function () {
        answers = [null, null, null];
        render();
      });
      applyCalli(box);
    }

    render();
  })();

  /* 尺寸自适应 */
  /* ---------- 锚点跳转 ----------
     section 自身有 64–118px 的 padding-top，默认锚点会把这段留白一起滚进视口，
     看起来像"跳过去先空一大块"。这里改成直接滚到该节标题，保留章节间原有间距。 */
  document.addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var id = a.getAttribute('href').slice(1);
    if (!id) return;
    var el = document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    if (id === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (history.replaceState) history.replaceState(null, '', '#' + id);
      return;
    }
    var navH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-h'), 10) || 58;
    var head = el.querySelector('.sec-head') || el;
    var top = head.getBoundingClientRect().top + (window.scrollY || document.documentElement.scrollTop) - navH - 40;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    if (history.replaceState) history.replaceState(null, '', '#' + id);
  });

  /* 首屏稳定后预热市名书法字 */
  if ('requestIdleCallback' in window) {
    requestIdleCallback(warmCities, { timeout: 2500 });
  } else {
    setTimeout(warmCities, 1800);
  }

  /* ============================================================
     结束语底图：省域轮廓（县块拼接，去掉内部边界即成整片剪影）
     ============================================================ */
  (function () {
    var el = document.getElementById('endMap');
    if (!el || !window.SD_COUNTY) return;
    if (!echarts.getMap || !echarts.getMap('sd-county-all')) {
      echarts.registerMap('sd-county-all', window.SD_COUNTY);
    }
    var ch = echarts.init(el, null, { renderer: 'canvas' });
    ch.setOption({
      animation: false,
      geo: {
        map: 'sd-county-all',
        roam: false,
        silent: true,
        itemStyle: {
          areaColor: 'rgba(33,29,24,.065)',
          borderColor: 'rgba(33,29,24,.035)',
          borderWidth: 0.2
        },
        emphasis: { disabled: true },
        select: { disabled: true }
      }
    });
    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { ch.resize(); }, 220);
    });
  })();

  var rt;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      map1.resize(); map2.resize(); bar.resize();
      if (current.level === 'province') {
        map1.setOption(provinceOption(), true);
      } else if (current.cityCode) {
        map1.setOption(countyOption(current.cityCode, current.selected), true);
      }
      if (kickMap1) kickMap1();
      if (kickMap2) kickMap2();
    }, 180);
  });
})();
