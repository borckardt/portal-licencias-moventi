// npm run migrate:blob-to-s3 — copia los datos actuales del portal desde
// Vercel Blob (producción) a Amazon S3, UNA vez, antes de apuntar el portal
// en AWS a S3.
//
// Copia dos documentos: 'app-state' (clientes, solicitudes, tipos de
// licencia, configuración) y 'admin-auth' (cuenta del administrador, con la
// contraseña hasheada). Solo LEE de Vercel Blob; no borra ni modifica nada
// allí. Nunca imprime el contenido ni los secretos, solo un resumen.
//
// Variables necesarias (en .env.local o en la terminal, nunca en el repo):
//   BLOB_READ_WRITE_TOKEN   token del Blob de producción (lectura)
//   S3_BUCKET, AWS_REGION   bucket de destino (y S3_PREFIX si lo usas)
//   credenciales AWS        perfil de la AWS CLI o AWS_ACCESS_KEY_ID/SECRET
//
// Opciones:
//   --dry-run   solo muestra qué copiaría, sin escribir en S3
//   --backup    además guarda una copia local en ./backup/ (no se sube a git)
//   --force     sobrescribe si el documento ya existe en S3

const fs = require('fs');
const path = require('path');

try {
  const dotenv = require('dotenv');
  ['.env.local', '.env'].forEach(function (f) {
    const p = path.join(__dirname, '..', f);
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  });
} catch (e) { /* opcional */ }

const { _drivers } = require('../lib/store');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const BACKUP = args.has('--backup');
const FORCE = args.has('--force');
const DOCS = ['app-state', 'admin-auth'];

function fail(msg) { console.error('ERROR: ' + msg); process.exit(1); }

function resumen(name, doc) {
  if (name === 'app-state') {
    return (doc.users || []).length + ' usuarios, ' + (doc.requests || []).length + ' solicitudes, ' +
      (doc.licenseTypes || []).length + ' tipos de licencia';
  }
  return 'usuario admin: ' + (doc.username ? 'sí' : 'no') + ', contraseña hasheada: ' + (doc.passwordHash ? 'sí' : 'no');
}

(async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) fail('falta BLOB_READ_WRITE_TOKEN (origen).');
  if (!process.env.S3_BUCKET) fail('falta S3_BUCKET (destino).');
  if (!process.env.AWS_REGION && !process.env.AWS_DEFAULT_REGION) fail('falta AWS_REGION.');

  for (const name of DOCS) {
    const doc = await _drivers.blob.load(name);
    if (!doc) { console.log('- ' + name + ': no existe en Vercel Blob, se omite.'); continue; }
    console.log('- ' + name + ': leído de Vercel Blob (' + resumen(name, doc) + ').');

    if (BACKUP) {
      const dir = path.join(__dirname, '..', 'backup');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, name + '-' + Date.now() + '.json');
      fs.writeFileSync(f, JSON.stringify(doc));
      console.log('  copia local: ' + path.relative(process.cwd(), f));
    }

    const existing = await _drivers.s3.load(name);
    if (existing && !FORCE) {
      console.log('  YA EXISTE en S3: no se sobrescribe (usa --force si de verdad quieres reemplazarlo).');
      continue;
    }
    if (DRY) { console.log('  [dry-run] se escribiría en s3://' + process.env.S3_BUCKET + '/' + (process.env.S3_PREFIX || '') + name + '.json'); continue; }
    await _drivers.s3.save(name, doc);
    const check = await _drivers.s3.load(name);
    const ok = check && JSON.stringify(check) === JSON.stringify(doc);
    console.log('  ' + (ok ? 'copiado y verificado en S3.' : 'ATENCIÓN: la verificación no coincide, revisa el bucket.'));
    if (!ok) process.exitCode = 1;
  }
  console.log('Listo.');
})().catch(function (err) { fail(err && err.message || String(err)); });
