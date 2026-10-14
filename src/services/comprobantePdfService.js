const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const COLOR_PRIMARIO = '#1F3A5F';
const COLOR_BANDA = '#E8EDF3';
const COLOR_TEXTO = '#222222';
const COLOR_SUAVE = '#666666';
const MARGEN = 50;

function errorEscritura(message, cause) {
  const err = new Error(message);
  err.code = 'COMPROBANTE_WRITE_ERROR';
  err.httpStatus = 500;
  err.cause = cause;
  return err;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtFecha(valor, conHora = false) {
  if (valor === null || valor === undefined || valor === '') return '-';
  if (valor instanceof Date) {
    const f = `${pad(valor.getDate())}/${pad(valor.getMonth() + 1)}/${valor.getFullYear()}`;
    return conHora ? `${f} ${pad(valor.getHours())}:${pad(valor.getMinutes())}` : f;
  }
  return String(valor);
}

function fmtValor(valor) {
  if (valor === null || valor === undefined || valor === '') return '-';
  return String(valor);
}

// Código de validación: SHA-256 de los datos canónicos de la solicitud + UUID del archivo.
// (El hash del archivo no puede imprimirse dentro del mismo archivo; ese se guarda en Oracle.)
function calcularCodigoValidacion(solicitud, uuid) {
  const canonico = JSON.stringify({
    id: solicitud.ID_SOLICITUD,
    rut: solicitud.CI_SOLICITANTE,
    inicio: fmtFecha(solicitud.FECHA_INICIO),
    fin: fmtFecha(solicitud.FECHA_FIN),
    retorno: fmtFecha(solicitud.FECHA_RETORNO),
    diasCalendario: solicitud.DIAS_CALENDARIO,
    diasHabiles: solicitud.DIAS_HABILES,
    aprobJefe: fmtFecha(solicitud.FECHA_APROBACION_JEFE_INMEDIATO, true),
    aprobNomina: fmtFecha(solicitud.FECHA_APROBACION_RRHH, true),
    uuid
  });
  return crypto.createHash('sha256').update(canonico).digest('hex').toUpperCase();
}

function seccion(doc, titulo) {
  const ancho = doc.page.width - MARGEN * 2;
  if (doc.y > doc.page.height - 140) doc.addPage();
  doc.moveDown(0.6);
  const y = doc.y;
  doc.rect(MARGEN, y, ancho, 18).fill(COLOR_BANDA);
  doc.fillColor(COLOR_PRIMARIO).font('Helvetica-Bold').fontSize(10)
    .text(titulo.toUpperCase(), MARGEN + 8, y + 5, { width: ancho - 16 });
  doc.y = y + 24;
  doc.x = MARGEN;
}

// Pares etiqueta/valor en dos columnas
function grilla(doc, pares) {
  const ancho = doc.page.width - MARGEN * 2;
  const colAncho = ancho / 2;
  const etiquetaAncho = 135;
  for (let i = 0; i < pares.length; i += 2) {
    const y = doc.y;
    let alto = 0;
    [pares[i], pares[i + 1]].forEach((par, idx) => {
      if (!par) return;
      const x = MARGEN + idx * colAncho;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR_SUAVE)
        .text(par[0], x, y, { width: etiquetaAncho });
      doc.font('Helvetica').fontSize(9).fillColor(COLOR_TEXTO)
        .text(fmtValor(par[1]), x + etiquetaAncho, y, { width: colAncho - etiquetaAncho - 8 });
      alto = Math.max(alto, doc.y - y);
    });
    doc.y = y + Math.max(alto, 12) + 3;
  }
  doc.x = MARGEN;
}

