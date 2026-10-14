const ENV = { ...process.env };

function cargarServicio(sendMail) {
  jest.resetModules();
  jest.doMock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail })) }));
  return require('../src/services/mailService');
}

afterEach(() => {
  process.env = { ...ENV };
  jest.useRealTimers();
});

describe('mailService', () => {
  test('587 usa STARTTLS (secure:false, requireTLS:true) y timeouts', () => {
    process.env.SMTP_PORT = '587';
    delete process.env.SMTP_SECURE;
    const o = cargarServicio(jest.fn()).opcionesTransporte();
    expect(o).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(o.connectionTimeout).toBeGreaterThan(0);
    expect(o.socketTimeout).toBeGreaterThan(0);
  });

  test('465 usa TLS implícito (secure:true)', () => {
    process.env.SMTP_PORT = '465';
    delete process.env.SMTP_SECURE;
    expect(cargarServicio(jest.fn()).opcionesTransporte()).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  test('reintenta ante ECONNRESET y termina enviando', async () => {
    jest.useFakeTimers();
    const sendMail = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ESOCKET' }))
      .mockResolvedValueOnce({ messageId: 'ok' });
    const mail = cargarServicio(sendMail);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const p = mail.enviarCorreo({ to: 'a@b.cl', subject: 's', html: 'h' });
    await jest.advanceTimersByTimeAsync(2000);

    await expect(p).resolves.toEqual({ messageId: 'ok' });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  test('no reintenta errores de autenticación', async () => {
    const sendMail = jest.fn().mockRejectedValue(Object.assign(new Error('535 Authentication unsuccessful'),
      { code: 'EAUTH', responseCode: 535 }));
    const mail = cargarServicio(sendMail);
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(mail.enviarCorreo({ to: 'a@b.cl', subject: 's', html: 'h' })).rejects.toThrow('535');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('describirError incluye code, command y response', () => {
    const { describirError } = cargarServicio(jest.fn());
    const err = Object.assign(new Error('fallo'), { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.1.1' });
    expect(describirError(err)).toBe('fallo [code=EENVELOPE, command=RCPT TO, responseCode=550, response=550 5.1.1]');
  });
});

