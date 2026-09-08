// npm run check — valida la sintaxis de todo el JS del proyecto (app.js,
// api/*.js, lib/*.js) sin depender de glob de shell (que en cmd.exe de
// Windows no expande api/*.js como en bash). No corre nada, solo compila.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = ['app.js'];
for (const dir of ['api', 'lib']) {
  for (const f of fs.readdirSync(path.join(root, dir))) {
    if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
}

let failed = false;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { cwd: root, stdio: 'inherit' });
  } catch (e) {
    failed = true;
  }
}
if (failed) {
  console.error('\nHay errores de sintaxis — revisa arriba.');
  process.exit(1);
}
console.log('OK: ' + files.length + ' archivos sin errores de sintaxis.');
