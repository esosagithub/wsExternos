const soap  = require('soap');
const https = require('https');
const axios = require('axios');
const path  = require('path');
const oracledb = require('oracledb');
const dbVtex = require('../../config/databaseVtex');

const WSDL_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  process.env.SAP_WSDL_PATH || 'wsdl/z_ws_mm_crea_pedidos_ora.wsdl'
);

// node-soap usa axios internamente — se pasa una instancia con el agent configurado
// para aceptar certificados con clave débil (< 2048 bits) solo en esta conexión
const sapAxios = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
    ciphers: 'DEFAULT@SECLEVEL=0'
  })
});

let _client = null;

async function getClient() {
  if (!_client) {
    _client = await soap.createClientAsync(WSDL_PATH, {
      request: sapAxios,
      forceSoap12Headers: true
    });
    _client.setSecurity(new soap.BasicAuthSecurity(
      process.env.SAP_USER,
      process.env.SAP_PASSWORD
    ));
  }
  return _client;
}

function formatDate(val) {
  if (!val) return '';
  const raw = String(val);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}${match[2]}${match[3]}`;

  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0');
}

function formatDateTime(val) {
  if (!val) return '';
  const raw = String(val);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):?(\d{2})?:?(\d{2})?)?/);
  if (match) {
    return `${match[1]}${match[2]}${match[3]}`
      + `${match[4] || '00'}${match[5] || '00'}${match[6] || '00'}`;
  }

  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear().toString()
    + String(d.getMonth() + 1).padStart(2, '0')
    + String(d.getDate()).padStart(2, '0')
    + String(d.getHours()).padStart(2, '0')
    + String(d.getMinutes()).padStart(2, '0')
    + String(d.getSeconds()).padStart(2, '0');
}

function formatSapDisplayDateTime(val) {
  if (!val) return '';
  const raw = String(val);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):?(\d{2})?:?(\d{2})?)?/);
  if (match) {
    return `${Number(match[2])}/${Number(match[3])}/${match[1]} ${match[4] || '00'}:${match[5] || '00'}`;
  }

  const d = new Date(val);
  if (isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function s(v) { return (v !== null && v !== undefined) ? String(v) : ''; }

function n(v) {
  if (v === null || v === undefined || v === '') return 0;
  const num = Number(String(v).replace(',', '.'));
  return Number.isFinite(num) ? num : 0;
}

function money(v) {
  return n(v).toFixed(2);
}

function validDateParts(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year
    && d.getUTCMonth() === month - 1
    && d.getUTCDate() === day;
}

function getDateParts(val) {
  if (!val) return null;

  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    return {
      year: val.getFullYear(),
      month: val.getMonth() + 1,
      day: val.getDate()
    };
  }

  const raw = String(val).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return validDateParts(year, month, day) ? { year, month, day } : null;
  }

  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate()
  };
}

function formatDeliveryDate(val, addDays = 0) {
  const parts = getDateParts(val);
  if (!parts) return '';

  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + addDays));
  return d.getUTCFullYear().toString()
    + '-'
    + String(d.getUTCMonth() + 1).padStart(2, '0')
    + '-'
    + String(d.getUTCDate()).padStart(2, '0');
}

function decimalText(v) {
  return s(v).trim().replace(',', '.');
}

function multiplyMoneyText(quantity, price) {
  return (n(quantity) * n(price)).toFixed(2);
}

function firstText(...values) {
  const value = values.find(v => s(v).trim() !== '');
  return value === undefined ? '' : s(value).trim();
}

function toLowerKeys(obj) {
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function normalizeSapEnvelope(xml) {
  const normalized = xml
    .replace(
      /<soap:Envelope\b[^>]*>/,
      '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:urn="urn:sap-com:document:sap:soap:functions:mc-style">'
    )
    .replace(/<tns:ZMmCreaPedidosOrl>/g, '<urn:ZMmCreaPedidosOrl>')
    .replace(/<\/tns:ZMmCreaPedidosOrl>/g, '</urn:ZMmCreaPedidosOrl>')
    .replace(/<TotalItemPrice>/g, '<TotaItemPrice>')
    .replace(/<\/TotalItemPrice>/g, '</TotaItemPrice>');

  if (normalized.includes('<soap:Header')) {
    return normalized;
  }

  return normalized.replace(
    /(<soap:Envelope[^>]*>)/,
    '$1<soap:Header/>'
  );
}

function removeDeliveryDetailsBlock(xml, force = false) {
  if (!force) return xml;

  return xml
    .replace(/<((?:\w+:)?DeliveryDetails)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<(?:\w+:)?DeliveryDetails\b[^>]*\/>/g, '');
}

function removeBillingAddressBlock(xml, force = false) {
  if (!force) return xml;

  return xml
    .replace(/<((?:\w+:)?BillingAddress)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<(?:\w+:)?BillingAddress\b[^>]*\/>/g, '');
}

function postProcessSapEnvelope(xml, request) {
  const withoutDeliveryDetails = removeDeliveryDetailsBlock(
    xml,
    Boolean(request?.__omitDeliveryDetails)
  );
  const withoutBillingAddress = removeBillingAddressBlock(
    withoutDeliveryDetails,
    Boolean(request?.__omitBillingAddress)
  );

  return normalizeSapEnvelope(withoutBillingAddress);
}

function buildRequest(header, detalle, pagos) {
  const isPickup = Boolean(s(header.centro_retira).trim());
  const deliveryType = s(header.tipo_entrega).trim().toUpperCase();
  const isStorePickup = deliveryType === 'RETIRO EN TIENDA';
  const isHomeDelivery = deliveryType === 'DOMICILIO';
  const pago = pagos[0] || {};
  const customerDocumentType = firstText(header.dato_1, header.dato1);
  const isRucBilling = s(header.fac_cliente_tipo).trim().toUpperCase() === 'RUC';
  const merchantId = process.env.SAP_MERCHANT_ID || '20000000101108000000';
  const merchantName = process.env.SAP_MERCHANT_NAME || 'Marathon Sports';
  const isDeliveryLine = (d) => s(d.codigo).trim().startsWith('600');
  const deliveryDetail = detalle.find(isDeliveryLine);
  const hasDeliveryLine = detalle.some(isDeliveryLine);
  const shouldIncludeHomeDeliveryDetails = isHomeDelivery && !hasDeliveryLine;
  const shouldIncludeDeliveryDetails = hasDeliveryLine || isStorePickup || shouldIncludeHomeDeliveryDetails;
  const emptyPickupContact = {
    FirstName: '',
    LastName: '',
    DocumentType: '',
    DocumentNumber: '',
    PhoneNumber: ''
  };
  const deliveryDetails = isStorePickup
    ? {
        DeliveryMethod: '',
        DeliveryCost: '',
        IsPickupInStore: true,
        StoreId: s(header.centro_retira),
        PickupContact: emptyPickupContact,
        DeliveryMinDate: '',
        DeliveryMaxDate: ''
      }
    : shouldIncludeHomeDeliveryDetails
      ? {
          DeliveryMethod: 'Env\u00edo Grat\u00eds Est\u00e1ndar',
          DeliveryCost: '0.0',
          IsPickupInStore: false,
          StoreId: '',
          PickupContact: '',
          DeliveryMinDate: formatDeliveryDate(header.fecha_creacion),
          DeliveryMaxDate: formatDeliveryDate(header.fecha_creacion, 1)
        }
    : {
        DeliveryMethod: '',
        DeliveryCost: deliveryDetail ? decimalText(deliveryDetail.precio) : '',
        IsPickupInStore: isPickup,
        StoreId: s(header.centro_retira),
        PickupContact: {
          FirstName: s(header.pickup_name),
          LastName: s(header.pickup_name),
          DocumentType: s(header.pickup_type).charAt(0),
          DocumentNumber: s(header.pickup_document),
          PhoneNumber: s(header.pickup_number)
        },
        DeliveryMinDate: deliveryDetail ? formatDeliveryDate(deliveryDetail.fecha_registro) : '',
        DeliveryMaxDate: deliveryDetail ? formatDeliveryDate(deliveryDetail.fecha_registro, 2) : ''
      };
  const billingAddress = {
    IdType: s(header.fac_cliente_tipo),
    IdNumber: s(header.fac_cliente_ci),
    BusinessName: s(header.fac_cliente_nombre),
    PhoneNumber: s(header.fac_cliente_telefono),
    DepartmentCode: s(header.fac_departamen_code),
    DepartmentName: s(header.fac_departamen_name),
    ProvinceCode: s(header.fac_provincia_code),
    ProvinceName: s(header.fac_provincia_name),
    StreetName: firstText(header.cliente_direccion, header.cliente_direcion),
    StreetNumber: firstText(header.cliente_direccion2, header.cliente_direcion2),
    Reference: s(header.cleinte_referencia),
    PostalCode: '',
    SecondaryStreet: ''
  };
  const buildItem = (d) => {
    const hasLineDiscount = n(d.descuento) > 0;
    const numberOfItems = n(d.cantidad);
    const totaItemPrice = hasLineDiscount ? decimalText(d.precio) : money(d.precio);
    const lineTotal = multiplyMoneyText(numberOfItems, totaItemPrice);
    const lineDiscountTotal = hasLineDiscount
      ? multiplyMoneyText(numberOfItems, d.descuento)
      : lineTotal;

    return {
      LineNumber: n(d.linea),
      ProductCode: s(d.codigo),
      Unit: s(d.unidad_medida),
      BaseItemPrice: hasLineDiscount ? decimalText(d.precio_original) : money(d.precio),
      TotaItemPrice: totaItemPrice,
      NumberOfItems: numberOfItems,
      TotalPrice: lineTotal,
      TotalDiscount: lineDiscountTotal,
      PromotionEntries: hasLineDiscount
        ? {
            PromotionCode: s(d.promotion_code),
            PromotionName: s(d.nombre_promo),
            PromotionType: s(d.promotion_type),
            PromotionGroup: s(d.promotion_group),
            IsEmployeePromotion: false,
            DiscountAmount: lineDiscountTotal,
            Description: s(d.nombre_promo),
            CouponCode: ''
          }
        : { item: [] }
    };
  };

  const request = {
    PiHeader: {
      Code: s(header.doc_ven),
      Date: formatDate(header.fecha_pedido),
      CountryCode: 'EC',
      CurrencyCode: 'USD',
      TotalPriceGross: money(header.fac_total),
      TotalPriceNet: money(header.fac_subtotal),
      Bukrs: s(header.empresa),
      Sitio: 'ADI',
      RequiresInvoice: isRucBilling ? true : '',
      CustomerDetails: {
        CustomerId: s(header.cliente_mail),
        DocumentType: customerDocumentType,
        DocumentNumber: s(header.cliente_ci),
        FirstName: s(header.cliente_nombre),
        LastName: s(header.dato2),
        EmployeeId: ''
      },
      PaymentDetails: {
        PaymentMethod: s(pago.paymetodo),
        PaymentDetails: s(header.pedido_web),
        AdditionalInfo: s(pago.tarejta_num_tc),
        ExchangeRate: '',
        PaypalPaymentInfo: {
          PaymentId: '', ParentPaymentId: '', SaleId: '',
          CartId: '', Currency: '', TotalAmount: ''
        },
        PayuPaymentInfo: {
          OrderId: `123${s(header.doc_ven)}`, TransactionId: s(header.pedido_web), State: '', TrazabilityCode: '',
          AuthorizationCode: s(pago.auto_tc), ResponseCode: '000', PendingReason: '',
          PaymentNetworkResponseCode: '', ExpirationDate: '', BarCode: '',
          UrlPaymentHtml: '', UrlPaymentPdf: '', Reference: '', OperationDate: ''
        },
        EcPaymentInfo: {
          OrderId: s(header.doc_ven),
          MerchantId: merchantId,
          MerchantName: merchantName,
          CardType: 'CREDIT',
          PaymentType: s(pago.tipo_pago_tc),
          MaskedCardNumber: s(pago.tarejta_num_tc),
          PaymentBrand: s(pago.marca_tc),
          IssuingBank: s(pago.banco_emisor_tc),
          AcquirerBank: s(pago.banco_adquiriente_tc),
          ProcessorBankName: s(pago.procesador_tc),
          Months: s(pago.cuota_tc),
          WayToPay: '2',
          GraceMonths: '0',
          ApprovedTransactionAmount: money(pago.pago_tc),
          SubtotalIva: '0',
          SubtotalIva0: money(pago.subtotal_tc),
          IvaValue: money(pago.iva_tc),
          Created: formatSapDisplayDateTime(header.fecha_pedido),
          Lot: s(pago.lote_tc),
          ResponseCode: '0',
          TransactionId: s(pago.bin_tc),
          ApprovalCode: s(pago.auto_tc),
          TransactionStatus: 'APPROVAL',
          CurrencyCode: 'USD'
        },
        CreditNotePaymentInfo: {
          CreditNote: '',
          ApplyAmount: money(pago.pago_tc),
          Audit: { RemoteIp: '192.168.91.28', Date: '0', Time: '0', Warehouse: s(header.centro), User: s(header.cliente_mail), Country: 'EC' }
        }
      },
      ...(shouldIncludeDeliveryDetails ? { DeliveryDetails: deliveryDetails } : {}),
      ShippingAddress: {
        ContactFirstName: isRucBilling ? '' : s(header.cliente_nombre),
        ContactLastName: isRucBilling ? '' : s(header.dato2),
        DocumentType: customerDocumentType,
        DocumentNumber: s(header.cliente_ci),
        PhoneNumber: s(header.cliente_telefono),
        DepartmentCode: s(header.cliente_departamen_code),
        DepartmentName: s(header.cliente_departamen_name),
        ProvinceCode: s(header.cliente_provincia_code),
        ProvinceName: s(header.cliente_provincia_name),
        DistrictCode: s(header.cliente_distri_code),
        DistrictName: s(header.cliente_distric_name),
        StreetName: s(header.cliente_direcion),
        StreetNumber: s(header.cliente_direcion2),
        Reference: s(header.cleinte_referencia),
        PostalCode: '',
        SecondaryStreet: s(header.cliente_direcion3)
      },
      ...(isRucBilling ? { BillingAddress: billingAddress } : {}),
      GiftWrappings: { item: [] },
      CustomDetails: { item: [] }
    },
    PtItems: {
      item: detalle
        .filter(d => !isDeliveryLine(d))
        .map(buildItem)
    }
  };

  Object.defineProperty(request, '__omitDeliveryDetails', {
    value: !shouldIncludeDeliveryDetails,
    enumerable: false
  });
  Object.defineProperty(request, '__omitBillingAddress', {
    value: !isRucBilling,
    enumerable: false
  });

  return request;
}

async function updateStatusSap(docVen, pedidoWeb, statusFi, mensajeFi) {
  let conn;
  try {
    conn = await dbVtex.getConnection();
    await conn.execute(
      `UPDATE ventas_web SET status_fi = :statusFi, mensaje_fi = :mensajeFi
       WHERE doc_ven = :docVen AND pedido_web = :pedidoWeb`,
      {
        statusFi,
        mensajeFi: String(mensajeFi).substring(0, 500),
        docVen,
        pedidoWeb
      },
      { autoCommit: true }
    );
  } catch (err) {
    console.error('[SAP] Error actualizando status en Oracle:', err.message);
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }
}

async function cargarVentaDesdeDb(docVen, pedidoWeb) {
  let conn;
  try {
    conn = await dbVtex.getConnection();

    const resHeader = await conn.execute(
      `SELECT *
       FROM ventas_web
       WHERE doc_ven = :docVen
         AND pedido_web = :pedidoWeb`,
      { docVen, pedidoWeb },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!resHeader.rows.length) {
      throw new Error(`No se encontro la venta insertada doc_ven=${docVen}, pedido_web=${pedidoWeb}`);
    }

    const header = toLowerKeys(resHeader.rows[0]);

    const resDetalle = await conn.execute(
      `SELECT *
       FROM ventas_web_detalle
       WHERE doc_ven = :docVen
         AND pedido_web = :pedidoWeb
       ORDER BY linea`,
      { docVen, pedidoWeb },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const resPagos = await conn.execute(
      `SELECT *
       FROM ventas_web_pagos
       WHERE doc_ven = :docVen
         AND pedido_web = :pedidoWeb
       ORDER BY linea`,
      { docVen, pedidoWeb },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return {
      header,
      detalle: resDetalle.rows.map(toLowerKeys),
      pagos: resPagos.rows.map(toLowerKeys)
    };
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }
}

async function cargarVentaPorOrderKeyDesdeDb(orderKey) {
  let conn;
  try {
    conn = await dbVtex.getConnection();

    const resHeader = await conn.execute(
      `SELECT *
       FROM (
         SELECT *
         FROM ventas_web
         WHERE doc_ven = :orderKey
            OR TO_CHAR(pedido_web) = :orderKey
         ORDER BY fecha_registro DESC
       )
       WHERE ROWNUM = 1`,
      { orderKey },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    if (!resHeader.rows.length) {
      throw new Error(`No se encontro '${orderKey}' en ventas_web por doc_ven ni pedido_web`);
    }

    const header = toLowerKeys(resHeader.rows[0]);

    const resDetalle = await conn.execute(
      `SELECT *
       FROM ventas_web_detalle
       WHERE pedido_web = :pedidoWeb
       ORDER BY linea`,
      { pedidoWeb: header.pedido_web },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    const resPagos = await conn.execute(
      `SELECT *
       FROM ventas_web_pagos
       WHERE pedido_web = :pedidoWeb
       ORDER BY linea`,
      { pedidoWeb: header.pedido_web },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );

    return {
      header,
      detalle: resDetalle.rows.map(toLowerKeys),
      pagos: resPagos.rows.map(toLowerKeys)
    };
  } finally {
    if (conn) try { await conn.close(); } catch (_) {}
  }
}

async function sendRequestToSap(request) {
  const client = await getClient();
  const postProcess = (xml) => {
    const processedXml = postProcessSapEnvelope(xml, request);
    console.log('[SAP] XML generado (post-proceso):\n', processedXml);
    return processedXml;
  };

  return client.ZMmCreaPedidosOrlAsync(request, {
    postProcess
  });
}

async function enviarFactura(docVen, pedidoWeb, header, detalle, pagos) {
  try {
    const request = buildRequest(header, detalle, pagos);
    await sendRequestToSap(request);
    await updateStatusSap(docVen, pedidoWeb, 'S', 'Enviado a SAP correctamente');
    console.log(`[SAP] Factura enviada OK — doc_ven: ${docVen}, pedido_web: ${pedidoWeb}`);
  } catch (err) {
    console.error(`[SAP] Error enviando factura doc_ven: ${docVen} —`, err.message);
    _client = null;
    await updateStatusSap(docVen, pedidoWeb, 'E', err.message || String(err));
  }
}

async function enviarFacturaPorOrderKey(orderKey) {
  const { header, detalle, pagos } = await cargarVentaPorOrderKeyDesdeDb(orderKey);
  const request = buildRequest(header, detalle, pagos);

  try {
    const sapResult = await sendRequestToSap(request);
    return {
      header,
      detalle,
      pagos,
      sapResult
    };
  } catch (err) {
    _client = null;
    throw err;
  }
}

async function enviarFacturaDesdeDb(docVen, pedidoWeb) {
  try {
    const { header, detalle, pagos } = await cargarVentaDesdeDb(docVen, pedidoWeb);
    await enviarFactura(docVen, pedidoWeb, header, detalle, pagos);
  } catch (err) {
    console.error(`[SAP] Error cargando venta para envio doc_ven: ${docVen} -`, err.message);
    await updateStatusSap(docVen, pedidoWeb, 'E', err.message || String(err));
  }
}

module.exports = {
  enviarFactura,
  enviarFacturaDesdeDb,
  enviarFacturaPorOrderKey,
  buildRequest,
  normalizeSapEnvelope,
  postProcessSapEnvelope
};
