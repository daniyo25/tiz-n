/* Servicio del launcher. TizenBrew lo ejecuta en su proceso de Node con acceso a `tizen`,
 * que sí tiene permiso para abrir otras apps (la página del launcher no lo tiene y la API
 * REST de la TV responde 401). Escucha solo en localhost.
 *   GET /launch?id=<appId>  abre una app instalada
 *   GET /apps               lista las apps instaladas (id y nombre)
 * Escrito en ES5 porque Tizen 3 trae Node 4. */
var http = require('http');
var url = require('url');

var PORT = 8091;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
}

function launch(appId, res) {
  try {
    tizen.application.launch(appId,
      function () { send(res, 200, { ok: true }); },
      function (err) { send(res, 500, { ok: false, error: err.name + ': ' + err.message }); });
  } catch (e) {
    send(res, 500, { ok: false, error: e.name + ': ' + e.message });
  }
}

function listApps(res) {
  try {
    tizen.application.getAppsInfo(function (apps) {
      var list = apps
        .filter(function (a) { return a.show; })
        .map(function (a) { return { id: a.id, name: a.name }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      send(res, 200, { ok: true, apps: list });
    }, function (err) {
      send(res, 500, { ok: false, error: err.name + ': ' + err.message });
    });
  } catch (e) {
    send(res, 500, { ok: false, error: e.name + ': ' + e.message });
  }
}

var server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url, true);
  if (parsed.pathname === '/launch' && parsed.query.id) launch(parsed.query.id, res);
  else if (parsed.pathname === '/apps') listApps(res);
  else if (parsed.pathname === '/ping') send(res, 200, { ok: true });
  else send(res, 404, { ok: false, error: 'Not found' });
});

// Si TizenBrew relanza el servicio y el puerto sigue ocupado, el anterior sigue atendiendo.
server.on('error', function () {});
server.listen(PORT, '127.0.0.1');
