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

function fastIconPath(appId) {
  try {
    var p = (tizen.application.getAppInfo(appId).iconPath || '').replace(/^file:\/\//, '');
    if (p && fs.statSync(p).isFile()) return p;
  } catch (e) { /* se busca en la carpeta */ }
  return '';
}

function sendIcon(appId, kind, res) {
  // El icono normal sale directo del iconPath si se puede leer; recorrer la carpeta de la
  // app solo hace falta para la panorámica o cuando el iconPath falla
  var path = kind === 'banner' ? '' : (imageCache[appId] ? imageCache[appId].icon : fastIconPath(appId));
  if (!path) {
    var info = appImages(appId);
    path = kind === 'banner' ? info.banner : info.icon;
  }
  if (!path) return send(res, 404, { ok: false, error: 'Sin imagen' });
  var ext = path.split('.').pop().toLowerCase();
  var type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
  var stream = fs.createReadStream(path);
  stream.on('error', function (e) { fail(res, e); });
  stream.on('open', function () {
    // La página añade &v=<arranque> a la URL, así que se puede guardar en caché sin miedo
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400', 'Access-Control-Allow-Origin': '*' });
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

var EDITOR_HTML = '__EDITOR_HTML__';
