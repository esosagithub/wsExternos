const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const service = require('../src/services/recepcionComprobanteChileService');
const realRepo = require('../src/repositories/comprobanteVacacionesRepository');
const controller = require('../src/controllers/vacacionesChileController');

const FIRMADO = Buffer.from('%PDF-1.7 comprobante firmado por el colaborador');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const CI_NOMINA = '17.144.000-1';
const FECHA = new Date('2026-10-07T13:45:00.000Z');
let dir;
let ruta;

// Repositorio en memoria con UPDATE condicional y rollback por conexión
function crearAmbiente({ comprobante = {}, permiso = true } = {}) {
  const estado = {
    comp: comprobante === null ? null : {
      ID_COMPROBANTE: 123,
      ID_SOLICITUD: 3459,
      RUTA_FISICA: ruta,
      TIPO_ARCHIVO_ACTUAL: 'FIRMADO',
      ESTADO_DOCUMENTO: 'PENDIENTE_RECEPCION',
      HASH_ARCHIVO_FIRMADO: sha(FIRMADO),
      CI_RRHH_RECEPCION: null,
      FECHA_RECEPCION: null,
      OBSERVACION_RECEPCION: null,
      ...comprobante
    },
    notificaciones: []
  };
  const pendientes = new Map(); // conn → { respaldo, notificaciones }

  const crearConn = () => {
    const conn = {
      commit: jest.fn(async () => { pendientes.delete(conn); }),
      rollback: jest.fn(async () => {
        const p = pendientes.get(conn);
        if (p) {
          if (p.respaldo) Object.assign(estado.comp, p.respaldo);
          estado.notificaciones = estado.notificaciones.filter(n => !p.notificaciones.includes(n));
        }
        pendientes.delete(conn);
      }),
      close: jest.fn().mockResolvedValue()
    };
    pendientes.set(conn, { respaldo: null, notificaciones: [] });
    return conn;
  };

  const repo = {
    tienePermisoNominaChile: jest.fn().mockResolvedValue(permiso),
    obtenerComprobantePorId: jest.fn(async () => {
      await new Promise(r => setImmediate(r)); // permite intercalar llamadas concurrentes
      return estado.comp ? { ...estado.comp } : null;
    }),
    registrarRecepcion: jest.fn(async (conn, id, d) => {
      await new Promise(r => setImmediate(r));
      if (estado.comp.ESTADO_DOCUMENTO !== 'PENDIENTE_RECEPCION') {
        throw Object.assign(new Error('El comprobante ya no está pendiente de recepción'), { code: 'ESTADO_CONCURRENTE' });
      }
      const p = pendientes.get(conn);
      p.respaldo = { ESTADO_DOCUMENTO: estado.comp.ESTADO_DOCUMENTO, CI_RRHH_RECEPCION: null, FECHA_RECEPCION: null, OBSERVACION_RECEPCION: null };
      Object.assign(estado.comp, {
        ESTADO_DOCUMENTO: d.estado, CI_RRHH_RECEPCION: d.ciRrhh, FECHA_RECEPCION: FECHA, OBSERVACION_RECEPCION: d.observacion
      });
      return { fechaRecepcion: FECHA };
    }),
    insertarNotificacion: jest.fn(async (conn, id, texto) => {
      const n = { id, texto };
      estado.notificaciones.push(n);
      pendientes.get(conn).notificaciones.push(n);
    })
  };
  const db = { getConnection: jest.fn(async () => crearConn()) };
  return { estado, repo, db, deps: { db, repo, fs } };
}

