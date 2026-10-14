const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const service = require('../src/services/comprobanteFirmadoChileService');
const realRepo = require('../src/repositories/comprobanteVacacionesRepository');

const PUBLIC_URL = 'https://ns.aseyco.com:444/nomina/Chile';
const NOMBRE = 'comprobante_vacaciones_3459_0f1e2d3c-aaaa-bbbb-cccc-111122223333.pdf';
const GENERADO = Buffer.from('%PDF-1.3 comprobante generado');
const FIRMADO = Buffer.from('%PDF-1.7 comprobante firmado por el colaborador');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
let dir;

function crearComprobante(extra = {}) {
  const ruta = path.join(dir, NOMBRE);
  fs.writeFileSync(ruta, GENERADO);
  return {
    ID_COMPROBANTE: 123,
    ID_SOLICITUD: 3459,
    NOMBRE_ARCHIVO: NOMBRE,
    RUTA_FISICA: ruta,
    URL_PUBLICA: `${PUBLIC_URL}/${NOMBRE}`,
    TIPO_ARCHIVO_ACTUAL: 'GENERADO',
    ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA',
    VERSION_ARCHIVO: 1,
    HASH_ARCHIVO_GENERADO: sha(GENERADO),
    ESTADO_ENVIO_EMAIL: 'ENVIADO',
    ...extra
  };
}

function crearRepo({ comprobante = null, ciSolicitante = '20.680.428-9', solicitud } = {}) {
  const estado = { comp: comprobante ? { ...comprobante } : null };
  const fechaCarga = new Date('2026-10-06T15:30:00.000Z');
  return {
    estado,
    obtenerSolicitud: jest.fn().mockResolvedValue(
      solicitud === undefined ? { ID_SOLICITUD: 3459, CI_SOLICITANTE: ciSolicitante, PAIS: 'CHILE' } : solicitud),
    obtenerComprobante: jest.fn(async () => (estado.comp ? { ...estado.comp } : null)),
    registrarCargaFirmado: jest.fn(async (conn, id, d) => {
      Object.assign(estado.comp, {
        TIPO_ARCHIVO_ACTUAL: 'FIRMADO',
        ESTADO_DOCUMENTO: 'PENDIENTE_RECEPCION',
        VERSION_ARCHIVO: estado.comp.VERSION_ARCHIVO + 1,
        HASH_ARCHIVO_FIRMADO: d.hash,
        TAMANIO_FIRMADO: d.tamanio,
        CI_USUARIO_CARGA: d.ciUsuario
      });
      return { version: estado.comp.VERSION_ARCHIVO, fechaCarga };
    }),
    insertarNotificacion: jest.fn().mockResolvedValue()
  };
}

function crearDeps(repo) {
  const conn = {
    execute: jest.fn(),
    commit: jest.fn().mockResolvedValue(),
    rollback: jest.fn().mockResolvedValue(),
    close: jest.fn().mockResolvedValue()
  };
  const db = { getConnection: jest.fn().mockResolvedValue(conn) };
  return { conn, db, deps: { db, repo, fs } };
}

const archivoPdf = (buffer = FIRMADO, extra = {}) =>
  ({ buffer, mimetype: 'application/pdf', originalname: 'comprobante firmado.pdf', size: buffer.length, ...extra });

const entrada = (extra = {}) => ({ idSolicitud: 3459, ciSolicitante: '20.680.428-9', archivo: archivoPdf(), ...extra });

