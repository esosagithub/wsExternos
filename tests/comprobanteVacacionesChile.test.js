const fs = require('fs');
const os = require('os');
const path = require('path');

const service = require('../src/services/comprobanteVacacionesChileService');
const realRepo = require('../src/repositories/comprobanteVacacionesRepository');
const pdfService = require('../src/services/comprobantePdfService');

const PUBLIC_URL = 'https://ns.aseyco.com:444/nomina/Chile';
let dir;

function solicitudChile(extra = {}) {
  return {
    ID_SOLICITUD: 3459,
    PAIS: 'CHILE',
    TIPO_REGISTRO: 'SOLICITUD',
    CI_SOLICITANTE: '12345678-9',
    NOMBRE_SOLICITANTE: 'Juana Pérez Soto',
    COD_SAP_EMPLEADO: '50001234',
    EMPRESA: 'Empresa Chile SpA',
    DEPARTAMENTO: 'Ventas',
    CARGO: 'Vendedora',
    CI_JEFE_INMEDIATO: '9876543-2',
    NOMBRES_JEFE: 'Carlos Rojas',
    FECHA_SOLICITUD: new Date(2026, 8, 1),
    FECHA_INICIO: new Date(2026, 9, 5),
    FECHA_FIN: new Date(2026, 9, 16),
    FECHA_RETORNO: new Date(2026, 9, 19),
    DIAS_CALENDARIO: 12,
    DIAS_HABILES: 9,
    FINES_SEMANA_EXCLUIDOS: 2,
    FERIADOS_EXCLUIDOS: 1,
    DIAS_CUBIERTOS_SALDO: 7,
    DIAS_ANTICIPADOS: 2,
    CLASIFICACION: 'ANTICIPADA',
    ESTADO_APROBACION_JEFE_INMEDIATO: 'APROBADA',
    FECHA_APROBACION_JEFE_INMEDIATO: new Date(2026, 8, 2, 10, 30),
    ESTADO_APROBACION_RRHH: 'APROBADA',
    FECHA_APROBACION_RRHH: new Date(2026, 8, 3, 15, 0),
    CI_RRHH: '11111111-1',
    ...extra
  };
}

const PERIODOS = [
  { ANIO_INICIO: '2024', ANIO_FIN: '2025', DIAS_SALDO: 7, DIAS_USO: 7, TIPO: 1 },
  { ANIO_INICIO: '2025', ANIO_FIN: '2026', DIAS_SALDO: 0, DIAS_USO: 2, TIPO: 2 }
];

function crearConn() {
  return {
    execute: jest.fn(),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    close: jest.fn().mockResolvedValue()
  };
}

