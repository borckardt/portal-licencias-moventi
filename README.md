# Portal de licencias — Moventi

Sitio estático desplegado en Vercel, con dos puntos de entrada separados:

- **`/` (index.html)** — acceso para clientes. Nunca muestra ni permite el login de administrador.
- **`/admin` (admin.html)** — acceso exclusivo para el administrador (Moventi). Es una URL distinta, que no se le entrega a los clientes.

Ambas páginas comparten el mismo código de la aplicación (`app.js`) y los mismos estilos (`styles.css`) — cada una solo le indica a `app.js`, mediante `window.PORTAL_ENTRY_MODE`, qué perfil de login mostrar. Esto significa que solo hay que mantener un archivo de lógica (`app.js`), no una copia por cada interfaz.

## Estructura

```
portal-licencias-vercel/
├── index.html      → entrada para clientes (/)
├── admin.html       → entrada para el administrador (/admin)
├── app.js           → toda la lógica de la aplicación (compartida por ambas páginas)
├── styles.css        → todos los estilos (compartidos)
├── robots.txt        → bloquea la indexación por buscadores (portal privado)
├── vercel.json        → cabeceras de seguridad + config de rutas
├── package.json
├── api/                → endpoints serverless (backend)
│   ├── get-state.js       GET  → lee el estado completo (clientes, solicitudes, tipos, config)
│   ├── save-state.js      POST → guarda el estado completo (admin) o solo agrega una solicitud propia (cliente, ver lib/appStateGuard.js)
│   ├── verify-admin-login.js  POST → valida usuario/clave del administrador y abre sesión (cookie)
│   ├── admin-logout.js    POST → cierra la sesión de administrador
│   ├── change-admin-password.js POST → cambia la contraseña del admin (requiere sesión)
│   ├── request-password-reset.js POST → genera token y manda correo de "olvidé mi contraseña" (enlace a /admin)
│   ├── reset-password.js  POST → aplica la nueva contraseña con el token
│   └── send-email.js      POST → envía el correo al proveedor (con CC) vía Gmail API, solo a direcciones en la lista blanca
└── lib/                 → lógica compartida entre endpoints
    ├── appState.js        Vercel Blob: estado compartido del portal
    ├── appStateGuard.js   qué le está permitido guardar a quien no es admin
    ├── adminAuth.js       Vercel Blob + hashing (scrypt) de la cuenta de admin
    ├── adminSession.js    cookie de sesión firmada del admin
    ├── rateLimit.js        límite básico de intentos por IP (login, reset, cambio de clave)
    ├── constants.js        direcciones internas de aviso, compartidas por varios endpoints
    └── gmail.js            envío de correo vía Gmail API
```

## Cómo editarlo

- Cambios de lógica/pantallas (ambos perfiles): edita `app.js`.
- Cambios de estilos: edita `styles.css`.
- Cambios que solo apliquen a una de las dos entradas (p. ej. el texto del encabezado): busca `ENTRY_MODE` dentro de `app.js` — ahí se ramifica lo que es distinto entre cliente y administrador.
- No dupliques `app.js` ni `styles.css` entre `index.html` y `admin.html`: ambas páginas cargan los mismos archivos.
- **Proyectos/servicios del cliente** (Ligo-Prod, LigoCloudPlatform, Ligo-Dev): la lista vive en la constante `PROJECT_OPTIONS` al inicio de `app.js`. Para agregar, quitar o renombrar un proyecto, edita esa constante — se actualiza automáticamente el selector del formulario de solicitud del cliente, las columnas/filtros "Proyecto" en los paneles de administrador (Solicitudes y Reporte), el desglose por proyecto del Reporte, el CSV exportado y los correos de notificación.

## Seguridad

- **Dos puertas separadas**: la interfaz de administrador nunca aparece ni es alcanzable desde la página de clientes (ni siquiera el selector de "Cliente/Administrador" existe ya) — son URLs (`/` y `/admin`) y archivos distintos.
- **Cabeceras HTTP** (`vercel.json`): `X-Robots-Tag: noindex` (no indexable por buscadores/bots), `Content-Security-Policy`, `X-Frame-Options: DENY` (anti-clickjacking), `Strict-Transport-Security`, `Referrer-Policy`, `Permissions-Policy`.
- **`robots.txt`**: bloquea el rastreo de todo el sitio por bots de buscadores.
- **`PORTAL_API_TOKEN`**: token compartido que el frontend manda en cada llamada a `/api/*`, para que esos endpoints no sean un relay abierto para bots/scripts automatizados (ver `SETUP_GMAIL.md`).
- **Datos**: el estado de la app (clientes, solicitudes, tipos de licencia) vive en Vercel Blob (`app-state.json`), no en el HTML ni en `localStorage` — todos los navegadores/dispositivos ven los mismos datos. La contraseña del administrador vive hasheada (salt + SHA-256) en un blob separado (`admin-auth-*.json`).
- **Sesión real de administrador**: iniciar sesión como admin emite una cookie `HttpOnly` firmada con `SESSION_SECRET` (ver `lib/adminSession.js`). `change-admin-password` y las escrituras "de admin" en `save-state` (usuarios, tipos de licencia, configuración, editar/aprobar/eliminar solicitudes) exigen esa cookie — ya no basta con conocer `PORTAL_API_TOKEN` (público, visible en el JS del sitio) para tomar la cuenta de administrador o reescribir los datos de todos los clientes. Un cliente que solo envía una solicitud nueva sigue funcionando sin sesión de admin (ver `lib/appStateGuard.js`).
- **Rate limiting básico** (`lib/rateLimit.js`) en login, "olvidé mi contraseña", reseteo y cambio de contraseña del admin — mitiga fuerza bruta casual. Limitación conocida: es en memoria por instancia de función serverless, no un límite distribuido de verdad (ver comentario en ese archivo).
- **`send-email` con lista blanca de destinatarios**: solo puede mandar a las direcciones internas de aviso y al correo de contacto/copias que el admin configuró en el panel (`lib/constants.js` + `STATE.settings`), nunca a una dirección arbitraria que llegue en el body.
- **Contraseñas de clientes hasheadas**: ninguna contraseña de cliente se guarda ni se muestra en texto plano. `app.js` calcula el hash en el navegador con la Web Crypto API nativa (`crypto.subtle.digest('SHA-256', ...)`, sin librerías externas, compatible con la Content-Security-Policy del sitio) usando el mismo formato `salt:hashHex` que ya usaba la cuenta del administrador. El campo guardado en el estado es `passwordHash`, nunca `password`. Al crear un cliente o cambiarle la contraseña desde el panel de administrador, el campo de contraseña siempre se muestra vacío (nunca precargado con el valor real) y solo se envía el hash. Las cuentas antiguas que aún tuvieran `password` en texto plano se migran automáticamente a `passwordHash` la primera vez que el estado se carga o que el usuario inicia sesión — no requiere ninguna acción manual. Con esto, inspeccionar la página (clic derecho → Inspeccionar) ya no expone ninguna contraseña de cliente ni de administrador.

## Desplegar cambios

Este proyecto se sube a GitHub (`borckardt/portal-licencias-moventi`, privado) y Vercel lo redespliega automáticamente en cada push a `main`. Ver `SETUP_GMAIL.md` para la configuración del envío automático de correo por Gmail.
