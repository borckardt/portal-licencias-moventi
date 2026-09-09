# Configurar envío automático por Gmail (administracion@moventiglobal.com)

Esto conecta el botón "Enviar solicitud por correo" del portal a una función serverless
(`api/send-email.js`) que envía el correo de verdad por SMTP, sin depender de que el
administrador presione enviar en su cliente de correo.

Se hace **una sola vez**. Después de configurarlo, el envío queda automático siempre.

Este método usa una **contraseña de aplicación de Gmail** (App Password) por SMTP, no la
API de Gmail con OAuth. Ventajas frente al método anterior: no hay que crear un proyecto en
Google Cloud Console, no hay Client ID/Secret ni refresh token que renovar, y no aparece
nada relacionado en el desglose de facturación de la cuenta de Google ni se pide vincular
tarjeta de crédito.

## Qué necesitas

Debes iniciar sesión como **administracion@moventiglobal.com** para los pasos 1 y 2.

## Paso 1 — Activar la verificación en 2 pasos

Las contraseñas de aplicación solo existen si la cuenta tiene la verificación en 2 pasos
activada.

1. Entra a [myaccount.google.com/security](https://myaccount.google.com/security) con
   **administracion@moventiglobal.com**.
2. En "Cómo inicias sesión en Google", activa **Verificación en 2 pasos** si no lo está ya
   (te va a pedir un número de teléfono para los códigos).

## Paso 2 — Generar la contraseña de aplicación

1. Entra a [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   (con la misma cuenta).
2. Ponle un nombre, por ejemplo `Portal de licencias`, y haz clic en **Crear**.
3. Google te muestra un código de **16 caracteres** (sin espacios al usarlo). Cópialo — es
   la única vez que se muestra.

## Paso 3 — Configurar las variables de entorno en Vercel

Ve al proyecto en Vercel → **Settings → Environment Variables** y agrega (tú mismo, desde
el dashboard de Vercel — este valor no debe compartirse por chat ni pegarse en ningún otro
lugar):

| Variable | Valor |
|---|---|
| `GMAIL_SENDER_EMAIL` | `administracion@moventiglobal.com` |
| `GMAIL_APP_PASSWORD` | El código de 16 caracteres del paso 2 |
| `PORTAL_API_TOKEN` | `FEn_CYyxfOZn8Q1BTXsDMxxJI-1fi9B5` (ya está puesto en el HTML del portal; puedes generar uno distinto si prefieres, pero debe coincidir con el valor de `PORTAL_API_TOKEN` dentro de `app.js`) |

Si antes tenías configuradas `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` y `GMAIL_REFRESH_TOKEN`
del método anterior (OAuth), ya no se usan — puedes eliminarlas de Vercel (Settings →
Environment Variables → ⋯ → Delete). Así también puedes dar de baja el proyecto en Google
Cloud Console si ya no lo necesitas para nada más.

Después de guardar las variables, haz un **Redeploy** del proyecto (Vercel → Deployments →
⋯ → Redeploy) para que la función tome las nuevas variables.

## Verificación

1. Entra al portal como administrador, aprueba o selecciona una solicitud aprobada y haz clic
   en **"Enviar solicitud por correo"**.
2. Debería aparecer el toast verde "Correo enviado (...)" sin abrir ningún cliente de correo,
   y el mensaje debe llegar a la bandeja configurada como correo de contacto, enviado
   *desde* administracion@moventiglobal.com.
3. Si en vez de eso ves "Se abrió tu cliente de correo..." (el flujo anterior), revisa en
   Vercel → Deployments → (el despliegue) → Functions/Logs si `api/send-email` devolvió algún
   error — lo más común es que falte alguna variable de entorno o que la contraseña de
   aplicación se haya revocado (basta con repetir el paso 2 para generar una nueva).

## Nota de seguridad

`PORTAL_API_TOKEN` vive dentro del HTML/JS público de la página (es un sitio estático, no
hay manera de ocultarlo del todo). Solo sirve para bloquear abuso casual/automatizado del
endpoint, no es un secreto real. Lo que sí protege de verdad el envío de correo es que
`GMAIL_APP_PASSWORD` vive **solo** como variable de entorno del lado del servidor en Vercel
— nunca en el HTML ni en el repositorio. Si alguna vez sospechas que se filtró, revócala
desde [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) y
genera una nueva (paso 2).
