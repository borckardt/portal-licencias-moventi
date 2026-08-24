# Portal de licencias — Moventi

Sitio estático de una sola página (`index.html`) con el portal de solicitud y aprobación de licencias de Google Workspace.

## Cómo abrirlo en Visual Studio Code

1. Descomprime esta carpeta donde quieras.
2. Abre la carpeta en VS Code (`Archivo > Abrir carpeta...`).
3. Todo el código vive en `index.html` (HTML, CSS y JavaScript en un solo archivo, sin build ni dependencias).
4. Para probarlo localmente, usa la extensión "Live Server" de VS Code (clic derecho sobre `index.html` → "Open with Live Server"), o corre en una terminal:
   ```
   npx serve .
   ```

## Cómo subirlo a Vercel

**Opción A — arrastrar y soltar (más simple):**
1. Entra a [vercel.com](https://vercel.com) e inicia sesión.
2. En el dashboard, "Add New… → Project", y arrastra esta carpeta (o haz zip y súbelo).
3. Vercel detecta que es un sitio estático y lo publica en segundos. Te da una URL tipo `https://tu-proyecto.vercel.app`.

**Opción B — con Git (recomendado si vas a seguir editando):**
1. Sube esta carpeta a un repositorio en GitHub/GitLab/Bitbucket.
2. En Vercel, "Add New… → Project" e importa ese repositorio.
3. Cada vez que hagas `git push`, Vercel vuelve a publicar automáticamente.

**Opción C — con la CLI de Vercel:**
```
npm i -g vercel
cd portal-licencias-vercel
vercel
```
Sigue las instrucciones (inicia sesión, confirma el proyecto) y te da la URL de producción.

## Muy importante: qué funciona y qué no, hosteado así

Esta página se construyó originalmente para correr dentro de Claude (Anthropic), donde tenía acceso a capacidades especiales para guardar datos compartidos entre usuarios, enviar correos por Gmail y generar descargas. Fuera de Claude (por ejemplo en Vercel, como sitio estático puro) **esas capacidades no existen**, así que se agregaron alternativas automáticas (fallbacks), pero con limitaciones reales que debes conocer antes de dárselo a tus clientes:

- **Guardado de datos**: sin backend, la app guarda las solicitudes en el `localStorage` del navegador — es decir, **cada navegador/dispositivo tiene su propia copia de los datos, que no se comparte** entre tú (administrador) y tus clientes. Un cliente que registre una solicitud en su computadora NO la verás tú en la tuya. Esto es solo apto para pruebas o demos, no para operar con clientes reales.
- **Envío de correo**: sin la integración de Gmail de Claude, el botón "Enviar solicitud por correo" abre el cliente de correo predeterminado del administrador (`mailto:`) con el asunto y mensaje ya armados, para que él mismo presione enviar. Funciona, pero es manual (no se envía automáticamente) y depende de que el navegador tenga un cliente de correo configurado.
- **Descarga de CSV**: funciona igual que antes, sin cambios — usa la descarga nativa del navegador.
- **Contraseñas**: los usuarios y contraseñas (incluida la del administrador) están en texto plano dentro del propio HTML, visibles para cualquiera que abra el "código fuente" de la página. Esto es aceptable para una demo privada, pero **no es seguro para producción real** con datos de clientes.

### Para que esto funcione de verdad con clientes reales

Necesitas un backend real:
1. Una base de datos (Vercel Postgres, Supabase, Neon, etc.) donde se guarden usuarios, tipos de licencia y solicitudes, y una API (funciones serverless de Vercel) para leer/escribir ahí — así todos los usuarios ven los mismos datos.
2. Autenticación real: contraseñas hasheadas (nunca en texto plano) y sesiones o tokens en vez de guardar todo en el HTML.
3. Un servicio de envío de correo (Resend, SendGrid, o SMTP) llamado desde una función serverless, para que el envío sea automático y no dependa del cliente de correo del administrador.

Si quieres, dile a Claude que continúe con este rebuild — solo necesita que le confirmes qué base de datos y qué servicio de correo prefieres usar, y las credenciales/API keys correspondientes (esas nunca deben quedar visibles en el código del navegador; se configuran como variables de entorno en Vercel).