const entrada = (extra = {}) => ({
  idSolicitud: 3459, idComprobante: 123, ciRrhh: CI_NOMINA, accion: 'RECIBIR', observacion: null, ...extra
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-recepcion-'));
  ruta = path.join(dir, 'comprobante_vacaciones_3459_x.pdf');
  fs.writeFileSync(ruta, FIRMADO);
  process.env.VACACIONES_CHILE_PDF_PATH = dir;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('wsConfirmarRecepcionComprobanteChile — flujo', () => {
  test('RECIBIR: estado RECIBIDO, datos de recepción, notificación y commit', async () => {
    const { estado, deps, db } = crearAmbiente();

    const r = await service.confirmarRecepcion(entrada({ observacion: '  Recibido conforme  ' }), deps);

    expect(r).toEqual({
      ok: true, idSolicitud: 3459, estadoDocumento: 'RECIBIDO',
      fechaRecepcion: '2026-10-07T13:45:00.000Z', ciRrhhRecepcion: CI_NOMINA
    });
    expect(estado.comp).toMatchObject({
      ESTADO_DOCUMENTO: 'RECIBIDO', CI_RRHH_RECEPCION: CI_NOMINA, OBSERVACION_RECEPCION: 'Recibido conforme'
    });
    expect(estado.notificaciones).toEqual([{
      id: 3459, texto: 'Nómina confirmó la recepción de su comprobante de vacaciones firmado de la solicitud N.º 3459.'
    }]);
    const conn = await db.getConnection.mock.results[0].value;
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain(dir.replace(/\\/g, '\\\\'));
  });

  test('RECIBIR sin observación: guarda null', async () => {
    const { estado, deps } = crearAmbiente();
    await service.confirmarRecepcion(entrada(), deps);
    expect(estado.comp.OBSERVACION_RECEPCION).toBeNull();
  });

  test('RECHAZAR con motivo: estado RECHAZADO y notificación con el motivo y nueva carga', async () => {
    const { estado, deps } = crearAmbiente();

    const r = await service.confirmarRecepcion(entrada({ accion: 'rechazar', observacion: 'Falta la firma en la página 1' }), deps);

    expect(r.estadoDocumento).toBe('RECHAZADO');
    expect(estado.comp).toMatchObject({ ESTADO_DOCUMENTO: 'RECHAZADO', OBSERVACION_RECEPCION: 'Falta la firma en la página 1' });
    expect(estado.notificaciones[0].texto).toBe(
      'Nómina rechazó su comprobante de vacaciones firmado de la solicitud N.º 3459. ' +
      'Motivo: Falta la firma en la página 1. Debe cargar nuevamente el comprobante firmado.');
  });

  test.each([null, '', '   '])('rechazo sin observación (%j) → 400 sin abrir conexión', async (observacion) => {
    const { db, deps } = crearAmbiente();
    await expect(service.confirmarRecepcion(entrada({ accion: 'RECHAZAR', observacion }), deps))
      .rejects.toMatchObject({ httpStatus: 400, code: 'OBSERVACION_REQUERIDA' });
    expect(db.getConnection).not.toHaveBeenCalled();
  });

  test('motivo de 1000 caracteres con tildes: completo en Oracle, notificación ≤ 500 bytes', async () => {
    const motivo = 'Revisión: firma ilegible y sin fecha. '.repeat(30).slice(0, 950); // ~990 bytes
    const { estado, deps } = crearAmbiente();

    await service.confirmarRecepcion(entrada({ accion: 'RECHAZAR', observacion: motivo }), deps);

    expect(estado.comp.OBSERVACION_RECEPCION).toBe(motivo.trim());
    const texto = estado.notificaciones[0].texto;
    expect(Buffer.byteLength(texto, 'utf8')).toBeLessThanOrEqual(service.MAX_BYTES_NOTIFICACION);
    expect(texto).toMatch(/^Nómina rechazó .* Motivo: Revisión: firma ilegible.*…\. Debe cargar nuevamente el comprobante firmado\.$/);
  });
});

describe('wsConfirmarRecepcionComprobanteChile — validaciones', () => {
  test('usuario sin permiso de Nómina → 403 sin consultar el comprobante', async () => {
    const { repo, estado, deps } = crearAmbiente({ permiso: false });
    await expect(service.confirmarRecepcion(entrada({ ciRrhh: '20.680.428-9' }), deps))
      .rejects.toMatchObject({ httpStatus: 403, code: 'SIN_PERMISO_NOMINA' });
    expect(repo.obtenerComprobantePorId).not.toHaveBeenCalled();
    expect(estado.comp.ESTADO_DOCUMENTO).toBe('PENDIENTE_RECEPCION');
  });

  test('comprobante inexistente → 404', async () => {
    const { deps } = crearAmbiente({ comprobante: null });
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 404, code: 'COMPROBANTE_NO_EXISTE' });
  });

  test('comprobante de otra solicitud → 409', async () => {
    const { repo, deps } = crearAmbiente({ comprobante: { ID_SOLICITUD: 9999 } });
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'COMPROBANTE_NO_PERTENECE' });
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
  });

  test('archivo todavía GENERADO (no firmado) → 409', async () => {
    const { deps } = crearAmbiente({ comprobante: { TIPO_ARCHIVO_ACTUAL: 'GENERADO', ESTADO_DOCUMENTO: 'PENDIENTE_FIRMA' } });
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'COMPROBANTE_NO_FIRMADO' });
  });

  test.each(['RECIBIDO', 'RECHAZADO'])('doble confirmación (ya %s) → 409 sin actualizar', async (ya) => {
    const { repo, estado, deps } = crearAmbiente({ comprobante: { ESTADO_DOCUMENTO: ya } });
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ESTADO_NO_PERMITE_RECEPCION' });
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
    expect(estado.notificaciones).toHaveLength(0);
  });

  test('archivo inexistente → 409 ARCHIVO_NO_DISPONIBLE sin actualizar', async () => {
    fs.unlinkSync(ruta);
    const { repo, deps } = crearAmbiente();
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ARCHIVO_NO_DISPONIBLE' });
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
  });

  test('hash diferente (archivo alterado) → 409 ARCHIVO_HASH_INVALIDO sin actualizar', async () => {
    fs.writeFileSync(ruta, Buffer.from('%PDF-1.7 archivo reemplazado fuera del sistema'));
    const { repo, estado, deps } = crearAmbiente();
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ARCHIVO_HASH_INVALIDO' });
    expect(repo.registrarRecepcion).not.toHaveBeenCalled();
    expect(estado.comp.ESTADO_DOCUMENTO).toBe('PENDIENTE_RECEPCION');
  });

  test('HASH_ARCHIVO_FIRMADO nulo → 409', async () => {
    const { deps } = crearAmbiente({ comprobante: { HASH_ARCHIVO_FIRMADO: null } });
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ code: 'ARCHIVO_HASH_INVALIDO' });
  });

  test('RUTA_FISICA fuera de la carpeta configurada → 500', async () => {
    const { deps } = crearAmbiente({ comprobante: { RUTA_FISICA: path.join(os.tmpdir(), 'otro.pdf') } });
    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ code: 'RUTA_INVALIDA' });
  });
});

