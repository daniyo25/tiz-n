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
 *   GET  /icon?id=<appId>     icono de una app (&kind=banner: imagen panorámica; &debug=1: qué encuentra)
 *   GET  /info                IP de la TV, para el editor del móvil
 *   GET  /config              configuración guardada (null si no hay)
 *   POST /config              guarda la configuración (desde la red local pide el PIN)
 *   DELETE /config            vuelve a la configuración del repo (ídem)
 *   GET  /default             configuración que trae el launcher (la página la comparte al abrirse)
 *   POST /default             (solo desde la TV)
 *   GET  /editor              editor de accesos para el móvil
 *   POST /shutdown            (solo desde la TV) cierra este servicio para que lo sustituya uno nuevo
 *   POST /ha/states           entidades de Home Assistant para el editor (pide el PIN)
 *   /spotify/...              conexión con Spotify y control de lo que suena (ver más abajo)
 *   POST /send                envía una foto, un vídeo o un enlace a la tele (pide el PIN)
 *   GET  /inbox               (solo desde la TV) lo último que se ha enviado
 *   GET  /media/<archivo>     fotos y vídeos enviados, con soporte de Range para los vídeos
 * Escrito en ES5 porque Tizen 3 trae Node 4. */
var http = require('http');
var https = require('https');
var url = require('url');
var fs = require('fs');
var os = require('os');
var crypto = require('crypto');

var PORT = 8091;
// Súbelo cuando cambie la API del servicio: la página avisa si el que corre es más antiguo
var SERVICE_VERSION = 6;
var CONFIG_FILE = '/home/owner/share/dani-launcher.json';
var PIN = String(1000 + Math.floor(Math.random() * 9000));
var defaultConfig = null;
var SHARE_DIR = '/home/owner/share';
var SPOTIFY_FILE = SHARE_DIR + '/dani-launcher-spotify.json';
var MEDIA_DIR = SHARE_DIR + '/dani-launcher-media';
var SPOTIFY_REDIRECT = 'http://127.0.0.1:8091/spotify/callback';

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

