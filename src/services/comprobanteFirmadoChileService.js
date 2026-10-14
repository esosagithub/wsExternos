const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbOcaccess = require('../../config/databaseOcaccess');
const repo = require('../repositories/comprobanteVacacionesRepository');
const { crearError, normalizar } = require('./comprobanteVacacionesChileService');

const ESTADOS_PERMITEN_CARGA = ['PENDIENTE_FIRMA', 'RECHAZADO'];
const FIRMA_PDF = Buffer.from('%PDF-');

const defaultDeps = { db: dbOcaccess, repo, fs };

function maxBytes() {
  return Number(process.env.VACACIONES_PDF_MAX_BYTES) || 10 * 1024 * 1024;
}

// Nombre recibido: solo para logs; el archivo se guarda con el NOMBRE_ARCHIVO registrado.
function sanitizarNombre(nombre) {
  const base = String(nombre || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[\\/]/).pop()
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 100);
  return base || 'archivo.pdf';
}

// RUT/CI comparable: sin puntos, guiones ni espacios, en mayúsculas (K)
function normalizarRut(valor) {
  return String(valor || '').replace(/[.\-\s]/g, '').toUpperCase();
}

function validarArchivoPdf(archivo) {
  if (!archivo || !Buffer.isBuffer(archivo.buffer)) {
    throw crearError(400, 'ARCHIVO_REQUERIDO', 'Debe adjuntar exactamente un archivo en el campo "archivo"');
  }
  if (archivo.buffer.length === 0) {
    throw crearError(400, 'ARCHIVO_VACIO', 'El archivo está vacío');
  }
  if (archivo.buffer.length > maxBytes()) {
    throw crearError(413, 'ARCHIVO_DEMASIADO_GRANDE', `El archivo supera el máximo permitido (${maxBytes()} bytes)`);
  }
  if (normalizar(archivo.mimetype) !== 'APPLICATION/PDF') {
    throw crearError(415, 'ARCHIVO_NO_PDF', 'El archivo debe ser de tipo application/pdf');
  }
  if (!archivo.buffer.subarray(0, FIRMA_PDF.length).equals(FIRMA_PDF)) {
    throw crearError(415, 'ARCHIVO_NO_PDF', 'El contenido del archivo no es un PDF válido');
  }
}

function dentroDeDirectorio(ruta, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(ruta));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function existe(fsMod, ruta) {
  try {
    await fsMod.promises.access(ruta);
    return true;
  } catch (_) {
    return false;
  }
}

