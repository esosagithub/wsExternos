# WS Externos

API REST para servicios de ventas web, construida con Node.js + Express y Oracle Database.

## Requisitos

- Node.js 14 o superior
- Oracle Instant Client 19.x (`C:\oracle\instantclient_19_28`)
- Acceso a la base de datos Oracle

## Instalación

```bash
npm install
```

## Variables de entorno

Crear el archivo `.env` en la raíz del proyecto:

```env
# Base de datos principal
DB_USER=MS_INVENTARIOS
DB_PASSWORD=MS_INVENTARIOS
DB_CONNECT_STRING=<host>:<puerto>/<servicio>

# Puerto de la aplicación
PORT=3001

# Autenticación Basic Auth (servicios existentes)
AUTH_USERNAME=<usuario>
AUTH_PASSWORD=<contraseña>

# Base de datos VTEX (pedidos_web_vtex)
DB_USER_VTEX=pedidos_web_vtex
DB_PASSWORD_VTEX=<contraseña>
DB_CONNECT_STRING_VTEX=<host>:<puerto>/<servicio>

# JWT — Servicio Ventas Web VTEX
JWT_SECRET=<clave_generada_con_crypto.randomBytes(64).toString('hex')>
JWT_EXPIRES_IN=4m
JWT_REFRESH_EXPIRES_IN=5m
VTEX_JWT_USERNAME=<usuario_vtex>
VTEX_JWT_PASSWORD=<contraseña_vtex>

# Base de datos OCACCESS (vacaciones Chile)
DB_USER_OCACCESS=OCACCESS
DB_PASSWORD_OCACCESS=<contraseña>
DB_CONNECT_STRING_OCACCESS=<host>:<puerto>/<servicio>

# Comprobante de vacaciones Chile
VACACIONES_CHILE_PDF_PATH=C:/java/wildfly-20.0.1.Final/welcome-content/nomina/Chile
VACACIONES_CHILE_PUBLIC_URL=https://ns.aseyco.com:444/nomina/Chile
VACACIONES_PDF_MAX_BYTES=10485760
COLABORADORES_PAIS_TABLE=SAP_HCM.COLABORADORES_PAIS

# Correo (Office 365, STARTTLS)
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=buxis@ec.aseyco.com
SMTP_PASSWORD=<contraseña>
SMTP_FROM=buxis@ec.aseyco.com
SMTP_CC=
```

## Ejecución

```bash
# Producción
npm start

# Desarrollo (con recarga automática)
npm run dev

# Pruebas unitarias
npm test
```

El servidor arranca en `http://localhost:3001`. Al iniciar se muestran en consola:
```
Pool de conexiones a Oracle creado
Pool de conexiones VTEX creado
Pool de conexiones OCACCESS creado
Servidor corriendo en http://localhost:3001
```

## Estructura del proyecto

```
wsExternos/
├── config/
│   ├── database.js          # Pool Oracle principal (MS_INVENTARIOS)
│   ├── databaseVtex.js      # Pool Oracle VTEX (pedidos_web_vtex)
│   └── databaseOcaccess.js  # Pool Oracle OCACCESS (vacaciones Chile)
├── src/
│   ├── index.js             # Punto de entrada, registro de rutas
│   ├── middleware/
│   │   ├── auth.js          # Basic Auth (servicios existentes)
│   │   └── jwtAuth.js       # JWT Bearer Auth (servicio VTEX)
│   ├── routes/
│   │   ├── faqRoutes.js
│   │   ├── reportCouponRoutes.js
│   │   ├── qrRoutes.js
│   │   ├── ventasWebRoutes.js   # Servicio VTEX
│   │   └── vacacionesChileRoutes.js  # Comprobante vacaciones Chile
│   ├── repositories/
│   │   └── comprobanteVacacionesRepository.js
│   ├── services/
│   │   ├── comprobanteVacacionesChileService.js
│   │   ├── comprobantePdfService.js  # PDFKit
│   │   └── mailService.js            # nodemailer
│   └── controllers/
│       ├── faqController.js
│       ├── reportCouponController.js
│       ├── qrController.js
│       ├── ventasWebController.js  # Servicio VTEX
│       └── vacacionesChileController.js
├── tests/
│   └── comprobanteVacacionesChile.test.js
├── docs/
│   └── api-ventas-web.html  # Documentación del servicio VTEX
├── .env
├── package.json
└── README.md
```

