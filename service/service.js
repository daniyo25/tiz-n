// Generado por tools/build-service.js desde service/src/. No editar a mano.
/* Servicio del launcher. TizenBrew lo ejecuta en su proceso de Node con acceso a `tizen`,
 * que sí tiene permiso para abrir otras apps (la página del launcher no lo tiene y la API
 * REST de la TV responde 401).
 *
 * Desde la propia TV (127.0.0.1):
 *   GET  /launch?id=<appId>   abre una app instalada
 *   GET  /proxy?url=<url>     descarga una URL sin CORS (noticias, Home Assistant)
 * Desde la TV o la red local:
 *   GET  /apps                apps instaladas (id y nombre)
 *   GET  /icon?id=<appId>     icono de una app
 *   GET  /info                IP de la TV, para el editor del móvil
 *   GET  /config              configuración guardada (null si no hay)
 *   POST /config              guarda la configuración (desde la red local pide el PIN)
 *   DELETE /config            vuelve a la configuración del repo (ídem)
 *   GET  /default             configuración que trae el launcher (la página la comparte al abrirse)
 *   POST /default             (solo desde la TV)
 *   GET  /editor              editor de accesos para el móvil
 * Escrito en ES5 porque Tizen 3 trae Node 4. */
var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var os = require('os');

var PORT = 8091;
var CONFIG_FILE = '/home/owner/share/dani-launcher.json';
var PIN = String(1000 + Math.floor(Math.random() * 9000));
var defaultConfig = null;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

function fail(res, err) {
  send(res, 500, { ok: false, error: (err && err.name ? err.name + ': ' : '') + (err && err.message || err) });
}

function isLocal(req) {
  var addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function launch(appId, res) {
  try {
    tizen.application.launch(appId,
      function () { send(res, 200, { ok: true }); },
      function (err) { fail(res, err); });
  } catch (e) { fail(res, e); }
}

function listApps(res) {
  try {
    tizen.application.getAppsInfo(function (apps) {
      var list = apps
        .filter(function (a) { return a.show; })
        .map(function (a) { return { id: a.id, name: a.name }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      send(res, 200, { ok: true, apps: list });
    }, function (err) { fail(res, err); });
  } catch (e) { fail(res, e); }
}

function sendIcon(appId, res) {
  var path;
  try {
    path = tizen.application.getAppInfo(appId).iconPath || '';
  } catch (e) { return fail(res, e); }
  path = path.replace(/^file:\/\//, '');
  var ext = path.split('.').pop().toLowerCase();
  var type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/png';
  var stream = fs.createReadStream(path);
  stream.on('error', function (e) { fail(res, e); });
  stream.on('open', function () {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
    stream.pipe(res);
  });
}

function proxy(target, token, res, redirects) {
  var lib = /^https:/.test(target) ? https : http;
  var opts = url.parse(target);
  opts.headers = { 'User-Agent': 'DaniLauncher' };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  var req = lib.get(opts, function (up) {
    if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location && redirects < 3) {
      up.resume();
      return proxy(url.resolve(target, up.headers.location), token, res, redirects + 1);
    }
    res.writeHead(up.statusCode, {
      'Content-Type': up.headers['content-type'] || 'text/plain',
      'Access-Control-Allow-Origin': '*'
    });
    up.pipe(res);
  });
  req.on('error', function (e) { fail(res, e); });
  req.setTimeout(10000, function () { req.abort(); });
}

function localIp() {
  var ifaces = os.networkInterfaces();
  for (var name in ifaces) {
    for (var i = 0; i < ifaces[name].length; i++) {
      var a = ifaces[name][i];
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

function readBody(req, cb) {
  var data = '';
  req.on('data', function (c) { data += c; if (data.length > 1e6) req.destroy(); });
  req.on('end', function () { cb(data); });
}

function readConfig(res) {
  fs.readFile(CONFIG_FILE, 'utf8', function (err, text) {
    if (err) return send(res, 200, { ok: true, config: null });
    try { send(res, 200, { ok: true, config: JSON.parse(text) }); } catch (e) { send(res, 200, { ok: true, config: null }); }
  });
}

function writeConfig(req, res) {
  readBody(req, function (body) {
    var cfg;
    try { cfg = JSON.parse(body); } catch (e) { return send(res, 400, { ok: false, error: 'JSON no válido' }); }
    if (!cfg || !Array.isArray(cfg.rows)) return send(res, 400, { ok: false, error: 'Falta "rows"' });
    fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), function (err) {
      if (err) return fail(res, err);
      send(res, 200, { ok: true });
    });
  });
}

var server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url, true);
  var q = parsed.query;
  var local = isLocal(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, X-Pin'
    });
    return res.end();
  }

  var writeAllowed = local || req.headers['x-pin'] === PIN;

  switch (parsed.pathname) {
    case '/ping': return send(res, 200, { ok: true });
    case '/launch':
      if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      return q.id ? launch(q.id, res) : send(res, 400, { ok: false, error: 'Falta id' });
    case '/proxy':
      if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      return q.url ? proxy(q.url, q.token, res, 0) : send(res, 400, { ok: false, error: 'Falta url' });
    case '/apps': return listApps(res);
    case '/icon': return q.id ? sendIcon(q.id, res) : send(res, 400, { ok: false, error: 'Falta id' });
    case '/info': return send(res, 200, { ok: true, ip: localIp(), port: PORT, pin: local ? PIN : undefined });
    case '/config':
      if (req.method === 'GET') return readConfig(res);
      if (!writeAllowed) return send(res, 403, { ok: false, error: 'PIN incorrecto' });
      if (req.method === 'POST') return writeConfig(req, res);
      if (req.method === 'DELETE') {
        return fs.unlink(CONFIG_FILE, function () { send(res, 200, { ok: true }); });
      }
      return send(res, 405, { ok: false, error: 'Método no permitido' });
    case '/default':
      if (req.method === 'GET') return send(res, 200, { ok: true, config: defaultConfig });
      if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      return readBody(req, function (body) {
        try { defaultConfig = JSON.parse(body); } catch (e) { return send(res, 400, { ok: false, error: 'JSON no válido' }); }
        send(res, 200, { ok: true });
      });
    case '/editor':
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(EDITOR_HTML);
    default: return send(res, 404, { ok: false, error: 'Not found' });
  }
});

