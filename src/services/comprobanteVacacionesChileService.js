const fs = require('fs');
const crypto = require('crypto');
const dbOcaccess = require('../../config/databaseOcaccess');
const repo = require('../repositories/comprobanteVacacionesRepository');
const pdf = require('./comprobantePdfService');
const mail = require('./mailService');

const PAISES_CHILE = ['CHILE', 'CL'];

const defaultDeps = { db: dbOcaccess, repo, pdf, mail, fs };

function crearError(httpStatus, code, message) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.code = code;
  return err;
}

function normalizar(valor) {
  return String(valor || '').trim().toUpperCase();
}

function escaparHtml(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function textoNotificacion(idSolicitud) {
  return `Su solicitud N.º ${idSolicitud} fue aprobada por Nómina. Descargue, firme y cargue el comprobante de vacaciones.`;
}

function htmlCorreo(solicitud) {
  const fmt = pdf.fmtFecha;
  return `
    <p>Estimado(a) ${escaparHtml(solicitud.NOMBRE_SOLICITANTE)}:</p>
    <p>Su solicitud de vacaciones <b>N.º ${escaparHtml(solicitud.ID_SOLICITUD)}</b> fue <b>aprobada por Nómina</b>.</p>
    <p>Período: del ${escaparHtml(fmt(solicitud.FECHA_INICIO))} al ${escaparHtml(fmt(solicitud.FECHA_FIN))},
       retorno el ${escaparHtml(fmt(solicitud.FECHA_RETORNO))}.</p>
    <p>Adjuntamos el comprobante de vacaciones. Por favor descárguelo, fírmelo y cárguelo en el sistema.</p>
    <p>Saludos cordiales,<br/>Nómina</p>`;
}

function validarSolicitud(solicitud, idSolicitud) {
  if (!solicitud) {
    throw crearError(404, 'SOLICITUD_NO_EXISTE', `La solicitud ${idSolicitud} no existe`);
  }
  if (!PAISES_CHILE.includes(normalizar(solicitud.PAIS))) {
    throw crearError(422, 'PAIS_NO_CHILE', `La solicitud ${idSolicitud} no corresponde a Chile`);
  }
  if (normalizar(solicitud.TIPO_REGISTRO) !== 'SOLICITUD') {
    throw crearError(422, 'TIPO_REGISTRO_INVALIDO', `La solicitud ${idSolicitud} no es de tipo SOLICITUD`);
  }
  if (normalizar(solicitud.ESTADO_APROBACION_RRHH) !== 'APROBADA') {
    throw crearError(409, 'SOLICITUD_NO_APROBADA', `La solicitud ${idSolicitud} no está aprobada por Nómina`);
  }
}

function respuesta(idSolicitud, comp, extra = {}) {
  // Nunca se expone RUTA_FISICA
  return {
    ok: true,
    idSolicitud,
    idComprobante: comp.ID_COMPROBANTE,
    estadoDocumento: comp.ESTADO_DOCUMENTO,
    estadoEmail: comp.ESTADO_ENVIO_EMAIL,
    nombreArchivo: comp.NOMBRE_ARCHIVO,
    urlPublica: comp.URL_PUBLICA,
    ...extra
  };
}

async function existeArchivo(fsMod, ruta) {
  if (!ruta) return false;
  try {
    await fsMod.promises.access(ruta, fsMod.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// Envía el PDF físico al colaborador y registra el resultado del envío (commit incluido).
async function enviarYRegistrar(conn, r, mailSrv, solicitud, comp, { notificar, extra = {} }) {
  const idSolicitud = solicitud.ID_SOLICITUD;
  let email = null;
  try {
    email = await r.obtenerCorreoColaborador(conn, solicitud.CI_SOLICITANTE);
    if (!email) {
      throw new Error(`El colaborador ${solicitud.CI_SOLICITANTE} no tiene correo registrado`);
    }
    await mailSrv.enviarCorreo({
      to: email,
      cc: process.env.SMTP_CC || undefined,
      subject: `Solicitud de vacaciones N.º ${idSolicitud} aprobada por Nómina`,
      html: htmlCorreo(solicitud),
      // Se adjunta el archivo físico, no la URL
      attachments: [{ filename: comp.NOMBRE_ARCHIVO, path: comp.RUTA_FISICA, contentType: 'application/pdf' }]
    });
  } catch (errMail) {
    console.error(`Error enviando comprobante de la solicitud ${idSolicitud}:`, errMail.message);
    await r.marcarEmailError(conn, comp.ID_COMPROBANTE, email, errMail.message);
    await conn.commit();
    return respuesta(idSolicitud, { ...comp, ESTADO_ENVIO_EMAIL: 'ERROR' }, {
      ...extra,
      ok: false,
      httpStatus: 502,
      error: { code: 'EMAIL_ERROR', message: errMail.message }
    });
  }

  await r.marcarEmailEnviado(conn, comp.ID_COMPROBANTE, email);
  await conn.commit();

  if (notificar) {
    try {
      await r.insertarNotificacion(conn, idSolicitud, textoNotificacion(idSolicitud));
      await conn.commit();
    } catch (errNotif) {
      // El correo ya se envió: no se revierte su estado
      console.error(`No se pudo registrar la notificación de la solicitud ${idSolicitud}:`, errNotif.message);
      await conn.rollback().catch(() => {});
    }
  }

  return respuesta(idSolicitud, {
    ...comp,
    ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA',
    ESTADO_ENVIO_EMAIL: 'ENVIADO'
  }, extra);
}

async function procesar({ idSolicitud, ciRrhh }, deps = defaultDeps) {
  const { db, repo: r, pdf: pdfSrv, mail: mailSrv, fs: fsMod } = { ...defaultDeps, ...deps };
  const dir = process.env.VACACIONES_CHILE_PDF_PATH;
  const baseUrl = (process.env.VACACIONES_CHILE_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!dir || !baseUrl) {
    throw crearError(500, 'CONFIGURACION_INCOMPLETA',
      'Faltan VACACIONES_CHILE_PDF_PATH o VACACIONES_CHILE_PUBLIC_URL');
  }

  let conn;
  let pdfSinConfirmar = null; // PDF escrito cuyo registro aún no se confirma en BD

  try {
    conn = await db.getConnection();

    const solicitud = await r.obtenerSolicitud(conn, idSolicitud);
    validarSolicitud(solicitud, idSolicitud);

    // FOR UPDATE: serializa llamadas concurrentes sobre la misma solicitud
    let comp = await r.obtenerComprobante(conn, idSolicitud);

    if (!comp || !(await existeArchivo(fsMod, comp.RUTA_FISICA))) {
      const periodos = await r.obtenerPeriodos(conn, idSolicitud);
      const gen = await pdfSrv.generarPdfAtomico({ solicitud, periodos, dir, idSolicitud });
      pdfSinConfirmar = gen.rutaFisica;
      const datos = {
        idSolicitud,
        nombreArchivo: gen.nombreArchivo,
        rutaFisica: gen.rutaFisica,
        urlPublica: `${baseUrl}/${gen.nombreArchivo}`,
        hash: gen.hash,
        tamanio: gen.tamanio
      };

      if (comp) {
        console.warn(`Comprobante ${comp.ID_COMPROBANTE}: archivo físico no encontrado, se regenera`);
        await r.actualizarArchivoRegenerado(conn, comp.ID_COMPROBANTE, datos);
      } else {
        try {
          await r.insertarComprobante(conn, datos);
        } catch (err) {
          if (err.errorNum === 1) {
            throw crearError(409, 'COMPROBANTE_EN_PROCESO',
              `El comprobante de la solicitud ${idSolicitud} se está generando en otra petición; reintente`);
          }
          throw err;
        }
      }
      await conn.commit();
      pdfSinConfirmar = null;
      console.log(`Comprobante vacaciones Chile generado: solicitud ${idSolicitud}, Nómina ${ciRrhh}`);

      // Se vuelve a bloquear y leer el estado confirmado
      comp = await r.obtenerComprobante(conn, idSolicitud);
    }

    if (normalizar(comp.ESTADO_ENVIO_EMAIL) === 'ENVIADO') {
      await conn.commit();
      return respuesta(idSolicitud, comp);
    }

    return await enviarYRegistrar(conn, r, mailSrv, solicitud, comp, { notificar: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    if (pdfSinConfirmar) await fsMod.promises.unlink(pdfSinConfirmar).catch(() => {});
    throw err;
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (err) {
        console.error('Error al cerrar la conexión OCACCESS:', err);
      }
    }
  }
}

const ESTADOS_YA_FIRMADO = ['PENDIENTE_RECEPCION', 'RECIBIDO'];

async function calcularHashArchivo(fsMod, ruta) {
  const contenido = await fsMod.promises.readFile(ruta);
  return crypto.createHash('sha256').update(contenido).digest('hex');
}

// Reintenta solo el correo: nunca genera ni reemplaza el PDF.
async function reenviar({ idSolicitud, ciRrhh, forzar = false }, deps = defaultDeps) {
  const { db, repo: r, mail: mailSrv, fs: fsMod } = { ...defaultDeps, ...deps };
  let conn;

  try {
    conn = await db.getConnection();

    if (!(await r.tienePermisoNominaChile(conn, ciRrhh))) {
      throw crearError(403, 'SIN_PERMISO_NOMINA',
        `El usuario ${ciRrhh} no tiene perfil de Nómina Chile`);
    }

    const solicitud = await r.obtenerSolicitud(conn, idSolicitud);
    validarSolicitud(solicitud, idSolicitud);

    // FOR UPDATE: evita dos reenvíos simultáneos
    const comp = await r.obtenerComprobante(conn, idSolicitud);
    if (!comp) {
      throw crearError(404, 'COMPROBANTE_NO_EXISTE',
        `La solicitud ${idSolicitud} no tiene comprobante generado; use wsGenerarEnviarComprobanteVacacionesChile`);
    }

    if (ESTADOS_YA_FIRMADO.includes(normalizar(comp.ESTADO_DOCUMENTO))
        || normalizar(comp.TIPO_ARCHIVO_ACTUAL) === 'FIRMADO') {
      throw crearError(409, 'COMPROBANTE_YA_FIRMADO',
        `El comprobante de la solicitud ${idSolicitud} ya tiene documento firmado (${comp.ESTADO_DOCUMENTO})`);
    }

    if (!(await existeArchivo(fsMod, comp.RUTA_FISICA))) {
      console.error(`Comprobante ${comp.ID_COMPROBANTE}: archivo físico no encontrado`);
      throw crearError(409, 'ARCHIVO_NO_DISPONIBLE',
        `El archivo del comprobante de la solicitud ${idSolicitud} no está disponible`);
    }
    const hashActual = await calcularHashArchivo(fsMod, comp.RUTA_FISICA);
    if (!comp.HASH_ARCHIVO_GENERADO || hashActual.toLowerCase() !== String(comp.HASH_ARCHIVO_GENERADO).toLowerCase()) {
      console.error(`Comprobante ${comp.ID_COMPROBANTE}: el hash del archivo no coincide con el registrado`);
      throw crearError(409, 'ARCHIVO_HASH_INVALIDO',
        `El archivo del comprobante de la solicitud ${idSolicitud} no corresponde al registrado`);
    }

    const yaEnviado = normalizar(comp.ESTADO_ENVIO_EMAIL) === 'ENVIADO';
    if (yaEnviado && forzar !== true) {
      await conn.commit();
      return respuesta(idSolicitud, comp, { reenviado: false });
    }

    console.log(`Reenvío de comprobante: solicitud ${idSolicitud}, Nómina ${ciRrhh}, forzar=${forzar === true}`);
    // La notificación solo se crea si nunca hubo un envío exitoso
    return await enviarYRegistrar(conn, r, mailSrv, solicitud, comp,
      { notificar: !yaEnviado, extra: { reenviado: true } });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    throw err;
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch (err) {
        console.error('Error al cerrar la conexión OCACCESS:', err);
      }
    }
  }
}

module.exports = { procesar, reenviar, textoNotificacion, crearError, normalizar };
