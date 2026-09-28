// Servidor Node (Express) para correr el portal FUERA de Vercel — por ejemplo
// en AWS (Elastic Beanstalk, EC2, App Runner, ECS) o en tu equipo.
//
// Se llama node-server.js (y no server.js/index.js/app.js) a propósito: con
// esos nombres Vercel podría detectarlo como app Express y cambiar cómo se
// despliega el proyecto allá. Así Vercel sigue igual que siempre.
//
// - Sirve el frontend (index.html, admin.html, app.js, styles.css, assets…)
//   con las mismas "clean URLs" que Vercel (/admin → admin.html).
// - Monta cada archivo de api/*.js en /api/<nombre>, sin tocar su código:
//   los handlers ya usan req.method / req.headers / req.body /
//   res.status().json() / res.setHeader(), que Express provee igual.
// - Aplica las mismas cabeceras de seguridad definidas en vercel.json
//   (se leen de ahí, para mantener una sola fuente de verdad).
//
// Arranque:  npm start           (usa las variables de entorno del sistema)
//            npm run dev          (local; carga .env.local / .env si existen)
// Puerto:    PORT (Elastic Beanstalk y App Runner lo definen solos; por
//            defecto 8080).

const fs = require('fs');
const path = require('path');

// En local cargamos .env.local / .env (nunca se suben: están en .gitignore).
// En AWS las variables vienen del entorno del servicio y estos archivos no
// existen en el paquete.
try {
  const dotenv = require('dotenv');
  ['.env.local', '.env'].forEach(function (f) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) dotenv.config({ path: p, override: false });
  });
} catch (e) { /* dotenv es opcional */ }

const express = require('express');
const { driverName } = require('./lib/store');

const ROOT = __dirname;
const app = express();
app.disable('x-powered-by');
// Detrás de un balanceador (ALB/CloudFront) la IP real llega en
// X-Forwarded-For; lib/rateLimit.js ya la lee de ahí.
app.set('trust proxy', true);

/* ---------- Cabeceras de seguridad (las mismas de vercel.json) ---------- */
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf-8'));
const headerRules = (vercelConfig.headers || []).map(function (rule) {
  // Vercel usa patrones tipo "/(.*)" y "/api/(.*)"; los pasamos a RegExp.
  return { re: new RegExp('^' + rule.source + '$'), headers: rule.headers || [] };
});
app.use(function (req, res, next) {
  headerRules.forEach(function (rule) {
    if (rule.re.test(req.path)) {
      rule.headers.forEach(function (h) { res.setHeader(h.key, h.value); });
    }
  });
  next();
});

/* ---------- API ---------- */
// El estado completo del portal viaja en un solo JSON; Vercel acepta hasta
// ~4.5 MB por request, así que dejamos un margen similar.
app.use('/api', express.json({ limit: '6mb' }));
const apiDir = path.join(ROOT, 'api');
fs.readdirSync(apiDir).filter(function (f) { return f.endsWith('.js'); }).forEach(function (f) {
  const name = f.replace(/\.js$/, '');
  const handler = require(path.join(apiDir, f));
  app.all('/api/' + name, function (req, res, next) {
    Promise.resolve(handler(req, res)).catch(next);
  });
});
app.all('/api/*', function (req, res) {
  res.status(404).json({ ok: false, error: 'not_found' });
});

/* ---------- Frontend estático ---------- */
// Lista blanca: solo se publican estos archivos y carpetas. Nunca se sirven
// node-server.js, lib/, api/, package.json, .env*, data/, etc.
const PUBLIC_FILES = new Set([
  'index.html', 'admin.html', 'app.js', 'styles.css', 'robots.txt',
  'favicon.ico', 'favicon-16.png', 'favicon-32.png',
]);
const PUBLIC_DIRS = ['assets', 'vendor'];

// trailingSlash: false → /admin/ redirige a /admin
app.use(function (req, res, next) {
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const q = req.url.slice(req.path.length);
    return res.redirect(308, req.path.replace(/\/+$/, '') + q);
  }
  next();
});
// cleanUrls: /admin.html redirige a /admin
app.use(function (req, res, next) {
  if (/\.html$/.test(req.path)) {
    const clean = req.path === '/index.html' ? '/' : req.path.replace(/\.html$/, '');
    return res.redirect(308, clean + req.url.slice(req.path.length));
  }
  next();
});

PUBLIC_DIRS.forEach(function (dir) {
  app.use('/' + dir, express.static(path.join(ROOT, dir), { dotfiles: 'deny', index: false, fallthrough: true }));
});

app.get('*', function (req, res, next) {
  let rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  if (!rel.includes('.') && PUBLIC_FILES.has(rel + '.html')) rel = rel + '.html';
  if (!PUBLIC_FILES.has(rel)) return next();
  res.sendFile(path.join(ROOT, rel), { dotfiles: 'deny' });
});

app.use(function (req, res) {
  res.status(404).type('text/plain').send('Not found');
});

// Errores no controlados de un handler de /api → 500 en JSON.
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  console.error('[server] error no controlado:', err && err.stack || err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) res.status(500).json({ ok: false, error: 'server_error' });
  else res.status(500).type('text/plain').send('Error interno');
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  app.listen(port, function () {
    console.log('[server] Portal de licencias escuchando en el puerto ' + port +
      ' · almacenamiento: ' + driverName());
    // Aviso (solo nombres, nunca valores) si faltan variables necesarias.
    const faltan = ['SESSION_SECRET'].concat(driverName() === 's3' ? ['S3_BUCKET', 'AWS_REGION'] : [])
      .filter(function (k) { return !process.env[k] && !(k === 'AWS_REGION' && process.env.AWS_DEFAULT_REGION); });
    if (faltan.length) {
      console.warn('[server] AVISO: faltan variables de entorno: ' + faltan.join(', ') +
        ' — el login de administrador y los guardados no funcionarán hasta definirlas.');
    }
    if (!process.env.GMAIL_SENDER_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
      console.warn('[server] AVISO: sin GMAIL_SENDER_EMAIL / GMAIL_APP_PASSWORD no se envían correos.');
    }
    if (driverName() === 'file') {
      console.log('[server] AVISO: STORAGE_DRIVER=file guarda los datos en disco local (solo para desarrollo).');
    }
  });
}

module.exports = app;