// Si TizenBrew relanza el servicio y el puerto sigue ocupado, el anterior sigue atendiendo.
server.on('error', function () {});
// En toda la red local, para que el editor del móvil llegue; lo que cambia algo pide PIN.
server.listen(PORT, '0.0.0.0');

var EDITOR_HTML = "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Dani Launcher · Editor</title>\n<style>\n  :root { --bg: #000; --card: #15171c; --line: #2a2d35; --text: #f2f4f8; --muted: #9aa0ab; --accent: #4f8cff; --danger: #ff5c5c; }\n  * { box-sizing: border-box; }\n  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.4 -apple-system, system-ui, sans-serif; }\n  main { max-width: 640px; margin: 0 auto; padding: 16px 16px 96px; }\n  h1 { font-size: 22px; margin: 8px 0 4px; }\n  h2 { font-size: 17px; margin: 0; }\n  p.muted, .muted { color: var(--muted); font-size: 14px; }\n  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin: 12px 0; }\n  label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }\n  input, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #0c0d10; color: var(--text); font-size: 16px; }\n  input[type=color] { padding: 2px; height: 42px; }\n  .row-head { display: flex; gap: 8px; align-items: center; }\n  .row-head input { flex: 1; font-weight: 600; }\n  .tile { border-top: 1px solid var(--line); padding: 10px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }\n  .tile .full { grid-column: 1 / -1; }\n  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }\n  button { border: 0; border-radius: 10px; padding: 10px 12px; font-size: 15px; background: #262a33; color: var(--text); }\n  button.primary { background: var(--accent); color: #fff; font-weight: 600; }\n  button.danger { color: var(--danger); }\n  .bar { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.92); border-top: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 8px; justify-content: center; }\n  .bar button { flex: 1; max-width: 300px; }\n  #msg { position: fixed; left: 16px; right: 16px; bottom: 76px; text-align: center; font-size: 14px; }\n  .pin { display: flex; gap: 8px; }\n  .pin input { flex: 1; letter-spacing: 6px; text-align: center; font-size: 22px; }\n</style>\n</head>\n<body>\n<main>\n  <h1>Dani Launcher</h1>\n  <p class=\"muted\">Edita los accesos de la tele. Los cambios se ven al pulsar Guardar; en la tele, pulsa el botón rojo para recargar.</p>\n\n  <div class=\"card\">\n    <h2>PIN</h2>\n    <p class=\"muted\">Lo ves en la tele: botón azul, Ajustes.</p>\n    <div class=\"pin\"><input id=\"pin\" inputmode=\"numeric\" maxlength=\"4\" placeholder=\"0000\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>General</h2>\n    <label for=\"title\">Saludo</label>\n    <input id=\"title\">\n    <label for=\"background\">Imagen de fondo (URL, vacío = negro puro)</label>\n    <input id=\"background\" placeholder=\"https://…\">\n    <label for=\"city\">Ciudad del tiempo</label>\n    <div class=\"row-head\"><input id=\"city\"><button id=\"findCity\">Buscar</button></div>\n    <p class=\"muted\" id=\"coords\"></p>\n  </div>\n\n  <div id=\"rows\"></div>\n  <button id=\"addRow\">+ Añadir fila</button>\n</main>\n<div id=\"msg\"></div>\n<div class=\"bar\">\n  <button id=\"reset\" class=\"danger\">Restablecer</button>\n  <button id=\"save\" class=\"primary\">Guardar</button>\n</div>\n\n<datalist id=\"appIds\"></datalist>\n\n<script>\n(function () {\n  var cfg = null;\n  var apps = [];\n\n  function $(id) { return document.getElementById(id); }\n  function msg(text, bad) { $('msg').textContent = text; $('msg').style.color = bad ? '#ff5c5c' : '#9aa0ab'; }\n  function el(tag, attrs, children) {\n    var e = document.createElement(tag);\n    for (var k in attrs || {}) {\n      if (k === 'text') e.textContent = attrs[k];\n      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);\n      else e.setAttribute(k, attrs[k]);\n    }\n    (children || []).forEach(function (c) { e.appendChild(c); });\n    return e;\n  }\n  function api(method, path, body) {\n    return fetch(path, {\n      method: method,\n      headers: { 'Content-Type': 'application/json', 'X-Pin': $('pin').value },\n      body: body ? JSON.stringify(body) : undefined\n    }).then(function (r) { return r.json(); });\n  }\n\n  function input(obj, key, label, opts) {\n    opts = opts || {};\n    var i = el('input', { type: opts.type || 'text', value: obj[key] || '' });\n    if (opts.list) i.setAttribute('list', opts.list);\n    i.addEventListener('input', function () { obj[key] = i.value; if (opts.onchange) opts.onchange(); });\n    return el('div', { 'class': opts.full ? 'full' : '' }, [el('label', { text: label }), i]);\n  }\n\n  function move(list, i, d) {\n    var j = i + d;\n    if (j < 0 || j >= list.length) return;\n    var t = list[i]; list[i] = list[j]; list[j] = t;\n    render();\n  }\n\n  function renderTile(row, t, i) {\n    var type = el('select', {}, [\n      el('option', { value: 'tvapp', text: 'App de la tele' }),\n      el('option', { value: 'module', text: 'Módulo de TizenBrew' }),\n      el('option', { value: 'url', text: 'Web' })\n    ]);\n    type.value = t.type || 'tvapp';\n    type.addEventListener('change', function () { t.type = type.value; render(); });\n    var idLabel = t.type === 'module' ? 'Módulo (gh/… o npm/…)' : t.type === 'url' ? 'URL' : 'ID de la app';\n    var idField = input(t, 'id', idLabel, {\n      full: true,\n      list: t.type === 'tvapp' || !t.type ? 'appIds' : null,\n      onchange: function () {\n        // Al elegir una app de la lista, rellena el nombre si está vacío\n        var match = apps.filter(function (a) { return a.id === t.id; })[0];\n        if (match && !t.name) { t.name = match.name; render(); }\n      }\n    });\n    return el('div', { 'class': 'tile' }, [\n      input(t, 'name', 'Nombre'),\n      el('div', {}, [el('label', { text: 'Tipo' }), type]),\n      idField,\n      input(t, 'color', 'Color', { type: 'color' }),\n      input(t, 'icon', 'Logo (URL, opcional)'),\n      el('div', { 'class': 'actions full' }, [\n        el('button', { text: '↑', onclick: function () { move(row.tiles, i, -1); } }),\n        el('button', { text: '↓', onclick: function () { move(row.tiles, i, 1); } }),\n        el('button', { 'class': 'danger', text: 'Quitar', onclick: function () { row.tiles.splice(i, 1); render(); } })\n      ])\n    ]);\n  }\n\n  function render() {\n    $('title').value = cfg.title || '';\n    $('background').value = cfg.background || '';\n    $('city').value = (cfg.weather && cfg.weather.city) || '';\n    $('coords').textContent = cfg.weather ? cfg.weather.latitude + ', ' + cfg.weather.longitude : '';\n    var rows = $('rows');\n    rows.innerHTML = '';\n    cfg.rows.forEach(function (row, r) {\n      var title = el('input', { value: row.title || '' });\n      title.addEventListener('input', function () { row.title = title.value; });\n      var card = el('div', { 'class': 'card' }, [\n        el('div', { 'class': 'row-head' }, [\n          title,\n          el('button', { text: '↑', onclick: function () { move(cfg.rows, r, -1); } }),\n          el('button', { text: '↓', onclick: function () { move(cfg.rows, r, 1); } }),\n          el('button', { 'class': 'danger', text: '✕', onclick: function () {\n            if (confirm('¿Quitar la fila \"' + (row.title || '') + '\"?')) { cfg.rows.splice(r, 1); render(); }\n          } })\n        ])\n      ]);\n      row.tiles.forEach(function (t, i) { card.appendChild(renderTile(row, t, i)); });\n      card.appendChild(el('div', { 'class': 'actions' }, [\n        el('button', { text: '+ Añadir acceso', onclick: function () { row.tiles.push({ name: '', type: 'tvapp', id: '', color: '#2a3550' }); render(); } })\n      ]));\n      rows.appendChild(card);\n    });\n  }\n\n  ['title', 'background'].forEach(function (k) {\n    $(k).addEventListener('input', function () { cfg[k] = $(k).value; });\n  });\n\n  $('findCity').addEventListener('click', function () {\n    var name = $('city').value.trim();\n    if (!name) return;\n    fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=es&name=' + encodeURIComponent(name))\n      .then(function (r) { return r.json(); })\n      .then(function (d) {\n        if (!d.results || !d.results.length) return msg('No encuentro esa ciudad', true);\n        var c = d.results[0];\n        cfg.weather = { city: c.name, latitude: c.latitude, longitude: c.longitude };\n        render();\n        msg('Ciudad: ' + c.name + (c.country ? ' (' + c.country + ')' : ''));\n      })\n      .catch(function () { msg('No se pudo buscar la ciudad', true); });\n  });\n\n  $('addRow').addEventListener('click', function () { cfg.rows.push({ title: 'Nueva fila', tiles: [] }); render(); });\n\n  $('save').addEventListener('click', function () {\n    api('POST', '/config', cfg).then(function (r) {\n      msg(r.ok ? 'Guardado. Pulsa el botón rojo en la tele para recargar.' : r.error, !r.ok);\n    }).catch(function () { msg('No se pudo guardar', true); });\n  });\n\n  $('reset').addEventListener('click', function () {\n    if (!confirm('¿Volver a la configuración original del launcher?')) return;\n    api('DELETE', '/config').then(function (r) {\n      msg(r.ok ? 'Restablecido. Recarga la página.' : r.error, !r.ok);\n    });\n  });\n\n  api('GET', '/apps').then(function (r) {\n    apps = r.apps || [];\n    var list = $('appIds');\n    apps.forEach(function (a) { list.appendChild(el('option', { value: a.id, text: a.name })); });\n  }).catch(function () {});\n\n  api('GET', '/config').then(function (r) {\n    if (r.config) { cfg = r.config; render(); return; }\n    // Sin configuración guardada: parte de la que trae el launcher (la tele la comparte al abrirse)\n    return api('GET', '/default').then(function (d) {\n      if (!d.config) return msg('Abre el launcher en la tele y recarga esta página', true);\n      cfg = d.config;\n      render();\n    });\n  }).catch(function () { msg('No se pudo leer la configuración', true); });\n})();\n</script>\n</body>\n</html>\n";
