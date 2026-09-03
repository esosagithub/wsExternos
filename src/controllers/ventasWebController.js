const jwt = require('jsonwebtoken');
const oracledb = require('oracledb');
const dbVtex = require('../../config/databaseVtex');
const { logWs } = require('../utils/wsLogger');
const sapService = require('../services/sapService');

const REQUIRED_FIELDS = [
  'doc_ven', 'pedido_web', 'empresa', 'centro', 'almacen', 'status',
  'cliente_ci', 'cliente_nombre', 'cliente_tipo', 'cliente_telefono',
  'cliente_direcion', 'cliente_mail'
];

const REQUIRED_DETALLE_FIELDS = [
  'linea', 'cantidad', 'precio', 'codigo', 'detalle',
  'descuento', 'precio_original', 'iva', 'valor_iva', 'ean',
  'unidad_medida'
];

const REQUIRED_PAGO_FIELDS = [
  'linea', 'pago_tc', 'subtotal_tc', 'iva_tc'
];

function parseLimit(rawLimit, defaultLimit = 100, maxLimit = 1000) {
  const parsedLimit = Number(rawLimit || defaultLimit);
  return Number.isInteger(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, maxLimit)
    : defaultLimit;
}

function getRequestPayload(req) {
  return req.method === 'GET' ? req.query : req.body;
}

async function sendLogged(req, res, startMs, statusCode, responseObject, queryEjecutado, mensajeError = null) {
  await logWs({
    endpoint: req.originalUrl,
    metodo_http: req.method,
    usuario: req.user?.username || null,
    json_request: getRequestPayload(req),
    query_ejecutado: queryEjecutado,
    json_response: responseObject,
    http_status: statusCode,
    duracion_ms: Date.now() - startMs,
    ip_origen: req.ip,
    mensaje_error: mensajeError
  });

  return res.status(statusCode).json(responseObject);
}

function emitTokens(username) {
  const secret = process.env.JWT_SECRET;
  const access_token = jwt.sign(
    { username, type: 'access' },
    secret,
    { expiresIn: process.env.JWT_EXPIRES_IN || '4m' }
  );
  const refresh_token = jwt.sign(
    { username, type: 'refresh' },
    secret,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '5m' }
  );
  return { access_token, refresh_token };
}

async function login(req, res) {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      status: 'ERROR',
      error: { code: 'MISSING_CREDENTIALS', message: 'Se requieren username y password' }
    });
  }

  if (username !== process.env.VTEX_JWT_USERNAME || password !== process.env.VTEX_JWT_PASSWORD) {
    return res.status(401).json({
      status: 'ERROR',
      error: { code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas' }
    });
  }

  const { access_token, refresh_token } = emitTokens(username);

  return res.status(200).json({
    status: 'SUCCESS',
    access_token,
    refresh_token,
    expires_in: process.env.JWT_EXPIRES_IN || '4m',
    refresh_expires_in: process.env.JWT_REFRESH_EXPIRES_IN || '5m'
  });
}

async function refreshToken(req, res) {
  const { refresh_token } = req.body || {};

  if (!refresh_token) {
    return res.status(400).json({
      status: 'ERROR',
      error: { code: 'MISSING_TOKEN', message: 'Se requiere refresh_token' }
    });
  }

  try {
    const payload = jwt.verify(refresh_token, process.env.JWT_SECRET);

    if (payload.type !== 'refresh') {
      return res.status(401).json({
        status: 'ERROR',
        error: { code: 'INVALID_TOKEN', message: 'El token proporcionado no es un refresh token' }
      });
    }

    const tokens = emitTokens(payload.username);

    return res.status(200).json({
      status: 'SUCCESS',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: process.env.JWT_EXPIRES_IN || '4m',
      refresh_expires_in: process.env.JWT_REFRESH_EXPIRES_IN || '5m'
    });
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      status: 'ERROR',
      error: {
        code: isExpired ? 'REFRESH_EXPIRED' : 'INVALID_TOKEN',
        message: isExpired
          ? 'Sesión expirada, inicie sesión nuevamente'
          : err.message
      }
    });
  }
}