function tablaPeriodos(doc, periodos) {
  const ancho = doc.page.width - MARGEN * 2;
  const cols = [
    { titulo: 'Período', ancho: ancho * 0.4 },
    { titulo: 'Saldo disponible', ancho: ancho * 0.2 },
    { titulo: 'Días usados', ancho: ancho * 0.2 },
    { titulo: 'Tipo', ancho: ancho * 0.2 }
  ];
  const fila = (valores, encabezado) => {
    const y = doc.y;
    if (encabezado) doc.rect(MARGEN, y - 2, ancho, 16).fill(COLOR_PRIMARIO);
    let x = MARGEN;
    valores.forEach((v, i) => {
      doc.font(encabezado ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
        .fillColor(encabezado ? '#FFFFFF' : COLOR_TEXTO)
        .text(v, x + 6, y + 2, { width: cols[i].ancho - 12 });
      x += cols[i].ancho;
    });
    doc.y = y + 16;
    doc.moveTo(MARGEN, doc.y - 2).lineTo(MARGEN + ancho, doc.y - 2)
      .lineWidth(0.5).strokeColor('#CCCCCC').stroke();
  };

  fila(cols.map(c => c.titulo), true);
  if (!periodos.length) {
    fila(['Sin períodos registrados', '-', '-', '-'], false);
  } else {
    periodos.forEach(p => fila([
      `${fmtValor(p.ANIO_INICIO)} - ${fmtValor(p.ANIO_FIN)}`,
      fmtValor(p.DIAS_SALDO),
      fmtValor(p.DIAS_USO),
      fmtValor(p.TIPO)
    ], false));
  }
  doc.x = MARGEN;
}

function bloqueFirma(doc, solicitud) {
  const ancho = doc.page.width - MARGEN * 2;
  if (doc.y > doc.page.height - 200) doc.addPage();
  doc.moveDown(1);
  const y = doc.y;
  doc.rect(MARGEN, y, ancho, 110).lineWidth(1).strokeColor(COLOR_PRIMARIO).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR_PRIMARIO)
    .text('CONFORMIDAD DEL COLABORADOR', MARGEN + 10, y + 8);
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_TEXTO)
    .text('Declaro haber tomado conocimiento de las vacaciones aprobadas en este comprobante.',
      MARGEN + 10, y + 22, { width: ancho - 20 });

  const lineaY = y + 78;
  const anchoFirma = ancho * 0.55;
  doc.moveTo(MARGEN + 20, lineaY).lineTo(MARGEN + 20 + anchoFirma, lineaY)
    .lineWidth(0.8).strokeColor(COLOR_TEXTO).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR_TEXTO)
    .text('Firma del colaborador', MARGEN + 20, lineaY + 4)
    .text(`${fmtValor(solicitud.NOMBRE_SOLICITANTE)} - RUT ${fmtValor(solicitud.CI_SOLICITANTE)}`,
      MARGEN + 20, lineaY + 15, { width: anchoFirma });

  const fechaX = MARGEN + 40 + anchoFirma;
  doc.moveTo(fechaX, lineaY).lineTo(MARGEN + ancho - 20, lineaY).stroke();
  doc.text('Fecha: ____ / ____ / ________', fechaX, lineaY + 4);
  doc.y = y + 120;
  doc.x = MARGEN;
}

