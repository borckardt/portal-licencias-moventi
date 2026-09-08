# Tareas de mejora — Portal de licencias Moventi

Checklist de la auditoría del proyecto (seguridad, compilación/deploy, environments, código). Los 4 puntos de "prioridad recomendada" ya se implementaron — quedan marcados como ✅ con el detalle de qué se hizo y qué límite conocido queda. El resto son tareas pendientes, con prioridad sugerida.

## 📋 Para quien va a revisar/fusionar/desplegar esto (acceso a GitHub + Vercel)

Este cambio se armó con Claude Code en otra máquina/checkout, sobre una rama aparte (no toca `main` directo). Antes de mergear y que Vercel lo despliegue a producción:

1. **Revisa el PR/rama** como cualquier otro cambio — toca archivos sensibles (`api/`, `lib/adminAuth.js`, hashing, sesión). `npm run check` y `npm test` ya corren solos en cada push vía GitHub Actions (`.github/workflows/ci.yml`, nuevo) — confirma que el check quedó en verde antes de mergear.
2. **Antes o justo después de mergear a `main`**, entra a Vercel → tu proyecto → Settings → Environment Variables y agrega:
   - `SESSION_SECRET` — un valor random y largo (`openssl rand -base64 48` o cualquier generador de contraseñas largo), **distinto** de `PORTAL_API_TOKEN`. Sin esto, el login de administrador deja de funcionar por completo — falla cerrado a propósito (ver `lib/adminSession.js`), no es un detalle opcional.
   - Puedes dejar `ALLOW_PREVIEW_EMAIL` sin definir (ver `.env.example`).
3. **Redeploy** si Vercel no lo dispara solo al agregar la variable.
4. **Después de que quede desplegado, cierra sesión como admin y vuelve a entrar una vez** — las sesiones abiertas antes de este cambio no tienen la cookie nueva, así que "Cambiar mi contraseña" y algunas acciones de guardado fallarán hasta ese re-login.
5. Sigue la lista de "pasos para probar" más abajo (sección siguiente) contra el sitio real ya desplegado.
6. Con calma, y no bloqueante: separa las env vars de `GMAIL_*`/`BLOB_READ_WRITE_TOKEN` entre Preview y Production en el dashboard (ver sección "Environments" más abajo) — hoy probablemente están en "All Environments".

### ✅ Pasos para probar en el sitio real, después de desplegar

Contra la URL de producción (`.../admin` y `/`, con dos pestañas/navegadores si puedes: uno "admin", otro "cliente"):

1. **Login de admin correcto** → debe entrar igual que siempre. Abre DevTools → Application → Cookies y confirma que aparece `moventi_admin_session` (HttpOnly, no debería poder leerse desde la consola con `document.cookie`).
2. **Login de admin con clave incorrecta, 11 veces seguidas y rápido** → de la intento ~11 en adelante debería responder "Demasiados intentos" (429) en vez de seguir validando — prueba el rate limiting.
3. **Cambiar mi contraseña** (ya logueado) → debe funcionar normal. Si te da "Tu sesión expiró o no es válida", cierra sesión y entra de nuevo (ver paso 4 de arriba).
4. **Un cliente entra y envía una solicitud nueva** → debe guardarse y aparecerle al admin en "Solicitudes", como siempre.
5. **El admin aprueba/edita/elimina una solicitud, agrega un cliente, cambia un tipo de licencia** → todo debe seguir funcionando igual que antes (esto ahora sí requiere la cookie de sesión, que el admin ya tiene por estar logueado).
6. **"Enviar solicitud por correo"** a un correo de contacto ya configurado → debe llegar igual que siempre. Si alguna vez pruebas cambiando el correo de contacto a uno cualquiera y mandando, y no llega / da error `recipient_not_allowed`, es la lista blanca nueva funcionando — hay que guardar el correo en "Tipos de licencia" antes de poder mandarle.
7. Si algo de esto falla de forma rara, revisa Vercel → Deployments → (el deploy) → Functions/Logs — ahí van a aparecer los `console.warn`/errores nuevos con contexto.

## ✅ 1. Cerrar el hueco de `change-admin-password` / `save-state` sin sesión real

