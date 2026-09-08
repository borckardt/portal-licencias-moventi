# Configurar envío automático por Gmail (administracion@moventiglobal.com)

Esto conecta el botón "Enviar solicitud por correo" del portal a una función serverless
(`api/send-email.js`) que envía el correo de verdad por la API de Gmail, sin depender de
que el administrador presione enviar en su cliente de correo.

Se hace **una sola vez**. Después de configurarlo, el envío queda automático siempre.

## Qué necesitas

Debes iniciar sesión como **administracion@moventiglobal.com** para los pasos 2 y 3
(la cuenta que va a "ser" el remitente). Los pasos 1 puedes hacerlos con cualquier cuenta
que tenga acceso a Google Cloud Console para este proyecto (puede ser la tuya).

## Paso 1 — Crear el proyecto y las credenciales OAuth en Google Cloud

1. Entra a [console.cloud.google.com](https://console.cloud.google.com/) y crea un proyecto
   nuevo (o usa uno existente), por ejemplo `portal-licencias-moventi`.
2. Ve a **APIs y servicios → Biblioteca**, busca **Gmail API** y haz clic en **Habilitar**.
3. Ve a **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: **Interno** (si tu Google Workspace lo permite — esto evita el proceso
     de verificación de Google, ya que solo la gente de tu organización puede autorizar la app).
   - Completa nombre de la app (p. ej. "Portal de licencias Moventi") y correo de soporte.
4. Ve a **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación web**.
   - En "URIs de redirección autorizados" agrega:
     `https://developers.google.com/oauthplayground`
     (la usaremos en el paso 2 para generar el refresh token; puedes quitarla después si
     prefieres, pero si algún día quieres regenerar el token la necesitarás de nuevo).
   - Al crear, Google te muestra un **Client ID** y un **Client Secret** — guárdalos, los
     necesitas en el paso 3.

## Paso 2 — Obtener el refresh token (como administracion@moventiglobal.com)

1. **Cierra sesión** de otras cuentas de Google en el navegador o usa una ventana de
   incógnito, e inicia sesión como **administracion@moventiglobal.com**.
2. Entra a [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/).
3. Haz clic en el ícono de engranaje (⚙️) arriba a la derecha:
   - Marca **"Use your own OAuth credentials"**.
   - Pega el **Client ID** y **Client Secret** del paso 1.
4. En el panel izquierdo, en el campo de scopes, pega manualmente:
   `https://www.googleapis.com/auth/gmail.send`
   y haz clic en **Authorize APIs**.
5. Te pedirá iniciar sesión (asegúrate de que sea con administracion@moventiglobal.com) y
   dar consentimiento. Acepta.
6. De vuelta en el Playground, haz clic en **"Exchange authorization code for tokens"**.
7. Copia el valor de **Refresh token** que aparece — ese es el que necesitas.

## Paso 3 — Configurar las variables de entorno en Vercel

Ve al proyecto en Vercel → **Settings → Environment Variables** y agrega:

| Variable | Valor |
|---|---|
| `GMAIL_CLIENT_ID` | El Client ID del paso 1 |
| `GMAIL_CLIENT_SECRET` | El Client Secret del paso 1 |
| `GMAIL_REFRESH_TOKEN` | El refresh token del paso 2 |
| `GMAIL_SENDER_EMAIL` | `administracion@moventiglobal.com` |
| `PORTAL_API_TOKEN` | `FEn_CYyxfOZn8Q1BTXsDMxxJI-1fi9B5` (ya está puesto en el HTML del portal; puedes generar uno distinto si prefieres, pero debe coincidir con el valor de `PORTAL_API_TOKEN` dentro de `index.html`) |
| `SESSION_SECRET` | **Nueva, obligatoria.** Un valor aleatorio y largo (`openssl rand -base64 48`), distinto de `PORTAL_API_TOKEN`. Firma la cookie de sesión del admin (ver `lib/adminSession.js`) — sin esto, `verify-admin-login` sigue funcionando pero `change-admin-password` y las escrituras de admin en `save-state` quedarán bloqueadas (falla cerrado, no abierto). |
| `ALLOW_PREVIEW_EMAIL` | Déjala vacía. Solo ponla en `true` si de verdad quieres que un *Preview deployment* de Vercel mande correo real (ver `lib/gmail.js`). |

Después de guardarlas, haz un **Redeploy** del proyecto (Vercel → Deployments → ⋯ → Redeploy)
para que la función tome las nuevas variables.

## Verificación

1. Entra al portal como administrador, aprueba o selecciona una solicitud aprobada y haz clic
   en **"Enviar solicitud por correo"**.
2. Debería aparecer el toast verde "Correo enviado (...)" sin abrir ningún cliente de correo,
   y el mensaje debe llegar a la bandeja configurada como correo de contacto, enviado
   *desde* administracion@moventiglobal.com.
3. Si en vez de eso ves "Se abrió tu cliente de correo..." (el flujo anterior), revisa en
   Vercel → Deployments → (el despliegue) → Functions/Logs si `api/send-email` devolvió algún
   error — lo más común es una variable de entorno faltante o el refresh token vencido/revocado
   (basta con repetir el paso 2 para generar uno nuevo).

## Nota de seguridad

`PORTAL_API_TOKEN` vive dentro del HTML público de la página (es un sitio estático, no hay
manera de ocultarlo del todo). Solo sirve para bloquear abuso casual/automatizado del endpoint,
no es un secreto real. Lo que sí protege de verdad las credenciales de Gmail es que el
Client Secret y el Refresh Token viven **solo** como variables de entorno del lado del
servidor en Vercel — nunca en el HTML.