async function insertarVenta(req, res) {
  const startMs = Date.now();
  const queryEjecutado = 'INSERT ventas_web + ventas_web_detalle + ventas_web_pagos';
  const body = req.body || {};

  for (const field of REQUIRED_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      const responseObject = {
        status: 'ERROR',
        error: { code: 'MISSING_FIELD', message: `Falta el campo requerido: ${field}` }
      };
      return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
    }
  }

  if (!Array.isArray(body.detalle) || body.detalle.length === 0) {
    const responseObject = {
      status: 'ERROR',
      error: { code: 'MISSING_FIELD', message: 'El campo detalle debe ser un array no vacío' }
    };
    return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
  }

  for (let i = 0; i < body.detalle.length; i++) {
    const item = body.detalle[i];
    for (const field of REQUIRED_DETALLE_FIELDS) {
      if (item[field] === undefined || item[field] === null || item[field] === '') {
        const responseObject = {
          status: 'ERROR',
          error: { code: 'MISSING_FIELD', message: `Falta el campo requerido en detalle[${i}]: ${field}` }
        };
        return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
      }
    }
  }

  if (!Array.isArray(body.pagos) || body.pagos.length === 0) {
    const responseObject = {
      status: 'ERROR',
      error: { code: 'MISSING_FIELD', message: 'El campo pagos debe ser un array no vacío' }
    };
    return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
  }

  for (let i = 0; i < body.pagos.length; i++) {
    const pago = body.pagos[i];
    for (const field of REQUIRED_PAGO_FIELDS) {
      if (pago[field] === undefined || pago[field] === null || pago[field] === '') {
        const responseObject = {
          status: 'ERROR',
          error: { code: 'MISSING_FIELD', message: `Falta el campo requerido en pagos[${i}]: ${field}` }
        };
        return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
      }
    }
  }

  const s = (val) => (val !== undefined && val !== null) ? String(val) : null;
  const n = (val) => (val !== undefined && val !== null && val !== '') ? Number(val) : null;
  const d = (val) => (val !== undefined && val !== null && val !== '') ? new Date(val) : null;

  const usuarioRegistro = s(body.usuario_registro) || req.user.username;
  const docVen = s(body.doc_ven);
  const pedidoWeb = n(body.pedido_web);
  const pedidoVenta = n(body.pedido_venta);

  const bindsHeader = {
    doc_ven:               docVen,
    pedido_web:            pedidoWeb,
    pedido_venta:          pedidoVenta,
    factura_sap:           n(body.factura_sap),
    factura_sri:           s(body.factura_sri),
    guia_sri:              s(body.guia_sri),
    pedido_tralado:        n(body.pedido_tralado),
    entrega_tras:          s(body.entrega_tras),
    guia_lar:              s(body.guia_lar),
    estado:                s(body.estado),
    hu:                    s(body.hu),
    fac_total:             n(body.fac_total),
    fac_subtotal:          n(body.fac_subtotal),
    fac_iva:               n(body.fac_iva),
    fac_descuento:         n(body.fac_descuento),
    fecha_creacion:        d(body.fecha_creacion),
    fecha_pedido:          d(body.fecha_pedido),
    fecha_transaldo:       d(body.fecha_transaldo),
    fecha_despacho:        d(body.fecha_despacho),
    fecha_entrega:         d(body.fecha_entrega),
    tipo_entrega:          s(body.tipo_entrega),
    empresa:               s(body.empresa),
    centro:                s(body.centro),
    almacen:               s(body.almacen),
    num_guia:              s(body.num_guia),
    nota:                  s(body.nota),
    cliente_ci:            s(body.cliente_ci),
    cliente_nombre:        s(body.cliente_nombre),
    cliente_tipo:          s(body.cliente_tipo),
    cliente_telefono:      s(body.cliente_telefono),
    cliente_direcion:      s(body.cliente_direcion),
    cliente_direcion2:     s(body.cliente_direcion2),
    cliente_direcion3:     s(body.cliente_direcion3),
    cleinte_referencia:    s(body.cleinte_referencia),
    cliente_mail:          s(body.cliente_mail),
    cliente_departamen_code: s(body.cliente_departamen_code),
    cliente_departamen_name: s(body.cliente_departamen_name),
    cliente_provincia_code: s(body.cliente_provincia_code),
    cliente_provincia_name: s(body.cliente_provincia_name),
    cliente_distri_code:   s(body.cliente_distri_code),
    cliente_distric_name:  s(body.cliente_distric_name),
    pickup_name:           s(body.pickup_name),
    pickup_type:           s(body.pickup_type),
    pickup_document:       s(body.pickup_document),
    pickup_number:         s(body.pickup_number),
    fac_cliente_tipo:      s(body.fac_cliente_tipo),
    fac_cliente_ci:        s(body.fac_cliente_ci),
    fac_cliente_nombre:    s(body.fac_cliente_nombre),
    fac_cliente_telefono:  s(body.fac_cliente_telefono),
    fac_departamen_code:   s(body.fac_departamen_code),
    fac_departamen_name:   s(body.fac_departamen_name),
    fac_provincia_code:    s(body.fac_provincia_code),
    fac_provincia_name:    s(body.fac_provincia_name),
    fac_distri_code:       s(body.fac_distri_code),
    fac_distric_name:      s(body.fac_distric_name),
    centro_retira:         s(body.centro_retira),
    dato1:                 s(body.dato1),
    dato2:                 s(body.dato2),
    dato3:                 s(body.dato3),
    dato4:                 s(body.dato4),
    dato5:                 s(body.dato5),
    dato6:                 s(body.dato6),
    dato7:                 s(body.dato7),
    dato8:                 s(body.dato8),
    dato9:                 s(body.dato9),
    dato10:                s(body.dato10),
    dato11:                s(body.dato11),
    dato12:                s(body.dato12),
    dato13:                s(body.dato13),
    dato14:                s(body.dato14),
    dato15:                s(body.dato15),
    dato16:                s(body.dato16),
    dato17:                s(body.dato17),
    dato18:                s(body.dato18),
    dato19:                s(body.dato19),
    dato20:                s(body.dato20),
    usuario_registro:      usuarioRegistro,
    status:                s(body.status),
    mensaje:               s(body.mensaje),
    status_fi:             s(body.status_fi),
    mensaje_fi:            s(body.mensaje_fi)
  };

  const sqlHeader = `
    INSERT INTO ventas_web (
      doc_ven, pedido_web, pedido_venta, factura_sap, factura_sri, guia_sri,
      pedido_tralado, entrega_tras, guia_lar, estado, hu,
      fac_total, fac_subtotal, fac_iva, fac_descuento,
      fecha_creacion, fecha_pedido, fecha_transaldo, fecha_despacho, fecha_entrega,
      tipo_entrega, empresa, centro, almacen, num_guia, nota,
      cliente_ci, cliente_nombre, cliente_tipo, cliente_telefono,
      cliente_direcion, cliente_direcion2, cliente_direcion3, cleinte_referencia,
      cliente_mail, cliente_departamen_code, cliente_departamen_name,
      cliente_provincia_code, cliente_provincia_name,
      cliente_distri_code, cliente_distric_name,
      pickup_name, pickup_type, pickup_document, pickup_number,
      fac_cliente_tipo, fac_cliente_ci, fac_cliente_nombre, fac_cliente_telefono,
      fac_departamen_code, fac_departamen_name, fac_provincia_code, fac_provincia_name,
      fac_distri_code, fac_distric_name, centro_retira,
      dato1, dato2, dato3, dato4, dato5, dato6, dato7, dato8, dato9,
      dato10, dato11, dato12, dato13, dato14, dato15, dato16, dato17, dato18, dato19, dato20,
      fecha_registro, usuario_registro, status, mensaje, status_fi, mensaje_fi
    ) VALUES (
      :doc_ven, :pedido_web, :pedido_venta, :factura_sap, :factura_sri, :guia_sri,
      :pedido_tralado, :entrega_tras, :guia_lar, :estado, :hu,
      :fac_total, :fac_subtotal, :fac_iva, :fac_descuento,
      :fecha_creacion, :fecha_pedido, :fecha_transaldo, :fecha_despacho, :fecha_entrega,
      :tipo_entrega, :empresa, :centro, :almacen, :num_guia, :nota,
      :cliente_ci, :cliente_nombre, :cliente_tipo, :cliente_telefono,
      :cliente_direcion, :cliente_direcion2, :cliente_direcion3, :cleinte_referencia,
      :cliente_mail, :cliente_departamen_code, :cliente_departamen_name,
      :cliente_provincia_code, :cliente_provincia_name,
      :cliente_distri_code, :cliente_distric_name,
      :pickup_name, :pickup_type, :pickup_document, :pickup_number,
      :fac_cliente_tipo, :fac_cliente_ci, :fac_cliente_nombre, :fac_cliente_telefono,
      :fac_departamen_code, :fac_departamen_name, :fac_provincia_code, :fac_provincia_name,
      :fac_distri_code, :fac_distric_name, :centro_retira,
      :dato1, :dato2, :dato3, :dato4, :dato5, :dato6, :dato7, :dato8, :dato9,
      :dato10, :dato11, :dato12, :dato13, :dato14, :dato15, :dato16, :dato17, :dato18, :dato19, :dato20,
      SYSDATE, :usuario_registro, :status, :mensaje, :status_fi, :mensaje_fi
    )
  `;

  const sqlDetalle = `
    INSERT INTO ventas_web_detalle (
      doc_ven, pedido_web, pedido_venta, linea, cantidad, precio, descuento,
      precio_original, iva, valor_iva, codigo, detalle, ean,
      codigo_internacional, unidad_medida, nombre_promo,
      promotion_code, promotion_type, promotion_group,
      dato1, dato2, dato3, dato4, dato5, dato6, dato7, dato8, dato9,
      dato10, dato11, dato12, dato13, dato14, dato15, dato16, dato17, dato18, dato19, dato20,
      fecha_registro, usuario_registro, status, mensaje, status_fi, mensaje_fi
    ) VALUES (
      :doc_ven, :pedido_web, :pedido_venta, :linea, :cantidad, :precio, :descuento,
      :precio_original, :iva, :valor_iva, :codigo, :detalle, :ean,
      :codigo_internacional, :unidad_medida, :nombre_promo,
      :promotion_code, :promotion_type, :promotion_group,
      :dato1, :dato2, :dato3, :dato4, :dato5, :dato6, :dato7, :dato8, :dato9,
      :dato10, :dato11, :dato12, :dato13, :dato14, :dato15, :dato16, :dato17, :dato18, :dato19, :dato20,
      SYSDATE, :usuario_registro, :status, :mensaje, :status_fi, :mensaje_fi
    )
  `;

  const sqlPagos = `
    INSERT INTO ventas_web_pagos (
      doc_ven, pedido_web, pedido_venta, linea,
      tipo_pago_tc, pago_tc, subtotal_tc, iva_tc, cuota_tc, lote_tc, bin_tc, auto_tc,
      marca_tc, procesador_tc, banco_adquiriente_tc, banco_emisor_tc, tarejta_num_tc,
      paymetodo,
      dato1, dato2, dato3, dato4, dato5, dato6, dato7, dato8, dato9,
      dato10, dato11, dato12, dato13, dato14, dato15, dato16, dato17, dato18, dato19, dato20,
      fecha_registro, usuario_registro, status, mensaje, status_fi, mensaje_fi
    ) VALUES (
      :doc_ven, :pedido_web, :pedido_venta, :linea,
      :tipo_pago_tc, :pago_tc, :subtotal_tc, :iva_tc, :cuota_tc, :lote_tc, :bin_tc, :auto_tc,
      :marca_tc, :procesador_tc, :banco_adquiriente_tc, :banco_emisor_tc, :tarejta_num_tc,
      :paymetodo,
      :dato1, :dato2, :dato3, :dato4, :dato5, :dato6, :dato7, :dato8, :dato9,
      :dato10, :dato11, :dato12, :dato13, :dato14, :dato15, :dato16, :dato17, :dato18, :dato19, :dato20,
      SYSDATE, :usuario_registro, :status, :mensaje, :status_fi, :mensaje_fi
    )
  `;

  let connection;
  try {
    connection = await dbVtex.getConnection();
    connection.autoCommit = false;

    await connection.execute(sqlHeader, bindsHeader);

    for (const item of body.detalle) {
      await connection.execute(sqlDetalle, {
        doc_ven:               docVen,
        pedido_web:            pedidoWeb,
        pedido_venta:          n(item.pedido_venta),
        linea:                 n(item.linea),
        cantidad:              n(item.cantidad),
        precio:                n(item.precio),
        descuento:             n(item.descuento),
        precio_original:       n(item.precio_original),
        iva:                   n(item.iva),
        valor_iva:             n(item.valor_iva),
        codigo:                s(item.codigo),
        detalle:               s(item.detalle),
        ean:                   s(item.ean),
        codigo_internacional:  s(item.codigo_internacional),
        unidad_medida:         s(item.unidad_medida),
        nombre_promo:          s(item.nombre_promo),
        promotion_code:        s(item.promotion_code),
        promotion_type:        s(item.promotion_type),
        promotion_group:       s(item.promotion_group),
        dato1:                 s(item.dato1),
        dato2:                 s(item.dato2),
        dato3:                 s(item.dato3),
        dato4:                 s(item.dato4),
        dato5:                 s(item.dato5),
        dato6:                 s(item.dato6),
        dato7:                 s(item.dato7),
        dato8:                 s(item.dato8),
        dato9:                 s(item.dato9),
        dato10:                s(item.dato10),
        dato11:                s(item.dato11),
        dato12:                s(item.dato12),
        dato13:                s(item.dato13),
        dato14:                s(item.dato14),
        dato15:                s(item.dato15),
        dato16:                s(item.dato16),
        dato17:                s(item.dato17),
        dato18:                s(item.dato18),
        dato19:                s(item.dato19),
        dato20:                s(item.dato20),
        usuario_registro:      usuarioRegistro,
        status:                s(item.status),
        mensaje:               s(item.mensaje),
        status_fi:             s(item.status_fi),
        mensaje_fi:            s(item.mensaje_fi)
      });
    }

    for (const pago of body.pagos || []) {
      await connection.execute(sqlPagos, {
        doc_ven:                 docVen,
        pedido_web:              pedidoWeb,
        pedido_venta:            pedidoVenta,
        linea:                   n(pago.linea),
        tipo_pago_tc:            s(pago.tipo_pago_tc),
        pago_tc:                 n(pago.pago_tc),
        subtotal_tc:             n(pago.subtotal_tc),
        iva_tc:                  n(pago.iva_tc),
        cuota_tc:                n(pago.cuota_tc),
        lote_tc:                 s(pago.lote_tc),
        bin_tc:                  s(pago.bin_tc),
        auto_tc:                 s(pago.auto_tc),
        marca_tc:                s(pago.marca_tc),
        procesador_tc:           s(pago.procesador_tc),
        banco_adquiriente_tc:    s(pago.banco_adquiriente_tc),
        banco_emisor_tc:         s(pago.banco_emisor_tc),
        tarejta_num_tc:          s(pago.tarejta_num_tc),
        paymetodo:               s(pago.paymetodo),
        dato1:                   s(pago.dato1),
        dato2:                   s(pago.dato2),
        dato3:                   s(pago.dato3),
        dato4:                   s(pago.dato4),
        dato5:                   s(pago.dato5),
        dato6:                   s(pago.dato6),
        dato7:                   s(pago.dato7),
        dato8:                   s(pago.dato8),
        dato9:                   s(pago.dato9),
        dato10:                  s(pago.dato10),
        dato11:                  s(pago.dato11),
        dato12:                  s(pago.dato12),
        dato13:                  s(pago.dato13),
        dato14:                  s(pago.dato14),
        dato15:                  s(pago.dato15),
        dato16:                  s(pago.dato16),
        dato17:                  s(pago.dato17),
        dato18:                  s(pago.dato18),
        dato19:                  s(pago.dato19),
        dato20:                  s(pago.dato20),
        usuario_registro:        usuarioRegistro,
        status:                  s(pago.status),
        mensaje:                 s(pago.mensaje),
        status_fi:               s(pago.status_fi),
        mensaje_fi:              s(pago.mensaje_fi)
      });
    }

    await connection.commit();

    // Fire-and-forget: recarga lo insertado en Oracle y no bloquea la respuesta a VTEX
    sapService.enviarFacturaDesdeDb(docVen, pedidoWeb).catch((err) => {
      console.error(`[SAP] Error no controlado en envio automatico doc_ven=${docVen}:`, err.message);
    });

    const responseObject = {
      status: 'SUCCESS',
      message: 'Venta registrada correctamente',
      data: {
        doc_ven: docVen,
        pedido_web: pedidoWeb,
        lineas_detalle: body.detalle.length,
        lineas_pagos: (body.pagos || []).length
      }
    };
    return sendLogged(
      req,
      res,
      startMs,
      201,
      responseObject,
      `INSERT ventas_web + ventas_web_detalle (${body.detalle.length} filas) + ventas_web_pagos (${(body.pagos || []).length} filas)`
    );
  } catch (err) {
    console.error('Error al insertar venta:', err);
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
    }
    const oraCode = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : 'UNKNOWN';
    const responseObject = {
      status: 'ERROR',
      error: { code: oraCode, message: err.message || String(err) }
    };
    return sendLogged(req, res, startMs, 500, responseObject, queryEjecutado, responseObject.error.message);
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