**Hecho:**
- `api/verify-admin-login.js` ahora emite una cookie de sesión `HttpOnly; Secure; SameSite=Strict`, firmada con HMAC (`lib/adminSession.js`), al loguearse correctamente.
- `api/change-admin-password.js` exige esa sesión válida — ya no basta con mandar `username: "admin"` (público) con el `PORTAL_API_TOKEN` (también público) para tomar la cuenta.
- `api/save-state.js` exige sesión de admin para cualquier cambio que no sea "un cliente agregando su propia solicitud nueva en estado pendiente" (`lib/appStateGuard.js` compara contra el último estado guardado y rechaza con 403 todo lo demás: tocar `users`, `licenseTypes`, `settings`, o editar/eliminar una solicitud existente).
- Nuevo `api/admin-logout.js` para limpiar la cookie del lado del servidor; `logout()` en `app.js` ya lo llama.
- No hizo falta tocar los `fetch()` existentes en `app.js`: al ser mismo origen, el navegador ya manda la cookie solo.

**Límites conocidos / follow-ups:**
- [ ] **`get-state` sigue devolviendo el estado completo** (incluye los `passwordHash` de *todos* los usuarios, clientes y admin) a cualquiera con el `PORTAL_API_TOKEN` público. Cerrar esto de verdad requiere una respuesta filtrada por rol (un cliente no debería recibir los hashes de otras cuentas) — es un cambio más grande de la forma en que `app.js` consume el estado; queda pendiente como tarea aparte.
- [ ] La migración automática de hashes de cliente en segundo plano (`migrateLegacyClientPasswords` y el rehash a PBKDF2 en el login, ambos en `app.js`) ya **no llega al backend compartido** cuando quien loguea es un cliente (el guardado toca `users`, y eso ahora exige sesión de admin) — falla en silencio y el hash viejo sigue funcionando hasta que un admin re-guarde esa cuenta desde el panel. Si queda algún cliente con contraseña en texto plano o hash SHA-256 viejo, conviene que el admin abra y re-guarde esa cuenta una vez. Idea para una solución mejor: un endpoint `api/migrate-my-password.js` donde el cliente pruebe su contraseña actual y el servidor actualice solo su propio `passwordHash`.
- [ ] `lib/appStateGuard.js` asume que las únicas mutaciones legítimas sin sesión de admin son "nueva solicitud pendiente". Si se agrega algún flujo nuevo donde un cliente pueda escribir algo distinto (cancelar su propia solicitud, editar su perfil, etc.), hay que ampliar ese guard a propósito.

## ✅ 2. Restringir el uso de `send-email` como relay libre

**Hecho:**
- `api/send-email.js` ahora arma una lista blanca de destinatarios (`lib/constants.js` + `STATE.settings.ingramEmail`/`ingramCc` leídos del propio estado guardado) y rechaza con 403 cualquier `to`/`cc` que no esté en ella — ya no acepta mandar a una dirección arbitraria solo por tener el token público.
- `lib/gmail.js` agrega una red de seguridad para *Preview deployments* de Vercel: si `VERCEL_ENV !== 'production'`, no manda correo real (solo lo deja en el log) salvo que se ponga `ALLOW_PREVIEW_EMAIL=true` a propósito.

**Follow-ups:**
- [ ] Si en el futuro se necesita mandar a direcciones fuera de `settings`/`constants.js` (p. ej. un proveedor nuevo por única vez), hay que agregarlas a esa configuración — no había antes, y ahora tampoco, una forma de "mandar a cualquiera" desde el panel.

## ✅ 3. Separar env vars Preview/Production y fijar `engines.node`

**Hecho:**
- `package.json` → `"engines": { "node": "20.x" }`, para no depender del default que tenga el proyecto en el dashboard de Vercel.
- `.env.example` (nuevo) documenta todas las variables, con nota explícita sobre separar Preview/Production.
- `.gitignore` (nuevo) — no existía; falta para no comprometer accidentalmente un `.env` local.
- Se generó `package-lock.json` (no existía) — corre `npm install` una vez y súbelo al repo para fijar versiones exactas de dependencias.

**Pendiente (requiere el dashboard de Vercel, no se puede hacer por código):**
- [ ] **Separar valores de `GMAIL_*` y `BLOB_READ_WRITE_TOKEN` entre Production y Preview** en Vercel → Settings → Environment Variables (elegir el entorno al agregar cada variable, en vez de "All Environments"). Sin esto, cada preview deploy de una rama/PR sigue escribiendo sobre el mismo Blob de producción — la salvaguarda de `ALLOW_PREVIEW_EMAIL` cubre el envío de correo, pero no la escritura de datos.
- [ ] Idealmente, un Blob store separado para Preview (o un `BLOB_PREFIX` distinto por entorno en `lib/appState.js`/`lib/adminAuth.js`) para que un preview deploy no pueda tocar los datos reales ni por accidente.

## ✅ 4. Reforzar hashing de contraseñas y rate limiting básico