## Servicios disponibles

### Servicios auxiliares — Basic Auth — `/api/*`

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET/POST | `/api/faq/*` | Consulta de FAQs |
| POST | `/api/report/coupons` | Reporte de cupones |
| POST | `/api/generar-qr` | Generación de código QR |

**Autenticación:** `Authorization: Basic <base64(usuario:contraseña)>`

---

### Servicio Ventas Web VTEX — JWT Bearer — `/vtex/*`

Inserta registros de ventas en la tabla `ventas_web` del esquema Oracle `pedidos_web_vtex`.

**URL de producción:** `https://ns.aseyco.com:444/picking/vtex`

**Documentación completa:** `docs/api-ventas-web.html`

| Método | Endpoint | Auth | Descripción |
|--------|----------|------|-------------|
| POST | `/vtex/login` | No | Obtiene access_token y refresh_token |
| POST | `/vtex/refresh` | No | Renueva tokens con refresh_token vigente |
| POST | `/vtex/ventas` | Bearer | Inserta un registro de venta |

**Flujo de autenticación:**
```
POST /vtex/login  →  { access_token (4min), refresh_token (5min) }
                         ↓
POST /vtex/ventas  Authorization: Bearer <access_token>
                         ↓  (si 401 TOKEN_EXPIRED)
POST /vtex/refresh  { refresh_token }  →  nuevos tokens
                         ↓  (si 401 REFRESH_EXPIRED)
POST /vtex/login  (re-login)
```

**Campos requeridos en `/vtex/ventas`:**
Cabecera: `doc_ven`, `pedido_web`, `empresa`, `centro`, `almacen`, `status`, `cliente_ci`, `cliente_nombre`, `cliente_tipo`, `cliente_telefono`, `cliente_direcion`, `cliente_mail`.

Detalle: `linea`, `cantidad`, `precio`, `codigo`, `detalle`, `descuento`, `precio_original`, `iva`, `valor_iva`, `ean`, `unidad_medida`.

Pagos: `linea`, `pago_tc`, `subtotal_tc`, `iva_tc`.

La estructura vigente inserta cada campo exactamente como llega en el JSON, sin interpretar ni usar `dato1`-`dato20` como sustitutos de otros campos. Campos nuevos de `ventas_web`: `fac_total`, `fac_subtotal`, `fac_iva`, `fac_descuento`, direcciones codificadas de cliente/facturacion y datos de pickup; en `detalle[]`: `unidad_medida`, `promotion_code`, `promotion_type`, `promotion_group`; y en `pagos[]`: `subtotal_tc`, `iva_tc`, `paymetodo`.

---

### Comprobante de vacaciones Chile — `/api/*`

**URL de producción:** `https://ns.aseyco.com:444/picking/api/wsGenerarEnviarComprobanteVacacionesChile` (el proxy quita `/picking`)

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/wsGenerarEnviarComprobanteVacacionesChile` | Genera el comprobante PDF de una solicitud aprobada por Nómina, lo envía por correo y registra la notificación |
| POST | `/api/wsReenviarComprobanteVacacionesChile` | Reintenta solo el correo con el PDF ya generado (no lo regenera) |
| POST | `/api/wsCargarComprobanteFirmadoChile` | El colaborador carga el PDF firmado (`multipart/form-data`) |
| POST | `/api/wsObtenerComprobantesVacacionesChile` | Consulta de comprobantes (colaborador: los suyos; Nómina: todos los de Chile) |
| POST | `/api/wsConfirmarRecepcionComprobanteChile` | Nómina recibe o rechaza el comprobante firmado |

**Ciclo de estados (`ESTADO_DOCUMENTO`):**
```
GENERADO ──correo──▶ PENDIENTE_FIRMA ──carga firmado──▶ PENDIENTE_RECEPCION ──Nómina──▶ RECIBIDO
                                                              ▲                     │
                                                              └──nueva carga── RECHAZADO
