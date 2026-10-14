const nodemailer = require('nodemailer');

let transporter;

// Errores de red que suelen ser transitorios (conexión cortada por el servidor, firewall o antivirus)
const CODIGOS_TRANSITORIOS = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'EPIPE', 'EAI_AGAIN'];
const ESPERAS_REINTENTO_MS = [2000, 5000];

function opcionesTransporte() {
  const port = Number(process.env.SMTP_PORT) || 587;
  // 465 → TLS implícito; 587/25 → STARTTLS obligatorio. SMTP_SECURE=true|false lo fuerza.
  const secure = process.env.SMTP_SECURE !== undefined && process.env.SMTP_SECURE !== ''
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;
  return {
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port,
    secure,
    requireTLS: !secure,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 20000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 20000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 60000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  };
}

// Misma configuración que EmailSenderService (Java): Office 365, STARTTLS, TLSv1.2
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(opcionesTransporte());
  }
  return transporter;
}

// Texto con todo el detalle que entrega nodemailer (sin credenciales)
function describirError(err) {
  if (!err) return 'Error desconocido';
  const partes = [];
  if (err.code) partes.push(`code=${err.code}`);
  if (err.command) partes.push(`command=${err.command}`);
  if (err.responseCode) partes.push(`responseCode=${err.responseCode}`);
  if (err.response) partes.push(`response=${err.response}`);
  if (err.errno && err.errno !== err.code) partes.push(`errno=${err.errno}`);
  if (err.syscall) partes.push(`syscall=${err.syscall}`);
  const mensaje = err.message || String(err);
  return partes.length ? `${mensaje} [${partes.join(', ')}]` : mensaje;
}

function esTransitorio(err) {
  if (!err) return false;
  if (CODIGOS_TRANSITORIOS.includes(err.code)) return true;
  return /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(err.message || '');
}

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

async function enviarCorreo({ to, cc, subject, html, attachments }) {
  const { host, port, secure } = opcionesTransporte();
  const mensaje = {
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    cc: cc || undefined,
    subject,
    html,
    attachments
  };

  for (let intento = 1; ; intento++) {
    try {
      const info = await getTransporter().sendMail(mensaje);
      if (intento > 1) console.log(`Correo a ${to} enviado en el intento ${intento}`);
      return info;
    } catch (err) {
      console.error(`SMTP ${host}:${port} secure=${secure} intento ${intento} a ${to} falló: ${describirError(err)}`);
      if (err.stack) console.error(err.stack);
      const espera = ESPERAS_REINTENTO_MS[intento - 1];
      if (!esTransitorio(err) || espera === undefined) throw err;
      await esperar(espera);
    }
  }
}

// Conecta, negocia TLS y autentica sin enviar nada
async function verificarConexion() {
  const { host, port, secure } = opcionesTransporte();
  try {
    await getTransporter().verify();
    console.log(`SMTP ${host}:${port} secure=${secure}: conexión y autenticación OK`);
    return true;
  } catch (err) {
    console.error(`SMTP ${host}:${port} secure=${secure}: verify falló: ${describirError(err)}`);
    return false;
  }
}

module.exports = { enviarCorreo, verificarConexion, describirError, esTransitorio, opcionesTransporte };
