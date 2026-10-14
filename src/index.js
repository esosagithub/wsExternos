require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const db = require('../config/database');
const dbVtex = require('../config/databaseVtex');
const faqRoutes = require('./routes/faqRoutes');
const reportCouponRoutes = require('./routes/reportCouponRoutes');
const qrRoutes = require('./routes/qrRoutes');
const ventasWebRoutes = require('./routes/ventasWebRoutes');


const app = express();
const PORT = process.env.PORT || 3001;
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Origin'],
};

// Middleware
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

// Rutas
app.use('/api/faq', faqRoutes);
app.use('/api', reportCouponRoutes);
app.use('/api', qrRoutes);
app.use('/vtex', ventasWebRoutes);

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({ mensaje: 'API funcionando' });
});

// Ruta para estadísticas del pool (debug)
app.get('/pool-stats', (req, res) => {
  const stats = db.getPoolStatistics();
  res.json(stats || { mensaje: 'Pool no inicializado' });
});

// Inicializar la aplicación
async function startServer() {
  try {
    await db.initialize();
    await dbVtex.initialize();
    // (Report DB eliminado: se usa el pool principal `config/database.js`)
    // Crear el servidor y guardarlo en variable global
    const server = app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });

    // Guardar referencia al servidor
    global.server = server;
    
  } catch (error) {
    console.error('Error al iniciar el servidor:', error);
    process.exit(1);
  }
}

// Manejo de cierre graceful
async function gracefulShutdown(signal) {
  console.log(`\n${signal} recibido. Cerrando aplicación gracefully...`);
  
  try {
    // Cerrar servidor HTTP si existe
    if (global.server) {
      await new Promise((resolve) => {
        global.server.close(() => {
          console.log('Servidor HTTP cerrado');
          resolve();
        });
      });
    }

    // Esperar que terminen las peticiones activas
    console.log('Esperando que terminen las peticiones activas...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Cerrar pools de conexiones
    await db.close();
    await dbVtex.close();
    
    console.log('Aplicación cerrada correctamente');
    process.exit(0);
  } catch (error) {
    console.error('Error durante el cierre:', error);
    process.exit(1);
  }
}

// Capturar señales
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Capturar errores no manejados
process.on('uncaughtException', (error) => {
  console.error('Error no capturado:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Promesa rechazada no manejada:', reason);
  gracefulShutdown('unhandledRejection');
});

startServer();