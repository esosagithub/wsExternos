const fs = require('fs');
const crypto = require('crypto');
const dbOcaccess = require('../../config/databaseOcaccess');
const repo = require('../repositories/comprobanteVacacionesRepository');
const { crearError, normalizar } = require('./comprobanteVacacionesChileService');
const { dentroDeDirectorio } = require('./comprobanteFirmadoChileService');

const ACCIONES = { RECIBIR: 'RECIBIDO', RECHAZAR: 'RECHAZADO' };
const MAX_BYTES_NOTIFICACION = 500; // MS_VACACIONES_NOTIFICACIONES.NOTIFICACION VARCHAR2(500 BYTE)

const defaultDeps = { db: dbOcaccess, repo, fs };

// Recorta el motivo (por caracteres completos) para que el texto total no supere el máximo en bytes
function textoConMotivo(prefijo, motivo, sufijo, maxBytes = MAX_BYTES_NOTIFICACION) {
  const completo = `${prefijo}${motivo}${sufijo}`;
  if (Buffer.byteLength(completo, 'utf8') <= maxBytes) return completo;
  const disponible = maxBytes - Buffer.byteLength(`${prefijo}…${sufijo}`, 'utf8');
  let recorte = '';
  for (const c of Array.from(motivo)) {
    if (Buffer.byteLength(recorte + c, 'utf8') > disponible) break;
    recorte += c;
  }
  return `${prefijo}${recorte.trimEnd()}…${sufijo}`;
}

function textoNotificacionRecepcion(accion, idSolicitud, observacion) {
  if (accion === 'RECIBIR') {
    return `Nómina confirmó la recepción de su comprobante de vacaciones firmado de la solicitud N.º ${idSolicitud}.`;
  }
  return textoConMotivo(
    `Nómina rechazó su comprobante de vacaciones firmado de la solicitud N.º ${idSolicitud}. Motivo: `,
    observacion,
    '. Debe cargar nuevamente el comprobante firmado.'
  );
}

async function confirmarRecepcion({ idSolicitud, idComprobante, ciRrhh, accion, observacion = null }, deps = defaultDeps) {
  const { db, repo: r, fs: fsMod } = { ...defaultDeps, ...deps };
  const accionNorm = normalizar(accion);
  const estadoNuevo = ACCIONES[accionNorm];
  const obs = typeof observacion === 'string' && observacion.trim() ? observacion.trim() : null;

  if (!estadoNuevo) {
    throw crearError(400, 'INVALID_FIELD', 'accion debe ser RECIBIR o RECHAZAR');
  }
  if (accionNorm === 'RECHAZAR' && !obs) {
    throw crearError(400, 'OBSERVACION_REQUERIDA', 'Debe indicar el motivo del rechazo en observacion');
  }

  let conn;
  try {
    conn = await db.getConnection();

    if (!(await r.tienePermisoNominaChile(conn, ciRrhh))) {
      throw crearError(403, 'SIN_PERMISO_NOMINA', `El usuario ${ciRrhh} no tiene perfil de Nómina Chile`);
    }

    // FOR UPDATE: dos confirmaciones simultáneas se atienden una después de otra
    const comp = await r.obtenerComprobantePorId(conn, idComprobante);
    if (!comp) {
      throw crearError(404, 'COMPROBANTE_NO_EXISTE', `El comprobante ${idComprobante} no existe`);
    }
    if (Number(comp.ID_SOLICITUD) !== Number(idSolicitud)) {
      throw crearError(409, 'COMPROBANTE_NO_PERTENECE',
        `El comprobante ${idComprobante} no pertenece a la solicitud ${idSolicitud}`);
    }
    if (normalizar(comp.TIPO_ARCHIVO_ACTUAL) !== 'FIRMADO') {
      throw crearError(409, 'COMPROBANTE_NO_FIRMADO', 'El colaborador aún no ha cargado el comprobante firmado');
    }
    if (normalizar(comp.ESTADO_DOCUMENTO) !== 'PENDIENTE_RECEPCION') {
      throw crearError(409, 'ESTADO_NO_PERMITE_RECEPCION',
        `El comprobante está en estado ${comp.ESTADO_DOCUMENTO}; solo se puede confirmar en PENDIENTE_RECEPCION`);
    }

    const dir = process.env.VACACIONES_CHILE_PDF_PATH;
    if (!comp.RUTA_FISICA || !dir || !dentroDeDirectorio(comp.RUTA_FISICA, dir)) {
      throw crearError(500, 'RUTA_INVALIDA', 'La ruta registrada del comprobante no es válida');
    }
    let contenido;
    try {
      contenido = await fsMod.promises.readFile(comp.RUTA_FISICA);
    } catch (_) {
      console.error(`Comprobante ${idComprobante}: archivo firmado no encontrado`);
      throw crearError(409, 'ARCHIVO_NO_DISPONIBLE', 'El archivo firmado no está disponible');
    }
    const hash = crypto.createHash('sha256').update(contenido).digest('hex');
    if (!comp.HASH_ARCHIVO_FIRMADO || hash.toLowerCase() !== String(comp.HASH_ARCHIVO_FIRMADO).toLowerCase()) {
      console.error(`Comprobante ${idComprobante}: el hash del archivo no coincide con HASH_ARCHIVO_FIRMADO`);
      throw crearError(409, 'ARCHIVO_HASH_INVALIDO', 'El archivo firmado no corresponde al registrado');
    }

    let fechaRecepcion;
    try {
      ({ fechaRecepcion } = await r.registrarRecepcion(conn, idComprobante, {
        estado: estadoNuevo,
        ciRrhh,
        observacion: obs
      }));
    } catch (err) {
      if (err.code === 'ESTADO_CONCURRENTE') {
        throw crearError(409, 'ESTADO_NO_PERMITE_RECEPCION', err.message);
      }
      throw err;
    }

    await r.insertarNotificacion(conn, idSolicitud, textoNotificacionRecepcion(accionNorm, idSolicitud, obs));
    await conn.commit();

    console.log(`Comprobante ${idComprobante} ${estadoNuevo} por Nómina ${ciRrhh} (solicitud ${idSolicitud})`);

    return {
      ok: true,
      idSolicitud,
      estadoDocumento: estadoNuevo,
      fechaRecepcion: fechaRecepcion instanceof Date ? fechaRecepcion.toISOString() : fechaRecepcion,
      ciRrhhRecepcion: ciRrhh
    };
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

module.exports = { confirmarRecepcion, textoNotificacionRecepcion, textoConMotivo, MAX_BYTES_NOTIFICACION };