// Repositorio en memoria que simula MS_VACACIONES_COMPROBANTE
function crearRepo({ solicitud = solicitudChile(), comprobante = null } = {}) {
  const estado = { comp: comprobante ? { ...comprobante } : null };
  const repo = {
    estado,
    tienePermisoNominaChile: jest.fn().mockResolvedValue(true),
    obtenerSolicitud: jest.fn().mockResolvedValue(solicitud),
    obtenerPeriodos: jest.fn().mockResolvedValue(PERIODOS),
    obtenerComprobante: jest.fn(async () => (estado.comp ? { ...estado.comp } : null)),
    insertarComprobante: jest.fn(async (conn, d) => {
      estado.comp = {
        ID_COMPROBANTE: 123,
        ID_SOLICITUD: d.idSolicitud,
        NOMBRE_ARCHIVO: d.nombreArchivo,
        RUTA_FISICA: d.rutaFisica,
        URL_PUBLICA: d.urlPublica,
        TIPO_ARCHIVO_ACTUAL: 'GENERADO',
        ESTADO_DOCUMENTO: 'GENERADO',
        VERSION_ARCHIVO: 1,
        HASH_ARCHIVO_GENERADO: d.hash,
        TAMANIO_GENERADO: d.tamanio,
        ESTADO_ENVIO_EMAIL: 'PENDIENTE',
        INTENTOS_ENVIO_EMAIL: 0
      };
      return 123;
    }),
    actualizarArchivoRegenerado: jest.fn(async (conn, id, d) => {
      Object.assign(estado.comp, {
        NOMBRE_ARCHIVO: d.nombreArchivo, RUTA_FISICA: d.rutaFisica, URL_PUBLICA: d.urlPublica
      });
    }),
    marcarEmailEnviado: jest.fn(async () => {
      Object.assign(estado.comp, { ESTADO_ENVIO_EMAIL: 'ENVIADO', ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA' });
      estado.comp.INTENTOS_ENVIO_EMAIL += 1;
    }),
    marcarEmailError: jest.fn(async () => {
      estado.comp.ESTADO_ENVIO_EMAIL = 'ERROR';
      estado.comp.INTENTOS_ENVIO_EMAIL += 1;
    }),
    obtenerCorreoColaborador: jest.fn().mockResolvedValue('juana.perez@empresa.cl'),
    insertarNotificacion: jest.fn().mockResolvedValue()
  };
  return repo;
}

function crearDeps(repo, { mailFalla = false } = {}) {
  const conn = crearConn();
  const mail = {
    enviarCorreo: mailFalla
      ? jest.fn().mockRejectedValue(new Error('535 Authentication unsuccessful'))
      : jest.fn().mockResolvedValue({ messageId: 'x' })
  };
  const pdf = { ...pdfService, generarPdfAtomico: jest.fn(pdfService.generarPdfAtomico) };
  return { conn, mail, pdf, deps: { db: { getConnection: jest.fn().mockResolvedValue(conn) }, repo, mail, pdf, fs } };
}

function archivoExistente(nombre = 'comprobante_vacaciones_3459_existente.pdf') {
  const ruta = path.join(dir, nombre);
  const contenido = '%PDF-1.3 prueba';
  fs.writeFileSync(ruta, contenido);
  return {
    ID_COMPROBANTE: 77,
    ID_SOLICITUD: 3459,
    NOMBRE_ARCHIVO: nombre,
    RUTA_FISICA: ruta,
    URL_PUBLICA: `${PUBLIC_URL}/${nombre}`,
    TIPO_ARCHIVO_ACTUAL: 'GENERADO',
    ESTADO_DOCUMENTO: 'GENERADO',
    VERSION_ARCHIVO: 1,
    HASH_ARCHIVO_GENERADO: require('crypto').createHash('sha256').update(contenido).digest('hex'),
    ESTADO_ENVIO_EMAIL: 'PENDIENTE',
    INTENTOS_ENVIO_EMAIL: 0
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-chile-'));
  process.env.VACACIONES_CHILE_PDF_PATH = dir;
  process.env.VACACIONES_CHILE_PUBLIC_URL = PUBLIC_URL;
  process.env.VACACIONES_PDF_MAX_BYTES = '10485760';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const pdfsEn = d => fs.readdirSync(d).filter(f => f.endsWith('.pdf'));

describe('wsGenerarEnviarComprobanteVacacionesChile', () => {
  test('solicitud inexistente → 404, sin PDF y conexión cerrada', async () => {
    const repo = crearRepo({ solicitud: null });
    const { conn, deps, pdf } = crearDeps(repo);

    await expect(service.procesar({ idSolicitud: 999, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 404, code: 'SOLICITUD_NO_EXISTE' });

    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test('solicitud no aprobada por Nómina → 409', async () => {
    const repo = crearRepo({ solicitud: solicitudChile({ ESTADO_APROBACION_RRHH: 'PENDIENTE' }) });
    const { conn, deps } = crearDeps(repo);

    await expect(service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'SOLICITUD_NO_APROBADA' });
    expect(repo.insertarComprobante).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

  test('solicitud de otro país → 422', async () => {
    const repo = crearRepo({ solicitud: solicitudChile({ PAIS: 'PERU' }) });
    const { conn, deps } = crearDeps(repo);

    await expect(service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 422, code: 'PAIS_NO_CHILE' });
    expect(repo.obtenerComprobante).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

  test('acepta PAIS CL y rechaza TIPO_REGISTRO distinto de SOLICITUD', async () => {
    const repo = crearRepo({ solicitud: solicitudChile({ PAIS: ' cl ', TIPO_REGISTRO: 'PLANIFICACION' }) });
    const { deps } = crearDeps(repo);
    await expect(service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 422, code: 'TIPO_REGISTRO_INVALIDO' });
  });

  test('flujo completo: genera, inserta, envía con adjunto físico y notifica', async () => {
    const repo = crearRepo();
    const { conn, deps, mail } = crearDeps(repo);

    const r = await service.procesar({ idSolicitud: 3459, ciRrhh: '11111111-1' }, deps);

    expect(r).toEqual({
      ok: true,
      idSolicitud: 3459,
      idComprobante: 123,
      estadoDocumento: 'PENDIENTE_FIRMA',
      estadoEmail: 'ENVIADO',
      nombreArchivo: expect.stringMatching(/^comprobante_vacaciones_3459_[0-9a-f-]{36}\.pdf$/),
      urlPublica: expect.stringMatching(new RegExp(`^${PUBLIC_URL}/comprobante_vacaciones_3459_.+\\.pdf$`))
    });
    expect(JSON.stringify(r)).not.toContain(dir.replace(/\\/g, '\\\\'));
    expect(r).not.toHaveProperty('rutaFisica');

    const archivos = fs.readdirSync(dir);
    expect(archivos).toEqual([r.nombreArchivo]); // sin temporales
    expect(fs.readFileSync(path.join(dir, r.nombreArchivo)).subarray(0, 4).toString()).toBe('%PDF');

    const envio = mail.enviarCorreo.mock.calls[0][0];
    expect(envio.to).toBe('juana.perez@empresa.cl');
    expect(envio.attachments[0].path).toBe(path.join(dir, r.nombreArchivo));
    expect(envio.attachments[0]).not.toHaveProperty('href');

    expect(repo.obtenerCorreoColaborador).toHaveBeenCalledWith(conn, '12345678-9');
    expect(repo.marcarEmailEnviado).toHaveBeenCalledWith(conn, 123, 'juana.perez@empresa.cl');
    expect(repo.insertarNotificacion).toHaveBeenCalledWith(conn, 3459,
      'Su solicitud N.º 3459 fue aprobada por Nómina. Descargue, firme y cargue el comprobante de vacaciones.');
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test('generación idempotente: comprobante existente y correo ENVIADO no regenera ni reenvía', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ENVIADO', ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA' };
    const repo = crearRepo({ comprobante: comp });
    const { deps, mail, pdf } = crearDeps(repo);

    const r = await service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(repo.insertarComprobante).not.toHaveBeenCalled();
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(repo.insertarNotificacion).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true, idComprobante: 77, estadoEmail: 'ENVIADO', estadoDocumento: 'PENDIENTE_FIRMA',
      nombreArchivo: comp.NOMBRE_ARCHIVO, urlPublica: comp.URL_PUBLICA
    });
    expect(pdfsEn(dir)).toEqual([comp.NOMBRE_ARCHIVO]);
  });

  test('regenera el PDF si el registro existe pero el archivo físico no', async () => {
    const comp = archivoExistente();
    fs.unlinkSync(comp.RUTA_FISICA);
    const repo = crearRepo({ comprobante: comp });
    const { deps, pdf } = crearDeps(repo);

    const r = await service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(pdf.generarPdfAtomico).toHaveBeenCalledTimes(1);
    expect(repo.actualizarArchivoRegenerado).toHaveBeenCalled();
    expect(repo.insertarComprobante).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, r.nombreArchivo))).toBe(true);
  });

  test('fallo de escritura → COMPROBANTE_WRITE_ERROR, sin insert, rollback y sin temporales', async () => {
    const noExiste = path.join(dir, 'no', 'existe');
    process.env.VACACIONES_CHILE_PDF_PATH = noExiste;
    const repo = crearRepo();
    const { conn, deps, mail } = crearDeps(repo);

    await expect(service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ code: 'COMPROBANTE_WRITE_ERROR', httpStatus: 500 });

    expect(repo.insertarComprobante).not.toHaveBeenCalled();
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('fallo de rename elimina el temporal', async () => {
    jest.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('EPERM'));
    await expect(pdfService.generarPdfAtomico({
      solicitud: solicitudChile(), periodos: PERIODOS, dir, idSolicitud: 3459
    })).rejects.toMatchObject({ code: 'COMPROBANTE_WRITE_ERROR' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('fallo de correo: conserva el PDF, marca ERROR, incrementa intentos y responde 502', async () => {
    const repo = crearRepo();
    const { conn, deps } = crearDeps(repo, { mailFalla: true });

    const r = await service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(r).toMatchObject({
      ok: false, httpStatus: 502, idComprobante: 123, estadoEmail: 'ERROR', estadoDocumento: 'GENERADO',
      error: { code: 'EMAIL_ERROR' }
    });
    expect(repo.marcarEmailError).toHaveBeenCalledWith(conn, 123, 'juana.perez@empresa.cl',
      '535 Authentication unsuccessful');
    expect(repo.estado.comp.INTENTOS_ENVIO_EMAIL).toBe(1);
    expect(repo.marcarEmailEnviado).not.toHaveBeenCalled();
    expect(repo.insertarNotificacion).not.toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, r.nombreArchivo))).toBe(true);
  });

  test('colaborador sin correo se registra como error de envío', async () => {
    const repo = crearRepo();
    repo.obtenerCorreoColaborador.mockResolvedValue(null);
    const { deps, mail } = crearDeps(repo);

    const r = await service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, estadoEmail: 'ERROR' });
    expect(repo.marcarEmailError).toHaveBeenCalled();
  });

  test('reintento de correo: usa el PDF existente sin regenerar y queda PENDIENTE_FIRMA', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ERROR', INTENTOS_ENVIO_EMAIL: 1 };
    const repo = crearRepo({ comprobante: comp });
    const { conn, deps, mail, pdf } = crearDeps(repo);

    const r = await service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(mail.enviarCorreo).toHaveBeenCalledTimes(1);
    expect(mail.enviarCorreo.mock.calls[0][0].attachments[0].path).toBe(comp.RUTA_FISICA);
    expect(repo.marcarEmailEnviado).toHaveBeenCalledWith(conn, 77, 'juana.perez@empresa.cl');
    expect(repo.insertarNotificacion).toHaveBeenCalled();
    expect(repo.estado.comp.INTENTOS_ENVIO_EMAIL).toBe(2);
    expect(r).toMatchObject({ ok: true, idComprobante: 77, estadoDocumento: 'PENDIENTE_FIRMA', estadoEmail: 'ENVIADO' });
    expect(pdfsEn(dir)).toEqual([comp.NOMBRE_ARCHIVO]);
  });

  test('insert concurrente (ORA-00001) → 409 y elimina el PDF no confirmado', async () => {
    const repo = crearRepo();
    repo.insertarComprobante.mockRejectedValue(Object.assign(new Error('ORA-00001'), { errorNum: 1 }));
    const { conn, deps } = crearDeps(repo);

    await expect(service.procesar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'COMPROBANTE_EN_PROCESO' });
    expect(conn.rollback).toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('repositorio Oracle', () => {
  test('inserción correcta en MS_VACACIONES_COMPROBANTE', async () => {
    const gen = await pdfService.generarPdfAtomico({
      solicitud: solicitudChile(), periodos: PERIODOS, dir, idSolicitud: 3459
    });
    const conn = { execute: jest.fn().mockResolvedValue({ outBinds: { idComprobante: [123] } }) };

    const id = await realRepo.insertarComprobante(conn, {
      idSolicitud: 3459,
      nombreArchivo: gen.nombreArchivo,
      rutaFisica: gen.rutaFisica,
      urlPublica: `${PUBLIC_URL}/${gen.nombreArchivo}`,
      hash: gen.hash,
      tamanio: gen.tamanio
    });

    expect(id).toBe(123);
    const [sql, binds, opts] = conn.execute.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO OCACCESS\.MS_VACACIONES_COMPROBANTE/);
    expect(sql).not.toMatch(/ID_COMPROBANTE,/); // lo asigna el trigger
    expect(sql).toMatch(/'CHILE', :nombreArchivo, :rutaFisica, :urlPublica,\s*'GENERADO', 'GENERADO', 1,/);
    expect(sql).toMatch(/:hash, :tamanio, SYSDATE/);
    expect(sql).toMatch(/RETURNING ID_COMPROBANTE INTO :idComprobante/);
    expect(binds).toMatchObject({
      idSolicitud: 3459,
      nombreArchivo: gen.nombreArchivo,
      rutaFisica: path.join(dir, gen.nombreArchivo),
      urlPublica: `${PUBLIC_URL}/${gen.nombreArchivo}`
    });
    expect(binds.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(binds.tamanio).toBe(fs.statSync(gen.rutaFisica).size);
    expect(binds.tamanio).toBeGreaterThan(0);
    expect(opts.autoCommit).toBe(false);
  });

  test('marcarEmailError recorta el mensaje y suma intentos', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({}) };
    await realRepo.marcarEmailError(conn, 5, null, 'x'.repeat(3000));
    const [sql, binds] = conn.execute.mock.calls[0];
    expect(sql).toMatch(/ESTADO_ENVIO_EMAIL = 'ERROR'/);
    expect(sql).toMatch(/INTENTOS_ENVIO_EMAIL = NVL\(INTENTOS_ENVIO_EMAIL, 0\) \+ 1/);
    expect(binds.error).toHaveLength(2000);
  });

  test('marcarEmailEnviado deja PENDIENTE_FIRMA con FECHA_ENVIO_EMAIL = SYSDATE', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({}) };
    await realRepo.marcarEmailEnviado(conn, 5, 'a@b.cl');
    const [sql] = conn.execute.mock.calls[0];
    expect(sql).toMatch(/ESTADO_ENVIO_EMAIL = 'ENVIADO'/);
    expect(sql).toMatch(/FECHA_ENVIO_EMAIL = SYSDATE/);
    expect(sql).toMatch(/ESTADO_DOCUMENTO = 'PENDIENTE_FIRMA'/);
    expect(sql).toMatch(/INTENTOS_ENVIO_EMAIL = NVL\(INTENTOS_ENVIO_EMAIL, 0\) \+ 1/);
  });

  test('correo del colaborador: empresarial con respaldo en personal', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({ rows: [{ CORREO_EMPRESARIAL: ' ', CORREO_PERSONAL: 'p@x.cl' }] }) };
    await expect(realRepo.obtenerCorreoColaborador(conn, '1-9')).resolves.toBe('p@x.cl');
    expect(conn.execute.mock.calls[0][0]).toMatch(/FROM SAP_HCM\.COLABORADORES_PAIS/);
  });
});