**Hecho:**
- **Admin** (`lib/adminAuth.js`): hash nuevo con `scrypt` (nativo de Node, sin dependencia nueva) en vez de un solo SHA-256. Compatible hacia atrás: si la cuenta todavía tiene el hash viejo, se sigue verificando y se re-hashea solo en el próximo login o cambio de contraseña exitoso (`needsRehash`).
- **Clientes** (`app.js`): hash nuevo con PBKDF2-SHA256 (150 000 iteraciones) vía Web Crypto nativa (sin librerías externas, compatible con la CSP del sitio). Mismo esquema de compatibilidad/migración transparente que el admin.
- **Rate limiting** (`lib/rateLimit.js`) aplicado a `verify-admin-login`, `request-password-reset`, `reset-password` y `change-admin-password`.

**Límite conocido (documentado en el propio archivo):**
- [ ] El rate limit es **en memoria, por instancia de función serverless** — se resetea en cada cold start y no se comparte entre instancias concurrentes. Sirve para frenar abuso casual/automatizado simple, no es una defensa robusta contra un atacante dedicado. Para eso: sumar **Vercel KV o Upstash Redis** como contador compartido de verdad (cambio acotado: solo tocaría `lib/rateLimit.js`).

---

## Seguridad — pendientes adicionales (no cubiertos arriba)

- [ ] **Prioridad alta.** Diseñar una respuesta de `get-state` filtrada por rol, para que un cliente no reciba los `passwordHash` de otras cuentas (ver nota en el punto 1).
- [ ] **Prioridad media.** Los blobs de estado y de auth se guardan con `access: 'public'` en Vercel Blob — la única protección es que el pathname es aleatorio/no listado. Evaluar si Vercel Blob ya soporta blobs privados (requieren URL firmada) para estos dos casos, o migrar ese dato a un almacén con control de acceso real (Vercel KV / Postgres) más adelante.
- [ ] **Prioridad media.** Quitar `'unsafe-inline'` de `script-src` en `vercel.json` — mover el `<script>window.PORTAL_ENTRY_MODE=...</script>` inline de `index.html`/`admin.html` a un atributo `data-*` que `app.js` lea, o a un nonce.
- [ ] **Prioridad baja.** Revisar si el repo de GitHub (`borckardt/portal-licencias-moventi`) tiene protección de rama en `main` (revisión obligatoria, sin push directo) — los últimos commits sugieren edición directa vía la web de GitHub.

## Compilación / Deploy

- [ ] Documentar en el README el flujo local: `npm install`, `vercel env pull .env.local`, `vercel dev`.
- [ ] Confirmar que el lockfile (`package-lock.json`, ya generado en este cambio) queda commiteado — da reproducibilidad exacta de `@vercel/blob`.
- [ ] Opcional: agregar un `npm run check` (`node --check api/*.js lib/*.js app.js`, o un linter tipo ESLint) como paso manual antes de subir cambios, ya que no hay CI todavía (ver sección Proceso).

## Código / calidad

- [ ] `app.js` sigue siendo un solo archivo (~100 KB). Entendible por qué (compartir lógica entre `/` y `/admin` sin duplicar), pero si sigue creciendo conviene partirlo en módulos internos + un build ligero (esbuild) que junte todo en un solo bundle servido — mantiene el "un solo archivo lógico" sin que la fuente sea un único archivo gigante.
- [x] **Tests automatizados para `lib/*.js`** — `test/adminAuth.test.js`, `test/adminSession.test.js`, `test/appStateGuard.test.js`, `test/rateLimit.test.js` (22 casos, `node --test`, sin dependencias nuevas). Corre `npm test`. Falta cubrir `api/*.js` (los handlers HTTP en sí) y `lib/appState.js`/`lib/gmail.js` (requieren mockear Vercel Blob / Gmail, no son solo lógica pura).
- [x] `npm run check` — valida sintaxis de todo el JS (`app.js`, `api/*.js`, `lib/*.js`) con un script propio (`scripts/check-syntax.js`) que no depende de glob de shell, así funciona igual en Windows/cmd que en bash.
- [x] **CI con GitHub Actions** (`.github/workflows/ci.yml`, nuevo) — corre `npm ci && npm run check && npm test` en cada push y en cada PR contra `main`. No bloquea el deploy de Vercel por sí solo (Vercel despliega igual aunque el check falle) — para que si bloquee de verdad, falta activar "Require status checks to pass" en la protección de la rama `main` en GitHub (Settings → Branches), lo cual requiere que alguien con permisos de admin del repo lo configure una vez.

## Proceso

- [ ] Adoptar un flujo mínimo de rama → PR → preview de Vercel → merge a `main`, en vez de editar directo sobre `main` (o al menos revisar el diff del preview antes de mergear cambios que toquen `api/`/`lib/`).
