// Junta service/src/service.js y el editor del móvil en service/service.js, que es el
// archivo que TizenBrew descarga (solo admite un archivo de servicio).
// Uso: node tools/build-service.js
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var src = fs.readFileSync(path.join(root, 'service/src/service.js'), 'utf8');
var editor = fs.readFileSync(path.join(root, 'service/src/editor.html'), 'utf8');

var out = '// Generado por tools/build-service.js desde service/src/. No editar a mano.\n' +
  src.replace("'__EDITOR_HTML__'", function () { return JSON.stringify(editor); });
fs.writeFileSync(path.join(root, 'service/service.js'), out);
console.log('service/service.js: ' + out.length + ' bytes');
