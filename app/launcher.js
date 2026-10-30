/* Dani Launcher: módulo "app" de TizenBrew.
 * TizenBrew sirve esta página desde http://127.0.0.1:8081/module/<módulo>/app/index.html,
 * así que el WebSocket del servicio de TizenBrew está en el mismo origen.
 * Escrito en ES5 para que funcione también en Tizen antiguos. */
(function () {
  'use strict';

  var KEY = {
    LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
    BACK: 10009, RED: 403, GREEN: 404
  };
  var TB_WS_URL = 'ws://127.0.0.1:8081';
  var TV_API = 'http://127.0.0.1:8001/api/v2/applications/';
  var TB_EVENTS = { GetModules: 4, LaunchModule: 5, Error: 8 };

  var WEATHER_CODES = {
    0: 'Despejado', 1: 'Casi despejado', 2: 'Parcialmente nuboso', 3: 'Nublado',
    45: 'Niebla', 48: 'Niebla', 51: 'Llovizna', 53: 'Llovizna', 55: 'Llovizna',
    61: 'Lluvia', 63: 'Lluvia', 65: 'Lluvia fuerte', 71: 'Nieve', 73: 'Nieve', 75: 'Nieve',
    80: 'Chubascos', 81: 'Chubascos', 82: 'Chubascos fuertes', 95: 'Tormenta', 96: 'Tormenta', 99: 'Tormenta'
  };

  var config = null;
  var tiles = [];
  var focus = 0;
  var tbModules = null;
  var ws = null;
  var pendingModule = null;

  function $(id) { return document.getElementById(id); }

  function setStatus(text) {
    $('status').textContent = text || '';
    if (text) {
      clearTimeout(setStatus.t);
      setStatus.t = setTimeout(function () { $('status').textContent = ''; }, 5000);
    }
  }

  function getJSON(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { cb(null, JSON.parse(xhr.responseText)); } catch (e) { cb(e); }
      } else cb(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = function () { cb(new Error('Sin conexión')); };
    xhr.send();
  }

  // Reloj y fecha
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function tickClock() {
    var d = new Date();
    $('clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var date = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    $('date').textContent = date.charAt(0).toUpperCase() + date.slice(1);
  }

  // Tiempo con Open-Meteo (sin clave de API)
  function loadWeather() {
    var w = config.weather;
    if (!w) return;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + w.latitude +
      '&longitude=' + w.longitude + '&current_weather=true&timezone=auto';
    getJSON(url, function (err, data) {
      if (err || !data.current_weather) return;
      var cw = data.current_weather;
      var desc = WEATHER_CODES[cw.weathercode] || '';
      $('weather').textContent = w.city + ' · ' + Math.round(cw.temperature) + '°C ' + desc;
    });
  }

  // Cuadrícula
  function columns() {
    return document.body.className.indexOf('compact') !== -1 ? 6 : 4;
  }

  function render() {
    var grid = $('grid');
    grid.innerHTML = '';
    tiles = [];
    config.tiles.forEach(function (t, i) {
      var el = document.createElement('div');
      el.className = 'tile';
      el.style.background = t.color || '#2a3550';
      el.textContent = t.name;
      var kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = t.type === 'module' ? 'TizenBrew' : '';
      el.appendChild(kind);
      el.addEventListener('click', function () { focus = i; updateFocus(); launch(t); });
      grid.appendChild(el);
      tiles.push(el);
    });
    if (focus >= tiles.length) focus = 0;
    updateFocus();
  }

  function updateFocus() {
    tiles.forEach(function (el, i) {
      el.className = i === focus ? 'tile focused' : 'tile';
    });
  }

  function move(dx, dy) {
    var cols = columns();
    var next = focus + dx + dy * cols;
    if (dx !== 0 && Math.floor(next / cols) !== Math.floor(focus / cols)) return;
    if (next < 0 || next >= tiles.length) return;
    focus = next;
    updateFocus();
  }

  // Lanzar apps de la TV
  function launchTvApp(appId, name) {
    setStatus('Abriendo ' + name + '…');
    if (window.tizen && tizen.application) {
      try {
        tizen.application.launch(appId, null, function () { fallbackLaunch(appId, name); });
        return;
      } catch (e) { /* sin permisos en esta página: usamos la API local */ }
    }
    fallbackLaunch(appId, name);
  }

  function fallbackLaunch(appId, name) {
    var xhr = new XMLHttpRequest();
    xhr.open('POST', TV_API + appId, true);
    xhr.onload = function () {
      if (xhr.status >= 300) setStatus('No se pudo abrir ' + name + ' (' + xhr.status + ')');
    };
    xhr.onerror = function () { setStatus('No se pudo abrir ' + name); };
    xhr.send();
  }

  // Lanzar otros módulos de TizenBrew a través de su servicio
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
    if (tile.type === 'tvapp') launchTvApp(tile.id, tile.name);
    else if (tile.type === 'module') launchModule(tile);
    else if (tile.type === 'url') location.href = tile.id;
  }

  // Mando
  document.addEventListener('keydown', function (e) {
    switch (e.keyCode) {
      case KEY.LEFT: move(-1, 0); break;
      case KEY.RIGHT: move(1, 0); break;
      case KEY.UP: move(0, -1); break;
      case KEY.DOWN: move(0, 1); break;
      case KEY.ENTER: if (tiles[focus]) launch(config.tiles[focus]); break;
      case KEY.RED: location.reload(); break;
      case KEY.GREEN:
        document.body.className = document.body.className.indexOf('compact') !== -1 ? '' : 'compact';
        break;
      case KEY.BACK: history.back(); break;
      default: return;
    }
    e.preventDefault();
  });

  function start(cfg) {
    config = cfg;
    $('title').textContent = cfg.title || 'Hola';
    if (cfg.background) {
      $('bg').style.backgroundImage = 'url("' + cfg.background + '")';
      $('bg').className = 'image';
    }
    render();
    tickClock();
    setInterval(tickClock, 10000);
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000);
    connectTizenBrew();
  }

  getJSON('config.json?t=' + Date.now(), function (err, cfg) {
    if (err) {
      setStatus('No se pudo leer config.json');
      cfg = { title: 'Hola', tiles: [] };
    }
    start(cfg);
  });
})();
