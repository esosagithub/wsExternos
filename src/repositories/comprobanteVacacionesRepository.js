const oracledb = require('oracledb');

// Todas las funciones reciben la conexión: el servicio controla la transacción.
const OPTS = { autoCommit: false, outFormat: oracledb.OUT_FORMAT_OBJECT };

const SQL_SOLICITUD = `
  SELECT ID_SOLICITUD, PAIS, TIPO_REGISTRO, ESTADO,
         CI_SOLICITANTE, NOMBRE_SOLICITANTE, COD_SAP_EMPLEADO, EMPREASA AS EMPRESA,
         DEPARTAMENTO, CARGO, CI_JEFE_INMEDIATO, NOMBRES_JEFE,
         FECHA_SOLICITUD, FECHA_INICIO, FECHA_FIN, FECHA_RETORNO,
         DIAS_CALENDARIO, DIAS_HABILES, FINES_SEMANA_EXCLUIDOS, FERIADOS_EXCLUIDOS,
         DIAS_CUBIERTOS_SALDO, DIAS_ANTICIPADOS, CLASIFICACION, TOTAL_DIAS,
         ESTADO_APROBACION_JEFE_INMEDIATO, FECHA_APROBACION_JEFE_INMEDIATO,
         ESTADO_APROBACION_RRHH, FECHA_APROBACION_RRHH, CI_RRHH
    FROM OCACCESS.MS_VACACIONES
   WHERE ID_SOLICITUD = :idSolicitud`;

const SQL_PERIODOS = `
  SELECT ANIO_INICIO, ANIO_FIN, DIAS_SALDO, DIAS_USO, TIPO
    FROM OCACCESS.MS_VACACIONES_PERIODO
   WHERE ID_SOLICITUD = :idSolicitud
   ORDER BY ANIO_INICIO`;

const SQL_COMPROBANTE = `
  SELECT ID_COMPROBANTE, ID_SOLICITUD, NOMBRE_ARCHIVO, RUTA_FISICA, URL_PUBLICA,
         TIPO_ARCHIVO_ACTUAL, ESTADO_DOCUMENTO, VERSION_ARCHIVO,
         HASH_ARCHIVO_GENERADO, TAMANIO_GENERADO,
         ESTADO_ENVIO_EMAIL, INTENTOS_ENVIO_EMAIL
    FROM OCACCESS.MS_VACACIONES_COMPROBANTE
   WHERE ID_SOLICITUD = :idSolicitud
     FOR UPDATE`;

// ID_COMPROBANTE, FECHA_CREACION y FECHA_ACTUALIZACION los asigna TRG_MS_VAC_COMP_BIU
const SQL_INSERT_COMPROBANTE = `
  INSERT INTO OCACCESS.MS_VACACIONES_COMPROBANTE (
    ID_SOLICITUD, PAIS, NOMBRE_ARCHIVO, RUTA_FISICA, URL_PUBLICA,
    TIPO_ARCHIVO_ACTUAL, ESTADO_DOCUMENTO, VERSION_ARCHIVO,
    HASH_ARCHIVO_GENERADO, TAMANIO_GENERADO, FECHA_GENERACION,
    ESTADO_ENVIO_EMAIL, INTENTOS_ENVIO_EMAIL
  ) VALUES (
    :idSolicitud, 'CHILE', :nombreArchivo, :rutaFisica, :urlPublica,
    'GENERADO', 'GENERADO', 1,
    :hash, :tamanio, SYSDATE,
    'PENDIENTE', 0
  ) RETURNING ID_COMPROBANTE INTO :idComprobante`;

const SQL_UPDATE_REGENERADO = `
  UPDATE OCACCESS.MS_VACACIONES_COMPROBANTE
     SET NOMBRE_ARCHIVO = :nombreArchivo,
         RUTA_FISICA = :rutaFisica,
         URL_PUBLICA = :urlPublica,
         HASH_ARCHIVO_GENERADO = :hash,
         TAMANIO_GENERADO = :tamanio,
         FECHA_GENERACION = SYSDATE
   WHERE ID_COMPROBANTE = :idComprobante`;