const contenido = () => fs.readFileSync(path.join(dir, NOMBRE));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-firmado-'));
  process.env.VACACIONES_CHILE_PDF_PATH = dir;
  process.env.VACACIONES_PDF_MAX_BYTES = '10485760';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('wsCargarComprobanteFirmadoChile — servicio', () => {
  test('carga correcta: reemplaza el PDF en la misma ruta, sin .bak ni temporales', async () => {
    const comp = crearComprobante();
    const repo = crearRepo({ comprobante: comp });
    const { conn, deps } = crearDeps(repo);

    const r = await service.cargarFirmado(entrada(), deps);

    expect(r).toEqual({
      ok: true,
      idSolicitud: 3459,
      idComprobante: 123,
      estadoDocumento: 'PENDIENTE_RECEPCION',
      tipoArchivo: 'FIRMADO',
      urlPublica: comp.URL_PUBLICA,
      fechaCarga: '2026-10-06T15:30:00.000Z'
    });
    expect(JSON.stringify(r)).not.toContain(dir.replace(/\\/g, '\\\\'));
    expect(contenido().equals(FIRMADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);

    expect(repo.registrarCargaFirmado).toHaveBeenCalledWith(conn, 123, {
      hash: sha(FIRMADO), tamanio: FIRMADO.length, ciUsuario: '20.680.428-9'
    });
    expect(repo.estado.comp.HASH_ARCHIVO_GENERADO).toBe(sha(GENERADO));
    expect(repo.estado.comp.VERSION_ARCHIVO).toBe(2);
    expect(repo.insertarNotificacion).toHaveBeenCalledWith(conn, 3459, expect.stringMatching(/N\.º 3459.*cargado/));
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test('acepta el RUT con o sin puntos y guion', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { deps } = crearDeps(repo);
    await expect(service.cargarFirmado(entrada({ ciSolicitante: '206804289' }), deps))
      .resolves.toMatchObject({ ok: true });
  });

  test.each([
    ['contenido que no es PDF', archivoPdf(Buffer.from('MZ ejecutable disfrazado'))],
    ['Content-Type distinto de application/pdf', archivoPdf(FIRMADO, { mimetype: 'text/plain' })],
    ['extensión .pdf con contenido HTML', archivoPdf(Buffer.from('<html>%PDF-</html>'), { originalname: 'x.pdf' })]
  ])('archivo que no es PDF (%s) → 415 sin tocar Oracle ni disco', async (_, archivo) => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { db, deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada({ archivo }), deps))
      .rejects.toMatchObject({ httpStatus: 415, code: 'ARCHIVO_NO_PDF' });
    expect(db.getConnection).not.toHaveBeenCalled();
    expect(contenido().equals(GENERADO)).toBe(true);
  });

  test('archivo superior al máximo configurado → 413', async () => {
    process.env.VACACIONES_PDF_MAX_BYTES = '20';
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { db, deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 413, code: 'ARCHIVO_DEMASIADO_GRANDE' });
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('usuario que no es propietario → 403 y el archivo no cambia', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { conn, deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada({ ciSolicitante: '11.111.111-1' }), deps))
      .rejects.toMatchObject({ httpStatus: 403, code: 'NO_PROPIETARIO' });
    expect(repo.obtenerComprobante).not.toHaveBeenCalled();
    expect(contenido().equals(GENERADO)).toBe(true);
    expect(conn.close).toHaveBeenCalled();
  });

  test('solicitud inexistente → 404', async () => {
    const repo = crearRepo({ solicitud: null });
    const { deps } = crearDeps(repo);
    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 404, code: 'SOLICITUD_NO_EXISTE' });
  });

  test('solicitud sin comprobante → 404 y no escribe nada', async () => {
    const repo = crearRepo();
    const { deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 404, code: 'COMPROBANTE_NO_EXISTE' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('carga duplicada (ya PENDIENTE_RECEPCION) → 409 y conserva el firmado anterior', async () => {
    const comp = crearComprobante({ ESTADO_DOCUMENTO: 'PENDIENTE_RECEPCION', TIPO_ARCHIVO_ACTUAL: 'FIRMADO', VERSION_ARCHIVO: 2 });
    const repo = crearRepo({ comprobante: comp });
    const { deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada({ archivo: archivoPdf(Buffer.from('%PDF-1.7 segundo intento')) }), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ESTADO_NO_PERMITE_CARGA' });
    expect(repo.registrarCargaFirmado).not.toHaveBeenCalled();
    expect(contenido().equals(GENERADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);
  });

  test('segunda carga sobre el mismo comprobante falla tras la primera exitosa', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { deps } = crearDeps(repo);

    await service.cargarFirmado(entrada(), deps);
    await expect(service.cargarFirmado(entrada({ archivo: archivoPdf(Buffer.from('%PDF-1.7 otro')) }), deps))
      .rejects.toMatchObject({ code: 'ESTADO_NO_PERMITE_CARGA' });
    expect(contenido().equals(FIRMADO)).toBe(true);
  });

  test('reemplazo después de rechazo: acepta nueva versión en la misma ruta y URL', async () => {
    const firmadoRechazado = Buffer.from('%PDF-1.7 firmado rechazado por Nómina');
    const comp = crearComprobante({
      ESTADO_DOCUMENTO: 'RECHAZADO', TIPO_ARCHIVO_ACTUAL: 'FIRMADO', VERSION_ARCHIVO: 2,
      HASH_ARCHIVO_FIRMADO: sha(firmadoRechazado)
    });
    fs.writeFileSync(comp.RUTA_FISICA, firmadoRechazado);
    const repo = crearRepo({ comprobante: comp });
    const { deps } = crearDeps(repo);

    const r = await service.cargarFirmado(entrada(), deps);

    expect(r).toMatchObject({ ok: true, estadoDocumento: 'PENDIENTE_RECEPCION', urlPublica: comp.URL_PUBLICA });
    expect(contenido().equals(FIRMADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);
    expect(repo.estado.comp.VERSION_ARCHIVO).toBe(3);
    expect(repo.estado.comp.HASH_ARCHIVO_FIRMADO).toBe(sha(FIRMADO));
    expect(repo.estado.comp.HASH_ARCHIVO_GENERADO).toBe(sha(GENERADO));
  });

  test('error de disco al mover el firmado → 500, restaura el original y no toca Oracle', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { conn, deps } = crearDeps(repo);
    const renameReal = fs.promises.rename;
    jest.spyOn(fs.promises, 'rename').mockImplementation(async (origen, destino) => {
      if (origen.endsWith('.upload.tmp')) throw Object.assign(new Error('ENOSPC: disco lleno'), { code: 'ENOSPC' });
      return renameReal(origen, destino);
    });

    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 500, code: 'ERROR_DISCO' });
    expect(contenido().equals(GENERADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);
    expect(repo.registrarCargaFirmado).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalled();
  });

  test('error de disco al escribir el temporal → 500 y el original intacto', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    const { deps } = crearDeps(repo);
    jest.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('EACCES'));

    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ code: 'ERROR_DISCO' });
    expect(contenido().equals(GENERADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);
  });

  test('error de Oracle → rollback y restauración del PDF original desde el .bak', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    repo.registrarCargaFirmado.mockRejectedValue(Object.assign(new Error('ORA-03113: end-of-file'), { errorNum: 3113 }));
    const { conn, deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada(), deps)).rejects.toMatchObject({ errorNum: 3113 });
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
    expect(contenido().equals(GENERADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);
  });

  test('error al registrar la notificación también restaura el original', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    repo.insertarNotificacion.mockRejectedValue(new Error('ORA-01400'));
    const { conn, deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada(), deps)).rejects.toThrow('ORA-01400');
    expect(conn.commit).not.toHaveBeenCalled();
    expect(contenido().equals(GENERADO)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([NOMBRE]);
  });

  test('estado cambiado por otra transacción (0 filas) → 409 y restaura', async () => {
    const repo = crearRepo({ comprobante: crearComprobante() });
    repo.registrarCargaFirmado.mockRejectedValue(Object.assign(new Error('cambió'), { code: 'ESTADO_CONCURRENTE' }));
    const { deps } = crearDeps(repo);

    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ESTADO_NO_PERMITE_CARGA' });
    expect(contenido().equals(GENERADO)).toBe(true);
  });

  test('rechaza una RUTA_FISICA fuera de la carpeta configurada', async () => {
    const repo = crearRepo({ comprobante: crearComprobante({ RUTA_FISICA: path.join(os.tmpdir(), 'otro.pdf') }) });
    const { deps } = crearDeps(repo);
    await expect(service.cargarFirmado(entrada(), deps))
      .rejects.toMatchObject({ code: 'RUTA_INVALIDA' });
  });

  test('sanitiza el nombre recibido', () => {
    expect(service.sanitizarNombre('..\\..\\Windows/system32/<script>fírma.pdf')).toBe('_script_firma.pdf');
    expect(service.sanitizarNombre('../../.env')).toBe('env');
    expect(service.sanitizarNombre('')).toBe('archivo.pdf');
    expect(service.sanitizarNombre('a'.repeat(300) + '.pdf')).toHaveLength(100);
  });
});

