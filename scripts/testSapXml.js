/**
 * Script de prueba SAP — muestra el XML y opcionalmente envía a SAP.
 *
 * Uso:
 *   node scripts/testSapXml.js <doc_ven>                    → solo muestra el XML
 *   node scripts/testSapXml.js <doc_ven> --send             → envía a SAP (SSL estricto)
 *   node scripts/testSapXml.js <doc_ven> --send --insecure  → envía ignorando SSL
 *   node scripts/testSapXml.js --cert                       → inspecciona certificado SAP
 */

const oracledb = require('oracledb');
oracledb.initOracleClient({ libDir: 'C:\\app\\Oracle Client for Microsoft Tools' });
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const soap  = require('soap');
const https = require('https');
const axios = require('axios');
const tls   = require('tls');
const dbVtex = require('../config/databaseVtex');

// node-soap usa axios internamente — instancia con SSL permisivo solo para SAP
const sapAxios = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
    ciphers: 'DEFAULT@SECLEVEL=0'
  })
});
const { buildRequest, postProcessSapEnvelope } = require('../src/services/sapService');

const WSDL_PATH  = path.resolve(__dirname, '..', process.env.SAP_WSDL_PATH || 'wsdl/z_ws_mm_crea_pedidos_ora.wsdl');
const SAP_URL    = 'https://mths4qas.ec.aseyco.com';
const SAP_PORT   = 8100;
const CERT_MODE  = process.argv.includes('--cert');
const SEND       = process.argv.includes('--send');
const INSECURE   = process.argv.includes('--insecure');
const ORDER_KEY  = process.argv.find(a => !a.startsWith('--') && a !== process.argv[1] && a !== process.argv[0]);

if (!CERT_MODE && !ORDER_KEY) {
  console.error('Uso: node scripts/testSapXml.js <doc_ven|pedido_web> [--send] [--insecure]');
  console.error('     node scripts/testSapXml.js --cert');
  process.exit(1);
}

// Modo inspección de certificado
if (CERT_MODE) {
  inspectCert();
  return;
}

function inspectCert() {
  console.log(`\nConectando a ${SAP_URL}:${SAP_PORT} para inspeccionar certificado...\n`);
  const socket = tls.connect({ host: SAP_URL.replace('https://', ''), port: SAP_PORT, rejectUnauthorized: false }, () => {
    const cert = socket.getPeerCertificate(true);
    const cipher = socket.getCipher();
    console.log('=== Información del Certificado SSL ===\n');
    console.log(`  Sujeto (Subject)   : ${JSON.stringify(cert.subject)}`);
    console.log(`  Emisor (Issuer)    : ${JSON.stringify(cert.issuer)}`);
    console.log(`  Válido desde       : ${cert.valid_from}`);
    console.log(`  Válido hasta       : ${cert.valid_to}`);
    console.log(`  Algoritmo firma    : ${cert.sigalg}`);
    console.log(`  Bits de la clave   : ${cert.bits}`);
    console.log(`  Número de serie    : ${cert.serialNumber}`);
    console.log(`  Protocolo TLS      : ${socket.getProtocol()}`);
    console.log(`  Cipher suite       : ${cipher.name}`);
    console.log('\n=== Diagnóstico ===\n');
    if (cert.bits < 2048) {
      console.log(`  ❌ PROBLEMA: La clave RSA tiene ${cert.bits} bits.`);
      console.log(`     Node.js v17+ requiere mínimo 2048 bits.`);
      console.log(`     El proveedor debe renovar el certificado con clave RSA 2048 bits o superior.`);
    } else {
      console.log(`  ✓ Clave de ${cert.bits} bits — tamaño correcto.`);
    }
    socket.end();
    process.exit(0);
  });
  socket.on('error', err => {
    console.error('Error al conectar:', err.message);
    process.exit(1);
  });
}

async function main() {
  await dbVtex.initialize();
  const conn = await dbVtex.getConnection();

  try {
    const resHeader = await conn.execute(
      `SELECT *
       FROM (
         SELECT *
         FROM ventas_web
         WHERE doc_ven = :orderKey OR TO_CHAR(pedido_web) = :orderKey
         ORDER BY fecha_registro DESC
       )
       WHERE ROWNUM = 1`,
      { orderKey: ORDER_KEY },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!resHeader.rows.length) {
      console.error(`No se encontro '${ORDER_KEY}' en ventas_web por doc_ven ni pedido_web`);
      process.exit(1);
    }

    const header_lc  = toLowerKeys(resHeader.rows[0]);

    const resDetalle = await conn.execute(
      `SELECT * FROM ventas_web_detalle WHERE pedido_web = :pedidoWeb ORDER BY linea`,
      { pedidoWeb: header_lc.pedido_web },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const resPagos = await conn.execute(
      `SELECT * FROM ventas_web_pagos WHERE pedido_web = :pedidoWeb ORDER BY linea`,
      { pedidoWeb: header_lc.pedido_web },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const detalle_lc = resDetalle.rows.map(toLowerKeys);
    const pagos_lc   = resPagos.rows.map(toLowerKeys);

    console.log(`\n=== Datos encontrados ===`);
    console.log(`  doc_ven     : ${header_lc.doc_ven}`);
    console.log(`  pedido_web  : ${header_lc.pedido_web}`);
    console.log(`  cliente     : ${header_lc.cliente_nombre}`);
    console.log(`  líneas det. : ${detalle_lc.length}`);
    console.log(`  líneas pago : ${pagos_lc.length}`);

    const request = buildRequest(header_lc, detalle_lc, pagos_lc);
    const client  = await soap.createClientAsync(WSDL_PATH, {
      request: sapAxios,
      forceSoap12Headers: true
    });

    client.setSecurity(new soap.BasicAuthSecurity(
      process.env.SAP_USER,
      process.env.SAP_PASSWORD
    ));

    if (!SEND) {
      client.setEndpoint('http://localhost:9999/fake');
      console.log('Modo: solo XML (usa --send para enviar a SAP)\n');
    } else {
      console.log('Modo: ENVÍO REAL A SAP\n');
    }

    try {
      const postProcess = (xml) => {
        const processedXml = postProcessSapEnvelope(xml, request);
        console.log('\n=== XML enviado a SAP ===\n');
        console.log(processedXml);
        console.log('\n=== Fin XML ===\n');
        return processedXml;
      };

      const result = await client.ZMmCreaPedidosOrlAsync(request, {
        postProcess
      });
      if (SEND) {
        console.log('=== Respuesta SAP ===');
        console.log(JSON.stringify(result, null, 2));
        console.log('\n✓ Enviado correctamente a SAP');
      }
    } catch (err) {
      if (SEND) {
        console.error('\n=== Error de SAP ===');
        console.error(`  Código  : ${err.code || 'N/A'}`);
        console.error(`  Mensaje : ${err.message}`);
        if (err.body) console.error(`  SOAP body: ${err.body}`);
      }
      // Si no es --send, el error de localhost:9999 es esperado — ignorar
    }

  } finally {
    await conn.close();
    await dbVtex.close();
  }
}

function toLowerKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v])
  );
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