const SQL_EMAIL_ENVIADO = `
  UPDATE OCACCESS.MS_VACACIONES_COMPROBANTE
     SET ESTADO_ENVIO_EMAIL = 'ENVIADO',
         FECHA_ENVIO_EMAIL = SYSDATE,
         ESTADO_DOCUMENTO = 'PENDIENTE_FIRMA',
         EMAIL_DESTINATARIO = :email,
         ERROR_ENVIO_EMAIL = NULL,
         INTENTOS_ENVIO_EMAIL = NVL(INTENTOS_ENVIO_EMAIL, 0) + 1
   WHERE ID_COMPROBANTE = :idComprobante`;

const SQL_EMAIL_ERROR = `
  UPDATE OCACCESS.MS_VACACIONES_COMPROBANTE
     SET ESTADO_ENVIO_EMAIL = 'ERROR',
         ERROR_ENVIO_EMAIL = SUBSTR(:error, 1, 2000),
         EMAIL_DESTINATARIO = :email,
         INTENTOS_ENVIO_EMAIL = NVL(INTENTOS_ENVIO_EMAIL, 0) + 1
   WHERE ID_COMPROBANTE = :idComprobante`;

// Misma consulta que ServicioColaboradoresPaisNomina (wsObtenerDatosColaboradorPais)
function sqlColaborador() {
  const tabla = process.env.COLABORADORES_PAIS_TABLE || 'SAP_HCM.COLABORADORES_PAIS';
  if (!/^[A-Za-z0-9_$#]+(\.[A-Za-z0-9_$#]+)?$/.test(tabla)) {
    throw new Error('COLABORADORES_PAIS_TABLE inválida');
  }
  return `
  SELECT NOMBRES, CEDULA, PAIS, CORREO_PERSONAL, CORREO_EMPRESARIAL
    FROM ${tabla}
   WHERE CEDULA = :cedula
   ORDER BY FECHA_ING ASC FETCH FIRST 1 ROW ONLY`;
}

// Misma inserción que ServicioNotificacionVacaciones (wsSetNotificacionVacaciones)
const SQL_NOTIFICACION = `
  INSERT INTO OCACCESS.MS_VACACIONES_NOTIFICACIONES (ID_SOLICITUD, NOTIFICACION)
  VALUES (:idSolicitud, :notificacion)`;

// Carga del PDF firmado: conserva HASH_ARCHIVO_GENERADO, NOMBRE_ARCHIVO, RUTA_FISICA y URL_PUBLICA.
// Solo es posible desde PENDIENTE_FIRMA o RECHAZADO; se limpia la recepción anterior (rechazo).
const SQL_CARGA_FIRMADO = `
  UPDATE OCACCESS.MS_VACACIONES_COMPROBANTE
     SET TIPO_ARCHIVO_ACTUAL = 'FIRMADO',
         ESTADO_DOCUMENTO = 'PENDIENTE_RECEPCION',
         VERSION_ARCHIVO = VERSION_ARCHIVO + 1,
         HASH_ARCHIVO_FIRMADO = :hash,
         TAMANIO_FIRMADO = :tamanio,
         CI_USUARIO_CARGA = :ciUsuario,
         FECHA_CARGA_FIRMADO = SYSDATE,
         CI_RRHH_RECEPCION = NULL,
         FECHA_RECEPCION = NULL,
         OBSERVACION_RECEPCION = NULL
   WHERE ID_COMPROBANTE = :idComprobante
     AND ESTADO_DOCUMENTO IN ('PENDIENTE_FIRMA', 'RECHAZADO')
  RETURNING VERSION_ARCHIVO, FECHA_CARGA_FIRMADO INTO :version, :fechaCarga`;

async function registrarCargaFirmado(conn, idComprobante, { hash, tamanio, ciUsuario }) {
  const r = await conn.execute(SQL_CARGA_FIRMADO, {
    idComprobante,
    hash,
    tamanio,
    ciUsuario,
    version: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
    fechaCarga: { dir: oracledb.BIND_OUT, type: oracledb.DATE }
  }, OPTS);
  if (r.rowsAffected !== 1) {
    const err = new Error('El comprobante cambió de estado durante la carga');
    err.code = 'ESTADO_CONCURRENTE';
    throw err;
  }
  const uno = v => (Array.isArray(v) ? v[0] : v);
  return { version: uno(r.outBinds.version), fechaCarga: uno(r.outBinds.fechaCarga) };
}

const SQL_COMPROBANTE_POR_ID = `
  SELECT ID_COMPROBANTE, ID_SOLICITUD, RUTA_FISICA, TIPO_ARCHIVO_ACTUAL,
         ESTADO_DOCUMENTO, HASH_ARCHIVO_FIRMADO
    FROM OCACCESS.MS_VACACIONES_COMPROBANTE
   WHERE ID_COMPROBANTE = :idComprobante
     FOR UPDATE`;

// Actualización condicional: evita la doble confirmación
const SQL_REGISTRAR_RECEPCION = `
  UPDATE OCACCESS.MS_VACACIONES_COMPROBANTE
     SET ESTADO_DOCUMENTO = :estado,
         CI_RRHH_RECEPCION = :ciRrhh,
         FECHA_RECEPCION = SYSDATE,
         OBSERVACION_RECEPCION = :observacion
   WHERE ID_COMPROBANTE = :idComprobante
     AND ESTADO_DOCUMENTO = 'PENDIENTE_RECEPCION'
  RETURNING FECHA_RECEPCION INTO :fechaRecepcion`;

async function obtenerComprobantePorId(conn, idComprobante) {
  const r = await conn.execute(SQL_COMPROBANTE_POR_ID, { idComprobante }, OPTS);
  return r.rows && r.rows.length ? r.rows[0] : null;
}

async function registrarRecepcion(conn, idComprobante, { estado, ciRrhh, observacion }) {
  const r = await conn.execute(SQL_REGISTRAR_RECEPCION, {
    idComprobante,
    estado,
    ciRrhh,
    observacion: { val: observacion || null, type: oracledb.STRING },
    fechaRecepcion: { dir: oracledb.BIND_OUT, type: oracledb.DATE }
  }, OPTS);
  if (r.rowsAffected !== 1) {
    const err = new Error('El comprobante ya no está pendiente de recepción');
    err.code = 'ESTADO_CONCURRENTE';
    throw err;
  }
  const f = r.outBinds.fechaRecepcion;
  return { fechaRecepcion: Array.isArray(f) ? f[0] : f };
}

// Consulta fija: los filtros opcionales van como binds (NULL = sin filtro), nunca concatenados.
// La vista no filtra país ni expone RUTA_FISICA; Chile se garantiza con el EXISTS.
const SQL_BUSCAR_COMPROBANTES_CHILE = `
  SELECT v.ID_SOLICITUD, v.ID_COMPROBANTE, v.NOMBRE_SOLICITANTE, v.CI_SOLICITANTE,
         v.ESTADO_DOCUMENTO, v.TIPO_ARCHIVO_ACTUAL, v.FECHA_GENERACION, v.FECHA_CARGA_FIRMADO,
         v.NOMBRE_ARCHIVO, v.URL_PUBLICA, v.FECHA_RECEPCION, v.OBSERVACION_RECEPCION,
         COUNT(*) OVER () AS TOTAL_REGISTROS
    FROM OCACCESS.VW_VACACIONES_COMP_CHILE v
   WHERE EXISTS (SELECT 1
                   FROM OCACCESS.MS_VACACIONES m
                  WHERE m.ID_SOLICITUD = v.ID_SOLICITUD
                    AND UPPER(TRIM(m.PAIS)) IN ('CHILE', 'CL'))
     AND (:idSolicitud IS NULL OR v.ID_SOLICITUD = :idSolicitud)
     AND (:ciNorm IS NULL OR REPLACE(REPLACE(REPLACE(UPPER(v.CI_SOLICITANTE), '.', ''), '-', ''), ' ', '') = :ciNorm)
     AND (:estado IS NULL OR v.ESTADO_DOCUMENTO = :estado)
   ORDER BY NVL(v.FECHA_CARGA_FIRMADO, v.FECHA_GENERACION) DESC NULLS LAST, v.ID_SOLICITUD DESC
  OFFSET :offset ROWS FETCH NEXT :limite ROWS ONLY`;

async function buscarComprobantesChile(conn, { idSolicitud = null, ciNorm = null, estado = null, offset, limite }) {
  const r = await conn.execute(SQL_BUSCAR_COMPROBANTES_CHILE, {
    idSolicitud: { val: idSolicitud, type: oracledb.NUMBER },
    ciNorm: { val: ciNorm, type: oracledb.STRING },
    estado: { val: estado, type: oracledb.STRING },
    offset: { val: offset, type: oracledb.NUMBER },
    limite: { val: limite, type: oracledb.NUMBER }
  }, OPTS);
  return r.rows || [];
}

// Misma consulta que ServicioJefeVacaciones.obtenerAprobarNominaChile (Java)
const SQL_PERMISO_NOMINA_CHILE = `
  SELECT COUNT(*) AS N
    FROM MS_USUARIOS_TI.PERFILES_VACACIONES_VIEW_CHILE
   WHERE CEDULA = :cedula`;

async function tienePermisoNominaChile(conn, cedula) {
  const r = await conn.execute(SQL_PERMISO_NOMINA_CHILE, { cedula }, OPTS);
  return Number(r.rows && r.rows[0] ? r.rows[0].N : 0) > 0;
}

async function obtenerSolicitud(conn, idSolicitud) {
  const r = await conn.execute(SQL_SOLICITUD, { idSolicitud }, OPTS);
  return r.rows && r.rows.length ? r.rows[0] : null;
}

async function obtenerPeriodos(conn, idSolicitud) {
  const r = await conn.execute(SQL_PERIODOS, { idSolicitud }, OPTS);
  return r.rows || [];
}

async function obtenerComprobante(conn, idSolicitud) {
  const r = await conn.execute(SQL_COMPROBANTE, { idSolicitud }, OPTS);
  return r.rows && r.rows.length ? r.rows[0] : null;
}

async function insertarComprobante(conn, data) {
  const r = await conn.execute(SQL_INSERT_COMPROBANTE, {
    idSolicitud: data.idSolicitud,
    nombreArchivo: data.nombreArchivo,
    rutaFisica: data.rutaFisica,
    urlPublica: data.urlPublica,
    hash: data.hash,
    tamanio: data.tamanio,
    idComprobante: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER }
  }, OPTS);
  const out = r.outBinds.idComprobante;
  return Array.isArray(out) ? out[0] : out;
}