describe('wsConfirmarRecepcionComprobanteChile — concurrencia y transacción', () => {
  test('dos confirmaciones simultáneas: una 200 y otra 409, una sola notificación', async () => {
    const { estado, deps } = crearAmbiente();

    const resultados = await Promise.allSettled([
      service.confirmarRecepcion(entrada({ accion: 'RECIBIR' }), deps),
      service.confirmarRecepcion(entrada({ accion: 'RECHAZAR', observacion: 'Firma no coincide', ciRrhh: '9.999.999-9' }), deps)
    ]);

    const ok = resultados.filter(x => x.status === 'fulfilled');
    const fallidos = resultados.filter(x => x.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(fallidos).toHaveLength(1);
    expect(fallidos[0].reason).toMatchObject({ httpStatus: 409, code: 'ESTADO_NO_PERMITE_RECEPCION' });
    expect(estado.notificaciones).toHaveLength(1);
    expect(estado.comp.ESTADO_DOCUMENTO).toBe(ok[0].value.estadoDocumento);
    expect(estado.comp.CI_RRHH_RECEPCION).toBe(ok[0].value.ciRrhhRecepcion);
  });

  test('UPDATE con 0 filas (ESTADO_CONCURRENTE) → 409, rollback y sin notificación', async () => {
    const { repo, estado, deps, db } = crearAmbiente();
    repo.registrarRecepcion.mockRejectedValue(Object.assign(new Error('ya no pendiente'), { code: 'ESTADO_CONCURRENTE' }));

    await expect(service.confirmarRecepcion(entrada(), deps))
      .rejects.toMatchObject({ httpStatus: 409, code: 'ESTADO_NO_PERMITE_RECEPCION' });
    expect(estado.notificaciones).toHaveLength(0);
    const conn = await db.getConnection.mock.results[0].value;
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  });

  test('falla la notificación → rollback y el estado vuelve a PENDIENTE_RECEPCION', async () => {
    const { repo, estado, deps, db } = crearAmbiente();
    repo.insertarNotificacion.mockRejectedValue(new Error('ORA-12899: valor demasiado grande'));

    await expect(service.confirmarRecepcion(entrada(), deps)).rejects.toThrow('ORA-12899');
    expect(estado.comp.ESTADO_DOCUMENTO).toBe('PENDIENTE_RECEPCION');
    expect(estado.comp.CI_RRHH_RECEPCION).toBeNull();
    const conn = await db.getConnection.mock.results[0].value;
    expect(conn.commit).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledTimes(1);
  });
});

describe('wsConfirmarRecepcionComprobanteChile — repositorio Oracle', () => {
  test('UPDATE condicional sobre PENDIENTE_RECEPCION con RETURNING', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({ rowsAffected: 1, outBinds: { fechaRecepcion: [FECHA] } }) };

    const r = await realRepo.registrarRecepcion(conn, 123, { estado: 'RECHAZADO', ciRrhh: CI_NOMINA, observacion: 'motivo' });

    expect(r).toEqual({ fechaRecepcion: FECHA });
    const [sql, binds, opts] = conn.execute.mock.calls[0];
    expect(sql).toMatch(/WHERE ID_COMPROBANTE = :idComprobante\s+AND ESTADO_DOCUMENTO = 'PENDIENTE_RECEPCION'/);
    expect(sql).toMatch(/ESTADO_DOCUMENTO = :estado/);
    expect(sql).toMatch(/CI_RRHH_RECEPCION = :ciRrhh/);
    expect(sql).toMatch(/FECHA_RECEPCION = SYSDATE/);
    expect(sql).toMatch(/OBSERVACION_RECEPCION = :observacion/);
    expect(sql).toMatch(/RETURNING FECHA_RECEPCION INTO :fechaRecepcion/);
    expect(binds).toMatchObject({ idComprobante: 123, estado: 'RECHAZADO', ciRrhh: CI_NOMINA });
    expect(binds.observacion.val).toBe('motivo');
    expect(opts.autoCommit).toBe(false);
  });

  test('rowsAffected 0 → ESTADO_CONCURRENTE', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({ rowsAffected: 0, outBinds: {} }) };
    await expect(realRepo.registrarRecepcion(conn, 123, { estado: 'RECIBIDO', ciRrhh: 'x' }))
      .rejects.toMatchObject({ code: 'ESTADO_CONCURRENTE' });
  });

  test('obtenerComprobantePorId bloquea la fila con FOR UPDATE', async () => {
    const conn = { execute: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(realRepo.obtenerComprobantePorId(conn, 123)).resolves.toBeNull();
    expect(conn.execute.mock.calls[0][0]).toMatch(/WHERE ID_COMPROBANTE = :idComprobante\s+FOR UPDATE/);
  });
});

describe('wsConfirmarRecepcionComprobanteChile — controlador', () => {
  const llamar = async (body) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await controller.confirmarRecepcion({ body }, res);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  };
  const base = { id_solicitud: 3459, id_comprobante: 123, ci_rrhh: CI_NOMINA, accion: 'RECIBIR' };

  test.each([
    [{ ...base, accion: 'APROBAR' }, 'INVALID_FIELD'],
    [{ ...base, id_comprobante: 'x' }, 'INVALID_FIELD'],
    [{ ...base, id_comprobante: undefined }, 'MISSING_FIELD'],
    [{ ...base, observacion: 'a'.repeat(1001) }, 'INVALID_FIELD'],
    [{ ...base, observacion: 'é'.repeat(501) }, 'INVALID_FIELD'],
    [{ ...base, observacion: 123 }, 'INVALID_FIELD'],
    [{ ...base, ci_rrhh: undefined }, 'MISSING_FIELD']
  ])('entrada inválida %# → 400 %s', async (body, code) => {
    const r = await llamar(body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(code);
  });
});
