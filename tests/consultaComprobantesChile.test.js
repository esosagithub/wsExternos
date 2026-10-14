const fs = require('fs');
const os = require('os');
const path = require('path');

const service = require('../src/services/consultaComprobantesChileService');
const realRepo = require('../src/repositories/comprobanteVacacionesRepository');
const { validarConsulta } = require('../src/controllers/vacacionesChileController');

const PUBLIC_URL = 'https://ns.aseyco.com:444/nomina/Chile';
const RUT_COLAB = '20.680.428-9';
const RUT_NOMINA = '17.144.000-1';
let dir;

function fila(extra = {}) {
  return {
    ID_SOLICITUD: 3459,
    ID_COMPROBANTE: 123,
    NOMBRE_SOLICITANTE: 'SILVA BARRIA ANTONIA BELEN',
    CI_SOLICITANTE: RUT_COLAB,
    ESTADO_DOCUMENTO: 'PENDIENTE_RECEPCION',
    TIPO_ARCHIVO_ACTUAL: 'FIRMADO',
    FECHA_GENERACION: new Date('2026-10-05T14:00:00.000Z'),
    FECHA_CARGA_FIRMADO: new Date('2026-10-06T15:30:00.000Z'),
    NOMBRE_ARCHIVO: 'comprobante_vacaciones_3459_x.pdf',
    URL_PUBLICA: `${PUBLIC_URL}/comprobante_vacaciones_3459_x.pdf`,
    TOTAL_REGISTROS: 1,
    ...extra
  };
}

function crearDeps({ esNomina = false, filas = [fila()], fsMod = fs } = {}) {
  const conn = { close: jest.fn().mockResolvedValue() };
  const repo = {
    tienePermisoNominaChile: jest.fn().mockResolvedValue(esNomina),
    buscarComprobantesChile: jest.fn().mockResolvedValue(filas)
  };
  return { conn, repo, deps: { db: { getConnection: jest.fn().mockResolvedValue(conn) }, repo, fs: fsMod } };
}