```

Entrada: `{ "id_solicitud": 3459, "ci_rrhh": "<CI usuario Nómina>" }`

- Valida en `OCACCESS.MS_VACACIONES` que la solicitud exista (404), sea de Chile (`CHILE`/`CL`, 422), tenga `TIPO_REGISTRO = SOLICITUD` (422) y `ESTADO_APROBACION_RRHH = APROBADA` (409).
- Los datos del PDF se leen solo de `MS_VACACIONES` y `MS_VACACIONES_PERIODO`.
- Es idempotente: si ya existe el registro en `MS_VACACIONES_COMPROBANTE` con su archivo físico, no se regenera; si `ESTADO_ENVIO_EMAIL = ENVIADO`, no se reenvía.
- El PDF se escribe en un temporal, se calcula su SHA-256 y se renombra a `comprobante_vacaciones_{id}_{uuid}.pdf`.
- El correo del colaborador se obtiene de `SAP_HCM.COLABORADORES_PAIS` (empresarial; si no hay, personal). El PDF va adjunto desde la ruta física.
- Si el correo falla, responde 502 con `estadoEmail: "ERROR"`; una nueva llamada reintenta sin regenerar el documento.
- El ID (`SEQ_MS_VAC_COMP`) y la auditoría (`A_MS_VACACIONES_COMPROBANTE`) los gestionan triggers de la base.

Respuesta exitosa:
```json
{ "ok": true, "idSolicitud": 3459, "idComprobante": 123, "estadoDocumento": "PENDIENTE_FIRMA",
  "estadoEmail": "ENVIADO", "nombreArchivo": "...pdf", "urlPublica": "https://ns.aseyco.com:444/nomina/Chile/...pdf" }
```

#### Reenvío del correo — `wsReenviarComprobanteVacacionesChile`

**URL de producción:** `https://ns.aseyco.com:444/picking/api/wsReenviarComprobanteVacacionesChile`

Entrada: `{ "id_solicitud": 3459, "ci_rrhh": "<CI usuario Nómina>", "forzar": false }` (`forzar` es opcional).

Reintenta solo el correo: nunca genera ni reemplaza el PDF.

| HTTP | Código | Caso |
|------|--------|------|
| 200 | — | Correo enviado (`reenviado: true`, `PENDIENTE_FIRMA`), o ya estaba `ENVIADO` y no se pidió `forzar` (`reenviado: false`) |
| 400 | `MISSING_FIELD` / `INVALID_FIELD` | Body inválido (`forzar` debe ser booleano) |
| 403 | `SIN_PERMISO_NOMINA` | `ci_rrhh` no está en `MS_USUARIOS_TI.PERFILES_VACACIONES_VIEW_CHILE` |
| 404 | `SOLICITUD_NO_EXISTE` / `COMPROBANTE_NO_EXISTE` | No existe la solicitud o aún no se generó el comprobante |
| 409 | `COMPROBANTE_YA_FIRMADO` | El colaborador ya cargó el firmado (`PENDIENTE_RECEPCION`, `RECIBIDO` o `FIRMADO`) |
| 409 | `ARCHIVO_NO_DISPONIBLE` / `ARCHIVO_HASH_INVALIDO` | Falta el archivo físico o no coincide con `HASH_ARCHIVO_GENERADO`; no se envía nada |
| 502 | `EMAIL_ERROR` | Falló el envío: queda `ESTADO_ENVIO_EMAIL = ERROR` con el error y los intentos incrementados |

La notificación al colaborador solo se registra si nunca hubo un envío exitoso; un reenvío con `forzar` no la duplica.

#### Carga del comprobante firmado — `wsCargarComprobanteFirmadoChile`

**URL de producción:** `https://ns.aseyco.com:444/picking/api/wsCargarComprobanteFirmadoChile`

