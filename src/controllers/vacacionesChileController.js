const service = require('../services/comprobanteVacacionesChileService');
const firmadoService = require('../services/comprobanteFirmadoChileService');
const consultaService = require('../services/consultaComprobantesChileService');
const recepcionService = require('../services/recepcionComprobanteChileService');

function validarPayload(body) {
  const id = Number(body.id_solicitud);
  if (body.id_solicitud === undefined || body.id_solicitud === null || body.id_solicitud === '') {
    return { code: 'MISSING_FIELD', message: 'Falta campo id_solicitud' };
  }
  if (!Number.isInteger(id) || id <= 0) {
    return { code: 'INVALID_FIELD', message: 'id_solicitud debe ser un entero positivo' };
  }
  const ci = typeof body.ci_rrhh === 'string' ? body.ci_rrhh.trim() : '';
  if (!ci) {
    return { code: 'MISSING_FIELD', message: 'Falta campo ci_rrhh' };
  }
  if (ci.length > 20) {
    return { code: 'INVALID_FIELD', message: 'ci_rrhh excede 20 caracteres' };
  }
  return null;
}

async function responder(res, nombreServicio, ejecutar) {
  try {
    const { httpStatus, ...payload } = await ejecutar();
    return res.status(httpStatus || 200).json(payload);
  } catch (err) {
    if (err.httpStatus && err.code) {
      return res.status(err.httpStatus).json({
        ok: false,
        status: 'ERROR',
        error: { code: err.code, message: err.message }
      });
    }
    console.error(`Error ${nombreServicio}:`, err);
    return res.status(500).json({
      ok: false,
      status: 'ERROR',
      error: { code: err.errorNum ? String(err.errorNum) : 'UNKNOWN', message: 'Error interno al procesar el comprobante' }
    });
  }
}

async function generarEnviarComprobante(req, res) {
  const body = req.body || {};
  const invalido = validarPayload(body);
  if (invalido) {
    return res.status(400).json({ ok: false, status: 'ERROR', error: invalido });
  }

  return responder(res, 'wsGenerarEnviarComprobanteVacacionesChile', () => service.procesar({
    idSolicitud: Number(body.id_solicitud),
    ciRrhh: body.ci_rrhh.trim()
  }));
}

async function reenviarComprobante(req, res) {
  const body = req.body || {};
  const invalido = validarPayload(body)
    || (body.forzar !== undefined && typeof body.forzar !== 'boolean'
      ? { code: 'INVALID_FIELD', message: 'forzar debe ser true o false' }
      : null);
  if (invalido) {
    return res.status(400).json({ ok: false, status: 'ERROR', error: invalido });
  }

  return responder(res, 'wsReenviarComprobanteVacacionesChile', () => service.reenviar({
    idSolicitud: Number(body.id_solicitud),
    ciRrhh: body.ci_rrhh.trim(),
    forzar: body.forzar === true
  }));
}

async function cargarComprobanteFirmado(req, res) {
  const body = req.body || {};
  const id = Number(body.id_solicitud);
  const ci = typeof body.ci_solicitante === 'string' ? body.ci_solicitante.trim() : '';
  let invalido = null;
  if (!Number.isInteger(id) || id <= 0) {
    invalido = { code: 'INVALID_FIELD', message: 'id_solicitud debe ser un entero positivo' };
  } else if (!ci) {
    invalido = { code: 'MISSING_FIELD', message: 'Falta campo ci_solicitante' };
  } else if (ci.length > 20) {
    invalido = { code: 'INVALID_FIELD', message: 'ci_solicitante excede 20 caracteres' };
  } else if (!req.file) {
    invalido = { code: 'ARCHIVO_REQUERIDO', message: 'Debe adjuntar exactamente un archivo en el campo "archivo"' };
  }
  if (invalido) {
    return res.status(400).json({ ok: false, status: 'ERROR', error: invalido });
  }

  return responder(res, 'wsCargarComprobanteFirmadoChile', () => firmadoService.cargarFirmado({
    idSolicitud: id,
    ciSolicitante: ci,
    archivo: req.file
  }));
}

// Misma regla que parseLimit (ventasWebController): 100 por defecto, máximo 1000
function parseLimit(rawLimit, defaultLimit = 100, maxLimit = 1000) {
  const parsedLimit = Number(rawLimit || defaultLimit);
  return Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, maxLimit)
    : defaultLimit;
}

const vacio = v => v === undefined || v === null || v === '';

