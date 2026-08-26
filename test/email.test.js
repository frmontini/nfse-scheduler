const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.SMTP_HOST = 'smtp.exemplo.com';
process.env.SMTP_FROM = 'financeiro@exemplo.com';

const scenario = { settings: null, invoice: null, events: [], sent: [], sendResult: null };

const fakeDb = {
  getSettings: () => scenario.settings,
  getInvoice: () => scenario.invoice,
  updateInvoice: (id, patch) => Object.assign(scenario.invoice, patch),
  addInvoiceEvent: (id, type, message, details) => scenario.events.push({ type, message, details })
};
const fakeMailer = {
  mailProvider: () => 'smtp',
  senderAddress: () => process.env.SMTP_FROM,
  verifyMailer: async () => ({ ok: true, provider: 'smtp' }),
  sendMail: async (message) => {
    scenario.sent.push(message);
    return scenario.sendResult(message, scenario.sent.length - 1);
  }
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === './mailer') return fakeMailer;
  if (request === './db') return fakeDb;
  return originalLoad.call(this, request, ...rest);
};
const { sendInvoiceEmail } = require('../src/email');
Module._load = originalLoad;

function setup(emailSettings = {}) {
  scenario.settings = {
    scheduler: { timezone: 'America/Sao_Paulo' },
    email: {
      enabled: true, requirePdf: false, attachXml: true,
      subject: 'NFS-e {MES}/{ANO}', body: 'Segue a nota.',
      notifyOnSent: true, notifyMode: 'separate', notifyTo: 'chefe@empresa.com', notifyAttach: false,
      notifySubject: 'NFS-e {NUMERO} enviada para {CLIENTE}',
      notifyBody: 'Enviada para {CLIENTE} ({EMAIL}) em {DATA}.',
      ...emailSettings
    }
  };
  scenario.invoice = {
    id: 1, competence: '2026-08', status: 'ISSUED', email_enabled: 1, email_attempts: 0,
    client_name: 'ACME', client_document: '00000000000191', client_email: 'cliente@acme.com',
    nfse_number: '123', access_key: 'CHAVE', value_cents: 50000, pdf_path: null, xml_path: null
  };
  scenario.events = [];
  scenario.sent = [];
  scenario.sendResult = () => ({ messageId: 'ok', rejected: [] });
}

test('aviso separado sai depois do e-mail do cliente', async () => {
  setup();
  const result = await sendInvoiceEmail(1);
  assert.equal(scenario.sent.length, 2);
  assert.equal(scenario.sent[0].to, 'cliente@acme.com');
  assert.equal(scenario.sent[0].bcc, undefined);
  assert.equal(scenario.sent[1].to, 'chefe@empresa.com');
  assert.equal(scenario.sent[1].subject, 'NFS-e 123 enviada para ACME');
  assert.match(scenario.sent[1].text, /Enviada para ACME \(cliente@acme\.com\) em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}\./);
  assert.equal(scenario.invoice.status, 'SENT');
  assert.equal(result.notice.ok, true);
  assert.deepEqual(scenario.events.map((e) => e.type), ['EMAIL_SENT', 'NOTIFY_SENT']);
});

test('modo cópia oculta manda um único e-mail com BCC', async () => {
  setup({ notifyMode: 'bcc', notifyTo: 'chefe@empresa.com, socio@empresa.com' });
  await sendInvoiceEmail(1);
  assert.equal(scenario.sent.length, 1);
  assert.equal(scenario.sent[0].bcc, 'chefe@empresa.com, socio@empresa.com');
  assert.equal(scenario.invoice.status, 'SENT');
  assert.deepEqual(scenario.events.map((e) => e.type), ['EMAIL_SENT', 'NOTIFY_SENT']);
});

test('sem destinatário configurado o aviso usa SMTP_FROM', async () => {
  setup({ notifyTo: '' });
  await sendInvoiceEmail(1);
  assert.equal(scenario.sent[1].to, 'financeiro@exemplo.com');
});

test('falha no aviso não desfaz o envio ao cliente', async () => {
  setup();
  scenario.sendResult = (message, index) => {
    if (index === 1) throw new Error('caixa do aviso indisponível');
    return { messageId: 'ok', rejected: [] };
  };
  const result = await sendInvoiceEmail(1);
  assert.equal(result.ok, true);
  assert.equal(result.notice.ok, false);
  assert.equal(scenario.invoice.status, 'SENT');
  assert.match(scenario.invoice.last_error, /aviso não saiu/);
  assert.deepEqual(scenario.events.map((e) => e.type), ['EMAIL_SENT', 'NOTIFY_ERROR']);
});

test('destinatário rejeitado pelo SMTP vira erro de e-mail', async () => {
  setup();
  scenario.sendResult = () => ({ messageId: 'ok', rejected: ['cliente@acme.com'] });
  await assert.rejects(() => sendInvoiceEmail(1), /rejeitou o destinatário/);
  assert.notEqual(scenario.invoice.status, 'SENT');
  assert.equal(scenario.events.length, 0);
});

test('aviso desligado não gera e-mail extra', async () => {
  setup({ notifyOnSent: false });
  await sendInvoiceEmail(1);
  assert.equal(scenario.sent.length, 1);
  assert.deepEqual(scenario.events.map((e) => e.type), ['EMAIL_SENT']);
});