async function cargarFirmado({ idSolicitud, ciSolicitante, archivo }, deps = defaultDeps) {
  const { db, repo: r, fs: fsMod } = { ...defaultDeps, ...deps };
  validarArchivoPdf(archivo);
  const nombreRecibido = sanitizarNombre(archivo.originalname);

  let conn;
  let rutaTemporal = null;
  let rutaBak = null;
  let rutaFinal = null;
  let reemplazado = false;
  let hash;
  let tamanio;

  // Deja el PDF generado tal como estaba antes de la carga
  const restaurarOriginal = async () => {
    if (rutaTemporal) {
      await fsMod.promises.unlink(rutaTemporal).catch(() => {});
      rutaTemporal = null;
    }
    if (rutaBak) {
      try {
        await fsMod.promises.rename(rutaBak, rutaFinal);
        rutaBak = null;
      } catch (e) {
        console.error(`CRÍTICO: no se pudo restaurar ${rutaBak} → ${rutaFinal}:`, e.message);
      }
    } else if (reemplazado) {
      await fsMod.promises.unlink(rutaFinal).catch(() => {});
    }
  };

  try {
    conn = await db.getConnection();

    const solicitud = await r.obtenerSolicitud(conn, idSolicitud);
    if (!solicitud) {
      throw crearError(404, 'SOLICITUD_NO_EXISTE', `La solicitud ${idSolicitud} no existe`);
    }
    if (normalizarRut(solicitud.CI_SOLICITANTE) !== normalizarRut(ciSolicitante)) {
      throw crearError(403, 'NO_PROPIETARIO', `La solicitud ${idSolicitud} no pertenece al colaborador indicado`);
    }

    // FOR UPDATE: serializa cargas simultáneas de la misma solicitud
    const comp = await r.obtenerComprobante(conn, idSolicitud);
    if (!comp) {
      throw crearError(404, 'COMPROBANTE_NO_EXISTE', `La solicitud ${idSolicitud} no tiene comprobante generado`);
    }
    if (!ESTADOS_PERMITEN_CARGA.includes(normalizar(comp.ESTADO_DOCUMENTO))) {
      throw crearError(409, 'ESTADO_NO_PERMITE_CARGA',
        `No se puede cargar el comprobante en estado ${comp.ESTADO_DOCUMENTO}`);
    }

    rutaFinal = comp.RUTA_FISICA;
    const dir = process.env.VACACIONES_CHILE_PDF_PATH;
    if (!rutaFinal || !dir || !dentroDeDirectorio(rutaFinal, dir)) {
      throw crearError(500, 'RUTA_INVALIDA', 'La ruta registrada del comprobante no es válida');
    }

    const sufijo = crypto.randomUUID();
    const dirFinal = path.dirname(rutaFinal);
    const nombreFinal = path.basename(rutaFinal);

    // 1. Temporal en la misma carpeta (rename atómico en el mismo volumen)
    try {
      rutaTemporal = path.join(dirFinal, `.${nombreFinal}.${sufijo}.upload.tmp`);
      await fsMod.promises.writeFile(rutaTemporal, archivo.buffer, { flag: 'wx' });

      // 2. Validar lo escrito y calcular SHA-256
      const escrito = await fsMod.promises.readFile(rutaTemporal);
      if (escrito.length !== archivo.buffer.length || !escrito.subarray(0, FIRMA_PDF.length).equals(FIRMA_PDF)) {
        throw new Error('El archivo temporal no coincide con el recibido');
      }
      hash = crypto.createHash('sha256').update(escrito).digest('hex');
      tamanio = escrito.length;

      // 3. Original → .bak  4. Firmado → ruta definitiva
      if (await existe(fsMod, rutaFinal)) {
        const bak = `${rutaFinal}.${sufijo}.bak`;
        await fsMod.promises.rename(rutaFinal, bak);
        rutaBak = bak;
      }
      await fsMod.promises.rename(rutaTemporal, rutaFinal);
      rutaTemporal = null;
      reemplazado = true;
    } catch (errDisco) {
      console.error(`Error de disco cargando firmado de la solicitud ${idSolicitud}:`, errDisco.message);
      await restaurarOriginal();
      throw crearError(500, 'ERROR_DISCO', 'No se pudo guardar el comprobante firmado');
    }

    // 5. Oracle + notificación  6. commit
    const { fechaCarga } = await r.registrarCargaFirmado(conn, comp.ID_COMPROBANTE, {
      hash,
      tamanio,
      ciUsuario: String(ciSolicitante).trim()
    });
    await r.insertarNotificacion(conn, idSolicitud,
      `Su comprobante de vacaciones firmado de la solicitud N.º ${idSolicitud} fue cargado y está pendiente de recepción por Nómina.`);
    await conn.commit();

    // 7. Eliminar el .bak: no se conservan dos archivos
    if (rutaBak) {
      await fsMod.promises.unlink(rutaBak).catch(e =>
        console.error(`No se pudo eliminar el respaldo ${rutaBak}:`, e.message));
      rutaBak = null;
    }

    console.log(`Comprobante firmado cargado: solicitud ${idSolicitud}, archivo recibido "${nombreRecibido}", ${tamanio} bytes`);

    return {
      ok: true,
      idSolicitud,
      idComprobante: comp.ID_COMPROBANTE,
      estadoDocumento: 'PENDIENTE_RECEPCION',
      tipoArchivo: 'FIRMADO',
      urlPublica: comp.URL_PUBLICA,
      fechaCarga: fechaCarga instanceof Date ? fechaCarga.toISOString() : fechaCarga
    };
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    // Si Oracle falló después del reemplazo, se restaura el PDF original
    if (reemplazado || rutaBak || rutaTemporal) await restaurarOriginal();
    if (err.code === 'ESTADO_CONCURRENTE') {
      throw crearError(409, 'ESTADO_NO_PERMITE_CARGA', err.message);
    }
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

module.exports = { cargarFirmado, sanitizarNombre, validarArchivoPdf, normalizarRut, dentroDeDirectorio };
