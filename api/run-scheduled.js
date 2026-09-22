// El envío programado se retiró del portal: las solicitudes se envían al
// distribuidor en el momento, desde el botón "Enviar solicitud por correo", y
// el propio correo indica desde cuándo se necesita cada licencia.
//
// Este endpoint queda como no-op para que cualquier llamada antigua (un cron
// que todavía no se haya borrado, un enlace guardado) no dispare correos a
// partir de solicitudes que quedaron marcadas como programadas.

module.exports = async function handler(req, res) {
  res.status(200).json({ ok: true, disabled: true, sent: 0, reason: 'scheduled_send_removed' });
};
