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
 *   POST /shutdown            (solo desde la TV) cierra este servicio para que lo sustituya uno nuevo
 * Escrito en ES5 porque Tizen 3 trae Node 4. */
var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var os = require('os');

var PORT = 8091;
// Súbelo cuando cambie la API del servicio: la página avisa si el que corre es más antiguo
var SERVICE_VERSION = 3;
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
  var ifaces;
  try { ifaces = os.networkInterfaces(); } catch (e) { return null; }
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
    case '/info':
      return send(res, 200, { ok: true, version: SERVICE_VERSION, ip: localIp(), port: PORT, pin: local ? PIN : undefined });
    case '/shutdown':
      if (!local || req.method !== 'POST') return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      send(res, 200, { ok: true });
      return server.close();
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

// Si el puerto está ocupado es que sigue vivo un servicio anterior (TizenBrew no lo cierra al
// actualizar el módulo). Si es de una versión más antigua se le pide que se cierre y se reintenta.
var retries = 0;
server.on('error', function (e) {
  if (e.code !== 'EADDRINUSE' || retries++ >= 5) return;
  http.get({ host: '127.0.0.1', port: PORT, path: '/info' }, function (res) {
    var body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () {
      var info = {};
      try { info = JSON.parse(body); } catch (err) { /* servicio sin /info: muy antiguo */ }
      if ((info.version || 0) >= SERVICE_VERSION) return; // ya corre uno igual o más nuevo
      var req = http.request({ host: '127.0.0.1', port: PORT, path: '/shutdown', method: 'POST' });
      req.on('error', function () {});
      req.end();
      setTimeout(listen, 1000);
    });
  }).on('error', function () { setTimeout(listen, 1000); });
});
// En toda la red local, para que el editor del móvil llegue; lo que cambia algo pide PIN.
function listen() { server.listen(PORT, '0.0.0.0'); }
listen();

var EDITOR_HTML = '__EDITOR_HTML__';
