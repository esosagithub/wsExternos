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
```

## Ejecución

```bash
# Producción
npm start

# Desarrollo (con recarga automática)
npm run dev
```

El servidor arranca en `http://localhost:3001`. Al iniciar se muestran en consola:
```
Pool de conexiones a Oracle creado
Pool de conexiones VTEX creado
Servidor corriendo en http://localhost:3001
```

## Estructura del proyecto

```
wsExternos/
├── config/
│   ├── database.js          # Pool Oracle principal (MS_INVENTARIOS)
│   └── databaseVtex.js      # Pool Oracle VTEX (pedidos_web_vtex)
├── src/
│   ├── index.js             # Punto de entrada, registro de rutas
│   ├── middleware/
│   │   ├── auth.js          # Basic Auth (servicios existentes)
│   │   └── jwtAuth.js       # JWT Bearer Auth (servicio VTEX)
│   ├── routes/
│   │   ├── faqRoutes.js
│   │   ├── reportCouponRoutes.js
│   │   ├── qrRoutes.js
│   │   └── ventasWebRoutes.js   # Servicio VTEX
│   └── controllers/
│       ├── faqController.js
│       ├── reportCouponController.js
│       ├── qrController.js
│       └── ventasWebController.js  # Servicio VTEX
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
| nodemon | ^3.0.1 | Recarga en desarrollo |
