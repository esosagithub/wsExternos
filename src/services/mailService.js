const nodemailer = require('nodemailer');

let transporter;

// Misma configuración que EmailSenderService (Java): Office 365, STARTTLS, TLSv1.2
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.office365.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: 'TLSv1.2' },
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
  }
  return transporter;
}

async function enviarCorreo({ to, cc, subject, html, attachments }) {
  return getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    cc: cc || undefined,
    subject,
    html,
    attachments
  });
}

module.exports = { enviarCorreo };