`multipart/form-data` con los campos `id_solicitud`, `ci_solicitante` y `archivo` (exactamente un PDF, máximo `VACACIONES_PDF_MAX_BYTES`, 10 MB por defecto).

- Valida el Content-Type `application/pdf` **y** la firma binaria `%PDF-`. El nombre recibido se sanitiza y solo se usa en el log.
- `ci_solicitante` debe coincidir con `MS_VACACIONES.CI_SOLICITANTE` (se compara sin puntos ni guion).
- Solo se permite si `ESTADO_DOCUMENTO` es `PENDIENTE_FIRMA` o `RECHAZADO`.
- El firmado reemplaza al generado en la misma `RUTA_FISICA`, así que la `URL_PUBLICA` no cambia: temporal → SHA-256 → original a `.bak` → firmado a la ruta definitiva → `UPDATE` y notificación → commit → se borra el `.bak`. Si Oracle falla, se restaura el original desde el `.bak`.
- Actualiza `TIPO_ARCHIVO_ACTUAL = FIRMADO`, `ESTADO_DOCUMENTO = PENDIENTE_RECEPCION`, `VERSION_ARCHIVO + 1`, `HASH_ARCHIVO_FIRMADO`, `TAMANIO_FIRMADO`, `CI_USUARIO_CARGA` y `FECHA_CARGA_FIRMADO`, y limpia la recepción anterior. `HASH_ARCHIVO_GENERADO` se conserva para auditoría.

| HTTP | Código | Caso |
|------|--------|------|
| 200 | — | `{ ok, idSolicitud, idComprobante, estadoDocumento, tipoArchivo, urlPublica, fechaCarga }` |
| 400 | `MISSING_FIELD` / `INVALID_FIELD` / `ARCHIVO_REQUERIDO` / `ARCHIVO_UNICO` | Campos inválidos, sin archivo o más de uno |
| 403 | `NO_PROPIETARIO` | La solicitud no pertenece a `ci_solicitante` |
| 404 | `SOLICITUD_NO_EXISTE` / `COMPROBANTE_NO_EXISTE` | No existe la solicitud o su comprobante |
| 409 | `ESTADO_NO_PERMITE_CARGA` | Ya cargado (`PENDIENTE_RECEPCION`, `RECIBIDO`) o en `GENERADO` |
| 413 | `ARCHIVO_DEMASIADO_GRANDE` | Supera el máximo |
| 415 | `ARCHIVO_NO_PDF` | No es `application/pdf` o no empieza con `%PDF-` |
| 500 | `ERROR_DISCO` | Falló la escritura; el original queda intacto |

#### Consulta de comprobantes — `wsObtenerComprobantesVacacionesChile`

**URL de producción:** `https://ns.aseyco.com:444/picking/api/wsObtenerComprobantesVacacionesChile`

```json
{
  "ci_usuario": "CI del usuario autenticado",
  "id_solicitud": null,
  "ci_solicitante": null,
  "estado_documento": null,
  "pendientes_nomina": false,
  "verificar_archivo": true,
  "limite": 100,
  "pagina": 1
}
```
Solo `ci_usuario` es obligatorio.

- **Nómina** (`ci_usuario` en `MS_USUARIOS_TI.PERFILES_VACACIONES_VIEW_CHILE`): consulta cualquier solicitud de Chile y puede usar `pendientes_nomina: true` (solo `PENDIENTE_RECEPCION`).
- **Colaborador:** siempre se filtra por su propio RUT. Pedir otro `ci_solicitante` → 403 `NO_PROPIETARIO`; `pendientes_nomina` → 403 `SOLO_NOMINA`.
- Lee `OCACCESS.VW_VACACIONES_COMP_CHILE`, limitada a `PAIS` CHILE/CL. Incluye solicitudes sin comprobante (`idComprobante: null`).
- Usa una consulta fija con binds; los filtros nunca se concatenan.
- Ordena por `FECHA_CARGA_FIRMADO` o `FECHA_GENERACION`, de la más reciente a la más antigua.
- `fechaRecepcion` y `observacionRecepcion`: fecha y observación de la última decisión de Nómina (recibir o rechazar) sobre el firmado vigente; `null` si no hay. Al cargar una corrección se limpian (el historial queda en `A_MS_VACACIONES_COMPROBANTE`), así que con `PENDIENTE_RECEPCION` siempre son `null`.
- `urlPublica` solo se devuelve si el archivo existe (`archivoDisponible: true`). Con `verificar_archivo: false` no se revisa el disco, `archivoDisponible` es `null` y se devuelve la URL registrada.
- Paginación: `limite` (100 por defecto, máximo 1000) y `pagina`. La respuesta incluye `paginacion: { pagina, limite, total }`.