async function actualizarArchivoRegenerado(conn, idComprobante, data) {
  await conn.execute(SQL_UPDATE_REGENERADO, {
    idComprobante,
    nombreArchivo: data.nombreArchivo,
    rutaFisica: data.rutaFisica,
    urlPublica: data.urlPublica,
    hash: data.hash,
    tamanio: data.tamanio
  }, OPTS);
}

async function marcarEmailEnviado(conn, idComprobante, email) {
  await conn.execute(SQL_EMAIL_ENVIADO, { idComprobante, email }, OPTS);
}

async function marcarEmailError(conn, idComprobante, email, error) {
  await conn.execute(SQL_EMAIL_ERROR, {
    idComprobante,
    email: email || null,
    error: String(error || 'Error desconocido').slice(0, 2000)
  }, OPTS);
}

async function obtenerCorreoColaborador(conn, cedula) {
  const r = await conn.execute(sqlColaborador(), { cedula }, OPTS);
  const row = r.rows && r.rows.length ? r.rows[0] : null;
  if (!row) return null;
  const correo = (row.CORREO_EMPRESARIAL || '').trim() || (row.CORREO_PERSONAL || '').trim();
  return correo || null;
}

async function insertarNotificacion(conn, idSolicitud, notificacion) {
  await conn.execute(SQL_NOTIFICACION, { idSolicitud, notificacion }, OPTS);
}

module.exports = {
  obtenerComprobantePorId,
  registrarRecepcion,
  buscarComprobantesChile,
  tienePermisoNominaChile,
  obtenerSolicitud,
  obtenerPeriodos,
  obtenerComprobante,
  insertarComprobante,
  actualizarArchivoRegenerado,
  marcarEmailEnviado,
  marcarEmailError,
  registrarCargaFirmado,
  obtenerCorreoColaborador,
  insertarNotificacion
};
