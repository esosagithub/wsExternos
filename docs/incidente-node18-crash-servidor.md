# Incidente: Node v18.20.8 crashea con `jsonwebtoken` y con `ng build` en el servidor de producción

**Fecha:** 2026-10-13
**Servidor afectado:** servidor Windows de producción (pm2, `C:\ionicProject\ecosystem.config.js`), host `ns.aseyco.com`
**Síntoma inicial:** `POST /vtex/login` en `wsExternos` funcionaba en local pero devolvía `502 Proxy Error: Error reading from remote server` en producción.

## Resumen del root cause

La instalación de **Node v18.20.8** en este servidor tiene un bug real y determinístico (crash nativo tipo *access violation*) que se dispara en más de un contexto distinto:

1. Al llamar `jsonwebtoken`'s `jwt.sign()` con un payload/opciones específicas (en `wsExternos`, endpoint `/vtex/login`).
2. Al compilar con `ng build` / `ionic serve` un proyecto Angular/Ionic (`msnomina`) después de un `git pull` normal, sin cambios de dependencias.

En ambos casos el proceso Node moría **sin ningún rastro**: nada en consola, nada en el Event Log de Windows (`Application Error`), nada en Windows Defender. Cambiar a **Node v20.20.2** resuelve el problema en ambos casos sin tocar el código de ninguno de los dos proyectos.

## Qué se descartó (en orden, con evidencia)

| Hipótesis | Resultado | Evidencia |
|---|---|---|
| Config de variables de entorno faltantes | Descartado | Los 3 pools (Oracle, VTEX, OCACCESS) se creaban bien en cada arranque |
| Proxy Apache/IIS mal configurado | Parcialmente relevante pero no la causa raíz | — |
| `localhost` resolviendo a IPv6 (`::1`) sin que Node escuchara ahí | Era un problema real y separado, se corrigió fijando `app.listen(PORT, '0.0.0.0', ...)` en `src/index.js` | `ECONNREFUSED ::1:3001` reproducido con cliente Node puro |
| Antivirus/EDR matando el proceso por contenido tipo "password" | Descartado | El mismo body con credenciales reales, mandado a una ruta sin lógica de login (`POST /`), no mató nada (404 normal) |
| Node 18 bug en el módulo `crypto` nativo | Descartado | `crypto.createHmac()` con el secreto real funcionó perfecto, standalone |
| `jsonwebtoken` corrupto/mal instalado | Descartado | Reinstalado desde cero (`9.0.3`), mismo crash. Downgrade a `8.5.1` (la versión que ya declaraba `package.json`), mismo crash |
| Estado corrupto del SO (handles, antivirus en mal estado, etc.) | Descartado | **Reinicio completo del servidor** y el crash se reprodujo igual, de cero |
| Payload específico de `jwt.sign()` (nombres/valores de las claims) | Parcialmente — aislado pero no root cause | Bisección exhaustiva: firmar el mismo payload a mano con `crypto` + `Buffer.toString('base64url')` (sin pasar por `jsonwebtoken`) funcionó perfecto. El bug está dentro de la librería/Node, no en el contenido que se firma |
| **Node v18.20.8 en sí (la build/instalación de este servidor)** | **Confirmado como causa raíz** | Mismo código, mismo payload, mismo secreto → funciona con Node v20.20.2, crashea con v18.20.8. Confirmado en dos proyectos totalmente distintos (`wsExternos` y `msnomina`) |

## Fix aplicado (aislado, sin tocar el Node del sistema)

No se reemplazó el Node del sistema (hay 7 apps más corriendo en el mismo pm2 que dependían de él, incluyendo el frontend Ionic/Angular de `contratos_frontend`). En vez de eso:

1. Se descargó el **ZIP** (no el instalador `.msi`) de Node v20.20.2 desde nodejs.org y se extrajo en una carpeta aparte: `C:\nodejs20\node-v20.20.2-win-x64\`. Esto no toca el PATH del sistema ni el Node v18.20.8 existente.
2. En `C:\ionicProject\ecosystem.config.js`, al bloque de `wsExternos` se le agregaron dos líneas:
   ```javascript
   interpreter: "C:/nodejs20/node-v20.20.2-win-x64/node.exe",
   exec_mode: "fork",
   ```
3. **Gotcha importante de pm2:** el `interpreter` personalizado se **ignora silenciosamente** si la app corre en modo `cluster` (que es el modo por defecto cuando se declara `instances` en el ecosystem file, aunque sea `instances: 1`). Hay que forzar `exec_mode: "fork"` junto con `interpreter` para que realmente tome el Node nuevo. Se puede confirmar con `pm2 describe <app>` — si el campo `node.js version` no coincide con el Node nuevo, el `interpreter` no se está aplicando.
4. Se reinició solo esa app (`pm2 delete wsExternos` + `pm2 start ecosystem.config.js --only wsExternos`) — las otras 7 apps no se tocaron y siguen en Node v18.20.8 sin cambios.

Para **msnomina** (Ionic/Angular, no corre bajo pm2 sino con `ionic serve` manual), se creó un `.bat` en la raíz del proyecto que antepone el Node 20 al `PATH` solo para esa sesión:
```bat
@echo off
set "PATH=C:\nodejs20\node-v20.20.2-win-x64;%PATH%"
cd /d C:\ionicProject\msnomina
ionic serve --host 192.168.91.28 --port 8100
```

## Otros hallazgos / gotchas durante la investigación

- **`package.json` de `wsExternos` declaraba `jsonwebtoken: ^8.5.1`, pero el `node_modules` del servidor tenía instalada la `9.0.3`** (fuera de ese rango semver). El `node_modules` del servidor estaba desincronizado de lo que pide el repo — vale la pena correr `npm ci` (no solo `npm install`) en cada deploy para evitar este tipo de drift.
- Editar `ecosystem.config.js` a mano es frágil: una vez se introdujo una coma suelta entre bloques (`},\n,\n{`) que generaba un `<empty item>` en el array `apps`, y eso hacía crashear `pm2 start` con `TypeError: Cannot read properties of undefined (reading 'exec_mode')`. Se puede validar el archivo antes de aplicarlo con:
  ```powershell
  node -e "const cfg = require('C:/ionicProject/ecosystem.config.js'); console.log(cfg.apps.map(a => a.name));"
  ```
  Si aparece algún `<N empty items>` en la lista, hay una coma de más/menos.
- `pm2` necesita correr en una consola **"Ejecutar como Administrador"** — en una consola normal falla con `Error: connect EPERM //./pipe/rpc.sock` al intentar hablar con el daemon.
- Aparte del bug de Node, también existía (y se corrigió) un problema real de ambigüedad `localhost` → IPv6 (`::1`) vs IPv4 (`127.0.0.1`) en `src/index.js`, ahora fijado explícitamente con `app.listen(PORT, '0.0.0.0', ...)`.
- También se agregó un `try/catch` en `login()` (`src/controllers/ventasWebController.js`) que antes no existía — si `jwt.sign()` fallara por configuración faltante, antes tumbaba todo el proceso (por los manejadores globales `uncaughtException`/`unhandledRejection` en `src/index.js`, que hacen `process.exit()` ante cualquier error no controlado de cualquier endpoint).

## Para cuando se planee migrar todo a Node 20

- Apps que **ya corren en Node 20** (vía `interpreter` + `exec_mode: fork` en pm2): `wsExternos`.
- Apps que **siguen en Node v18.20.8 del sistema** (sin cambios): `webserviceVitality`, `webserviceInternos`, `contratos_frontend`, `webAdidasCS`, `conexiones_sap`, `sap-job-monitor`, `fef_envio_facturas`.
- **Ojo con `conexiones_sap`**: usa `instances: 'max'` + `exec_mode: 'cluster'` para repartir carga entre núcleos. El truco de `interpreter` + `exec_mode: 'fork'` que usamos para `wsExternos` **sacrifica el clustering multi-core** (fork mode = una sola instancia). Si se migra esta app a Node 20 habría que investigar otra estrategia para no perder el balanceo (ej. correr varias instancias fork en puertos distintos detrás de un balanceador).
- `msnomina` había tenido problemas previos migrando a Node >18 (motivo no documentado en su momento, por eso se había quedado fijo en v18). Con Node v20.20.2 compiló y sirvió bien en esta prueba, pero falta validar en el navegador las partes que antes fallaban (especialmente lo que usa `canvg`, `html2canvas`, `ng2-pdf-viewer`, `moment`/`date-fns-tz` — son las dependencias más sensibles que aparecieron en los warnings del build).
- Antes de migrar todo de una, considerar también la alternativa de **reinstalar Node v18.20.8 desde cero** (mismo binario oficial) por si la instalación actual del servidor está corrupta a nivel de archivos — eso no se probó, solo se evitó reemplazando con v20 por app.
- Hay un backup del `ecosystem.config.js` previo a estos cambios en `C:\ionicProject\ecosystem.config.js.backup`.
- El Node v20.20.2 standalone vive en `C:\nodejs20\node-v20.20.2-win-x64\node.exe` — no está en el PATH del sistema, hay que referenciarlo con ruta completa o anteponerlo al `PATH` de la sesión.
