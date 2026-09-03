const express = require('express');
const router = express.Router();
const controller = require('../controllers/ventasWebController');
const { jwtAuth } = require('../middleware/jwtAuth');

router.post('/login', controller.login);
router.post('/refresh', controller.refreshToken);
router.post('/msEnivaSapVtex', controller.msEnivaSapVtex);
router.post('/msEnivaSapVtex/:orderKey', controller.msEnivaSapVtex);
router.post('/ventas', jwtAuth, controller.insertarVenta);
router.get('/pedidos/pendientes', jwtAuth, controller.obtenerPedidosPendientes);
router.post('/pedidos/marcar', jwtAuth, controller.marcarPedidosEnviados);
router.get('/stock', jwtAuth, controller.obtenerStock);
router.get('/precios', jwtAuth, controller.obtenerPrecios);

module.exports = router;