#### Recepción por Nómina — `wsConfirmarRecepcionComprobanteChile`

**URL de producción:** `https://ns.aseyco.com:444/picking/api/wsConfirmarRecepcionComprobanteChile`

```json
{ "id_solicitud": 3459, "id_comprobante": 123, "ci_rrhh": "CI de Nómina", "accion": "RECIBIR", "observacion": null }
```
- `accion`: `RECIBIR` o `RECHAZAR`.
- `observacion`: opcional al recibir, **obligatoria al rechazar**; máximo 1000 bytes, y las letras con tilde cuentan doble.

Reglas:
- `ci_rrhh` debe tener perfil de Nómina Chile.
- El comprobante debe pertenecer a la solicitud, ser `FIRMADO` y estar en `PENDIENTE_RECEPCION`.
- El archivo físico debe existir y su SHA-256 debe coincidir con `HASH_ARCHIVO_FIRMADO`.
- El `UPDATE` es condicional (`AND ESTADO_DOCUMENTO = 'PENDIENTE_RECEPCION'`) y se exige `rowsAffected = 1`, así una segunda confirmación responde 409.
- Guarda `CI_RRHH_RECEPCION`, `FECHA_RECEPCION = SYSDATE` y `OBSERVACION_RECEPCION`.
- Notifica al colaborador. Al rechazar, la notificación incluye el motivo (recortado a 500 bytes) y le pide cargarlo de nuevo con `wsCargarComprobanteFirmadoChile`, que reemplaza el mismo archivo y conserva la URL.

| HTTP | Código | Caso |
|------|--------|------|
| 200 | — | `{ ok, idSolicitud, estadoDocumento, fechaRecepcion, ciRrhhRecepcion }` |
| 400 | `OBSERVACION_REQUERIDA` / `INVALID_FIELD` / `MISSING_FIELD` | Rechazo sin motivo o entrada inválida |
| 403 | `SIN_PERMISO_NOMINA` | `ci_rrhh` sin perfil de Nómina Chile |
| 404 | `COMPROBANTE_NO_EXISTE` | No existe el comprobante |
| 409 | `COMPROBANTE_NO_PERTENECE` / `COMPROBANTE_NO_FIRMADO` / `ESTADO_NO_PERMITE_RECEPCION` | Otra solicitud, aún no firmado, o ya confirmado (doble confirmación o concurrencia) |
| 409 | `ARCHIVO_NO_DISPONIBLE` / `ARCHIVO_HASH_INVALIDO` | Falta el archivo o fue alterado |

---

## Rutas de diagnóstico

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/` | Estado de la API |
| GET | `/pool-stats` | Estadísticas del pool Oracle principal |

## Dependencias principales

| Paquete | Versión | Uso |
|---------|---------|-----|
| express | ^4.18.2 | Framework HTTP |
| oracledb | ^6.0.0 | Conector Oracle |
| jsonwebtoken | ^9.0.3 | JWT (servicio VTEX) |
| dotenv | ^16.0.3 | Variables de entorno |
| pdfkit | ver package.json | PDF del comprobante de vacaciones Chile |
| nodemailer | ver package.json | Envío de correo (Office 365) |
| jest | ver package.json | Pruebas unitarias |
| nodemon | ^3.0.1 | Recarga en desarrollo |