async function msEnivaSapVtex(req, res) {
  const startMs = Date.now();
  const queryEjecutado = 'SELECT ventas_web por orderKey + SEND SAP';
  const body = req.body || {};
  const orderKey = req.params.orderKey
    || body.orderKey
    || body.doc_ven
    || body.pedido_web
    || body.orden
    || body.numero_orden;

  if (!orderKey) {
    const responseObject = {
      status: 'ERROR',
      error: { code: 'MISSING_ORDER', message: 'Se requiere numero de orden en orderKey, doc_ven o pedido_web' }
    };
    return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
  }

  try {
    const { header, detalle, pagos } = await sapService.enviarFacturaPorOrderKey(String(orderKey));
    const responseObject = {
      status: 'SUCCESS',
      message: 'Venta enviada a SAP correctamente',
      data: {
        doc_ven: header.doc_ven,
        pedido_web: header.pedido_web,
        lineas_detalle: detalle.length,
        lineas_pagos: pagos.length
      }
    };
    return sendLogged(req, res, startMs, 200, responseObject, queryEjecutado);
  } catch (err) {
    console.error(`Error en msEnivaSapVtex orderKey=${orderKey}:`, err);
    const notFound = String(err.message || '').includes('No se encontro');
    const responseObject = {
      status: 'ERROR',
      error: {
        code: notFound ? 'ORDER_NOT_FOUND' : 'SAP_SEND_ERROR',
        message: err.message || String(err)
      }
    };
    return sendLogged(
      req,
      res,
      startMs,
      notFound ? 404 : 500,
      responseObject,
      queryEjecutado,
      responseObject.error.message
    );
  }
}

