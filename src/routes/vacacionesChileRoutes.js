const express = require('express');
const router = express.Router();
const controller = require('../controllers/vacacionesChileController');
const { uploadPdf } = require('../middleware/uploadPdf');

router.post('/wsGenerarEnviarComprobanteVacacionesChile', controller.generarEnviarComprobante);
router.post('/wsReenviarComprobanteVacacionesChile', controller.reenviarComprobante);
router.post('/wsCargarComprobanteFirmadoChile', uploadPdf('archivo'), controller.cargarComprobanteFirmado);
router.post('/wsObtenerComprobantesVacacionesChile', controller.obtenerComprobantes);
router.post('/wsConfirmarRecepcionComprobanteChile', controller.confirmarRecepcion);

module.exports = router;