function piePaginas(doc, codigoValidacion, fechaGeneracion) {
  const rango = doc.bufferedPageRange();
  for (let i = rango.start; i < rango.start + rango.count; i++) {
    doc.switchToPage(i);
    const margenInferior = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const ancho = doc.page.width - MARGEN * 2;
    const y = doc.page.height - 50;
    doc.moveTo(MARGEN, y - 6).lineTo(MARGEN + ancho, y - 6)
      .lineWidth(0.5).strokeColor('#CCCCCC').stroke();
    doc.font('Helvetica').fontSize(7).fillColor(COLOR_SUAVE)
      .text(`Código de validación: ${codigoValidacion}`, MARGEN, y, { width: ancho, lineBreak: false })
      .text(`Generado: ${fmtFecha(fechaGeneracion, true)}`, MARGEN, y + 10, { width: ancho / 2, lineBreak: false })
      .text(`Página ${i - rango.start + 1} de ${rango.count}`, MARGEN + ancho / 2, y + 10,
        { width: ancho / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margenInferior;
  }
}

function dibujarComprobante(doc, { solicitud, periodos, codigoValidacion, fechaGeneracion }) {
  const ancho = doc.page.width - MARGEN * 2;

  // Encabezado
  doc.rect(0, 0, doc.page.width, 80).fill(COLOR_PRIMARIO);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#FFFFFF')
    .text('Comprobante de Vacaciones', MARGEN, 22, { width: ancho * 0.65 });
  doc.font('Helvetica').fontSize(10).fillColor('#DCE4EE')
    .text(`Chile - ${fmtValor(solicitud.EMPRESA)}`, MARGEN, 46, { width: ancho * 0.65 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#DCE4EE')
    .text('SOLICITUD N.º', MARGEN + ancho * 0.65, 24, { width: ancho * 0.35, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#FFFFFF')
    .text(String(solicitud.ID_SOLICITUD), MARGEN + ancho * 0.65, 38, { width: ancho * 0.35, align: 'right' });
  doc.y = 95;
  doc.x = MARGEN;

  seccion(doc, 'Datos del colaborador');
  grilla(doc, [
    ['Nombre', solicitud.NOMBRE_SOLICITANTE],
    ['RUT', solicitud.CI_SOLICITANTE],
    ['Código SAP', solicitud.COD_SAP_EMPLEADO],
    ['Empresa', solicitud.EMPRESA],
    ['Departamento', solicitud.DEPARTAMENTO],
    ['Cargo', solicitud.CARGO],
    ['Jefe inmediato', solicitud.NOMBRES_JEFE],
    ['RUT jefe inmediato', solicitud.CI_JEFE_INMEDIATO]
  ]);

  seccion(doc, 'Fechas');
  grilla(doc, [
    ['Fecha de solicitud', fmtFecha(solicitud.FECHA_SOLICITUD)],
    ['Fecha de inicio', fmtFecha(solicitud.FECHA_INICIO)],
    ['Fecha de fin', fmtFecha(solicitud.FECHA_FIN)],
    ['Fecha de retorno', fmtFecha(solicitud.FECHA_RETORNO)]
  ]);

  seccion(doc, 'Detalle de días');
  grilla(doc, [
    ['Días calendario', solicitud.DIAS_CALENDARIO],
    ['Días hábiles', solicitud.DIAS_HABILES],
    ['Fines de semana excluidos', solicitud.FINES_SEMANA_EXCLUIDOS],
    ['Feriados excluidos', solicitud.FERIADOS_EXCLUIDOS],
    ['Días cubiertos con saldo', solicitud.DIAS_CUBIERTOS_SALDO],
    ['Días anticipados', solicitud.DIAS_ANTICIPADOS],
    ['Clasificación', solicitud.CLASIFICACION]
  ]);

  seccion(doc, 'Distribución por períodos');
  tablaPeriodos(doc, periodos);

  seccion(doc, 'Aprobaciones');
  grilla(doc, [
    ['Jefatura', solicitud.ESTADO_APROBACION_JEFE_INMEDIATO],
    ['Fecha aprobación jefatura', fmtFecha(solicitud.FECHA_APROBACION_JEFE_INMEDIATO, true)],
    ['Nómina', solicitud.ESTADO_APROBACION_RRHH],
    ['Fecha aprobación Nómina', fmtFecha(solicitud.FECHA_APROBACION_RRHH, true)]
  ]);

  bloqueFirma(doc, solicitud);
  piePaginas(doc, codigoValidacion, fechaGeneracion);
}

// Genera el PDF en un temporal, calcula SHA-256 y lo renombra al nombre definitivo.
async function generarPdfAtomico({ solicitud, periodos, dir, idSolicitud }) {
  const uuid = crypto.randomUUID();
  const nombreArchivo = `comprobante_vacaciones_${idSolicitud}_${uuid}.pdf`;
  const rutaFisica = path.join(dir, nombreArchivo);
  const rutaTemporal = path.join(dir, `.${nombreArchivo}.tmp`);
  const maxBytes = Number(process.env.VACACIONES_PDF_MAX_BYTES) || 10485760;
  const codigoValidacion = calcularCodigoValidacion(solicitud, uuid);
  const fechaGeneracion = new Date();

  try {
    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(rutaTemporal, { flags: 'wx' });
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: MARGEN, bottom: 70, left: MARGEN, right: MARGEN },
        bufferPages: true,
        info: {
          Title: `Comprobante de vacaciones N.º ${idSolicitud}`,
          Author: 'Nómina Chile',
          Subject: 'Comprobante de vacaciones',
          Keywords: codigoValidacion
        }
      });
      stream.on('error', reject);
      doc.on('error', reject);
      stream.on('finish', resolve);
      doc.pipe(stream);
      dibujarComprobante(doc, { solicitud, periodos, codigoValidacion, fechaGeneracion });
      doc.end();
    });

    const contenido = await fs.promises.readFile(rutaTemporal);
    if (contenido.length === 0) throw new Error('El PDF generado está vacío');
    if (contenido.length > maxBytes) {
      throw new Error(`El PDF generado (${contenido.length} bytes) supera el máximo permitido (${maxBytes})`);
    }
    const hash = crypto.createHash('sha256').update(contenido).digest('hex');

    await fs.promises.rename(rutaTemporal, rutaFisica);

    return { nombreArchivo, rutaFisica, hash, tamanio: contenido.length, codigoValidacion };
  } catch (err) {
    await fs.promises.unlink(rutaTemporal).catch(() => {});
    throw errorEscritura(`No se pudo generar el comprobante PDF: ${err.message}`, err);
  }
}

module.exports = { generarPdfAtomico, calcularCodigoValidacion, fmtFecha };
