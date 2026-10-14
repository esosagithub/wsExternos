const multer = require('multer');

// multipart/form-data con exactamente un archivo en memoria (tamaño máximo configurable)
function uploadPdf(campo) {
  return (req, res, next) => {
    const maxBytes = Number(process.env.VACACIONES_PDF_MAX_BYTES) || 10 * 1024 * 1024;
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: maxBytes, files: 1, fields: 10, fieldSize: 1024, parts: 11 }
    }).single(campo);

    upload(req, res, (err) => {
      if (!err) return next();

      let status = 400;
      let code = 'MULTIPART_INVALIDO';
      let message = err.message;
      if (err.code === 'LIMIT_FILE_SIZE') {
        status = 413;
        code = 'ARCHIVO_DEMASIADO_GRANDE';
        message = `El archivo supera el máximo permitido (${maxBytes} bytes)`;
      } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        code = 'ARCHIVO_UNICO';
        message = `Debe enviar exactamente un archivo en el campo "${campo}"`;
      }
      return res.status(status).json({ ok: false, status: 'ERROR', error: { code, message } });
    });
  };
}

module.exports = { uploadPdf };
