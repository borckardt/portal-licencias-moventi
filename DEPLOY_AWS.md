# Desplegar el Portal de licencias en AWS (manual)

El portal ya no depende de Vercel para correr: `node-server.js` levanta el frontend y
las funciones de `api/` con Express, y `lib/store.js` guarda los datos en
**Amazon S3** (o en Vercel Blob / archivos locales, según `STORAGE_DRIVER`).
Vercel sigue funcionando igual que antes; este camino es adicional.

Arquitectura recomendada (la más simple para desplegar a mano):

```
Usuario ──HTTPS──▶ CloudFront ──HTTP──▶ Elastic Beanstalk (Node 20, node-server.js) ──▶ S3 (datos, privado)
                                                   └──SMTP──▶ Gmail (correos)
```

> **HTTPS es obligatorio.** La cookie de sesión del administrador es `Secure`:
> por `http://` el navegador no la guarda y el admin no puede guardar cambios.
> Por eso va CloudFront delante (da HTTPS sin comprar dominio) o un
> balanceador con certificado ACM si usas un dominio propio.

---

## 0. Probar en local (sin tocar datos reales)

```bash
npm install
# genera un secreto de sesión SOLO para tu equipo (no lo pegues en ningún chat)
node -e "console.log('SESSION_SECRET='+require('crypto').randomBytes(32).toString('hex'))" >> .env.local
npm run dev          # http://localhost:8080  y  http://localhost:8080/admin
```

Sin `S3_BUCKET` ni `BLOB_READ_WRITE_TOKEN`, los datos se guardan en `./data/`
(ignorada por git). La primera vez el admin es `admin` / la contraseña por
defecto de `lib/adminAuth.js`; cámbiala desde "Mi cuenta".

> Ya no hace falta `vercel dev`. Si quieres correr exactamente como en Vercel,
> sigue funcionando; `npm run dev` es la forma nueva y no necesita cuenta.

---

## 1. Bucket S3 para los datos

1. S3 → **Crear bucket**, por ejemplo `moventi-portal-licencias-datos`, en tu
   región (ej. `us-east-1`).
2. Deja **Bloquear todo el acceso público: activado** y el cifrado por defecto.
3. (Recomendado) Activa **Control de versiones**: si un guardado sale mal,
   puedes recuperar la versión anterior del JSON.

El portal usará dos objetos: `portal/app-state.json` y `portal/admin-auth.json`.

## 2. Permisos (IAM) — sin access keys en el servidor