async function obtenerPedidosPendientes(req, res) {
  const startMs = Date.now();
  const queryEjecutado = 'SELECT ventas_web_cola_ws JOIN ventas_web pendientes';
  const limit = parseLimit(req.query.limit);

  let connection;
  try {
    connection = await dbVtex.getConnection();

    const result = await connection.execute(
      `SELECT
          c.id_cola,
          c.pedido_web,
          c.estado_anterior,
          c.estado_nuevo,
          c.doc_ven,
          c.mensaje_error,
          TO_CHAR(c.fecha_cambio, 'YYYY-MM-DD HH24:MI:SS') AS fecha_cambio,
          v.cliente_nombre,
          v.cliente_mail,
          v.pedido_venta
       FROM ventas_web_cola_ws c
       JOIN ventas_web v ON v.pedido_web = c.pedido_web
       WHERE c.procesado = 'N'
       ORDER BY c.fecha_cambio ASC
       FETCH FIRST :limit ROWS ONLY`,
      { limit },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const responseObject = {
      status: 'SUCCESS',
      total: result.rows.length,
      pedidos: result.rows
    };
    return sendLogged(req, res, startMs, 200, responseObject, queryEjecutado);
  } catch (err) {
    console.error('Error al obtener pedidos pendientes VTEX:', err);
    const oraCode = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : 'UNKNOWN';
    const responseObject = {
      status: 'ERROR',
      error: { code: oraCode, message: err.message || String(err) }
    };
    return sendLogged(req, res, startMs, 500, responseObject, queryEjecutado, responseObject.error.message);
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

async function obtenerStock(req, res) {
  const startMs = Date.now();
  const queryEjecutado = 'SELECT ventas_web_stock';

  let connection;
  try {
    connection = await dbVtex.getConnection();

    const result = await connection.execute(
      `SELECT *
       FROM ventas_web_stock`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const responseObject = {
      status: 'SUCCESS',
      total: result.rows.length,
      stock: result.rows
    };
    return sendLogged(req, res, startMs, 200, responseObject, queryEjecutado);
  } catch (err) {
    console.error('Error al obtener stock VTEX:', err);
    const oraCode = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : 'UNKNOWN';
    const responseObject = {
      status: 'ERROR',
      error: { code: oraCode, message: err.message || String(err) }
    };
    return sendLogged(req, res, startMs, 500, responseObject, queryEjecutado, responseObject.error.message);
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

async function obtenerPrecios(req, res) {
  const startMs = Date.now();
  const queryEjecutado = 'SELECT ventas_web_precios';

  let connection;
  try {
    connection = await dbVtex.getConnection();

    const result = await connection.execute(
      `SELECT *
       FROM ventas_web_precios`,
      {},
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const responseObject = {
      status: 'SUCCESS',
      total: result.rows.length,
      precios: result.rows
    };
    return sendLogged(req, res, startMs, 200, responseObject, queryEjecutado);
  } catch (err) {
    console.error('Error al obtener precios VTEX:', err);
    const oraCode = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : 'UNKNOWN';
    const responseObject = {
      status: 'ERROR',
      error: { code: oraCode, message: err.message || String(err) }
    };
    return sendLogged(req, res, startMs, 500, responseObject, queryEjecutado, responseObject.error.message);
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

async function marcarPedidosEnviados(req, res) {
  const startMs = Date.now();
  const queryEjecutado = 'UPDATE ventas_web_cola_ws SET procesado = S';
  const { ids } = req.body || {};

  if (!Array.isArray(ids) || ids.length === 0) {
    const responseObject = {
      status: 'ERROR',
      error: { code: 'MISSING_IDS', message: 'Se requiere lista de IDs' }
    };
    return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
  }

  const idList = ids.map((id) => Number(id));
  const invalidIds = idList.filter((id) => !Number.isInteger(id) || id <= 0);

  if (invalidIds.length > 0) {
    const responseObject = {
      status: 'ERROR',
      error: { code: 'INVALID_IDS', message: 'Todos los IDs deben ser numeros enteros positivos' }
    };
    return sendLogged(req, res, startMs, 400, responseObject, queryEjecutado, responseObject.error.message);
  }

  const binds = {};
  const placeholders = idList.map((id, index) => {
    const bindName = `id${index}`;
    binds[bindName] = id;
    return `:${bindName}`;
  });

  let connection;
  try {
    connection = await dbVtex.getConnection();

    const result = await connection.execute(
      `UPDATE ventas_web_cola_ws
       SET procesado = 'S',
           fecha_procesado = SYSDATE
       WHERE id_cola IN (${placeholders.join(',')})`,
      binds,
      { autoCommit: true }
    );

    const responseObject = {
      status: 'SUCCESS',
      message: `${result.rowsAffected} pedidos marcados como enviados`,
      procesados: result.rowsAffected
    };
    return sendLogged(
      req,
      res,
      startMs,
      200,
      responseObject,
      `UPDATE ventas_web_cola_ws (${result.rowsAffected} filas)`
    );
  } catch (err) {
    console.error('Error al marcar pedidos enviados VTEX:', err);
    const oraCode = err.errorNum ? `ORA-${String(err.errorNum).padStart(5, '0')}` : 'UNKNOWN';
    const responseObject = {
      status: 'ERROR',
      error: { code: oraCode, message: err.message || String(err) }
    };
    return sendLogged(req, res, startMs, 500, responseObject, queryEjecutado, responseObject.error.message);
  } finally {
    if (connection) {
      try { await connection.close(); } catch (_) {}
    }
  }
}

module.exports = {
  login,
  refreshToken,
  insertarVenta,
  msEnivaSapVtex,
  obtenerPedidosPendientes,
  obtenerStock,
  obtenerPrecios,
  marcarPedidosEnviados
};