const params = (extra = {}) => ({
  ciUsuario: RUT_COLAB, idSolicitud: null, ciSolicitante: null, estadoDocumento: null,
  pendientesNomina: false, verificarArchivo: true, limite: 100, pagina: 1, ...extra
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-consulta-'));
  process.env.VACACIONES_CHILE_PDF_PATH = dir;
  fs.writeFileSync(path.join(dir, 'comprobante_vacaciones_3459_x.pdf'), '%PDF-1.7');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('wsObtenerComprobantesVacacionesChile — autorización', () => {
  test('colaborador sin filtro: solo consulta su propio RUT', async () => {
    const { repo, conn, deps } = crearDeps();

    const r = await service.obtenerComprobantes(params(), deps);

    expect(repo.tienePermisoNominaChile).toHaveBeenCalledWith(conn, RUT_COLAB);
    expect(repo.buscarComprobantesChile).toHaveBeenCalledWith(conn,
      { idSolicitud: null, ciNorm: '206804289', estado: null, offset: 0, limite: 100 });
    expect(r.ok).toBe(true);
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test('colaborador con su propio RUT en otro formato → permitido', async () => {
    const { repo, deps } = crearDeps();
    await service.obtenerComprobantes(params({ ciSolicitante: '206804289' }), deps);
    expect(repo.buscarComprobantesChile.mock.calls[0][1].ciNorm).toBe('206804289');
  });

  test('colaborador que pide solicitudes de otro → 403 sin consultar', async () => {
    const { repo, conn, deps } = crearDeps();

    await expect(service.obtenerComprobantes(params({ ciSolicitante: '11.111.111-1' }), deps))
      .rejects.toMatchObject({ httpStatus: 403, code: 'NO_PROPIETARIO' });
    expect(repo.buscarComprobantesChile).not.toHaveBeenCalled();
    expect(conn.close).toHaveBeenCalledTimes(1);
  });

  test('colaborador con pendientes_nomina → 403 SOLO_NOMINA', async () => {
    const { repo, deps } = crearDeps();
    await expect(service.obtenerComprobantes(params({ pendientesNomina: true }), deps))
      .rejects.toMatchObject({ httpStatus: 403, code: 'SOLO_NOMINA' });
    expect(repo.buscarComprobantesChile).not.toHaveBeenCalled();
  });

  test('Nómina sin filtros: consulta todas las solicitudes de Chile', async () => {
    const { repo, deps } = crearDeps({ esNomina: true });
    await service.obtenerComprobantes(params({ ciUsuario: RUT_NOMINA }), deps);
    expect(repo.buscarComprobantesChile.mock.calls[0][1]).toMatchObject({ ciNorm: null, estado: null });
  });

  test('Nómina filtrando por colaborador y estado', async () => {
    const { repo, deps } = crearDeps({ esNomina: true });
    await service.obtenerComprobantes(params({
      ciUsuario: RUT_NOMINA, ciSolicitante: RUT_COLAB, estadoDocumento: 'RECHAZADO', idSolicitud: 3459
    }), deps);
    expect(repo.buscarComprobantesChile.mock.calls[0][1])
      .toMatchObject({ idSolicitud: 3459, ciNorm: '206804289', estado: 'RECHAZADO' });
  });

  test('Nómina con pendientes_nomina: solo PENDIENTE_RECEPCION', async () => {
    const { repo, deps } = crearDeps({ esNomina: true });
    await service.obtenerComprobantes(params({ ciUsuario: RUT_NOMINA, pendientesNomina: true }), deps);
    expect(repo.buscarComprobantesChile.mock.calls[0][1].estado).toBe('PENDIENTE_RECEPCION');
  });

  test('pendientes_nomina con otro estado → 400 sin abrir conexión', async () => {
    const { deps } = crearDeps({ esNomina: true });
    await expect(service.obtenerComprobantes(params({ pendientesNomina: true, estadoDocumento: 'RECIBIDO' }), deps))
      .rejects.toMatchObject({ httpStatus: 400, code: 'FILTROS_INCOMPATIBLES' });
    expect(deps.db.getConnection).not.toHaveBeenCalled();
  });

  test('cierra la conexión si la consulta falla', async () => {
    const { repo, conn, deps } = crearDeps();
    repo.buscarComprobantesChile.mockRejectedValue(new Error('ORA-00942'));
    await expect(service.obtenerComprobantes(params(), deps)).rejects.toThrow('ORA-00942');
    expect(conn.close).toHaveBeenCalledTimes(1);
  });
});

describe('wsObtenerComprobantesVacacionesChile — respuesta y archivos', () => {
  test('archivo existente: urlPublica y archivoDisponible true, sin RUTA_FISICA', async () => {
    const { deps } = crearDeps();

    const r = await service.obtenerComprobantes(params(), deps);

    expect(r).toEqual({
      ok: true,
      data: [{
        idSolicitud: 3459,
        idComprobante: 123,
        nombreSolicitante: 'SILVA BARRIA ANTONIA BELEN',
        ciSolicitante: RUT_COLAB,
        estadoDocumento: 'PENDIENTE_RECEPCION',
        tipoArchivoActual: 'FIRMADO',
        fechaGeneracion: '2026-10-05T14:00:00.000Z',
        fechaCargaFirmado: '2026-10-06T15:30:00.000Z',
        urlPublica: `${PUBLIC_URL}/comprobante_vacaciones_3459_x.pdf`,
        archivoDisponible: true
      }],
      paginacion: { pagina: 1, limite: 100, total: 1 }
    });
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/RUTA_FISICA|rutaFisica/);
    expect(json).not.toContain(dir.replace(/\\/g, '\\\\'));
  });

  test('archivo inexistente: urlPublica null y archivoDisponible false', async () => {
    const { deps } = crearDeps({ filas: [fila({ NOMBRE_ARCHIVO: 'no_existe.pdf', URL_PUBLICA: `${PUBLIC_URL}/no_existe.pdf` })] });
    const r = await service.obtenerComprobantes(params(), deps);
    expect(r.data[0]).toMatchObject({ urlPublica: null, archivoDisponible: false });
  });

  test('solicitud de Chile sin comprobante: campos del comprobante en null', async () => {
    const { deps } = crearDeps({
      filas: [fila({
        ID_COMPROBANTE: null, ESTADO_DOCUMENTO: null, TIPO_ARCHIVO_ACTUAL: null, FECHA_GENERACION: null,
        FECHA_CARGA_FIRMADO: null, NOMBRE_ARCHIVO: null, URL_PUBLICA: null
      })]
    });
    const r = await service.obtenerComprobantes(params(), deps);
    expect(r.data[0]).toMatchObject({
      idSolicitud: 3459, idComprobante: null, estadoDocumento: null, fechaGeneracion: null,
      urlPublica: null, archivoDisponible: false
    });
  });

  test('NOMBRE_ARCHIVO con ruta relativa no sale de la carpeta configurada', async () => {
    const { deps } = crearDeps({ filas: [fila({ NOMBRE_ARCHIVO: `..${path.sep}..${path.sep}comprobante_vacaciones_3459_x.pdf` })] });
    const spy = jest.spyOn(fs.promises, 'access');
    await service.obtenerComprobantes(params(), deps);
    expect(path.dirname(spy.mock.calls[0][0])).toBe(dir);
  });

  test('verificar_archivo false: no accede al disco y archivoDisponible null', async () => {
    const spy = jest.spyOn(fs.promises, 'access');
    const { deps } = crearDeps();
    const r = await service.obtenerComprobantes(params({ verificarArchivo: false }), deps);
    expect(spy).not.toHaveBeenCalled();
    expect(r.data[0]).toMatchObject({ archivoDisponible: null, urlPublica: `${PUBLIC_URL}/comprobante_vacaciones_3459_x.pdf` });
  });

  test('paginación: offset calculado y total desde COUNT(*) OVER', async () => {
    const { repo, deps } = crearDeps({ esNomina: true, filas: [fila({ TOTAL_REGISTROS: 57 })] });
    const r = await service.obtenerComprobantes(params({ ciUsuario: RUT_NOMINA, limite: 20, pagina: 3 }), deps);
    expect(repo.buscarComprobantesChile.mock.calls[0][1]).toMatchObject({ offset: 40, limite: 20 });
    expect(r.paginacion).toEqual({ pagina: 3, limite: 20, total: 57 });
  });

  test('sin resultados: data vacía y total 0', async () => {
    const { deps } = crearDeps({ filas: [] });
    const r = await service.obtenerComprobantes(params(), deps);
    expect(r).toEqual({ ok: true, data: [], paginacion: { pagina: 1, limite: 100, total: 0 } });
  });
});

describe('wsObtenerComprobantesVacacionesChile — SQL parametrizado', () => {
  const ejecutar = async (filtros) => {
    const conn = { execute: jest.fn().mockResolvedValue({ rows: [] }) };
    await realRepo.buscarComprobantesChile(conn, { offset: 0, limite: 100, ...filtros });
    return conn.execute.mock.calls[0];
  };

  test('el texto SQL es idéntico con cualquier combinación de filtros', async () => {
    const [sinFiltros] = await ejecutar({});
    const [conTodos] = await ejecutar({ idSolicitud: 3459, ciNorm: '206804289', estado: 'RECIBIDO' });
    const [inyeccion] = await ejecutar({ ciNorm: "' OR 1=1 --", estado: "X' UNION SELECT" });
    expect(conTodos).toBe(sinFiltros);
    expect(inyeccion).toBe(sinFiltros);
  });

  test('usa la vista, filtra Chile, ordena por fechas y pagina', async () => {
    const [sql, binds] = await ejecutar({ ciNorm: '206804289', offset: 40, limite: 20 });
    expect(sql).toMatch(/FROM OCACCESS\.VW_VACACIONES_COMP_CHILE v/);
    expect(sql).toMatch(/UPPER\(TRIM\(m\.PAIS\)\) IN \('CHILE', 'CL'\)/);
    expect(sql).toMatch(/ORDER BY NVL\(v\.FECHA_CARGA_FIRMADO, v\.FECHA_GENERACION\) DESC/);
    expect(sql).toMatch(/OFFSET :offset ROWS FETCH NEXT :limite ROWS ONLY/);
    expect(sql).not.toMatch(/RUTA_FISICA/);
    expect(binds.ciNorm.val).toBe('206804289');
    expect(binds.idSolicitud.val).toBeNull();
    expect(binds.offset.val).toBe(40);
    expect(binds.limite.val).toBe(20);
  });
});

describe('wsObtenerComprobantesVacacionesChile — validación de entrada', () => {
  test('entrada mínima: valores por defecto', () => {
    expect(validarConsulta({ ci_usuario: ' 1-9 ', id_solicitud: null, ci_solicitante: null, estado_documento: null, pendientes_nomina: false }))
      .toEqual({
        params: {
          ciUsuario: '1-9', idSolicitud: null, ciSolicitante: null, estadoDocumento: null,
          pendientesNomina: false, verificarArchivo: true, limite: 100, pagina: 1
        }
      });
  });

  test.each([
    [{}, 'MISSING_FIELD'],
    [{ ci_usuario: '1-9', id_solicitud: 'abc' }, 'INVALID_FIELD'],
    [{ ci_usuario: '1-9', estado_documento: 'BORRADO' }, 'INVALID_FIELD'],
    [{ ci_usuario: '1-9', pendientes_nomina: 'true' }, 'INVALID_FIELD'],
    [{ ci_usuario: '1-9', verificar_archivo: 1 }, 'INVALID_FIELD'],
    [{ ci_usuario: '1-9', pagina: 0 }, 'INVALID_FIELD']
  ])('entrada inválida %j → %s', (body, code) => {
    expect(validarConsulta(body).error.code).toBe(code);
  });

  test('límite máximo 1000 y estado en minúsculas aceptado', () => {
    const { params: p } = validarConsulta({ ci_usuario: '1-9', limite: 5000, estado_documento: 'pendiente_firma' });
    expect(p.limite).toBe(1000);
    expect(p.estadoDocumento).toBe('PENDIENTE_FIRMA');
  });
});
