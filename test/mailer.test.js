const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.BREVO_API_URL = 'https://api.brevo.test/v3';
process.env.BREVO_API_KEY = 'chave-de-teste';
process.env.MAIL_FROM = 'NFS-e Auto <financeiro@exemplo.com>';
delete process.env.SMTP_HOST;

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'nodemailer') return { createTransport: () => ({ sendMail: async () => ({}), verify: async () => true }) };
  return originalLoad.call(this, request, ...rest);
};
const mailer = require('../src/mailer');
Module._load = originalLoad;

let calls = [];
let nextResponse = null;
global.fetch = async (url, init) => {
  calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
  return nextResponse();
};
function respond(status, body) {
  nextResponse = () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}

test.beforeEach(() => {
  calls = [];
  respond(201, { messageId: '<abc@brevo>' });
  process.env.MAIL_PROVIDER = 'brevo';
});

test('escolhe o provedor pela flag MAIL_PROVIDER', () => {
  process.env.MAIL_PROVIDER = 'brevo';
  assert.equal(mailer.mailProvider(), 'brevo');
  process.env.MAIL_PROVIDER = 'smtp';
  assert.equal(mailer.mailProvider(), 'smtp');
  process.env.MAIL_PROVIDER = '';
  assert.equal(mailer.mailProvider(), 'brevo', 'sem flag, cai no Brevo quando só ele está configurado');
  process.env.MAIL_PROVIDER = 'qualquer-coisa';
  assert.equal(mailer.mailProvider(), 'smtp', 'valor inválido cai no padrão seguro');
});

test('separa nome e e-mail do remetente', () => {
  assert.deepEqual(mailer.parseAddress('NFS-e Auto <fin@exemplo.com>'), { name: 'NFS-e Auto', email: 'fin@exemplo.com' });
  assert.deepEqual(mailer.parseAddress('fin@exemplo.com'), { email: 'fin@exemplo.com' });
  assert.deepEqual(mailer.addressList('a@x.com, b@y.com'), [{ email: 'a@x.com' }, { email: 'b@y.com' }]);
});

test('monta o payload da API do Brevo', async () => {
  const result = await mailer.sendMail({
    from: mailer.senderAddress(),
    to: 'cliente@acme.com',
    bcc: 'chefe@empresa.com',
    subject: 'NFS-e 123',
    text: 'Segue a nota.',
    attachments: [{ filename: 'teste.js', path: __filename }]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.brevo.test/v3/smtp/email');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['api-key'], 'chave-de-teste');
  assert.deepEqual(calls[0].body.sender, { name: 'NFS-e Auto', email: 'financeiro@exemplo.com' });
  assert.deepEqual(calls[0].body.to, [{ email: 'cliente@acme.com' }]);
  assert.deepEqual(calls[0].body.bcc, [{ email: 'chefe@empresa.com' }]);
  assert.equal(calls[0].body.textContent, 'Segue a nota.');
  assert.equal(calls[0].body.attachment[0].name, 'teste.js');
  assert.ok(calls[0].body.attachment[0].content.length > 0);
  assert.equal(result.provider, 'brevo');
  assert.equal(result.messageId, '<abc@brevo>');
  assert.deepEqual(result.rejected, []);
});

test('erro da API do Brevo vira mensagem legível', async () => {
  respond(401, { code: 'unauthorized', message: 'Key not found' });
  await assert.rejects(
    () => mailer.sendMail({ from: mailer.senderAddress(), to: 'cliente@acme.com', subject: 'x', text: 'y' }),
    /Brevo respondeu HTTP 401: Key not found/
  );
});

test('teste de conexão do Brevo consulta a conta', async () => {
  respond(200, { email: 'conta@empresa.com' });
  const result = await mailer.verifyMailer();
  assert.equal(calls[0].url, 'https://api.brevo.test/v3/account');
  assert.deepEqual(result, { ok: true, provider: 'brevo', account: 'conta@empresa.com' });
});