describe('wsReenviarComprobanteVacacionesChile', () => {
  const NOTIF = 'Su solicitud N.º 3459 fue aprobada por Nómina. Descargue, firme y cargue el comprobante de vacaciones.';

  test('sin permiso de Nómina → 403, no consulta comprobante ni envía', async () => {
    const repo = crearRepo({ comprobante: archivoExistente() });
    repo.tienePermisoNominaChile.mockResolvedValue(false);
    const { conn, deps, mail } = crearDeps(repo);

    await expect(service.reenviar({ idSolicitud: 3459, ciRrhh: '99-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 403, code: 'SIN_PERMISO_NOMINA' });
    expect(repo.tienePermisoNominaChile).toHaveBeenCalledWith(conn, '99-9');
    expect(repo.obtenerComprobante).not.toHaveBeenCalled();
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test('comprobante inexistente → 404 y no genera PDF', async () => {
    const repo = crearRepo();
    const { conn, deps, pdf, mail } = crearDeps(repo);

    await expect(service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 404, code: 'COMPROBANTE_NO_EXISTE' });
    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(conn.close).toHaveBeenCalled();
  });

  test('archivo físico inexistente → 409 sin regenerar ni tocar estado de correo', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ERROR' };
    fs.unlinkSync(comp.RUTA_FISICA);
    const repo = crearRepo({ comprobante: comp });
    const { deps, pdf, mail } = crearDeps(repo);

    await expect(service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ARCHIVO_NO_DISPONIBLE' });
    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(repo.marcarEmailError).not.toHaveBeenCalled();
    expect(repo.marcarEmailEnviado).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('archivo alterado (hash distinto) → 409 y no envía', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ERROR' };
    fs.appendFileSync(comp.RUTA_FISICA, 'alterado');
    const repo = crearRepo({ comprobante: comp });
    const { deps, mail } = crearDeps(repo);

    await expect(service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ARCHIVO_HASH_INVALIDO' });
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(repo.marcarEmailError).not.toHaveBeenCalled();
  });

  test('hash no registrado → 409 y no envía', async () => {
    const comp = { ...archivoExistente(), HASH_ARCHIVO_GENERADO: null };
    const repo = crearRepo({ comprobante: comp });
    const { deps, mail } = crearDeps(repo);

    await expect(service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps))
      .rejects.toMatchObject({ code: 'ARCHIVO_HASH_INVALIDO' });
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
  });

  test.each([
    ['ESTADO_DOCUMENTO', 'PENDIENTE_RECEPCION'],
    ['ESTADO_DOCUMENTO', 'RECIBIDO'],
    ['TIPO_ARCHIVO_ACTUAL', 'FIRMADO']
  ])('documento ya firmado (%s = %s) → 409 y no envía', async (campo, valor) => {
    const comp = { ...archivoExistente(), [campo]: valor, ESTADO_ENVIO_EMAIL: 'ERROR' };
    const repo = crearRepo({ comprobante: comp });
    const { deps, mail } = crearDeps(repo);

    await expect(service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9', forzar: true }, deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'COMPROBANTE_YA_FIRMADO' });
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(repo.marcarEmailEnviado).not.toHaveBeenCalled();
  });

  test('ENVIADO sin forzar → idempotente, no duplica el correo', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ENVIADO', ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA', INTENTOS_ENVIO_EMAIL: 1 };
    const repo = crearRepo({ comprobante: comp });
    const { deps, mail, pdf } = crearDeps(repo);

    const r = await service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(r).toEqual({
      ok: true, idSolicitud: 3459, idComprobante: 77, estadoDocumento: 'PENDIENTE_FIRMA',
      estadoEmail: 'ENVIADO', nombreArchivo: comp.NOMBRE_ARCHIVO, urlPublica: comp.URL_PUBLICA, reenviado: false
    });
    expect(mail.enviarCorreo).not.toHaveBeenCalled();
    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(repo.estado.comp.INTENTOS_ENVIO_EMAIL).toBe(1);
  });

  test('ENVIADO con forzar: true → reenvía, suma intento y no duplica la notificación', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ENVIADO', ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA', INTENTOS_ENVIO_EMAIL: 1 };
    const repo = crearRepo({ comprobante: comp });
    const { conn, deps, mail, pdf } = crearDeps(repo);

    const r = await service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9', forzar: true }, deps);

    expect(mail.enviarCorreo).toHaveBeenCalledTimes(1);
    expect(mail.enviarCorreo.mock.calls[0][0].attachments[0].path).toBe(comp.RUTA_FISICA);
    expect(repo.marcarEmailEnviado).toHaveBeenCalledWith(conn, 77, 'juana.perez@empresa.cl');
    expect(repo.insertarNotificacion).not.toHaveBeenCalled();
    expect(repo.estado.comp.INTENTOS_ENVIO_EMAIL).toBe(2);
    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, reenviado: true, estadoEmail: 'ENVIADO', estadoDocumento: 'PENDIENTE_FIRMA' });
  });

  test('reintento tras ERROR → envía el archivo físico, notifica y queda PENDIENTE_FIRMA', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ERROR', INTENTOS_ENVIO_EMAIL: 2 };
    const repo = crearRepo({ comprobante: comp });
    const { conn, deps, mail, pdf } = crearDeps(repo);

    const r = await service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    const envio = mail.enviarCorreo.mock.calls[0][0];
    expect(envio.attachments).toEqual([{ filename: comp.NOMBRE_ARCHIVO, path: comp.RUTA_FISICA, contentType: 'application/pdf' }]);
    expect(repo.insertarNotificacion).toHaveBeenCalledWith(conn, 3459, NOTIF);
    expect(repo.estado.comp.INTENTOS_ENVIO_EMAIL).toBe(3);
    expect(pdf.generarPdfAtomico).not.toHaveBeenCalled();
    expect(pdfsEn(dir)).toEqual([comp.NOMBRE_ARCHIVO]);
    expect(r).toEqual({
      ok: true, idSolicitud: 3459, idComprobante: 77, estadoDocumento: 'PENDIENTE_FIRMA',
      estadoEmail: 'ENVIADO', nombreArchivo: comp.NOMBRE_ARCHIVO, urlPublica: comp.URL_PUBLICA, reenviado: true
    });
    expect(JSON.stringify(r)).not.toContain(dir.replace(/\\/g, '\\\\'));
  });

  test('fallo de correo → 502, marca ERROR, suma intento y conserva el archivo', async () => {
    const comp = { ...archivoExistente(), ESTADO_ENVIO_EMAIL: 'ERROR', INTENTOS_ENVIO_EMAIL: 1 };
    const repo = crearRepo({ comprobante: comp });
    const { conn, deps } = crearDeps(repo, { mailFalla: true });

    const r = await service.reenviar({ idSolicitud: 3459, ciRrhh: '1-9' }, deps);

    expect(r).toMatchObject({ ok: false, httpStatus: 502, estadoEmail: 'ERROR', reenviado: true, error: { code: 'EMAIL_ERROR' } });
    expect(repo.marcarEmailError).toHaveBeenCalledWith(conn, 77, 'juana.perez@empresa.cl', '535 Authentication unsuccessful');
    expect(repo.estado.comp.INTENTOS_ENVIO_EMAIL).toBe(2);
    expect(repo.insertarNotificacion).not.toHaveBeenCalled();
    expect(conn.commit).toHaveBeenCalled();
    expect(fs.existsSync(comp.RUTA_FISICA)).toBe(true);
  });

  test('repositorio: permiso se consulta en PERFILES_VACACIONES_VIEW_CHILE', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({ rows: [{ N: 1 }] }) };
    await expect(realRepo.tienePermisoNominaChile(conn, '1-9')).resolves.toBe(true);
    const [sql, binds] = conn.execute.mock.calls[0];
    expect(sql).toMatch(/FROM MS_USUARIOS_TI\.PERFILES_VACACIONES_VIEW_CHILE/);
    expect(binds).toEqual({ cedula: '1-9' });

    conn.execute.mockResolvedValue({ rows: [{ N: 0 }] });
    await expect(realRepo.tienePermisoNominaChile(conn, '2-7')).resolves.toBe(false);
  });

  test('controlador: forzar debe ser booleano', async () => {
    const controller = require('../src/controllers/vacacionesChileController');
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.reenviarComprobante({ body: { id_solicitud: 3459, ci_rrhh: '1-9', forzar: 'si' } }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('INVALID_FIELD');
  });
});
