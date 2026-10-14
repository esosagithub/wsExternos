const fs = require('fs');
const path = require('path');
const dbOcaccess = require('../../config/databaseOcaccess');
const repo = require('../repositories/comprobanteVacacionesRepository');
const { crearError } = require('./comprobanteVacacionesChileService');
const { normalizarRut } = require('./comprobanteFirmadoChileService');

const ESTADOS_DOCUMENTO = ['GENERADO', 'PENDIENTE_FIRMA', 'PENDIENTE_RECEPCION', 'RECIBIDO', 'RECHAZADO'];

const defaultDeps = { db: dbOcaccess, repo, fs };

function fechaIso(valor) {
  return valor instanceof Date ? valor.toISOString() : (valor || null);
}

async function archivoExiste(fsMod, nombreArchivo) {
  const dir = process.env.VACACIONES_CHILE_PDF_PATH;
  if (!nombreArchivo || !dir) return false;
  try {
    // basename: el nombre registrado nunca puede salir de la carpeta configurada
    await fsMod.promises.access(path.join(dir, path.basename(nombreArchivo)), fsMod.constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

async function obtenerComprobantes({
  ciUsuario,
  idSolicitud = null,
  ciSolicitante = null,
  estadoDocumento = null,
  pendientesNomina = false,
  verificarArchivo = true,
  limite,
  pagina
}, deps = defaultDeps) {
  const { db, repo: r, fs: fsMod } = { ...defaultDeps, ...deps };

  if (pendientesNomina && estadoDocumento && estadoDocumento !== 'PENDIENTE_RECEPCION') {
    throw crearError(400, 'FILTROS_INCOMPATIBLES',
      'pendientes_nomina solo admite estado_documento PENDIENTE_RECEPCION');
  }

  let conn;
  try {
    conn = await db.getConnection();
    const esNomina = await r.tienePermisoNominaChile(conn, ciUsuario);

    let ciNorm;
    if (esNomina) {
      ciNorm = ciSolicitante ? normalizarRut(ciSolicitante) : null;
    } else {
      // Colaborador: solo sus propias solicitudes
      if (pendientesNomina) {
        throw crearError(403, 'SOLO_NOMINA', 'pendientes_nomina solo está disponible para Nómina');
      }
      if (ciSolicitante && normalizarRut(ciSolicitante) !== normalizarRut(ciUsuario)) {
        throw crearError(403, 'NO_PROPIETARIO', 'Solo puede consultar sus propias solicitudes');
      }
      ciNorm = normalizarRut(ciUsuario);
    }

    const filas = await r.buscarComprobantesChile(conn, {
      idSolicitud,
      ciNorm,
      estado: pendientesNomina ? 'PENDIENTE_RECEPCION' : estadoDocumento,
      offset: (pagina - 1) * limite,
      limite
    });

    const data = await Promise.all(filas.map(async (f) => {
      const disponible = verificarArchivo
        ? (f.ID_COMPROBANTE != null && await archivoExiste(fsMod, f.NOMBRE_ARCHIVO))
        : null;
      // URL solo si el archivo existe (sin verificar: la registrada)
      const urlPublica = verificarArchivo ? (disponible ? f.URL_PUBLICA : null) : (f.URL_PUBLICA || null);
      return {
        idSolicitud: f.ID_SOLICITUD,
        idComprobante: f.ID_COMPROBANTE ?? null,
        nombreSolicitante: f.NOMBRE_SOLICITANTE,
        ciSolicitante: f.CI_SOLICITANTE,
        estadoDocumento: f.ESTADO_DOCUMENTO || null,
        tipoArchivoActual: f.TIPO_ARCHIVO_ACTUAL || null,
        fechaGeneracion: fechaIso(f.FECHA_GENERACION),
        fechaCargaFirmado: fechaIso(f.FECHA_CARGA_FIRMADO),
        // Decisión de Nómina sobre el firmado vigente; la carga de una corrección las limpia
        fechaRecepcion: fechaIso(f.FECHA_RECEPCION),
        observacionRecepcion: f.OBSERVACION_RECEPCION || null,
        urlPublica,
        archivoDisponible: disponible
      };
    }));

    return {
      ok: true,
      data,
      paginacion: {
        pagina,
        limite,
        total: filas.length ? Number(filas[0].TOTAL_REGISTROS) : 0
      }
    };
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

module.exports = { obtenerComprobantes, ESTADOS_DOCUMENTO };
