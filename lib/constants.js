// Direcciones internas de Moventi que reciben avisos automáticos del portal
// (nueva solicitud de un cliente, recuperación de contraseña del admin).
// Centralizado acá porque tanto api/request-password-reset.js como
// api/send-email.js (para construir la lista blanca de destinatarios
// permitidos, ver ese archivo) necesitan el mismo valor — antes vivía
// duplicado en cada endpoint. Debe coincidir con NEW_REQUEST_NOTIFY_EMAILS
// en app.js (ese sí vive del lado del cliente porque decide a dónde *avisar*,
// no a dónde está permitido enviar).
const INTERNAL_NOTIFY_EMAILS = ['sborckardt@moventiglobal.com', 'administracion@moventiglobal.com'];

module.exports = { INTERNAL_NOTIFY_EMAILS };