describe('wsCargarComprobanteFirmadoChile — repositorio Oracle', () => {
  test('UPDATE conserva el hash generado y la ruta, y limpia la recepción anterior', async () => {
    const fecha = new Date();
    const conn = { execute: jest.fn().mockResolvedValue({ rowsAffected: 1, outBinds: { version: [2], fechaCarga: [fecha] } }) };

    const r = await realRepo.registrarCargaFirmado(conn, 123, { hash: 'a'.repeat(64), tamanio: 99, ciUsuario: '1-9' });

    expect(r).toEqual({ version: 2, fechaCarga: fecha });
    const [sql, binds, opts] = conn.execute.mock.calls[0];
    expect(sql).toMatch(/TIPO_ARCHIVO_ACTUAL = 'FIRMADO'/);
    expect(sql).toMatch(/ESTADO_DOCUMENTO = 'PENDIENTE_RECEPCION'/);
    expect(sql).toMatch(/VERSION_ARCHIVO = VERSION_ARCHIVO \+ 1/);
    expect(sql).toMatch(/HASH_ARCHIVO_FIRMADO = :hash/);
    expect(sql).toMatch(/TAMANIO_FIRMADO = :tamanio/);
    expect(sql).toMatch(/CI_USUARIO_CARGA = :ciUsuario/);
    expect(sql).toMatch(/FECHA_CARGA_FIRMADO = SYSDATE/);
    expect(sql).toMatch(/CI_RRHH_RECEPCION = NULL[\s\S]*FECHA_RECEPCION = NULL[\s\S]*OBSERVACION_RECEPCION = NULL/);
    expect(sql).toMatch(/ESTADO_DOCUMENTO IN \('PENDIENTE_FIRMA', 'RECHAZADO'\)/);
    expect(sql).not.toMatch(/HASH_ARCHIVO_GENERADO|RUTA_FISICA|URL_PUBLICA|NOMBRE_ARCHIVO/);
    expect(binds).toMatchObject({ idComprobante: 123, hash: 'a'.repeat(64), tamanio: 99, ciUsuario: '1-9' });
    expect(opts.autoCommit).toBe(false);
  });

  test('0 filas actualizadas → ESTADO_CONCURRENTE', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({ rowsAffected: 0, outBinds: {} }) };
    await expect(realRepo.registrarCargaFirmado(conn, 1, { hash: 'x', tamanio: 1, ciUsuario: '1' }))
      .rejects.toMatchObject({ code: 'ESTADO_CONCURRENTE' });
  });
});

