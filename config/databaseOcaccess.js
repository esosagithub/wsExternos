const oracledb = require('oracledb');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const ocaccessConfig = {
  user: process.env.DB_USER_OCACCESS,
  password: process.env.DB_PASSWORD_OCACCESS,
  connectString: process.env.DB_CONNECT_STRING_OCACCESS,
  poolAlias: 'ocaccess',
  poolMin: 0,
  poolMax: 5,
  poolIncrement: 1
};

async function initialize() {
  try {
    await oracledb.createPool(ocaccessConfig);
    console.log('Pool de conexiones OCACCESS creado');
  } catch (err) {
    console.error('⚠️  Pool OCACCESS no pudo iniciarse:', err.message);
    // No se mata el servidor — el error se reportará al usar el servicio
  }
}

async function getConnection() {
  try {
    return await oracledb.getPool('ocaccess').getConnection();
  } catch (err) {
    console.error('Error al obtener conexión OCACCESS:', err);
    throw err;
  }
}

async function close() {
  try {
    await oracledb.getPool('ocaccess').close();
    console.log('Pool OCACCESS cerrado');
  } catch (err) {
    console.error('Error al cerrar el pool OCACCESS:', err);
  }
}

module.exports = { initialize, getConnection, close };