Crea una política `PortalLicenciasS3` y adjúntala al **rol de instancia** que
usa Elastic Beanstalk (`aws-elasticbeanstalk-ec2-role`, o el que elijas al
crear el entorno):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"],
    "Resource": "arn:aws:s3:::moventi-portal-licencias-datos/portal/*"
  }]
}
```

Así el servidor accede a S3 con el rol, sin guardar claves en ningún lado.

## 3. Migrar los datos actuales de Vercel a S3 (una sola vez)

Hazlo **antes** de abrir el portal en AWS. Si S3 está vacío, el portal crea un
admin con la contraseña por defecto y arranca sin clientes ni solicitudes.

En tu equipo, con la AWS CLI configurada (`aws configure`) y en `.env.local`
(nunca en el repo):

```
BLOB_READ_WRITE_TOKEN=...   # el de producción, solo para leer
S3_BUCKET=moventi-portal-licencias-datos
S3_PREFIX=portal/
AWS_REGION=us-east-1
```

```bash
npm run migrate:blob-to-s3 -- --dry-run            # muestra qué copiaría
npm run migrate:blob-to-s3 -- --backup             # copia y deja respaldo en ./backup
```

El script solo **lee** de Vercel Blob, no borra nada allí, verifica la copia
en S3 y muestra solo un resumen (cantidad de usuarios/solicitudes), nunca los
datos. Después borra el `BLOB_READ_WRITE_TOKEN` de tu `.env.local`.

## 4. Crear el entorno en Elastic Beanstalk

1. Elastic Beanstalk → **Crear aplicación** → nombre `portal-licencias`.
2. Plataforma: **Node.js 20** (o 22) on Amazon Linux 2023.
3. Código: **Cargar el código** → sube el zip del paso 5 (o créalo con la app
   de ejemplo y luego sube el zip).
4. Preset: **Instancia única** (suficiente para este portal). El rate limiting
   de login vive en memoria, así que con una sola instancia funciona exacto.
5. Rol de servicio / perfil de instancia: el que tiene la política del paso 2.
6. **Propiedades del entorno** (variables):

| Variable | Valor |
|---|---|
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | `moventi-portal-licencias-datos` |
| `S3_PREFIX` | `portal/` |
| `AWS_REGION` | tu región |
| `SESSION_SECRET` | uno **nuevo**, generado en tu terminal |
| `GMAIL_SENDER_EMAIL` | `administracion@moventiglobal.com` |
| `GMAIL_APP_PASSWORD` | la contraseña de aplicación de Gmail |
| `PORTAL_API_TOKEN` | opcional; si la pones, igual a la de `app.js` |

No hace falta definir `PORT`: Beanstalk la pone solo y `node-server.js` la usa.

## 5. Generar el paquete y subirlo

```bash
npm test && npm run check
npm run build:aws      # → dist/portal-licencias-aws-AAAAMMDD-HHMM.zip
```

El zip incluye solo `node-server.js`, `api/`, `lib/`, el frontend y la
configuración; **excluye** `.env*`, `.vercel/`, `node_modules/`, `data/` y
`.git/`. Beanstalk instala las dependencias solo.

Beanstalk → tu entorno → **Subir e implementar** → elige el zip. Cada nueva
versión se sube igual.

Incluido en el zip: `.platform/nginx/conf.d/portal.conf`, que sube el límite
de tamaño de nginx a 8 MB (por defecto 1 MB) para que guardar el estado no
falle con 413.

## 6. HTTPS con CloudFront

1. CloudFront → **Crear distribución** → origen: el dominio del entorno
   (`xxxx.us-east-1.elasticbeanstalk.com`), protocolo **HTTP only**.
2. Visor: **Redirect HTTP to HTTPS**. Métodos: **GET, HEAD, OPTIONS, PUT,
   POST, PATCH, DELETE**.
3. Política de caché: **CachingDisabled** (el portal es dinámico y los datos
   no deben cachearse).
4. Política de solicitud de origen: **AllViewerExceptHostHeader** (reenvía
   cookies, cabeceras como `x-portal-token` y la query `?resetToken=`).
5. Usa la URL `https://dxxxx.cloudfront.net` (o asocia tu dominio con un
   certificado de ACM en `us-east-1`).

Con dominio propio también puedes usar un entorno **con balanceador** y un
certificado ACM en el listener 443 en vez de CloudFront.

## 7. Verificación después de desplegar

- `https://…/` abre el login de clientes y `https://…/admin` el de admin.
- Login de admin con tu contraseña actual (la migrada) → entra y **guarda**
  un cambio pequeño; recarga en otro navegador y se ve.
- "Olvidé mi contraseña" → llega el correo y el enlace abre `/admin?resetToken=…`.
- `https://…/node-server.js` y `https://…/package.json` devuelven **404** (no se
  publica código del servidor).
- En Beanstalk → Registros no hay errores de `AccessDenied` (permisos S3) ni
  avisos de variables faltantes al arrancar.

## 8. Qué cambia y qué no

- **Sin cambios:** el frontend, la API, los correos, las cabeceras de
  seguridad (se leen de `vercel.json`) y el despliegue en Vercel.
- **Nuevo:** `node-server.js`, `lib/store.js`, `Procfile`, `Dockerfile`
  (para App Runner/ECS si prefieres contenedores),
  `.platform/`, `scripts/build-aws-zip.js`, `scripts/migrate-blob-to-s3.js`.
- **Ojo con correr dos entornos a la vez:** si Vercel y AWS quedan activos
  apuntando a datos distintos, cada uno tendrá su propia copia. Cuando AWS
  esté validado, deja de usar la URL de Vercel (o pon Vercel a redirigir).