describe('wsCargarComprobanteFirmadoChile — HTTP multipart', () => {
  let server;
  let url;

  beforeAll(async () => {
    const app = express();
    app.use('/api', require('../src/routes/vacacionesChileRoutes'));
    await new Promise(resolve => { server = app.listen(0, resolve); });
    url = `http://localhost:${server.address().port}/api/wsCargarComprobanteFirmadoChile`;
  });

  afterAll(() => new Promise(resolve => server.close(resolve)));

  const form = (archivos = [['archivo', FIRMADO]], campos = { id_solicitud: '3459', ci_solicitante: '20.680.428-9' }) => {
    const fd = new FormData();
    Object.entries(campos).forEach(([k, v]) => fd.append(k, v));
    archivos.forEach(([campo, buf]) => fd.append(campo, new Blob([buf], { type: 'application/pdf' }), 'firmado.pdf'));
    return fd;
  };

  test('archivo superior al máximo → 413 (corta multer antes del servicio)', async () => {
    process.env.VACACIONES_PDF_MAX_BYTES = '1024';
    const res = await fetch(url, { method: 'POST', body: form([['archivo', Buffer.alloc(2048, 0x25)]]) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('ARCHIVO_DEMASIADO_GRANDE');
  });

  test('más de un archivo → 400 ARCHIVO_UNICO', async () => {
    const res = await fetch(url, { method: 'POST', body: form([['archivo', FIRMADO], ['archivo', FIRMADO]]) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ARCHIVO_UNICO');
  });

  test('sin archivo → 400 ARCHIVO_REQUERIDO', async () => {
    const res = await fetch(url, { method: 'POST', body: form([]) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ARCHIVO_REQUERIDO');
  });

  test('sin ci_solicitante → 400', async () => {
    const res = await fetch(url, { method: 'POST', body: form(undefined, { id_solicitud: '3459' }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('MISSING_FIELD');
  });
});
