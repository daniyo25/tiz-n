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
  var SERVICE_VERSION = 6; // la que trae service/service.js en esta versión
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
  var STYLES = [{ name: 'Apple TV', value: 'tvos' }, { name: 'Clásico', value: 'classic' }];
  var NEWS = [
    { name: 'El País', value: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada' },
    { name: 'El Mundo', value: 'https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml' },
    { name: 'elDiario.es', value: 'https://www.eldiario.es/rss/' },
    { name: '20minutos', value: 'https://www.20minutos.es/rss/' },
    { name: 'BBC Mundo', value: 'https://feeds.bbci.co.uk/mundo/rss.xml' },
    { name: 'Marca', value: 'https://e00-marca.uecdn.es/rss/portada.xml' },
    { name: 'Xataka', value: 'https://www.xataka.com/feedburner.xml' },
    { name: 'Ninguna', value: '' }
  ];
  var SAVER = [{ name: 'Nunca', value: 0 }, { name: '2 min', value: 2 }, { name: '5 min', value: 5 }, { name: '10 min', value: 10 }, { name: '30 min', value: 30 }];

  var config = null;
  var rowEls = [];      // [{ el, strip, tiles: [el], data: [tile] }]
  var focusRow = 0;
  var focusCol = [];    // última columna enfocada en cada fila
  var rowsY = 0;        // desplazamiento vertical de las filas
  var tbModules = null;
  var ws = null;
  var pendingModule = null;
  var serviceInfo = null;
  // Zonas del mando: menú de arriba, filas de accesos y columna de widgets
  var zone = 'rows';
  var topSel = 0;
  var sideSel = 0;
  var newsItems = [];   // [{ title, text, date, image }]
  var BOOT = Date.now(); // para pedir los logos de nuevo cada vez que se abre el módulo

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
    delete cfg.widgets.calendar;
    return cfg;
  }

  // El servicio tarda un momento en arrancar cuando TizenBrew abre el launcher
  // Lo último guardado en el servicio, para notar cambios hechos desde el móvil
  var savedJSON = null;

  function loadConfig(cb) {
    var tries = 0;
    function trySaved() {
      getJSON(SERVICE_URL + '/config', function (err, data) {
        if (!err && data && data.config) {
          savedJSON = JSON.stringify(data.config);
          return cb(normalize(data.config));
        }
        if (err && ++tries < 4) return setTimeout(trySaved, 700);
        loadBundled();
      });
    }
    function loadBundled() {
      savedJSON = '';
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
    savedJSON = JSON.stringify(config);
    try { localStorage.setItem('daniLauncherTheme', JSON.stringify(config.theme)); } catch (e) { /* sin almacenamiento */ }
    request('POST', SERVICE_URL + '/config', config, function (err, data) {
      if (err) setStatus('No se pudo guardar (' + errText(err, data) + ')');
    });
  }

  // ---------- Tema ----------

  function applyTheme() {
    var t = config.theme;
    document.documentElement.style.setProperty('--accent', t.accent || '#ffffff');
    var intro = document.body.className.indexOf('intro') !== -1 ? ' intro' : '';
    document.body.className = 'size-' + (t.size || 'm') + ' font-' + (t.font || 'sans') +
      ' style-' + (t.style || 'tvos') +
      (t.anim === false ? ' noanim' : '') + intro;
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
      buildSide();
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

  function proxyUrl(url, token) {
    return SERVICE_URL + '/proxy?url=' + encodeURIComponent(url) + (token ? '&token=' + encodeURIComponent(token) : '');
  }

  function loadNews() {
    var n = config.widgets.news;
    if (!n || !n.url) { $('w-news').className = 'widget hidden'; return; }
    request('GET', proxyUrl(n.url), undefined, function (err, text) {
      if (err || !text) return;
      var doc = new DOMParser().parseFromString(text, 'text/xml');
      var items = doc.querySelectorAll('item, entry');
      if (!items.length) return;
      newsItems = [];
      for (var i = 0; i < items.length && i < 25; i++) newsItems.push(parseNewsItem(items[i]));
      var box = widget('w-news', n.title || 'Noticias');
      var list = document.createElement('ul');
      list.className = 'news';
      newsItems.forEach(function (item) {
        var li = document.createElement('li');
        var t = document.createElement('span');
        t.textContent = item.title;
        li.appendChild(t);
        list.appendChild(li);
      });
      box.appendChild(list);
      buildSide();
    }, true);
  }

  function childText(node, names) {
    for (var i = 0; i < node.childNodes.length; i++) {
      var c = node.childNodes[i];
      if (names.indexOf(c.nodeName) !== -1 && c.textContent) return c.textContent.trim();
    }
    return '';
  }

  // Quita las etiquetas HTML que traen las descripciones de los RSS
  function plainText(html) {
    var div = document.createElement('div');
    div.innerHTML = html;
    var imgs = div.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) imgs[i].parentNode.removeChild(imgs[i]);
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function parseNewsItem(node) {
    var image = '';
    for (var i = 0; i < node.childNodes.length && !image; i++) {
      var c = node.childNodes[i];
      if (!c.getAttribute) continue;
      var type = c.getAttribute('type') || c.getAttribute('medium') || '';
      if ((c.nodeName === 'enclosure' || c.nodeName === 'media:content' || c.nodeName === 'media:thumbnail') &&
          (!type || type.indexOf('image') === 0) && c.getAttribute('url')) image = c.getAttribute('url');
    }
    var date = childText(node, ['pubDate', 'updated', 'published', 'dc:date']);
    return {
      title: childText(node, ['title']),
      text: plainText(childText(node, ['description', 'content:encoded', 'summary', 'content', 'media:description'])),
      date: date ? new Date(date) : null,
      image: image
    };
  }

  var HA_TOGGLE = { light: 'toggle', 'switch': 'toggle', fan: 'toggle', input_boolean: 'toggle', automation: 'toggle',
    cover: 'toggle', media_player: 'media_play_pause', script: 'turn_on', scene: 'turn_on', button: 'press' };
  var HA_STATES = { on: 'Encendido', off: 'Apagado', open: 'Abierto', closed: 'Cerrado', playing: 'Reproduciendo',
    paused: 'En pausa', idle: 'Inactivo', unavailable: 'No disponible', home: 'En casa', not_home: 'Fuera',
    locked: 'Cerrado', unlocked: 'Abierto', scening: '' };
  var haTimer = null;

  function loadHomeAssistant() {
    var ha = config.widgets.homeassistant;
    if (!ha || ha.enabled === false || !ha.url || !ha.token || !ha.entities || !ha.entities.length) {
      $('w-ha').className = 'widget hidden';
      buildSide();
      return;
    }
    var results = [];
    var pending = ha.entities.length;
    ha.entities.forEach(function (id, i) {
      getJSON(proxyUrl(ha.url.replace(/\/$/, '') + '/api/states/' + id, ha.token), function (err, s) {
        if (!err && s && s.state !== undefined) {
          var unit = s.attributes && s.attributes.unit_of_measurement ? ' ' + s.attributes.unit_of_measurement : '';
          results[i] = { id: id, name: (s.attributes && s.attributes.friendly_name) || id,
            value: (HA_STATES[s.state] !== undefined ? HA_STATES[s.state] : s.state) + unit, on: s.state === 'on' || s.state === 'open' || s.state === 'playing' };
        }
        if (--pending) return;
        var box = widget('w-ha', 'Casa');
        var wrap = document.createElement('div');
        wrap.className = 'ha';
        results.forEach(function (r) {
          if (!r) return;
          var line = document.createElement('div');
          var domain = r.id.split('.')[0];
          line.className = 'ha-item' + (HA_TOGGLE[domain] ? ' can' : '') + (r.on ? ' on' : '');
          line.setAttribute('data-id', r.id);
          line.innerHTML = '<span></span><span class="v"></span>';
          line.children[0].textContent = r.name;
          line.children[1].textContent = r.value;
          wrap.appendChild(line);
        });
        box.appendChild(wrap);
        buildSide();
      });
    });
  }

  // OK sobre una entidad de Home Assistant: encender/apagar, abrir/cerrar o activar
  function haAction(id) {
    var ha = config.widgets.homeassistant;
    var domain = id.split('.')[0];
    var service = HA_TOGGLE[domain];
    if (!service) return setStatus('Esta entidad solo se puede ver');
    var target = ha.url.replace(/\/$/, '') + '/api/services/' + domain + '/' + service;
    request('POST', proxyUrl(target, ha.token), { entity_id: id }, function (err) {
      if (err) return setStatus('Home Assistant no responde');
      clearTimeout(haTimer);
      haTimer = setTimeout(loadHomeAssistant, 600);
    });
  }

  // ---------- Spotify ----------

  var spotifyNow = null;

  function msText(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + pad(s % 60); }

  function loadSpotify() {
    if (config.widgets.spotify === false) { $('w-spotify').className = 'widget hidden'; buildSide(); return; }
    getJSON(SERVICE_URL + '/spotify/now', function (err, d) {
      if (err || !d || !d.connected) { $('w-spotify').className = 'widget hidden'; buildSide(); return; }
      spotifyNow = d;
      var box = widget('w-spotify', 'Spotify');
      var it = d.item;
      var wrap = document.createElement('div');
      wrap.className = 'sp';
      if (!it) {
        wrap.appendChild(line('No suena nada', 'sp-idle'));
      } else {
        var img = document.createElement('img');
        if (it.image) img.src = it.image;
        wrap.appendChild(img);
        var txt = document.createElement('div');
        txt.className = 'sp-txt';
        txt.appendChild(line(it.title, 'sp-title'));
        txt.appendChild(line(it.artist, 'sp-artist'));
        var bar = document.createElement('div');
        bar.className = 'sp-bar';
        var fill = document.createElement('div');
        fill.style.width = (it.duration ? Math.min(100, it.progress / it.duration * 100) : 0) + '%';
        bar.appendChild(fill);
        txt.appendChild(bar);
        txt.appendChild(line((d.playing ? '▶  ' : '❚❚  ') + msText(it.progress) + ' / ' + msText(it.duration), 'sp-time'));
        wrap.appendChild(txt);
      }
      box.appendChild(wrap);
      buildSide();
    });
  }

  function spotifyControl(action) {
    getJSON(SERVICE_URL + '/spotify/control?action=' + action, function (err, d) {
      if (err || !d.ok) setStatus('Spotify: ' + errText(err, d) + (d && /premium/i.test(d.error || '') ? '' : ''));
      setTimeout(loadSpotify, 500);
    });
  }

  // ---------- Enviar desde el móvil ----------

  var lastInbox = null;
  var viewerItem = null;

  function checkInbox() {
    if (!$('saver')) return;
    getJSON(SERVICE_URL + '/inbox', function (err, d) {
      if (err || !d) return;
      // Lo enviado antes de abrir el launcher no se muestra
      if (lastInbox === null) { lastInbox = d.item ? d.item.id : 0; return; }
      if (!d.item) return;
      if (d.item.id === lastInbox) return;
      lastInbox = d.item.id;
      showSent(d.item);
    });
  }

  function showSent(item) {
    if ($('saver').className === 'on') stopSaver();
    if (item.kind === 'youtube') {
      setStatus('Abriendo en YouTube…');
      return getJSON(SERVICE_URL + '/launch?id=111299001912&payload=' + encodeURIComponent('v=' + item.video), function () {});
    }
    if (item.kind === 'web') return setStatus('Solo se pueden enviar fotos, vídeos o enlaces de YouTube');
    closePanels();
    var v = $('viewer');
    v.innerHTML = '';
    viewerItem = item;
    var media;
    if (item.kind === 'image') {
      media = document.createElement('img');
    } else {
      media = document.createElement('video');
      media.autoplay = true;
      media.onended = function () { closeViewer(); };
    }
    media.src = item.src;
    media.onerror = function () { setStatus('No se pudo abrir lo enviado'); closeViewer(); };
    v.appendChild(media);
    v.appendChild(line(item.kind === 'video' ? 'OK pausa · ←→ 10 s · Volver para cerrar' : 'Volver para cerrar', 'viewer-hint'));
    v.className = 'on';
  }

  function closeViewer() {
    var v = $('viewer');
    var media = v.querySelector('video');
    if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
    v.className = '';
    v.innerHTML = '';
    viewerItem = null;
  }

  function viewerKey(code) {
    var media = $('viewer').querySelector('video');
    if (code === KEY.BACK) return closeViewer();
    if (!media) return;
    if (code === KEY.ENTER) { if (media.paused) media.play(); else media.pause(); }
    if (code === KEY.LEFT || code === KEY.RIGHT) media.currentTime = Math.max(0, media.currentTime + (code === KEY.RIGHT ? 10 : -10));
  }

  // ---------- Filas de accesos ----------

  function iconUrl(t) {
    if (t.icon) return t.icon;
    if (t.type === 'tvapp' && t.id) return SERVICE_URL + '/icon?id=' + encodeURIComponent(t.id) + '&v=' + BOOT;
    return null;
  }

  // Color medio del borde del logo, si es liso. Con ese color se rellena la tarjeta
  // y el logo ocupa todo el alto sin estirarse ni recortarse.
  function edgeColor(img) {
    try {
      var n = 24;
      var cv = document.createElement('canvas');
      cv.width = n; cv.height = n;
      var ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, n, n);
      var d = ctx.getImageData(0, 0, n, n).data;
      var px = [];
      for (var i = 0; i < n; i++) {
        [[i, 0], [i, n - 1], [0, i], [n - 1, i]].forEach(function (p) {
          var k = (p[1] * n + p[0]) * 4;
          px.push([d[k], d[k + 1], d[k + 2], d[k + 3]]);
        });
      }
      var avg = [0, 0, 0, 0];
      px.forEach(function (p) { for (var j = 0; j < 4; j++) avg[j] += p[j] / px.length; });
      if (avg[3] < 230) return null; // borde transparente: el logo no tiene fondo propio
      var dev = 0;
      px.forEach(function (p) { dev += Math.abs(p[0] - avg[0]) + Math.abs(p[1] - avg[1]) + Math.abs(p[2] - avg[2]); });
      if (dev / px.length > 40) return null; // borde con dibujo: mejor no rellenar
      return 'rgb(' + Math.round(avg[0]) + ',' + Math.round(avg[1]) + ',' + Math.round(avg[2]) + ')';
    } catch (e) { return null; }
  }

  function buildTile(t, r, c) {
    var el = document.createElement('div');
    el.className = 'tile';
    el.style.background = t.color || '#2a3550';
    var url = iconUrl(t);
    if (t.banner) {
      // Imagen panorámica propia: cubre la tarjeta entera
      el.style.backgroundImage = 'url("' + t.banner.replace(/"/g, '%22') + '")';
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.className += ' banner';
    } else if (url) {
      var img = document.createElement('img');
      img.crossOrigin = 'anonymous';
      // Las apps de la tele prueban primero una imagen panorámica de su carpeta
      var tryBanner = !t.icon && t.type === 'tvapp';
      img.onload = function () {
        var color = edgeColor(img);
        if (tryBanner) el.className += ' wide';
        if (color) {
          el.style.background = color;
          el.className += ' logo-fill';
        }
      };
      img.onerror = function () {
        if (tryBanner) { tryBanner = false; img.src = url; return; }
        if (img.parentNode) el.removeChild(img);
        el.className += ' noicon';
      };
      img.src = tryBanner ? url + '&kind=banner' : url;
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
      // Los accesos van en una pista que se desplaza con transform: más fluido en la tele que scrollLeft
      var track = document.createElement('div');
      track.className = 'track';
      strip.appendChild(track);
      var tiles = row.tiles.map(function (t, c) {
        var tile = buildTile(t, idx, c);
        track.appendChild(tile);
        return tile;
      });
      el.appendChild(title);
      el.appendChild(strip);
      inner.appendChild(el);
      rowEls.push({ el: el, strip: strip, track: track, x: 0, tiles: tiles, data: row.tiles });
      if (document.body.className.indexOf('intro') !== -1) el.style.animationDelay = (150 + idx * 90) + 'ms';
      if (focusCol[idx] === undefined || focusCol[idx] >= tiles.length) focusCol[idx] = 0;
    });
    if (focusRow >= rowEls.length) focusRow = 0;
    setFocus(focusRow, focusCol[focusRow] || 0);
  }

  function setFocus(r, c) {
    if (!rowEls.length) return;
    var prev = document.querySelectorAll('.tile.focused, .row.active');
    for (var i = 0; i < prev.length; i++) prev[i].className = prev[i].className.replace(/ (focused|active)/g, '');
    focusRow = r;
    focusCol[r] = c;
    var row = rowEls[r];
    var tile = row.tiles[c];
    row.el.className += ' active';
    tile.className += ' focused';
    // Mantener visible el acceso enfocado (horizontal) y la fila enfocada (vertical)
    var visible = row.strip.clientWidth - 32;
    if (tile.offsetLeft + tile.offsetWidth + 24 > row.x + visible) row.x = tile.offsetLeft + tile.offsetWidth + 24 - visible;
    else if (tile.offsetLeft < row.x) row.x = Math.max(0, tile.offsetLeft);
    row.track.style.transform = 'translateX(' + (-row.x) + 'px)';
    var rows = $('rows'), inner = $('rowsInner');
    if (row.el.offsetTop < rowsY) rowsY = row.el.offsetTop;
    else if (row.el.offsetTop + row.el.offsetHeight > rowsY + rows.clientHeight) {
      rowsY = row.el.offsetTop + row.el.offsetHeight - rows.clientHeight;
    }
    inner.style.transform = 'translateY(' + (-rowsY) + 'px)';
  }

  function move(dx, dy) {
    if (!rowEls.length) return;
    if (dy) {
      var r = focusRow + dy;
      if (r < 0) return setZone('top');
      if (r >= rowEls.length) return;
      setFocus(r, Math.min(focusCol[r] || 0, rowEls[r].tiles.length - 1));
    } else {
      var c = focusCol[focusRow] + dx;
      if (c >= rowEls[focusRow].tiles.length && sideItems().length) return setZone('side');
      if (c < 0 || c >= rowEls[focusRow].tiles.length) return;
      setFocus(focusRow, c);
    }
  }

  // Pequeño "clic" visual antes de abrir
  function press() {
    var row = rowEls[focusRow];
    if (!row) return;
    var tile = row.tiles[focusCol[focusRow]];
    var data = focusedTile();
    if (!config.theme.anim && config.theme.anim !== undefined) return launch(data);
    tile.className += ' pressed';
    setTimeout(function () {
      tile.className = tile.className.replace(' pressed', '');
      launch(data);
    }, 140);
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

  // ---------- Editar (amarillo): accesos del launcher y apps instaladas ----------

  function isOpen(id) { return $(id).className === 'panel open'; }

  // items: [{ head }, { tile, r, i }, { widget }, { app }]
  var appList = { apps: [], items: [], sel: 0, mode: 'list', choices: [], choiceSel: 0 };

  function toggleAppList() {
    var panel = $('applist');
    if (isOpen('applist')) { panel.className = 'panel'; return; }
    closePanels();
    panel.className = 'panel open';
    appList.mode = 'list';
    buildEditItems();
    renderAppList();
    getJSON(SERVICE_URL + '/apps', function (err, data) {
      appList.error = err || !data.apps ? 'No se pudo obtener la lista de apps (' + errText(err, data) + ')' : '';
      appList.apps = (data && data.apps) || [];
      buildEditItems();
      if (isOpen('applist')) renderAppList();
    });
  }

  function buildEditItems() {
    var items = [{ head: 'En el launcher · OK para quitar o mover' }];
    config.rows.forEach(function (row, r) {
      (row.tiles || []).forEach(function (t, i) { items.push({ tile: t, r: r, i: i }); });
    });
    items.push({ head: 'Widgets · OK o ←→ para cambiar' });
    widgetItems().forEach(function (w) { items.push({ widget: w }); });
    items.push({ head: appList.error || (appList.apps.length ? 'Apps instaladas (' + appList.apps.length + ') · OK para añadir' : 'Cargando apps instaladas…') });
    appList.apps.forEach(function (a) { items.push({ app: a }); });
    appList.items = items;
    if (appList.sel >= items.length || !selectable(appList.sel)) appList.sel = nextSelectable(-1, 1);
  }

  function selectable(i) { return appList.items[i] && !appList.items[i].head; }
  function nextSelectable(from, dir) {
    for (var i = from + dir; i >= 0 && i < appList.items.length; i += dir) if (selectable(i)) return i;
    return from < 0 ? 0 : from;
  }

  // Dónde está ya una app de la tele: { r, i } o null
  function findTvApp(id) {
    for (var r = 0; r < config.rows.length; r++) {
      var tiles = config.rows[r].tiles || [];
      for (var i = 0; i < tiles.length; i++) if (tiles[i].type === 'tvapp' && tiles[i].id === id) return { r: r, i: i };
    }
    return null;
  }

  function line(text, className) {
    var el = document.createElement('div');
    el.className = className || '';
    el.textContent = text;
    return el;
  }

  function listIcon(src, color) {
    var box = document.createElement('span');
    box.className = 'ico';
    box.style.background = color || '#262a33';
    if (src) {
      var img = document.createElement('img');
      img.onerror = function () { if (img.parentNode) box.removeChild(img); };
      img.src = src;
      box.appendChild(img);
    }
    return box;
  }

  function renderAppList() {
    var panel = $('applist');
    panel.innerHTML = '';
    var selEl = null;
    if (appList.mode === 'list') {
      panel.appendChild(line('Editar', 'title'));
      appList.items.forEach(function (it, i) {
        if (it.head) return panel.appendChild(line(it.head, 'head'));
        var el = document.createElement('div');
        el.className = 'app' + (i === appList.sel ? ' sel' : '');
        var name = document.createElement('span');
        name.className = 'nm';
        var sub = document.createElement('span');
        sub.className = 'id';
        if (it.widget) {
          el.className += ' opt';
          name.textContent = it.widget.label;
          var cur = it.widget.list[findIndex(it.widget.list, it.widget.get())];
          sub.className = 'val';
          sub.textContent = cur ? cur.name : '—';
        } else if (it.tile) {
          el.appendChild(listIcon(iconUrl(it.tile), it.tile.color));
          name.textContent = it.tile.name || it.tile.id;
          sub.textContent = (config.rows[it.r].title || '') + (it.tile.type === 'module' ? ' · TizenBrew' : it.tile.type === 'url' ? ' · Web' : '');
        } else {
          el.appendChild(listIcon(SERVICE_URL + '/icon?id=' + encodeURIComponent(it.app.id) + '&v=' + BOOT));
          var at = findTvApp(it.app.id);
          name.textContent = it.app.name;
          sub.textContent = at ? '✓ ' + (config.rows[at.r].title || '') : it.app.id;
        }
        el.appendChild(name);
        el.appendChild(sub);
        panel.appendChild(el);
        if (i === appList.sel) selEl = el;
      });
    } else {
      panel.appendChild(line(appList.choiceTitle, 'title'));
      appList.choices.forEach(function (c, i) {
        var el = line(c.label, 'app' + (i === appList.choiceSel ? ' sel' : ''));
        panel.appendChild(el);
        if (i === appList.choiceSel) selEl = el;
      });
      panel.appendChild(line('Volver para cancelar', 'head'));
    }
    // Mantener visible la línea seleccionada
    if (selEl) {
      if (selEl.offsetTop < panel.scrollTop + 80) panel.scrollTop = selEl.offsetTop - 80;
      else if (selEl.offsetTop + selEl.offsetHeight > panel.scrollTop + panel.clientHeight - 20) {
        panel.scrollTop = selEl.offsetTop + selEl.offsetHeight - panel.clientHeight + 20;
      }
    }
  }

  function changeWidget(it, dir) {
    cycleOption(it.widget, dir);
    saveConfig();
    buildEditItems();
    renderAppList();
  }

  function openRowChooser() {
    var it = appList.items[appList.sel];
    if (!it || it.head) return;
    if (it.widget) return changeWidget(it, 1);
    var at = it.tile ? { r: it.r, i: it.i } : findTvApp(it.app.id);
    var choices = [];
    if (at) choices.push({ label: 'Quitar del launcher', remove: true });
    config.rows.forEach(function (row, r) {
      if (!at || r !== at.r) choices.push({ label: (at ? 'Mover a «' : 'Añadir a «') + (row.title || '') + '»', row: r });
    });
    if (at && at.i > 0) choices.push({ label: 'Mover a la izquierda', shift: -1 });
    if (at && at.i < config.rows[at.r].tiles.length - 1) choices.push({ label: 'Mover a la derecha', shift: 1 });
    choices.push({ label: 'Nueva fila «Mis apps»', row: -1 });
    appList.choiceTitle = (it.tile ? it.tile.name : it.app.name) + (at ? ' · ¿qué hago?' : ' · ¿dónde la pongo?');
    appList.target = { at: at, app: it.app };
    appList.choices = choices;
    appList.choiceSel = 0;
    appList.mode = 'rows';
    renderAppList();
  }

  function applyRowChoice() {
    var target = appList.target;
    var choice = appList.choices[appList.choiceSel];
    var at = target.at;
    var tile = null;
    if (choice.shift) {
      var list = config.rows[at.r].tiles;
      var j = at.i + choice.shift;
      var moved = list[at.i]; list[at.i] = list[j]; list[j] = moved;
      setStatus((moved.name || '') + ' movida');
    } else {
      if (at) tile = config.rows[at.r].tiles.splice(at.i, 1)[0];
      var name = tile ? tile.name : target.app.name;
      if (choice.remove) {
        setStatus(name + ' quitada del launcher');
      } else {
        var r = choice.row;
        if (r < 0) {
          config.rows.push({ title: 'Mis apps', tiles: [] });
          r = config.rows.length - 1;
        }
        // Fondo oscuro neutro: el logo de la app ya da el color
        config.rows[r].tiles.push(tile || { name: target.app.name, type: 'tvapp', id: target.app.id, color: '#1c1f26' });
        setStatus(name + (at ? ' movida a «' : ' añadida a «') + config.rows[r].title + '»');
      }
    }
    // Las filas que se quedan vacías desaparecen
    config.rows = config.rows.filter(function (row) { return row.tiles && row.tiles.length; });
    saveConfig();
    renderRows();
    appList.mode = 'list';
    buildEditItems();
    if (!selectable(appList.sel)) appList.sel = nextSelectable(appList.sel, -1);
    renderAppList();
  }

  function appListKey(code) {
    if (appList.mode === 'list') {
      if (code === KEY.UP || code === KEY.DOWN) {
        appList.sel = nextSelectable(appList.sel, code === KEY.DOWN ? 1 : -1);
      } else if ((code === KEY.LEFT || code === KEY.RIGHT) && appList.items[appList.sel].widget) {
        return changeWidget(appList.items[appList.sel], code === KEY.RIGHT ? 1 : -1);
      } else if (code === KEY.LEFT || code === KEY.RIGHT) {
        // Saltar de 10 en 10 para listas largas
        for (var k = 0; k < 10; k++) appList.sel = nextSelectable(appList.sel, code === KEY.RIGHT ? 1 : -1);
      } else if (code === KEY.ENTER) return openRowChooser();
      renderAppList();
    } else {
      if (code === KEY.UP || code === KEY.DOWN) {
        appList.choiceSel = Math.max(0, Math.min(appList.choices.length - 1, appList.choiceSel + (code === KEY.DOWN ? 1 : -1)));
        renderAppList();
      } else if (code === KEY.ENTER) applyRowChoice();
    }
  }

  // ---------- Ajustes (azul) ----------

  var settingsSel = 0;

  function findIndex(list, value) {
    for (var i = 0; i < list.length; i++) if (list[i].value === value) return i;
    return 0;
  }

  // Opciones de los widgets, compartidas por Ajustes y Editar
  function newsItem() {
    var n = config.widgets.news || {};
    var list = NEWS.slice();
    if (n.url && !list.some(function (o) { return o.value === n.url; })) list.unshift({ name: n.title || 'Personalizada', value: n.url });
    return {
      label: 'Noticias', list: list,
      get: function () { return n.url || ''; },
      set: function (v) {
        var src = list[findIndex(list, v)];
        config.widgets.news = v ? { title: src.name, url: v } : null;
      },
      after: function () { newsItems = []; loadNews(); }
    };
  }

  function widgetItems() {
    var items = [
      { label: 'Previsión del tiempo', list: [{ name: 'Sí', value: true }, { name: 'No', value: false }],
        get: function () { return !!config.widgets.forecast; },
        set: function (v) { config.widgets.forecast = v; },
        after: function () { if (config.widgets.forecast) loadWeather(); else $('w-forecast').className = 'widget hidden'; } },
      newsItem()
    ];
    items.push({ label: 'Spotify', list: [{ name: 'Sí', value: true }, { name: 'No', value: false }],
      get: function () { return config.widgets.spotify !== false; },
      set: function (v) { config.widgets.spotify = v; },
      after: function () { loadSpotify(); } });
    var ha = config.widgets.homeassistant;
    if (ha && ha.url && ha.token) {
      items.push({ label: 'Casa (Home Assistant)', list: [{ name: 'Sí', value: true }, { name: 'No', value: false }],
        get: function () { return ha.enabled !== false; },
        set: function (v) { ha.enabled = v; },
        after: function () { loadHomeAssistant(); } });
    }
    return items;
  }

  function cycleOption(it, dir) {
    var i = findIndex(it.list, it.get());
    i = ((i < 0 ? 0 : i + dir) + it.list.length) % it.list.length;
    it.set(it.list[i].value);
    if (it.after) it.after();
  }

  function settingsItems() {
    var t = config.theme;
    var info;
    if (!serviceInfo) info = 'Comprobando…';
    else if (serviceInfo.error) info = serviceInfo.error;
    else if (!serviceInfo.ip) info = 'No encuentro la IP de la tele';
    else info = 'http://' + serviceInfo.ip + ':' + serviceInfo.port + '/editor  ·  PIN ' + serviceInfo.pin;
    return [
      { label: 'Estilo', list: STYLES, get: function () { return t.style || 'tvos'; }, set: function (v) { t.style = v; } },
      { label: 'Color de acento', list: ACCENTS, get: function () { return t.accent || '#ffffff'; }, set: function (v) { t.accent = v; } },
      { label: 'Tamaño de accesos', list: SIZES, get: function () { return t.size || 'm'; }, set: function (v) { t.size = v; } },
      { label: 'Tipografía', list: FONTS, get: function () { return t.font || 'sans'; }, set: function (v) { t.font = v; } },
      { label: 'Animaciones', list: [{ name: 'Sí', value: true }, { name: 'No', value: false }],
        get: function () { return t.anim !== false; }, set: function (v) { t.anim = v; } },
      newsItem(),
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
      cycleOption(it, code === KEY.RIGHT ? 1 : -1);
      applyTheme();
      renderRows();
      saveConfig();
    }
    renderSettings();
  }

  function closePanels() {
    $('applist').className = 'panel';
    $('settings').className = 'panel';
    $('weatherPanel').className = 'panel';
    $('newsPanel').className = 'panel';
  }

  // ---------- Menú de arriba y columna de widgets ----------

  var TOP_ITEMS = [
    { id: 'm-apps', action: function () { toggleAppList(); } },
    { id: 'm-settings', action: function () { toggleSettings(); } },
    { id: 'm-reload', action: function () { location.reload(); } },
    { id: 'weather', action: function () { openWeather(); } }
  ];

  function clearSel() {
    var prev = document.querySelectorAll('.nav-sel');
    for (var i = 0; i < prev.length; i++) prev[i].className = prev[i].className.replace(/ ?nav-sel/g, '');
  }

  function setZone(z) {
    zone = z;
    clearSel();
    var prev = document.querySelectorAll('.tile.focused, .row.active');
    for (var i = 0; i < prev.length; i++) prev[i].className = prev[i].className.replace(/ (focused|active)/g, '');
    if (z === 'rows') return setFocus(focusRow, focusCol[focusRow] || 0);
    if (z === 'top') $(TOP_ITEMS[topSel].id).className += ' nav-sel';
    if (z === 'side') showSideSel();
  }

  function topKey(code) {
    if (code === KEY.DOWN) return setZone('rows');
    if (code === KEY.ENTER) return TOP_ITEMS[topSel].action();
    if (code === KEY.UP) return;
    var i = topSel + (code === KEY.RIGHT ? 1 : -1);
    if (i < 0 || i >= TOP_ITEMS.length) return;
    topSel = i;
    setZone('top');
  }

  // Elementos de la columna derecha que se pueden elegir con el mando
  function sideItems() {
    var items = [];
    if ($('w-forecast').className.indexOf('hidden') === -1) items.push({ el: $('w-forecast'), action: openWeather });
    if ($('w-spotify').className.indexOf('hidden') === -1) {
      items.push({ el: $('w-spotify'), action: function () { spotifyControl(spotifyNow && spotifyNow.playing ? 'pause' : 'play'); } });
    }
    var has = $('w-ha').className.indexOf('hidden') === -1 ? document.querySelectorAll('#w-ha .ha-item') : [];
    for (var h = 0; h < has.length; h++) items.push({ el: has[h], action: (function (id) { return function () { haAction(id); }; })(has[h].getAttribute('data-id')) });
    var lis = $('w-news').className.indexOf('hidden') === -1 ? document.querySelectorAll('#w-news li') : [];
    for (var i = 0; i < lis.length; i++) items.push({ el: lis[i], news: i, action: (function (n) { return function () { openNews(n); }; })(i) });
    return items;
  }

  function buildSide() {
    if (zone !== 'side') return;
    var n = sideItems().length;
    if (!n) return setZone('rows');
    if (sideSel >= n) sideSel = n - 1;
    showSideSel();
  }

  function showSideSel() {
    clearSel();
    var items = sideItems();
    var it = items[sideSel];
    if (!it) return;
    it.el.className += ' nav-sel';
    // Desplaza la lista de noticias para que la elegida quede a la vista
    var list = document.querySelector('#w-news .news');
    if (list && it.news !== undefined) {
      // .news tiene position: relative, así que offsetTop ya es relativo a la lista
      var li = it.el;
      if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
      else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
      }
    } else if (list && it.news === undefined) list.scrollTop = 0;
  }

  function sideKey(code) {
    var items = sideItems();
    if (code === KEY.LEFT) return setZone('rows');
    if (code === KEY.ENTER) return items[sideSel] && items[sideSel].action();
    if (code === KEY.RIGHT) {
      if (items[sideSel] && items[sideSel].el.id === 'w-spotify') spotifyControl('next');
      return;
    }
    var i = sideSel + (code === KEY.DOWN ? 1 : -1);
    if (i < 0) return setZone('top');
    if (i >= items.length) return;
    sideSel = i;
    showSideSel();
  }

  // ---------- Noticia completa ----------

  var newsSel = 0;

  function openNews(i) {
    if (i < 0 || i >= newsItems.length) return;
    newsSel = i;
    var item = newsItems[i];
    var panel = $('newsPanel');
    closePanels();
    panel.innerHTML = '';
    var body = document.createElement('div');
    body.id = 'newsBody';
    if (item.image) {
      var img = document.createElement('img');
      img.src = item.image;
      img.onerror = function () { if (img.parentNode) img.parentNode.removeChild(img); };
      body.appendChild(img);
    }
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = ((config.widgets.news && config.widgets.news.title) || 'Noticias') +
      (item.date && !isNaN(item.date) ? ' · ' + item.date.toLocaleString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '');
    var h = document.createElement('h2');
    h.textContent = item.title;
    var p = document.createElement('p');
    p.textContent = item.text || 'Esta noticia no trae resumen.';
    body.appendChild(meta);
    body.appendChild(h);
    body.appendChild(p);
    panel.appendChild(body);
    var hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = (i + 1) + ' de ' + newsItems.length + ' · ←→ otra noticia · ↑↓ desplazar · Volver para cerrar';
    panel.appendChild(hint);
    panel.className = 'panel open';
    // Lleva también la selección de la columna a esa noticia
    var items = sideItems();
    for (var k = 0; k < items.length; k++) if (items[k].news === i) sideSel = k;
    if (zone === 'side') showSideSel();
  }

  // ---------- El tiempo, con más detalle ----------

  function windDir(deg) {
    return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(deg / 45) % 8];
  }

  function openWeather() {
    var w = config.weather;
    if (!w) return setStatus('Elige una ciudad en el editor del móvil');
    var panel = $('weatherPanel');
    closePanels();
    panel.innerHTML = '<h2></h2><p class="hint">Cargando…</p>';
    panel.children[0].textContent = 'El tiempo en ' + w.city;
    panel.className = 'panel open';
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.latitude + '&longitude=' + w.longitude +
      '&timezone=auto&forecast_days=7' +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,pressure_msl,cloud_cover' +
      '&hourly=temperature_2m,precipitation_probability,weather_code' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max';
    getJSON(url, function (err, d) {
      if (!isOpen('weatherPanel')) return;
      if (err || !d || !d.current) { panel.children[1].textContent = 'No se pudo cargar el tiempo'; return; }
      renderWeatherPanel(panel, w, d);
    });
  }

  function cell(parent, cls, text) {
    var c = document.createElement('div');
    c.className = cls;
    c.textContent = text;
    parent.appendChild(c);
    return c;
  }

  function renderWeatherPanel(panel, w, d) {
    var c = d.current, day = d.daily;
    panel.innerHTML = '';
    var top = document.createElement('div');
    top.className = 'wx-now';
    var left = document.createElement('div');
    cell(left, 'wx-city', w.city);
    cell(left, 'wx-temp', Math.round(c.temperature_2m) + '°');
    cell(left, 'wx-desc', (WEATHER_CODES[c.weather_code] || '') + ' · Máx. ' + Math.round(day.temperature_2m_max[0]) + '° Mín. ' + Math.round(day.temperature_2m_min[0]) + '°');
    top.appendChild(left);
    var facts = document.createElement('div');
    facts.className = 'wx-facts';
    [
      ['Sensación', Math.round(c.apparent_temperature) + '°'],
      ['Humedad', Math.round(c.relative_humidity_2m) + ' %'],
      ['Viento', Math.round(c.wind_speed_10m) + ' km/h ' + windDir(c.wind_direction_10m)],
      ['Lluvia hoy', (day.precipitation_sum[0] || 0).toFixed(1) + ' mm · ' + (day.precipitation_probability_max[0] || 0) + ' %'],
      ['Índice UV', Math.round(day.uv_index_max[0] || 0)],
      ['Nubes', Math.round(c.cloud_cover) + ' %'],
      ['Presión', Math.round(c.pressure_msl) + ' hPa'],
      ['Sol', day.sunrise[0].slice(11, 16) + ' – ' + day.sunset[0].slice(11, 16)]
    ].forEach(function (f) {
      var box = document.createElement('div');
      cell(box, 'k', f[0]);
      cell(box, 'v', '' + f[1]);
      facts.appendChild(box);
    });
    top.appendChild(facts);
    panel.appendChild(top);

    // Próximas 24 horas, desde la hora actual
    cell(panel, 'wx-h', 'Próximas horas');
    var hours = document.createElement('div');
    hours.className = 'wx-hours';
    var now = c.time.slice(0, 13);
    var start = 0;
    for (var i = 0; i < d.hourly.time.length; i++) if (d.hourly.time[i].slice(0, 13) === now) { start = i; break; }
    for (var j = start; j < start + 24 && j < d.hourly.time.length; j += 2) {
      var h = document.createElement('div');
      cell(h, 'k', j === start ? 'Ahora' : d.hourly.time[j].slice(11, 16));
      cell(h, 'v', Math.round(d.hourly.temperature_2m[j]) + '°');
      cell(h, 's', (WEATHER_CODES[d.hourly.weather_code[j]] || '').replace('Parcialmente nuboso', 'Nubes y claros'));
      cell(h, 'p', (d.hourly.precipitation_probability[j] || 0) + ' %');
      hours.appendChild(h);
    }
    panel.appendChild(hours);

    // Siete días con barra de temperaturas
    cell(panel, 'wx-h', 'Próximos 7 días');
    var days = document.createElement('div');
    days.className = 'wx-days';
    var lo = Math.min.apply(null, day.temperature_2m_min), hi = Math.max.apply(null, day.temperature_2m_max);
    for (var k = 0; k < day.time.length; k++) {
      var row = document.createElement('div');
      var name = k === 0 ? 'Hoy' : new Date(day.time[k] + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long' });
      cell(row, 'd', name.charAt(0).toUpperCase() + name.slice(1));
      cell(row, 's', WEATHER_CODES[day.weather_code[k]] || '');
      cell(row, 'p', (day.precipitation_probability_max[k] || 0) + ' %');
      cell(row, 'lo', Math.round(day.temperature_2m_min[k]) + '°');
      var bar = cell(row, 'bar', '');
      var fill = cell(bar, 'fill', '');
      var span = Math.max(1, hi - lo);
      fill.style.left = ((day.temperature_2m_min[k] - lo) / span * 100) + '%';
      fill.style.width = Math.max(4, (day.temperature_2m_max[k] - day.temperature_2m_min[k]) / span * 100) + '%';
      cell(row, 'hi', Math.round(day.temperature_2m_max[k]) + '°');
      days.appendChild(row);
    }
    panel.appendChild(days);
    cell(panel, 'hint', 'Datos de Open-Meteo · Volver para cerrar');
  }

  // ---------- Modo reposo OLED ----------

  var idleTimer = null;
  var saverMove = null;

  function moveSaverClock() {
    var c = $('saverClock');
    // Se apaga, cambia de sitio y vuelve a aparecer
    c.style.opacity = '0';
    setTimeout(function () { placeSaverClock(c); c.style.opacity = ''; }, 1000);
  }

  function placeSaverClock(c) {
    c.style.left = Math.round(80 + Math.random() * (1920 - 160 - 360)) + 'px';
    c.style.top = Math.round(80 + Math.random() * (1080 - 160 - 150)) + 'px';
  }

  function startSaver() {
    if ($('viewer').className === 'on') return resetIdle();
    closePanels();
    $('saver').className = 'on';
    placeSaverClock($('saverClock'));
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
    if ($('viewer').className === 'on') { viewerKey(code); e.preventDefault(); return; }

    if (code === KEY.BACK && isOpen('applist') && appList.mode === 'rows') {
      appList.mode = 'list';
      renderAppList();
      e.preventDefault();
      return;
    }
    if (code === KEY.BACK && (isOpen('applist') || isOpen('settings') || isOpen('weatherPanel') || isOpen('newsPanel'))) {
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
      appListKey(code);
      e.preventDefault();
      return;
    }
    if (isOpen('newsPanel')) {
      if (code === KEY.UP || code === KEY.DOWN) $('newsBody').scrollTop += code === KEY.DOWN ? 160 : -160;
      if (code === KEY.LEFT || code === KEY.RIGHT) openNews(newsSel + (code === KEY.RIGHT ? 1 : -1));
      if (code === KEY.ENTER) closePanels();
      e.preventDefault();
      return;
    }
    if (isOpen('weatherPanel')) {
      if (code === KEY.ENTER) closePanels();
      e.preventDefault();
      return;
    }
    if (zone !== 'rows' && (code === KEY.LEFT || code === KEY.RIGHT || code === KEY.UP || code === KEY.DOWN || code === KEY.ENTER)) {
      if (zone === 'top') topKey(code); else sideKey(code);
      e.preventDefault();
      return;
    }

    switch (code) {
      case KEY.LEFT: move(-1, 0); break;
      case KEY.RIGHT: move(1, 0); break;
      case KEY.UP: move(0, -1); break;
      case KEY.DOWN: move(0, 1); break;
      case KEY.ENTER: press(); break;
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

  // ---------- Fondo y cambios desde el móvil ----------

  function applyBackground(url) {
    var bg = $('bg');
    url = (url || '').trim();
    if (!url) { bg.style.backgroundImage = ''; bg.className = ''; return; }
    // Se precarga para avisar si la URL no es una imagen (p. ej. una página de Google Imágenes)
    var img = new Image();
    img.onload = function () {
      bg.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
      bg.className = 'image';
    };
    img.onerror = function () { setStatus('El fondo no es una imagen válida'); };
    img.src = url;
  }

  // Si se guarda desde el móvil, la tele se recarga sola (sin interrumpir paneles ni el reposo)
  function watchConfig() {
    setInterval(function () {
      if (isOpen('applist') || isOpen('settings') || $('saver').className === 'on') return;
      getJSON(SERVICE_URL + '/config', function (err, data) {
        if (err || !data || !data.config) return;
        var json = JSON.stringify(data.config);
        if (savedJSON !== null && json !== savedJSON) return location.reload();
        savedJSON = json;
      });
    }, 5000);
  }

  // ---------- Arranque ----------

  function start(cfg) {
    config = cfg;
    // Animación de entrada solo al abrir el launcher, no al cambiar ajustes
    document.body.className += ' intro';
    setTimeout(function () { document.body.className = document.body.className.replace(' intro', ''); }, 2500);
    $('title').textContent = cfg.title || 'Hola';
    applyBackground(cfg.background);
    applyTheme();
    renderRows();
    tickClock();
    setInterval(tickClock, 10000);
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000);
    loadNews();
    setInterval(loadNews, 30 * 60 * 1000);
    loadHomeAssistant();
    setInterval(loadHomeAssistant, 60 * 1000);
    loadSpotify();
    setInterval(function () { if ($('saver').className !== 'on') loadSpotify(); }, 5000);
    checkInbox();
    setInterval(checkInbox, 2000);
    connectTizenBrew();
    watchConfig();
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
