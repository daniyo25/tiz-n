/* Dani Launcher: módulo "app" de TizenBrew.
 * TizenBrew sirve esta página desde http://127.0.0.1:8081/module/<módulo>/app/index.html,
 * así que el WebSocket del servicio de TizenBrew está en el mismo origen. Lo que la página
 * no puede hacer sola (abrir apps, leer iconos, guardar ajustes, saltarse CORS) lo hace
 * nuestro servicio en 127.0.0.1:8091 (service/src/service.js).
 * Escrito en ES5 para que funcione también en Tizen antiguos. */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406
  };
  var TB_WS_URL = 'ws://127.0.0.1:8081';
  var SERVICE_URL = 'http://127.0.0.1:8091';
  var SERVICE_VERSION = 3; // la que trae service/service.js en esta versión
  var TB_EVENTS = { GetModules: 4, LaunchModule: 5, Error: 8, ModuleAction: 10 };

  var WEATHER_CODES = {
    0: 'Despejado', 1: 'Casi despejado', 2: 'Parcialmente nuboso', 3: 'Nublado',
    45: 'Niebla', 48: 'Niebla', 51: 'Llovizna', 53: 'Llovizna', 55: 'Llovizna',
    61: 'Lluvia', 63: 'Lluvia', 65: 'Lluvia fuerte', 71: 'Nieve', 73: 'Nieve', 75: 'Nieve',
    80: 'Chubascos', 81: 'Chubascos', 82: 'Chubascos fuertes', 95: 'Tormenta', 96: 'Tormenta', 99: 'Tormenta'
  };
  var ACCENTS = [
    { name: 'Blanco', value: '#ffffff' }, { name: 'Azul', value: '#4f8cff' },
    { name: 'Morado', value: '#a970ff' }, { name: 'Verde', value: '#3ddc84' },
    { name: 'Naranja', value: '#ff9f43' }
  ];
  var SIZES = [{ name: 'Pequeño', value: 's' }, { name: 'Normal', value: 'm' }, { name: 'Grande', value: 'l' }];
  var FONTS = [{ name: 'Samsung', value: 'sans' }, { name: 'Serif', value: 'serif' }, { name: 'Máquina de escribir', value: 'mono' }];
  var SAVER = [{ name: 'Nunca', value: 0 }, { name: '2 min', value: 2 }, { name: '5 min', value: 5 }, { name: '10 min', value: 10 }, { name: '30 min', value: 30 }];

  var config = null;
  var rowEls = [];      // [{ el, strip, tiles: [el], data: [tile] }]
  var focusRow = 0;
  var focusCol = [];    // última columna enfocada en cada fila
  var tbModules = null;
  var ws = null;
  var pendingModule = null;
  var serviceInfo = null;

  function $(id) { return document.getElementById(id); }

  function setStatus(text) {
    $('status').textContent = text || '';
    if (text) {
      clearTimeout(setStatus.t);
      setStatus.t = setTimeout(function () { $('status').textContent = ''; }, 5000);
    }
  }

  function request(method, url, body, cb, raw) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.onload = function () {
      var data = null;
      if (raw) data = xhr.responseText;
      else { try { data = JSON.parse(xhr.responseText); } catch (e) { /* sin cuerpo JSON */ } }
      if (xhr.status >= 200 && xhr.status < 300) cb(null, data);
      else cb(new Error('HTTP ' + xhr.status), data);
    };
    xhr.onerror = function () { cb(new Error('Sin conexión')); };
    // text/plain evita la petición previa de CORS
    if (body !== undefined) xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.send(body === undefined ? null : JSON.stringify(body));
  }
  function getJSON(url, cb) { request('GET', url, undefined, cb); }
  function errText(err, data) { return (data && data.error) || err.message; }

  // ---------- Configuración ----------

  // Las primeras versiones tenían una lista plana de "tiles" en vez de filas
  function normalize(cfg) {
    if (!cfg.rows) cfg.rows = [{ title: 'Apps', tiles: cfg.tiles || [] }];
    delete cfg.tiles;
    cfg.theme = cfg.theme || {};
    cfg.screensaver = cfg.screensaver || { minutes: 5 };
    cfg.widgets = cfg.widgets || {};
    return cfg;
  }

  // El servicio tarda un momento en arrancar cuando TizenBrew abre el launcher
  function loadConfig(cb) {
    var tries = 0;
    function trySaved() {
      getJSON(SERVICE_URL + '/config', function (err, data) {
        if (!err && data && data.config) return cb(normalize(data.config));
        if (err && ++tries < 4) return setTimeout(trySaved, 700);
        loadBundled();
      });
    }
    function loadBundled() {
      getJSON('config.json?t=' + Date.now(), function (err, cfg) {
        if (err) { setStatus('No se pudo leer config.json'); cfg = {}; }
        cfg = normalize(cfg);
        // El editor del móvil parte de esta configuración si aún no se ha guardado ninguna
        request('POST', SERVICE_URL + '/default', cfg, function () {});
        cb(cfg);
      });
    }
    trySaved();
  }

  function saveConfig() {
    try { localStorage.setItem('daniLauncherTheme', JSON.stringify(config.theme)); } catch (e) { /* sin almacenamiento */ }
    request('POST', SERVICE_URL + '/config', config, function (err, data) {
      if (err) setStatus('No se pudo guardar (' + errText(err, data) + ')');
    });
  }

  // ---------- Tema ----------

  function applyTheme() {
    var t = config.theme;
    document.documentElement.style.setProperty('--accent', t.accent || '#ffffff');
    document.body.className = 'size-' + (t.size || 'm') + ' font-' + (t.font || 'sans');
  }

  // ---------- Reloj y tiempo ----------

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function timeText(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function tickClock() {
    var d = new Date();
    $('clock').textContent = timeText(d);
    $('saverClock').textContent = timeText(d);
    var date = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    $('date').textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }

  // Open-Meteo, sin clave de API: tiempo actual y previsión en una sola petición
  function loadWeather() {
    var w = config.weather;
    if (!w) return;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.latitude +
      '&longitude=' + w.longitude + '&current_weather=true&timezone=auto&forecast_days=4' +
      '&daily=weathercode,temperature_2m_max,temperature_2m_min';
    getJSON(url, function (err, data) {
      if (err || !data.current_weather) return;
      var cw = data.current_weather;
      $('weather').textContent = w.city + ' · ' + Math.round(cw.temperature) + '°C ' + (WEATHER_CODES[cw.weathercode] || '');
      if (config.widgets.forecast && data.daily) renderForecast(data.daily);
    });
  }

  // ---------- Widgets ----------

  function widget(id, title) {
    var box = $(id);
    box.innerHTML = '';
    box.className = 'widget';
    var h = document.createElement('h3');
    h.textContent = title;
    box.appendChild(h);
    return box;
  }

  function renderForecast(daily) {
    var box = widget('w-forecast', 'Próximos días');
    var wrap = document.createElement('div');
    wrap.className = 'forecast';
    for (var i = 1; i < daily.time.length && i <= 3; i++) {
      var d = new Date(daily.time[i] + 'T12:00:00');
      var day = document.createElement('div');
      day.className = 'day';
      day.innerHTML = '<div class="d"></div><div class="t"></div><div class="s"></div>';
      day.children[0].textContent = d.toLocaleDateString('es-ES', { weekday: 'short' });
      day.children[1].textContent = Math.round(daily.temperature_2m_max[i]) + '° / ' + Math.round(daily.temperature_2m_min[i]) + '°';
      day.children[2].textContent = WEATHER_CODES[daily.weathercode[i]] || '';
      wrap.appendChild(day);
    }
    box.appendChild(wrap);
  }

  function renderCalendar() {
    if (!config.widgets.calendar) { $('w-calendar').className = 'widget hidden'; return; }
    var now = new Date();
    var month = now.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    var box = widget('w-calendar', month);
    var grid = document.createElement('div');
    grid.className = 'cal';
    ['L', 'M', 'X', 'J', 'V', 'S', 'D'].forEach(function (d) {
      var c = document.createElement('div');
      c.className = 'wd';
      c.textContent = d;
      grid.appendChild(c);
    });
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    var offset = (first.getDay() + 6) % 7; // semana empieza en lunes
    for (var i = 0; i < 42; i++) {
      var day = new Date(first.getFullYear(), first.getMonth(), 1 - offset + i);
      if (i % 7 === 0 && i > 0 && day.getMonth() !== now.getMonth()) break;
      var cell = document.createElement('div');
      cell.textContent = day.getDate();
      if (day.getMonth() !== now.getMonth()) cell.className = 'other';
      else if (day.getDate() === now.getDate()) cell.className = 'today';
      grid.appendChild(cell);
    }
    box.appendChild(grid);
  }

  function proxyUrl(url, token) {
    return SERVICE_URL + '/proxy?url=' + encodeURIComponent(url) + (token ? '&token=' + encodeURIComponent(token) : '');
  }

  function loadNews() {
    var n = config.widgets.news;
    if (!n || !n.url) { $('w-news').className = 'widget hidden'; return; }
    request('GET', proxyUrl(n.url), undefined, function (err, text) {
      if (err || !text) return;
      var doc = new DOMParser().parseFromString(text, 'text/xml');
      var items = doc.querySelectorAll('item > title, entry > title');
      if (!items.length) return;
      var box = widget('w-news', n.title || 'Noticias');
      var list = document.createElement('ul');
      list.className = 'news';
      for (var i = 0; i < items.length && i < 4; i++) {
        var li = document.createElement('li');
        li.textContent = items[i].textContent.trim();
        list.appendChild(li);
      }
      box.appendChild(list);
    }, true);
  }

  function loadHomeAssistant() {
    var ha = config.widgets.homeassistant;
    if (!ha || !ha.url || !ha.token || !ha.entities || !ha.entities.length) {
      $('w-ha').className = 'widget hidden';
      return;
    }
    var results = [];
    var pending = ha.entities.length;
    ha.entities.forEach(function (id, i) {
      getJSON(proxyUrl(ha.url.replace(/\/$/, '') + '/api/states/' + id, ha.token), function (err, s) {
        if (!err && s && s.state !== undefined) {
          var unit = s.attributes && s.attributes.unit_of_measurement ? ' ' + s.attributes.unit_of_measurement : '';
          results[i] = { name: (s.attributes && s.attributes.friendly_name) || id, value: s.state + unit };
        }
        if (--pending) return;
        var box = widget('w-ha', 'Casa');
        var wrap = document.createElement('div');
        wrap.className = 'ha';
        results.forEach(function (r) {
          if (!r) return;
          var line = document.createElement('div');
          line.innerHTML = '<span></span><span class="v"></span>';
          line.children[0].textContent = r.name;
          line.children[1].textContent = r.value;
          wrap.appendChild(line);
        });
        box.appendChild(wrap);
      });
    });
  }

  // ---------- Filas de accesos ----------

  function iconUrl(t) {
    if (t.icon) return t.icon;
    if (t.type === 'tvapp' && t.id) return SERVICE_URL + '/icon?id=' + encodeURIComponent(t.id);
    return null;
  }

  function buildTile(t, r, c) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.style.background = t.color || '#2a3550';
    var url = iconUrl(t);
    if (url) {
      var img = document.createElement('img');
      img.onerror = function () {
        if (img.parentNode) el.removeChild(img);
        el.className += ' noicon';
      };
      img.src = url;
      el.appendChild(img);
    } else el.className += ' noicon';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = t.name;
    el.appendChild(name);
    if (t.type === 'module') {
      var kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = 'TizenBrew';
      el.appendChild(kind);
    }
    el.addEventListener('click', function () { setFocus(r, c); launch(t); });
    return el;
  }

  function renderRows() {
    var inner = $('rowsInner');
    inner.innerHTML = '';
    rowEls = [];
    config.rows.forEach(function (row) {
      if (!row.tiles || !row.tiles.length) return;
      var idx = rowEls.length;
      var el = document.createElement('div');
      el.className = 'row';
      var title = document.createElement('div');
      title.className = 'row-title';
      title.textContent = row.title || '';
      var strip = document.createElement('div');
      strip.className = 'strip';
      var tiles = row.tiles.map(function (t, c) {
        var tile = buildTile(t, idx, c);
        strip.appendChild(tile);
        return tile;
      });
      el.appendChild(title);
      el.appendChild(strip);
      inner.appendChild(el);
      rowEls.push({ el: el, strip: strip, tiles: tiles, data: row.tiles });
      if (focusCol[idx] === undefined || focusCol[idx] >= tiles.length) focusCol[idx] = 0;
    });
    if (focusRow >= rowEls.length) focusRow = 0;
    setFocus(focusRow, focusCol[focusRow] || 0);
  }

  function setFocus(r, c) {
    if (!rowEls.length) return;
    var prev = document.querySelectorAll('.focused, .active');
    for (var i = 0; i < prev.length; i++) prev[i].className = prev[i].className.replace(/ (focused|active)/g, '');
    focusRow = r;
    focusCol[r] = c;
    var row = rowEls[r];
    var tile = row.tiles[c];
    row.el.className += ' active';
    tile.className += ' focused';
    // Mantener visible el acceso enfocado (horizontal) y la fila enfocada (vertical)
    var strip = row.strip;
    if (tile.offsetLeft + tile.offsetWidth + 40 > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = tile.offsetLeft + tile.offsetWidth + 40 - strip.clientWidth;
    } else if (tile.offsetLeft - 16 < strip.scrollLeft) {
      strip.scrollLeft = Math.max(0, tile.offsetLeft - 16);
    }
    var rows = $('rows');
    if (row.el.offsetTop < rows.scrollTop) rows.scrollTop = row.el.offsetTop;
    else if (row.el.offsetTop + row.el.offsetHeight > rows.scrollTop + rows.clientHeight) {
      rows.scrollTop = row.el.offsetTop + row.el.offsetHeight - rows.clientHeight;
    }
  }

  function move(dx, dy) {
    if (!rowEls.length) return;
    if (dy) {
      var r = focusRow + dy;
      if (r < 0 || r >= rowEls.length) return;
      setFocus(r, Math.min(focusCol[r] || 0, rowEls[r].tiles.length - 1));
    } else {
      var c = focusCol[focusRow] + dx;
      if (c < 0 || c >= rowEls[focusRow].tiles.length) return;
      setFocus(focusRow, c);
    }
  }

  function focusedTile() {
    var row = rowEls[focusRow];
    return row ? row.data[focusCol[focusRow]] : null;
  }

  // ---------- Abrir apps y módulos ----------

  function launchTvApp(appId, name) {
    setStatus('Abriendo ' + name + '…');
    if (window.tizen && tizen.application) {
      try {
        tizen.application.launch(appId, null, function () { serviceLaunch(appId, name, true); });
        return;
      } catch (e) { /* esta página no tiene permiso: lo hace nuestro servicio */ }
    }
    serviceLaunch(appId, name, true);
  }

  function serviceLaunch(appId, name, retry) {
    getJSON(SERVICE_URL + '/launch?id=' + encodeURIComponent(appId), function (err, data) {
      if (!err) return;
      // Recién abierto el launcher, TizenBrew puede estar aún arrancando el servicio
      if (retry && /Sin conexión/.test(err.message)) {
        setTimeout(function () { serviceLaunch(appId, name, false); }, 1500);
        return;
      }
      setStatus('No se pudo abrir ' + name + ' (' + errText(err, data) + ')');
    });
  }

  function connectTizenBrew() {
    if (ws || !window.WebSocket) return;
    try { ws = new WebSocket(TB_WS_URL); } catch (e) { ws = null; return; }
    ws.onopen = function () { ws.send(JSON.stringify({ type: TB_EVENTS.GetModules, payload: false })); };
    ws.onmessage = function (msg) {
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data.type === TB_EVENTS.GetModules) {
        if (data.payload === null) {
          setTimeout(function () { ws.send(JSON.stringify({ type: TB_EVENTS.GetModules })); }, 500);
          return;
        }
        tbModules = data.payload;
        if (pendingModule) { var m = pendingModule; pendingModule = null; launchModule(m); }
      } else if (data.type === TB_EVENTS.Error) {
        setStatus('TizenBrew: ' + data.payload);
      }
    };
    ws.onclose = function () { ws = null; };
    ws.onerror = function () { ws = null; };
  }

  function launchModule(tile) {
    if (!tbModules) {
      pendingModule = tile;
      setStatus('Conectando con TizenBrew…');
      connectTizenBrew();
      return;
    }
    var mdl = null;
    for (var i = 0; i < tbModules.length; i++) {
      if (tbModules[i].fullName.toLowerCase() === tile.id.toLowerCase()) mdl = tbModules[i];
    }
    if (!mdl || !mdl.appPath) {
      setStatus('Añade ' + tile.id + ' en TizenBrew primero (botón verde)');
      return;
    }
    if (window.tizen && tizen.tvinputdevice) {
      (mdl.keys || []).forEach(function (k) {
        try { tizen.tvinputdevice.registerKey(k); } catch (e) { /* tecla no soportada */ }
      });
    }
    ws.send(JSON.stringify({ type: TB_EVENTS.LaunchModule, payload: mdl }));
    if (!mdl.evaluateScriptOnDocumentStart) location.href = mdl.appPath;
  }

  function launch(tile) {
    if (!tile) return;
    if (tile.type === 'tvapp') launchTvApp(tile.id, tile.name);
    else if (tile.type === 'module') launchModule(tile);
    else if (tile.type === 'url') location.href = tile.id;
  }

  // Nombre de este módulo en TizenBrew, sacado de la URL /module/<nombre>/app/index.html
  function ownModuleName() {
    var m = location.pathname.match(/\/module\/([^/]+)\//);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setAutolaunch(on) {
    var name = ownModuleName();
    if (!name) { setStatus('Solo funciona dentro de TizenBrew'); return; }
    connectTizenBrew();
    var send = function () {
      ws.send(JSON.stringify({ type: TB_EVENTS.ModuleAction, payload: { action: 'autolaunch', module: on ? name : '' } }));
    };
    if (ws && ws.readyState === 1) send();
    else if (ws) ws.addEventListener('open', send);
  }

  // ---------- Lista de apps instaladas (amarillo) ----------

  function isOpen(id) { return $(id).className === 'panel open'; }

  function toggleAppList() {
    var panel = $('applist');
    if (isOpen('applist')) { panel.className = 'panel'; return; }
    closePanels();
    panel.className = 'panel open';
    panel.textContent = 'Cargando apps instaladas…';
    getJSON(SERVICE_URL + '/apps', function (err, data) {
      if (err || !data.apps) {
        panel.textContent = 'No se pudo obtener la lista (' + errText(err, data) + ')';
        return;
      }
      panel.innerHTML = '';
      var head = document.createElement('div');
      head.className = 'head';
      head.textContent = data.apps.length + ' apps · ↑↓ para desplazarte · Volver para cerrar';
      panel.appendChild(head);
      data.apps.forEach(function (a) {
        var row = document.createElement('div');
        row.textContent = a.name + '  ·  ' + a.id;
        panel.appendChild(row);
      });
    });
  }

  // ---------- Ajustes (azul) ----------

  var settingsSel = 0;

  function findIndex(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return i;
    return 0;
  }

  function settingsItems() {
    var t = config.theme;
    var info;
    if (!serviceInfo) info = 'Comprobando…';
    else if (serviceInfo.error) info = serviceInfo.error;
    else if (!serviceInfo.ip) info = 'No encuentro la IP de la tele';
    else info = 'http://' + serviceInfo.ip + ':' + serviceInfo.port + '/editor  ·  PIN ' + serviceInfo.pin;
    return [
      { label: 'Color de acento', list: ACCENTS, get: function () { return t.accent || '#ffffff'; }, set: function (v) { t.accent = v; } },
      { label: 'Tamaño de accesos', list: SIZES, get: function () { return t.size || 'm'; }, set: function (v) { t.size = v; } },
      { label: 'Tipografía', list: FONTS, get: function () { return t.font || 'sans'; }, set: function (v) { t.font = v; } },
      { label: 'Modo reposo OLED', list: SAVER, get: function () { return config.screensaver.minutes; }, set: function (v) { config.screensaver.minutes = v; } },
      { label: 'Abrir al iniciar TizenBrew', list: [{ name: 'No', value: false }, { name: 'Sí', value: true }],
        get: function () { return !!config.autolaunch; }, set: function (v) { config.autolaunch = v; setAutolaunch(v); } },
      { label: 'Editar desde el móvil', info: info }
    ];
  }

  function renderSettings() {
    var panel = $('settings');
    panel.innerHTML = '<h2>Ajustes</h2>';
    settingsItems().forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'item' + (it.info ? ' info' : '') + (i === settingsSel ? ' sel' : '');
      row.innerHTML = '<span></span><span class="val"></span>';
      row.children[0].textContent = it.label;
      row.children[1].textContent = it.info || it.list[findIndex(it.list, it.get())].name;
      panel.appendChild(row);
    });
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '↑↓ elegir · ←→ cambiar · Volver para cerrar. Para editar los accesos, abre la dirección de arriba en el navegador del móvil con la tele y el móvil en la misma wifi.';
    panel.appendChild(hint);
  }

  function toggleSettings() {
    var panel = $('settings');
    if (isOpen('settings')) { panel.className = 'panel'; return; }
    closePanels();
    panel.className = 'panel open';
    settingsSel = 0;
    renderSettings();
    serviceInfo = null;
    loadServiceInfo(function () { if (isOpen('settings')) renderSettings(); });
  }

  // Si el servicio que corre es de una versión anterior, TizenBrew no lo ha reiniciado tras
  // actualizar el módulo: el nuevo lo sustituye solo, pero si no lo consigue hay que reiniciar la tele.
  function loadServiceInfo(cb) {
    getJSON(SERVICE_URL + '/info', function (err, data) {
      if (err || !data || (data.version || 0) < SERVICE_VERSION) {
        serviceInfo = { error: err && /Sin conexión/.test(err.message)
          ? 'El servicio no responde: reinicia la tele'
          : 'Servicio antiguo: reinicia la tele' };
        return cb();
      }
      serviceInfo = data;
      if (data.ip) return cb();
      // Sin IP desde el servicio: TizenBrew responde con la IP de la tele en su raíz
      request('GET', 'http://127.0.0.1:8081/', undefined, function (e, ip) {
        if (!e && /^\d+\.\d+\.\d+\.\d+$/.test((ip || '').trim())) serviceInfo.ip = ip.trim();
        cb();
      }, true);
    });
  }

  function settingsKey(code) {
    var items = settingsItems();
    if (code === KEY.UP || code === KEY.DOWN) {
      settingsSel = Math.max(0, Math.min(items.length - 1, settingsSel + (code === KEY.DOWN ? 1 : -1)));
    } else if (code === KEY.LEFT || code === KEY.RIGHT) {
      var it = items[settingsSel];
      if (it.info) return;
      var i = findIndex(it.list, it.get()) + (code === KEY.RIGHT ? 1 : -1);
      i = (i + it.list.length) % it.list.length;
      it.set(it.list[i].value);
      applyTheme();
      renderRows();
      saveConfig();
    }
    renderSettings();
  }

  function closePanels() {
    $('applist').className = 'panel';
    $('settings').className = 'panel';
  }

  // ---------- Modo reposo OLED ----------

  var idleTimer = null;
  var saverMove = null;

  function moveSaverClock() {
    var c = $('saverClock');
    c.style.left = Math.round(80 + Math.random() * (1920 - 160 - 360)) + 'px';
    c.style.top = Math.round(80 + Math.random() * (1080 - 160 - 150)) + 'px';
  }

  function startSaver() {
    closePanels();
    $('saver').className = 'on';
    moveSaverClock();
    saverMove = setInterval(moveSaverClock, 60000);
  }

  function stopSaver() {
    $('saver').className = '';
    clearInterval(saverMove);
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    var min = config.screensaver.minutes;
    if (min > 0) idleTimer = setTimeout(startSaver, min * 60000);
  }

  // ---------- Mando ----------

  document.addEventListener('keydown', function (e) {
    var code = e.keyCode;
    if (!config) return;
    resetIdle();
    if ($('saver').className === 'on') { stopSaver(); e.preventDefault(); return; }

    if (code === KEY.BACK && (isOpen('applist') || isOpen('settings'))) {
      closePanels();
      e.preventDefault();
      return;
    }
    if (isOpen('settings') && code !== KEY.BLUE) {
      if (code >= KEY.LEFT && code <= KEY.DOWN) settingsKey(code);
      e.preventDefault();
      return;
    }
    if (isOpen('applist') && code !== KEY.YELLOW) {
      var apps = $('applist');
      if (code === KEY.UP || code === KEY.DOWN) {
        apps.scrollTop += (code === KEY.DOWN ? 1 : -1) * (apps.clientHeight - 80);
      }
      e.preventDefault();
      return;
    }

    switch (code) {
      case KEY.LEFT: move(-1, 0); break;
      case KEY.RIGHT: move(1, 0); break;
      case KEY.UP: move(0, -1); break;
      case KEY.DOWN: move(0, 1); break;
      case KEY.ENTER: launch(focusedTile()); break;
      case KEY.RED: location.reload(); break;
      case KEY.GREEN: {
        var i = (findIndex(SIZES, config.theme.size || 'm') + 1) % SIZES.length;
        config.theme.size = SIZES[i].value;
        applyTheme();
        renderRows();
        saveConfig();
        setStatus('Tamaño: ' + SIZES[i].name);
        break;
      }
      case KEY.YELLOW: toggleAppList(); break;
      case KEY.BLUE: toggleSettings(); break;
      case KEY.BACK: history.back(); break;
      default: return;
    }
    e.preventDefault();
  });

  // ---------- Arranque ----------

  function start(cfg) {
    config = cfg;
    $('title').textContent = cfg.title || 'Hola';
    if (cfg.background) {
      $('bg').style.backgroundImage = 'url("' + cfg.background + '")';
      $('bg').className = 'image';
    }
    applyTheme();
    renderRows();
    tickClock();
    setInterval(tickClock, 10000);
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000);
    renderCalendar();
    setInterval(renderCalendar, 60 * 60 * 1000);
    loadNews();
    setInterval(loadNews, 30 * 60 * 1000);
    loadHomeAssistant();
    setInterval(loadHomeAssistant, 60 * 1000);
    connectTizenBrew();
    resetIdle();
  }

  // Aplica el último tema antes de cargar la configuración, para que no parpadee
  try {
    var saved = JSON.parse(localStorage.getItem('daniLauncherTheme') || 'null');
    if (saved) {
      document.documentElement.style.setProperty('--accent', saved.accent || '#ffffff');
      document.body.className = 'size-' + (saved.size || 'm') + ' font-' + (saved.font || 'sans');
    }
  } catch (e) { /* sin almacenamiento */ }

  loadConfig(start);
})();
