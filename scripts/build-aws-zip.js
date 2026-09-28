// npm run build:aws — arma el .zip listo para subir a AWS Elastic Beanstalk
// (consola → "Subir e implementar"). Incluye solo lo necesario para correr
// node-server.js y deja fuera secretos y archivos locales:
//   - nunca: .env*, .vercel/, .git/, node_modules/, data/, dist/, .kilo/
//   - Beanstalk instala las dependencias solo (npm install) a partir de
//     package.json / package-lock.json.
// Resultado: dist/portal-licencias-aws-AAAAMMDD-HHMM.zip

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const root = path.join(__dirname, '..');
const INCLUDE = [
  // servidor y backend
  'node-server.js', 'package.json', 'package-lock.json', 'Procfile', 'vercel.json',
  'api', 'lib',
  // frontend
  'index.html', 'admin.html', 'app.js', 'styles.css', 'robots.txt',
  'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'assets', 'vendor',
  // configuración opcional de Beanstalk
  '.ebextensions', '.platform',
];
const NEVER = /(^|[\\/])(\.env[^\\/]*|\.vercel|\.git|node_modules|data|dist|\.kilo)([\\/]|$)/;

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'portal-licencias-aws-' + stamp + '.zip');

const output = fs.createWriteStream(outFile);
const zip = archiver('zip', { zlib: { level: 9 } });
zip.on('warning', function (e) { console.warn(e); });
zip.on('error', function (e) { throw e; });
zip.pipe(output);

let count = 0;
function addPath(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || NEVER.test(rel)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    fs.readdirSync(abs).forEach(function (f) { addPath(path.join(rel, f)); });
  } else {
    // Rutas con "/" dentro del zip (Beanstalk en Linux no acepta "\").
    zip.file(abs, { name: rel.split(path.sep).join('/') });
    count++;
  }
}
INCLUDE.forEach(addPath);

output.on('close', function () {
  console.log('OK: ' + count + ' archivos → ' + path.relative(root, outFile) +
    ' (' + Math.round(zip.pointer() / 1024) + ' KB)');
  console.log('Súbelo en Elastic Beanstalk → tu entorno → "Subir e implementar".');
});
zip.finalize();
