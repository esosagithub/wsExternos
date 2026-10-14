// Diagnóstico SMTP: node scripts/verificarSmtp.js [correo_destino] [ruta_pdf]
// Sin argumentos solo verifica conexión, STARTTLS y autenticación.
// Con correo_destino envía un correo de prueba; con ruta_pdf lo adjunta (prueba el envío del adjunto).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mail = require('../src/services/mailService');

async function main() {
  const [destino, rutaPdf] = process.argv.slice(2);
  const { host, port, secure, requireTLS } = mail.opcionesTransporte();
  console.log(`Servidor SMTP: ${host}:${port} secure=${secure} requireTLS=${requireTLS} usuario=${process.env.SMTP_USER}`);

  if (!(await mail.verificarConexion())) process.exit(1);
  if (!destino) return;

  await mail.enviarCorreo({
    to: destino,
    subject: 'Prueba SMTP wsExternos',
    html: '<p>Correo de prueba de wsExternos.</p>',
    attachments: rutaPdf
      ? [{ filename: path.basename(rutaPdf), path: rutaPdf, contentType: 'application/pdf' }]
      : undefined
  });
  console.log(`Correo de prueba enviado a ${destino}${rutaPdf ? ' con adjunto' : ''}`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Fallo:', mail.describirError(err));
  process.exit(1);
});