function validarConsulta(body) {
  const ciUsuario = typeof body.ci_usuario === 'string' ? body.ci_usuario.trim() : '';
  if (!ciUsuario) return { error: { code: 'MISSING_FIELD', message: 'Falta campo ci_usuario' } };
  if (ciUsuario.length > 20) return { error: { code: 'INVALID_FIELD', message: 'ci_usuario excede 20 caracteres' } };

  let idSolicitud = null;
  if (!vacio(body.id_solicitud)) {
    idSolicitud = Number(body.id_solicitud);
    if (!Number.isInteger(idSolicitud) || idSolicitud <= 0) {
      return { error: { code: 'INVALID_FIELD', message: 'id_solicitud debe ser un entero positivo' } };
    }
  }

  let ciSolicitante = null;
  if (!vacio(body.ci_solicitante)) {
    if (typeof body.ci_solicitante !== 'string' || body.ci_solicitante.trim().length > 20) {
      return { error: { code: 'INVALID_FIELD', message: 'ci_solicitante inválido' } };
    }
    ciSolicitante = body.ci_solicitante.trim() || null;
  }

  let estadoDocumento = null;
  if (!vacio(body.estado_documento)) {
    estadoDocumento = String(body.estado_documento).trim().toUpperCase();
    if (!consultaService.ESTADOS_DOCUMENTO.includes(estadoDocumento)) {
      return { error: { code: 'INVALID_FIELD', message: `estado_documento debe ser uno de: ${consultaService.ESTADOS_DOCUMENTO.join(', ')}` } };
    }
  }

  for (const campo of ['pendientes_nomina', 'verificar_archivo']) {
    if (!vacio(body[campo]) && typeof body[campo] !== 'boolean') {
      return { error: { code: 'INVALID_FIELD', message: `${campo} debe ser true o false` } };
    }
  }

  let pagina = 1;
  if (!vacio(body.pagina)) {
    pagina = Number(body.pagina);
    if (!Number.isInteger(pagina) || pagina < 1) {
      return { error: { code: 'INVALID_FIELD', message: 'pagina debe ser un entero mayor o igual a 1' } };
    }
  }

  return {
    params: {
      ciUsuario,
      idSolicitud,
      ciSolicitante,
      estadoDocumento,
      pendientesNomina: body.pendientes_nomina === true,
      verificarArchivo: body.verificar_archivo !== false,
      limite: parseLimit(body.limite),
      pagina
    }
  };
}

async function obtenerComprobantes(req, res) {
  const { error, params } = validarConsulta(req.body || {});
  if (error) {
    return res.status(400).json({ ok: false, status: 'ERROR', error });
  }
  return responder(res, 'wsObtenerComprobantesVacacionesChile', () => consultaService.obtenerComprobantes(params));
}

async function confirmarRecepcion(req, res) {
  const body = req.body || {};
  const idComprobante = Number(body.id_comprobante);
  const accion = typeof body.accion === 'string' ? body.accion.trim().toUpperCase() : '';
  let invalido = validarPayload(body);
  if (!invalido) {
    if (vacio(body.id_comprobante)) {
      invalido = { code: 'MISSING_FIELD', message: 'Falta campo id_comprobante' };
    } else if (!Number.isInteger(idComprobante) || idComprobante <= 0) {
      invalido = { code: 'INVALID_FIELD', message: 'id_comprobante debe ser un entero positivo' };
    } else if (!['RECIBIR', 'RECHAZAR'].includes(accion)) {
      invalido = { code: 'INVALID_FIELD', message: 'accion debe ser RECIBIR o RECHAZAR' };
    } else if (!vacio(body.observacion) && typeof body.observacion !== 'string') {
      invalido = { code: 'INVALID_FIELD', message: 'observacion debe ser texto' };
    } else if (typeof body.observacion === 'string' && Buffer.byteLength(body.observacion.trim(), 'utf8') > 1000) {
      // OBSERVACION_RECEPCION es VARCHAR2(1000 BYTE): las tildes ocupan 2 bytes
      invalido = { code: 'INVALID_FIELD', message: 'observacion excede 1000 bytes (las letras con tilde cuentan doble)' };
    }
  }
  if (invalido) {
    return res.status(400).json({ ok: false, status: 'ERROR', error: invalido });
  }

  return responder(res, 'wsConfirmarRecepcionComprobanteChile', () => recepcionService.confirmarRecepcion({
    idSolicitud: Number(body.id_solicitud),
    idComprobante,
    ciRrhh: body.ci_rrhh.trim(),
    accion,
    observacion: typeof body.observacion === 'string' ? body.observacion : null
  }));
}

module.exports = {
  confirmarRecepcion,
  generarEnviarComprobante,
  reenviarComprobante,
  cargarComprobanteFirmado,
  obtenerComprobantes,
  validarPayload,
  validarConsulta
};