function launch(appId, res, payload) {
  if (payload) {
    // Enlace directo (p. ej. un vídeo de YouTube): si la app no lo acepta, se abre sin más
    try {
      var ctrl = new tizen.ApplicationControl('http://tizen.org/appcontrol/operation/view', null, null, null,
        [new tizen.ApplicationControlData('PAYLOAD', [payload])]);
      return tizen.application.launchAppControl(ctrl, appId,
        function () { send(res, 200, { ok: true }); },
        function () { launch(appId, res); });
    } catch (e) { /* sigue con el lanzamiento normal */ }
  }
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

// ---------- Imágenes de las apps ----------
// El iconPath de algunas apps no se puede leer o no existe, así que se busca también en la
// carpeta de la app. De paso se buscan imágenes panorámicas (logos del tamaño de la tarjeta).

var imageCache = {};

// Ancho y alto de un PNG o JPEG leyendo solo la cabecera
function imageSize(path) {
  var fd, buf = Buffer.alloc ? Buffer.alloc(65536) : new Buffer(65536), n;
  try {
    fd = fs.openSync(path, 'r');
    n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
  } catch (e) { return null; }
  if (n > 24 && buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (n > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    var i = 2;
    while (i + 9 < n) {
      if (buf[i] !== 0xff) { i++; continue; }
      var m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

function walkImages(dir, depth, out) {
  if (depth > 4 || out.length > 300) return;
  var names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  names.forEach(function (name) {
    var p = dir + '/' + name, st;
    try { st = fs.statSync(p); } catch (e) { return; }
    if (st.isDirectory()) return walkImages(p, depth + 1, out);
    if (/\.(png|jpe?g)$/i.test(name) && st.size > 200) {
      var size = imageSize(p);
      if (size && size.w >= 64 && size.h >= 64) out.push({ path: p, w: size.w, h: size.h, bytes: st.size });
    }
  });
}

function appImages(appId) {
  if (imageCache[appId]) return imageCache[appId];
  var info = { appId: appId, iconPath: '', roots: [], images: [], errors: [] };
  var app = null;
  try { app = tizen.application.getAppInfo(appId); } catch (e) { info.errors.push('getAppInfo: ' + (e.message || e.name)); }
  var pkg = app && app.packageId;
  if (app) info.iconPath = (app.iconPath || '').replace(/^file:\/\//, '');
  var roots = [];
  function addRoot(r) { if (r && roots.indexOf(r) === -1) roots.push(r); }
  if (info.iconPath) {
    // Raíz de la app: lo que hay antes de /shared/ o /res/
    var m = info.iconPath.match(/^(.*?)\/(shared|res)\//);
    var root = m ? m[1] : info.iconPath.replace(/\/[^\/]*$/, '');
    // Solo carpetas de apps: no recorrer medio disco si el icono está en otro sitio
    if (/apps/.test(root)) addRoot(root);
  }
  if (pkg) {
    try {
      var pi = tizen.package.getPackageInfo(pkg);
      var pIcon = (pi.iconPath || '').replace(/^file:\/\//, '');
      if (pIcon) { info.pkgIconPath = pIcon; var pm = pIcon.match(/^(.*?)\/(shared|res)\//); addRoot(pm ? pm[1] : null); }
    } catch (e) { info.errors.push('getPackageInfo: ' + (e.message || e.name)); }
    ['/opt/usr/apps/', '/opt/usr/globalapps/', '/usr/apps/', '/opt/usr/home/owner/apps_rw/'].forEach(function (base) {
      try { if (fs.statSync(base + pkg).isDirectory()) addRoot(base + pkg); } catch (e) { /* no existe */ }
    });
  }
  info.roots = roots;
  roots.forEach(function (r) { walkImages(r, 0, info.images); });
  [info.iconPath, info.pkgIconPath].forEach(function (p) {
    if (!p || info.images.some(function (i) { return i.path === p; })) return;
    var size = imageSize(p);
    if (size) info.images.push({ path: p, w: size.w, h: size.h });
    else info.errors.push('No se puede leer ' + p);
  });

  function score(img, wide) {
    var name = img.path.toLowerCase();
    var s = img.w * img.h;
    if (/logo|banner|tile|title|brand|icon/.test(name)) s *= 4;
    if (/splash|loading|background|bg_|_bg|screen|shot|preview|dummy/.test(name)) s *= 0.1;
    if (wide && img.w > 1280) s *= 0.5; // las de pantalla completa suelen ser fondos
    return s;
  }
  var readable = info.images.filter(function (i) { return i.path; });
  var square = readable.filter(function (i) { return i.w / i.h < 1.3 && i.h / i.w < 1.3; });
  var wide = readable.filter(function (i) { return i.w / i.h >= 1.5 && i.w / i.h <= 2.6 && i.w >= 300; });
  info.icon = info.iconPath && imageSize(info.iconPath) ? info.iconPath :
    (square.sort(function (a, b) { return score(b) - score(a); })[0] || {}).path || '';
  info.banner = (wide.sort(function (a, b) { return score(b, true) - score(a, true); })[0] || {}).path || '';
  imageCache[appId] = info;
  return info;
}

function sendIcon(appId, kind, res) {
  var info = appImages(appId);
  var path = kind === 'banner' ? info.banner : info.icon;
  if (!path) return send(res, 404, { ok: false, error: 'Sin imagen' });
  var ext = path.split('.').pop().toLowerCase();
  var type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  var stream = fs.createReadStream(path);
  stream.on('error', function (e) { fail(res, e); });
  stream.on('open', function () {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    stream.pipe(res);
  });
}

function proxy(target, token, res, redirects, method, body) {
  var lib = /^https:/.test(target) ? https : http;
  var opts = url.parse(target);
  opts.method = method || 'GET';
  opts.headers = { 'User-Agent': 'DaniLauncher' };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(body); }
  var req = lib.request(opts, function (up) {
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
  req.end(body || undefined);
}

// Petición HTTPS que devuelve JSON (Spotify, Home Assistant)
function fetchJSON(target, opts, cb) {
  var lib = /^https:/.test(target) ? https : http;
  var o = url.parse(target);
  o.method = opts.method || 'GET';
  o.headers = opts.headers || {};
  if (opts.body) o.headers['Content-Length'] = Buffer.byteLength(opts.body);
  var req = lib.request(o, function (up) {
    var data = '';
    up.on('data', function (c) { data += c; });
    up.on('end', function () {
      var json = null;
      try { json = data ? JSON.parse(data) : null; } catch (e) { /* no es JSON */ }
      cb(null, up.statusCode, json);
    });
  });
  req.on('error', function (e) { cb(e); });
  req.setTimeout(10000, function () { req.abort(); });
  req.end(opts.body || undefined);
}

// ---------- Home Assistant ----------

function haStates(req, res) {
  readBody(req, function (body) {
    var b;
    try { b = JSON.parse(body); } catch (e) { return send(res, 400, { ok: false, error: 'JSON no válido' }); }
    if (!b.url || !b.token) return send(res, 400, { ok: false, error: 'Faltan la URL o el token' });
    fetchJSON(b.url.replace(/\/$/, '') + '/api/states', { headers: { Authorization: 'Bearer ' + b.token } }, function (err, status, list) {
      if (err) return send(res, 502, { ok: false, error: 'No llego a Home Assistant: ' + err.message });
      if (status !== 200 || !Array.isArray(list)) return send(res, 502, { ok: false, error: 'Home Assistant respondió ' + status });
      send(res, 200, { ok: true, entities: list.map(function (e) {
        return { id: e.entity_id, name: (e.attributes && e.attributes.friendly_name) || e.entity_id, state: e.state };
      }) });
    });
  });
}

// ---------- Spotify ----------
// Flujo PKCE sin secreto: el editor del móvil pide la URL de autorización; tras iniciar sesión,
// Spotify redirige a 127.0.0.1 (que en el móvil no carga) y el usuario pega esa dirección en el editor.

var spotify = { clientId: '', refreshToken: '', accessToken: '', expires: 0, verifier: '' };
try { var sp = JSON.parse(fs.readFileSync(SPOTIFY_FILE, 'utf8')); spotify.clientId = sp.clientId || ''; spotify.refreshToken = sp.refreshToken || ''; } catch (e) { /* sin conectar */ }

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function saveSpotify() {
  fs.writeFile(SPOTIFY_FILE, JSON.stringify({ clientId: spotify.clientId, refreshToken: spotify.refreshToken }), function () {});
}

function spotifyToken(params, cb) {
  var body = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
  fetchJSON('https://accounts.spotify.com/api/token', {
    method: 'POST', body: body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, function (err, status, data) {
    if (err || status !== 200 || !data || !data.access_token) return cb(err || new Error((data && (data.error_description || data.error)) || 'Spotify respondió ' + status));
    spotify.accessToken = data.access_token;
    spotify.expires = Date.now() + (data.expires_in - 60) * 1000;
    if (data.refresh_token) { spotify.refreshToken = data.refresh_token; saveSpotify(); }
    cb(null);
  });
}

function withSpotify(cb) {
  if (!spotify.refreshToken) return cb(new Error('Spotify no está conectado'));
  if (spotify.accessToken && Date.now() < spotify.expires) return cb(null);
  spotifyToken({ grant_type: 'refresh_token', refresh_token: spotify.refreshToken, client_id: spotify.clientId }, cb);
}

function spotifyApi(method, path, cb) {
  withSpotify(function (err) {
    if (err) return cb(err);
    fetchJSON('https://api.spotify.com/v1' + path, { method: method, headers: { Authorization: 'Bearer ' + spotify.accessToken } }, cb);
  });
}

function spotifyRoute(req, res, path, q, local, writeAllowed) {
  if (path === '/spotify/status') return send(res, 200, { ok: true, connected: !!spotify.refreshToken, clientId: spotify.clientId, redirect: SPOTIFY_REDIRECT });
  if (path === '/spotify/now') {
    if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
    return spotifyApi('GET', '/me/player/currently-playing?additional_types=episode', function (err, status, d) {
      if (err) return send(res, 200, { ok: false, connected: !!spotify.refreshToken, error: err.message });
      if (status === 204 || !d || !d.item) return send(res, 200, { ok: true, connected: true, playing: false, item: null });
      var it = d.item, images = (it.album && it.album.images) || (it.images) || [];
      send(res, 200, { ok: true, connected: true, playing: d.is_playing, item: {
        title: it.name,
        artist: it.artists ? it.artists.map(function (a) { return a.name; }).join(', ') : (it.show && it.show.name) || '',
        album: it.album ? it.album.name : '',
        image: images.length ? images[Math.min(1, images.length - 1)].url : '',
        progress: d.progress_ms, duration: it.duration_ms
      } });
    });
  }
  if (path === '/spotify/control') {
    if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
    var map = { play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'], next: ['POST', '/me/player/next'], previous: ['POST', '/me/player/previous'] };
    var m = map[q.action];
    if (!m) return send(res, 400, { ok: false, error: 'Acción desconocida' });
    return spotifyApi(m[0], m[1], function (err, status, d) {
      if (err) return send(res, 200, { ok: false, error: err.message });
      if (status >= 300) return send(res, 200, { ok: false, error: (d && d.error && d.error.message) || 'Spotify respondió ' + status });
      send(res, 200, { ok: true });
    });
  }
  if (!writeAllowed) return send(res, 403, { ok: false, error: 'PIN incorrecto' });
  if (path === '/spotify/login') {
    return readBody(req, function (body) {
      var b = {};
      try { b = JSON.parse(body); } catch (e) { /* vacío */ }
      if (!b.clientId) return send(res, 400, { ok: false, error: 'Falta el Client ID' });
      spotify.clientId = b.clientId.trim();
      spotify.verifier = b64url(crypto.randomBytes(48));
      var challenge = b64url(crypto.createHash('sha256').update(spotify.verifier).digest());
      send(res, 200, { ok: true, url: 'https://accounts.spotify.com/authorize?response_type=code&client_id=' + encodeURIComponent(spotify.clientId) +
        '&scope=' + encodeURIComponent('user-read-currently-playing user-read-playback-state user-modify-playback-state') +
        '&redirect_uri=' + encodeURIComponent(SPOTIFY_REDIRECT) + '&code_challenge_method=S256&code_challenge=' + challenge });
    });
  }
  if (path === '/spotify/code') {
    return readBody(req, function (body) {
      var b = {};
      try { b = JSON.parse(body); } catch (e) { /* vacío */ }
      var m = /[?&]code=([^&#]+)/.exec(b.url || '') || [null, b.url];
      if (!m[1] || !spotify.verifier) return send(res, 400, { ok: false, error: 'Pega la dirección completa a la que te llevó Spotify' });
      spotifyToken({ grant_type: 'authorization_code', code: decodeURIComponent(m[1]), redirect_uri: SPOTIFY_REDIRECT,
        client_id: spotify.clientId, code_verifier: spotify.verifier }, function (err) {
        if (err) return send(res, 200, { ok: false, error: err.message });
        send(res, 200, { ok: true });
      });
    });
  }
  if (path === '/spotify/logout') {
    spotify.refreshToken = ''; spotify.accessToken = '';
    saveSpotify();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { ok: false, error: 'Not found' });
}

// ---------- Enviar a la tele ----------

var inbox = null;
var MEDIA_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg' };

function mediaKind(name, type) {
  if (/^image\//.test(type || '') || /\.(jpe?g|png|gif|webp)$/i.test(name)) return 'image';
  if (/^(video|audio)\//.test(type || '') || /\.(mp4|m4v|mov|webm|mkv|mp3|m3u8)$/i.test(name)) return 'video';
  return '';
}

function receive(req, res) {
  var type = (req.headers['content-type'] || '').split(';')[0];
  if (type === 'application/json') {
    return readBody(req, function (body) {
      var b;
      try { b = JSON.parse(body); } catch (e) { return send(res, 400, { ok: false, error: 'JSON no válido' }); }
      var link = (b.url || '').trim();
      if (!/^https?:\/\//.test(link)) return send(res, 400, { ok: false, error: 'El enlace tiene que empezar por http' });
      var yt = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(link);
      var kind = yt ? 'youtube' : mediaKind(link.split('?')[0]) || 'web';
      inbox = { id: Date.now(), kind: kind, src: link, video: yt ? yt[1] : '', name: link };
      send(res, 200, { ok: true, kind: kind });
    });
  }
  var name = String(req.headers['x-name'] || 'archivo').replace(/[^\w.\-]+/g, '_').slice(-80);
  var kind = mediaKind(name, type);
  if (!kind) return send(res, 400, { ok: false, error: 'Solo fotos, vídeos o audio' });
  try { fs.mkdirSync(MEDIA_DIR); } catch (e) { /* ya existe */ }
  // Se guarda solo lo último: se borra lo enviado antes para no llenar la tele
  try { fs.readdirSync(MEDIA_DIR).forEach(function (f) { fs.unlinkSync(MEDIA_DIR + '/' + f); }); } catch (e) { /* vacío */ }
  var file = Date.now() + '-' + name;
  var out = fs.createWriteStream(MEDIA_DIR + '/' + file);
  req.pipe(out);
  out.on('error', function (e) { fail(res, e); });
  out.on('finish', function () {
    inbox = { id: Date.now(), kind: kind, src: 'http://127.0.0.1:' + PORT + '/media/' + encodeURIComponent(file), name: req.headers['x-name'] || name };
    send(res, 200, { ok: true, kind: kind });
  });
}

function sendMedia(req, res, file) {
  var path = MEDIA_DIR + '/' + file.replace(/[\/]/g, '');
  fs.stat(path, function (err, st) {
    if (err) return send(res, 404, { ok: false, error: 'No existe' });
    var type = MEDIA_TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream';
    var range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    var head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    if (!range) {
      head['Content-Length'] = st.size;
      res.writeHead(200, head);
      return fs.createReadStream(path).pipe(res);
    }
    var start = range[1] ? +range[1] : st.size - +range[2];
    var end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    head['Content-Length'] = end - start + 1;
    res.writeHead(206, head);
    fs.createReadStream(path, { start: start, end: end }).pipe(res);
  });
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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, X-Pin, X-Name'
    });
    return res.end();
  }

  var writeAllowed = local || req.headers['x-pin'] === PIN;

  switch (parsed.pathname) {
    case '/ping': return send(res, 200, { ok: true });
    case '/launch':
      if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      return q.id ? launch(q.id, res, q.payload) : send(res, 400, { ok: false, error: 'Falta id' });
    case '/proxy':
      if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      if (!q.url) return send(res, 400, { ok: false, error: 'Falta url' });
      if (req.method === 'POST') return readBody(req, function (body) { proxy(q.url, q.token, res, 0, 'POST', body || '{}'); });
      return proxy(q.url, q.token, res, 0);
    case '/ha/states':
      if (!writeAllowed) return send(res, 403, { ok: false, error: 'PIN incorrecto' });
      return haStates(req, res);
    case '/send':
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Método no permitido' });
      if (!writeAllowed) return send(res, 403, { ok: false, error: 'PIN incorrecto' });
      return receive(req, res);
    case '/inbox':
      if (!local) return send(res, 403, { ok: false, error: 'Solo desde la TV' });
      return send(res, 200, { ok: true, item: inbox });
    case '/apps': return listApps(res);
    case '/icon':
      if (!q.id) return send(res, 400, { ok: false, error: 'Falta id' });
      if (q.debug) return send(res, 200, appImages(q.id));
      return sendIcon(q.id, q.kind, res);
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
    default:
      if (/^\/spotify\//.test(parsed.pathname)) return spotifyRoute(req, res, parsed.pathname, q, local, writeAllowed);
      if (/^\/media\//.test(parsed.pathname)) return sendMedia(req, res, decodeURIComponent(parsed.pathname.slice(7)));
      return send(res, 404, { ok: false, error: 'Not found' });
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

var EDITOR_HTML = "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Dani Launcher · Editor</title>\n<style>\n  :root { --bg: #000; --card: #15171c; --line: #2a2d35; --text: #f2f4f8; --muted: #9aa0ab; --accent: #4f8cff; --danger: #ff5c5c; }\n  * { box-sizing: border-box; }\n  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.4 -apple-system, system-ui, sans-serif; }\n  main { max-width: 640px; margin: 0 auto; padding: 16px 16px 96px; }\n  h1 { font-size: 22px; margin: 8px 0 4px; }\n  h2 { font-size: 17px; margin: 0; }\n  p.muted, .muted { color: var(--muted); font-size: 14px; }\n  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin: 12px 0; }\n  label { display: block; font-size: 13px; color: var(--muted); margin: 10px 0 4px; }\n  input, select { width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: #0c0d10; color: var(--text); font-size: 16px; }\n  input[type=color] { padding: 2px; height: 42px; }\n  .row-head { display: flex; gap: 8px; align-items: center; }\n  .row-head input { flex: 1; font-weight: 600; }\n  .tile { border-top: 1px solid var(--line); padding: 10px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }\n  .tile .full { grid-column: 1 / -1; }\n  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }\n  button { border: 0; border-radius: 10px; padding: 10px 12px; font-size: 15px; background: #262a33; color: var(--text); }\n  button.primary { background: var(--accent); color: #fff; font-weight: 600; }\n  button.danger { color: var(--danger); }\n  .bar { position: fixed; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.92); border-top: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 8px; justify-content: center; }\n  .bar button { flex: 1; max-width: 300px; }\n  #msg { position: fixed; left: 16px; right: 16px; bottom: 76px; text-align: center; font-size: 14px; background: rgba(0,0,0,.85); border-radius: 10px; padding: 0 8px; }\n  #msg:empty { display: none; }\n  .pin { display: flex; gap: 8px; }\n  .pin input { flex: 1; letter-spacing: 6px; text-align: center; font-size: 22px; }\n  #apps { max-height: 420px; overflow-y: auto; margin-top: 10px; }\n  .app { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }\n  .app:first-child { border-top: 0; }\n  .app img, .app .noimg { width: 44px; height: 44px; border-radius: 10px; object-fit: contain; background: #0c0d10; flex: none; }\n  .app .info { flex: 1; min-width: 0; }\n  .app .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n  .app .where { font-size: 13px; color: var(--muted); }\n  .app button { flex: none; }\n  .app button.added { color: #4ade80; }\n  .two { display: flex; gap: 8px; }\n  .hidden { display: none !important; }\n  .progress { height: 6px; background: #0c0d10; border-radius: 3px; margin-top: 8px; overflow: hidden; }\n  .progress div { height: 100%; width: 0; background: var(--accent); transition: width .2s; }\n  code { background: #0c0d10; padding: 2px 6px; border-radius: 6px; font-size: 13px; word-break: break-all; }\n  #haList { max-height: 360px; overflow-y: auto; margin-top: 8px; }\n  #haList label { display: flex; gap: 10px; align-items: center; color: var(--text); font-size: 15px; margin: 0; padding: 8px 0; border-top: 1px solid var(--line); }\n  #haList input { width: auto; }\n  #haList .st { margin-left: auto; color: var(--muted); font-size: 13px; }\n  .two > * { flex: 1; }\n</style>\n</head>\n<body>\n<main>\n  <h1>Dani Launcher</h1>\n  <p class=\"muted\">Edita los accesos de la tele. Al guardar, la tele se actualiza sola en unos segundos.</p>\n\n  <div class=\"card\">\n    <h2>PIN</h2>\n    <p class=\"muted\">Lo ves en la tele: botón azul, Ajustes.</p>\n    <div class=\"pin\"><input id=\"pin\" inputmode=\"numeric\" maxlength=\"4\" placeholder=\"0000\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>General</h2>\n    <label for=\"title\">Saludo</label>\n    <input id=\"title\">\n    <label for=\"background\">Imagen de fondo (URL, vacío = negro puro)</label>\n    <input id=\"background\" placeholder=\"https://…\">\n    <label for=\"city\">Ciudad del tiempo</label>\n    <div class=\"row-head\"><input id=\"city\"><button id=\"findCity\">Buscar</button></div>\n    <p class=\"muted\" id=\"coords\"></p>\n  </div>\n\n  <div class=\"card\">\n    <h2>Enviar a la tele</h2>\n    <p class=\"muted\">Una foto o un vídeo de este móvil, o un enlace de YouTube o de un vídeo. Se abre en la tele al momento.</p>\n    <label for=\"sendFile\">Foto o vídeo</label>\n    <input id=\"sendFile\" type=\"file\" accept=\"image/*,video/*,audio/*\">\n    <div class=\"progress\"><div id=\"sendBar\"></div></div>\n    <label for=\"sendUrl\">Enlace</label>\n    <div class=\"row-head\"><input id=\"sendUrl\" placeholder=\"https://youtu.be/…\"><button id=\"sendLink\">Enviar</button></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Home Assistant</h2>\n    <p class=\"muted\">Dirección de tu Home Assistant y un token de larga duración (Perfil → Seguridad → Tokens). En la tele, OK sobre una luz o un enchufe lo enciende o lo apaga.</p>\n    <label for=\"haUrl\">Dirección</label>\n    <input id=\"haUrl\" placeholder=\"http://192.168.1.x:8123\">\n    <label for=\"haToken\">Token</label>\n    <input id=\"haToken\" type=\"password\" placeholder=\"eyJ…\">\n    <div class=\"actions\"><button id=\"haLoad\">Cargar entidades</button></div>\n    <input id=\"haFilter\" class=\"hidden\" placeholder=\"Buscar entidad…\">\n    <div id=\"haList\"></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Spotify</h2>\n    <div id=\"spState\" class=\"muted\">Comprobando…</div>\n    <div id=\"spSetup\" class=\"hidden\">\n      <p class=\"muted\">1. En developer.spotify.com crea una app (Web API) y añade esta Redirect URI: <code id=\"spRedirect\"></code><br>\n      2. Pega aquí su Client ID y pulsa Conectar.<br>\n      3. Inicia sesión. Al final el navegador dirá que no puede abrir la página: copia la dirección de la barra y pégala abajo.</p>\n      <label for=\"spClient\">Client ID</label>\n      <div class=\"row-head\"><input id=\"spClient\"><button id=\"spLogin\">Conectar</button></div>\n      <label for=\"spCode\">Dirección a la que te llevó Spotify</label>\n      <div class=\"row-head\"><input id=\"spCode\" placeholder=\"http://127.0.0.1:8091/spotify/callback?code=…\"><button id=\"spSend\">Listo</button></div>\n    </div>\n    <div class=\"actions\"><button id=\"spLogout\" class=\"danger hidden\">Desconectar</button></div>\n  </div>\n\n  <div class=\"card\">\n    <h2>Apps instaladas</h2>\n    <p class=\"muted\">Pulsa Añadir y la app aparece en la tele en unos segundos.</p>\n    <div class=\"two\">\n      <div><label for=\"appFilter\">Buscar</label><input id=\"appFilter\" placeholder=\"Nombre…\"></div>\n      <div><label for=\"appRow\">Añadir a la fila</label><select id=\"appRow\"></select></div>\n    </div>\n    <div id=\"apps\"><p class=\"muted\">Cargando…</p></div>\n  </div>\n\n  <div id=\"rows\"></div>\n  <button id=\"addRow\">+ Añadir fila</button>\n</main>\n<div id=\"msg\"></div>\n<div class=\"bar\">\n  <button id=\"reset\" class=\"danger\">Restablecer</button>\n  <button id=\"save\" class=\"primary\">Guardar</button>\n</div>\n\n<datalist id=\"appIds\"></datalist>\n\n<script>\n(function () {\n  var cfg = null;\n  var apps = [];\n  var appsError = '';\n\n  function $(id) { return document.getElementById(id); }\n  function msg(text, bad) { $('msg').textContent = text; $('msg').style.color = bad ? '#ff5c5c' : '#9aa0ab'; }\n  function el(tag, attrs, children) {\n    var e = document.createElement(tag);\n    for (var k in attrs || {}) {\n      if (k === 'text') e.textContent = attrs[k];\n      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);\n      else e.setAttribute(k, attrs[k]);\n    }\n    (children || []).forEach(function (c) { e.appendChild(c); });\n    return e;\n  }\n  function api(method, path, body) {\n    return fetch(path, {\n      method: method,\n      headers: { 'Content-Type': 'application/json', 'X-Pin': $('pin').value },\n      body: body ? JSON.stringify(body) : undefined\n    }).then(function (r) { return r.json(); });\n  }\n\n  function input(obj, key, label, opts) {\n    opts = opts || {};\n    var i = el('input', { type: opts.type || 'text', value: obj[key] || '' });\n    if (opts.list) i.setAttribute('list', opts.list);\n    i.addEventListener('input', function () { obj[key] = i.value; if (opts.onchange) opts.onchange(); });\n    return el('div', { 'class': opts.full ? 'full' : '' }, [el('label', { text: label }), i]);\n  }\n\n  function move(list, i, d) {\n    var j = i + d;\n    if (j < 0 || j >= list.length) return;\n    var t = list[i]; list[i] = list[j]; list[j] = t;\n    render();\n  }\n\n  function renderTile(row, t, i) {\n    var type = el('select', {}, [\n      el('option', { value: 'tvapp', text: 'App de la tele' }),\n      el('option', { value: 'module', text: 'Módulo de TizenBrew' }),\n      el('option', { value: 'url', text: 'Web' })\n    ]);\n    type.value = t.type || 'tvapp';\n    type.addEventListener('change', function () { t.type = type.value; render(); });\n    var idLabel = t.type === 'module' ? 'Módulo (gh/… o npm/…)' : t.type === 'url' ? 'URL' : 'ID de la app';\n    var idField = input(t, 'id', idLabel, {\n      full: true,\n      list: t.type === 'tvapp' || !t.type ? 'appIds' : null,\n      onchange: function () {\n        // Al elegir una app de la lista, rellena el nombre si está vacío\n        var match = apps.filter(function (a) { return a.id === t.id; })[0];\n        if (match && !t.name) { t.name = match.name; render(); }\n      }\n    });\n    return el('div', { 'class': 'tile' }, [\n      input(t, 'name', 'Nombre'),\n      el('div', {}, [el('label', { text: 'Tipo' }), type]),\n      idField,\n      input(t, 'color', 'Color', { type: 'color' }),\n      input(t, 'icon', 'Logo (URL, opcional)'),\n      input(t, 'banner', 'Imagen panorámica (URL, rellena toda la tarjeta)', { full: true }),\n      el('div', { 'class': 'actions full' }, [\n        el('button', { text: '↑', onclick: function () { move(row.tiles, i, -1); } }),\n        el('button', { text: '↓', onclick: function () { move(row.tiles, i, 1); } }),\n        el('button', { 'class': 'danger', text: 'Quitar', onclick: function () { row.tiles.splice(i, 1); render(); } })\n      ])\n    ]);\n  }\n\n  function render() {\n    $('title').value = cfg.title || '';\n    var ha = (cfg.widgets && cfg.widgets.homeassistant) || {};\n    if (document.activeElement !== $('haUrl')) $('haUrl').value = ha.url || '';\n    if (document.activeElement !== $('haToken')) $('haToken').value = ha.token || '';\n    $('background').value = cfg.background || '';\n    $('city').value = (cfg.weather && cfg.weather.city) || '';\n    $('coords').textContent = cfg.weather ? cfg.weather.latitude + ', ' + cfg.weather.longitude : '';\n    var rows = $('rows');\n    rows.innerHTML = '';\n    cfg.rows.forEach(function (row, r) {\n      var title = el('input', { value: row.title || '' });\n      title.addEventListener('input', function () { row.title = title.value; });\n      var card = el('div', { 'class': 'card' }, [\n        el('div', { 'class': 'row-head' }, [\n          title,\n          el('button', { text: '↑', onclick: function () { move(cfg.rows, r, -1); } }),\n          el('button', { text: '↓', onclick: function () { move(cfg.rows, r, 1); } }),\n          el('button', { 'class': 'danger', text: '✕', onclick: function () {\n            if (confirm('¿Quitar la fila \"' + (row.title || '') + '\"?')) { cfg.rows.splice(r, 1); render(); }\n          } })\n        ])\n      ]);\n      row.tiles.forEach(function (t, i) { card.appendChild(renderTile(row, t, i)); });\n      card.appendChild(el('div', { 'class': 'actions' }, [\n        el('button', { text: '+ Añadir acceso', onclick: function () { row.tiles.push({ name: '', type: 'tvapp', id: '', color: '#2a3550' }); render(); } })\n      ]));\n      rows.appendChild(card);\n    });\n    renderApps();\n  }\n\n  // ---------- Apps instaladas ----------\n\n  // Fila y posición de una app de la tele en el launcher, o null\n  function findApp(id) {\n    for (var r = 0; r < cfg.rows.length; r++) {\n      for (var i = 0; i < cfg.rows[r].tiles.length; i++) {\n        var t = cfg.rows[r].tiles[i];\n        if ((t.type || 'tvapp') === 'tvapp' && t.id === id) return { row: r, index: i };\n      }\n    }\n    return null;\n  }\n\n  function renderRowSelect() {\n    var sel = $('appRow');\n    var prev = sel.value;\n    sel.innerHTML = '';\n    cfg.rows.forEach(function (row, r) { sel.appendChild(el('option', { value: String(r), text: row.title || 'Fila ' + (r + 1) })); });\n    sel.appendChild(el('option', { value: 'new', text: '+ Nueva fila «Mis apps»' }));\n    sel.value = prev && sel.querySelector('option[value=\"' + prev + '\"]') ? prev : (cfg.rows.length ? '0' : 'new');\n  }\n\n  function addApp(a) {\n    var target = $('appRow').value;\n    var row;\n    if (target === 'new') {\n      row = { title: 'Mis apps', tiles: [] };\n      cfg.rows.push(row);\n    } else {\n      row = cfg.rows[+target];\n    }\n    row.tiles.push({ name: a.name, type: 'tvapp', id: a.id, color: '#1c1f26' });\n    render();\n    save('«' + a.name + '» añadida a «' + row.title + '»');\n  }\n\n  function removeApp(a, pos) {\n    cfg.rows[pos.row].tiles.splice(pos.index, 1);\n    render();\n    save('«' + a.name + '» quitada del launcher');\n  }\n\n  function renderApps() {\n    if (!cfg) return;\n    renderRowSelect();\n    var box = $('apps');\n    if (!apps.length) {\n      box.innerHTML = '';\n      box.appendChild(el('p', { 'class': 'muted', text: appsError || 'Cargando…' }));\n      return;\n    }\n    var q = $('appFilter').value.trim().toLowerCase();\n    box.innerHTML = '';\n    apps.filter(function (a) { return !q || a.name.toLowerCase().indexOf(q) !== -1; }).forEach(function (a) {\n      var pos = findApp(a.id);\n      var icon = el('img', { src: '/icon?id=' + encodeURIComponent(a.id), alt: '' });\n      icon.onerror = function () { icon.replaceWith(el('div', { 'class': 'noimg' })); };\n      box.appendChild(el('div', { 'class': 'app' }, [\n        icon,\n        el('div', { 'class': 'info' }, [\n          el('div', { 'class': 'name', text: a.name }),\n          el('div', { 'class': 'where', text: pos ? 'En «' + cfg.rows[pos.row].title + '»' : a.id })\n        ]),\n        pos\n          ? el('button', { 'class': 'added', text: '✓ Quitar', onclick: function () { removeApp(a, pos); } })\n          : el('button', { text: 'Añadir', onclick: function () { addApp(a); } })\n      ]));\n    });\n  }\n\n  $('appFilter').addEventListener('input', renderApps);\n\n  // ---------- Enviar a la tele ----------\n\n  $('sendFile').addEventListener('change', function () {\n    var f = $('sendFile').files[0];\n    if (!f) return;\n    if (!$('pin').value) return msg('Escribe el PIN de la tele', true);\n    var xhr = new XMLHttpRequest();\n    xhr.open('POST', '/send');\n    xhr.setRequestHeader('X-Pin', $('pin').value);\n    xhr.setRequestHeader('X-Name', f.name);\n    xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');\n    xhr.upload.onprogress = function (e) { if (e.lengthComputable) $('sendBar').style.width = (e.loaded / e.total * 100) + '%'; };\n    xhr.onload = function () {\n      var r = {};\n      try { r = JSON.parse(xhr.responseText); } catch (e) { /* vacío */ }\n      msg(r.ok ? 'Enviado a la tele' : (r.error || 'No se pudo enviar'), !r.ok);\n      setTimeout(function () { $('sendBar').style.width = '0'; }, 1500);\n      $('sendFile').value = '';\n    };\n    xhr.onerror = function () { msg('No se pudo enviar', true); };\n    msg('Enviando ' + f.name + '…');\n    xhr.send(f);\n  });\n\n  $('sendLink').addEventListener('click', function () {\n    if (!$('pin').value) return msg('Escribe el PIN de la tele', true);\n    api('POST', '/send', { url: $('sendUrl').value }).then(function (r) {\n      msg(r.ok ? (r.kind === 'web' ? 'Enviado, pero la tele solo abre fotos, vídeos y YouTube' : 'Enviado a la tele') : r.error, !r.ok);\n      if (r.ok) $('sendUrl').value = '';\n    }).catch(function () { msg('No se pudo enviar', true); });\n  });\n\n  // ---------- Home Assistant ----------\n\n  var haEntities = [];\n  function haCfg() {\n    cfg.widgets = cfg.widgets || {};\n    cfg.widgets.homeassistant = cfg.widgets.homeassistant || { url: '', token: '', entities: [] };\n    return cfg.widgets.homeassistant;\n  }\n  function renderHa() {\n    var ha = haCfg();\n    var q = $('haFilter').value.trim().toLowerCase();\n    var box = $('haList');\n    box.innerHTML = '';\n    haEntities.filter(function (e) {\n      return ha.entities.indexOf(e.id) !== -1 || !q || (e.name + ' ' + e.id).toLowerCase().indexOf(q) !== -1;\n    }).sort(function (a, b) {\n      return (ha.entities.indexOf(b.id) !== -1) - (ha.entities.indexOf(a.id) !== -1) || a.name.localeCompare(b.name);\n    }).slice(0, 80).forEach(function (e) {\n      var cb = el('input', { type: 'checkbox' });\n      cb.checked = ha.entities.indexOf(e.id) !== -1;\n      cb.addEventListener('change', function () {\n        var i = ha.entities.indexOf(e.id);\n        if (cb.checked && i === -1) ha.entities.push(e.id);\n        if (!cb.checked && i !== -1) ha.entities.splice(i, 1);\n      });\n      box.appendChild(el('label', {}, [cb, el('span', { text: e.name }), el('span', { 'class': 'st', text: e.state })]));\n    });\n  }\n  ['haUrl', 'haToken'].forEach(function (k) {\n    $(k).addEventListener('input', function () { haCfg()[k === 'haUrl' ? 'url' : 'token'] = $(k).value.trim(); });\n  });\n  $('haFilter').addEventListener('input', renderHa);\n  $('haLoad').addEventListener('click', function () {\n    var ha = haCfg();\n    if (!$('pin').value) return msg('Escribe el PIN de la tele', true);\n    msg('Conectando con Home Assistant…');\n    api('POST', '/ha/states', { url: ha.url, token: ha.token }).then(function (r) {\n      if (!r.ok) return msg(r.error, true);\n      haEntities = r.entities;\n      $('haFilter').classList.remove('hidden');\n      renderHa();\n      msg(r.entities.length + ' entidades. Marca las que quieras y pulsa Guardar.');\n    }).catch(function () { msg('No se pudo conectar', true); });\n  });\n\n  // ---------- Spotify ----------\n\n  function spotifyStatus() {\n    api('GET', '/spotify/status').then(function (r) {\n      $('spRedirect').textContent = r.redirect;\n      $('spState').textContent = r.connected ? 'Conectado. En la tele, OK sobre el widget pausa o reanuda y derecha pasa de canción (pausar necesita Premium).' : 'Sin conectar.';\n      $('spSetup').classList.toggle('hidden', r.connected);\n      $('spLogout').classList.toggle('hidden', !r.connected);\n      if (r.clientId) $('spClient').value = r.clientId;\n    }).catch(function () { $('spState').textContent = 'El servicio de la tele no responde'; });\n  }\n  $('spLogin').addEventListener('click', function () {\n    if (!$('pin').value) return msg('Escribe el PIN de la tele', true);\n    api('POST', '/spotify/login', { clientId: $('spClient').value }).then(function (r) {\n      if (!r.ok) return msg(r.error, true);\n      // Si el navegador bloquea la ventana nueva, se va en esta misma (al volver, el PIN sigue guardado)\n      if (!window.open(r.url, '_blank')) location.href = r.url;\n      msg('Inicia sesión en Spotify y vuelve aquí con la dirección');\n    });\n  });\n  $('spSend').addEventListener('click', function () {\n    api('POST', '/spotify/code', { url: $('spCode').value }).then(function (r) {\n      msg(r.ok ? 'Spotify conectado' : r.error, !r.ok);\n      spotifyStatus();\n    });\n  });\n  $('spLogout').addEventListener('click', function () {\n    api('POST', '/spotify/logout').then(function () { spotifyStatus(); });\n  });\n  spotifyStatus();\n\n  // El PIN se recuerda en este móvil\n  try { $('pin').value = localStorage.getItem('daniLauncherPin') || ''; } catch (e) { /* sin almacenamiento */ }\n  $('pin').addEventListener('input', function () {\n    try { localStorage.setItem('daniLauncherPin', $('pin').value); } catch (e) { /* sin almacenamiento */ }\n  });\n\n  ['title', 'background'].forEach(function (k) {\n    $(k).addEventListener('input', function () { cfg[k] = $(k).value; });\n  });\n\n  $('findCity').addEventListener('click', function () {\n    var name = $('city').value.trim();\n    if (!name) return;\n    fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&language=es&name=' + encodeURIComponent(name))\n      .then(function (r) { return r.json(); })\n      .then(function (d) {\n        if (!d.results || !d.results.length) return msg('No encuentro esa ciudad', true);\n        var c = d.results[0];\n        cfg.weather = { city: c.name, latitude: c.latitude, longitude: c.longitude };\n        render();\n        msg('Ciudad: ' + c.name + (c.country ? ' (' + c.country + ')' : ''));\n      })\n      .catch(function () { msg('No se pudo buscar la ciudad', true); });\n  });\n\n  $('addRow').addEventListener('click', function () { cfg.rows.push({ title: 'Nueva fila', tiles: [] }); render(); });\n\n  function save(okText) {\n    if (!$('pin').value) { msg('Escribe el PIN de la tele para guardar', true); $('pin').focus(); return; }\n    api('POST', '/config', cfg).then(function (r) {\n      msg(r.ok ? okText : r.error, !r.ok);\n    }).catch(function () { msg('No se pudo guardar', true); });\n  }\n\n  $('save').addEventListener('click', function () { save('Guardado. La tele se actualiza en unos segundos.'); });\n\n  $('reset').addEventListener('click', function () {\n    if (!confirm('¿Volver a la configuración original del launcher?')) return;\n    api('DELETE', '/config').then(function (r) {\n      msg(r.ok ? 'Restablecido. Recarga la página.' : r.error, !r.ok);\n    });\n  });\n\n  api('GET', '/apps').then(function (r) {\n    apps = r.apps || [];\n    var list = $('appIds');\n    apps.forEach(function (a) { list.appendChild(el('option', { value: a.id, text: a.name })); });\n    if (!apps.length) appsError = r.error || 'La tele no ha devuelto ninguna app';\n    renderApps();\n  }).catch(function () { appsError = 'No se pudo leer la lista de apps'; renderApps(); });\n\n  api('GET', '/config').then(function (r) {\n    if (r.config) { cfg = r.config; render(); return; }\n    // Sin configuración guardada: parte de la que trae el launcher (la tele la comparte al abrirse)\n    return api('GET', '/default').then(function (d) {\n      if (!d.config) return msg('Abre el launcher en la tele y recarga esta página', true);\n      cfg = d.config;\n      render();\n    });\n  }).catch(function () { msg('No se pudo leer la configuración', true); });\n})();\n</script>\n</body>\n</html>\n";
