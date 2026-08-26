/*
 * Camada de provedor de e-mail: SMTP (nodemailer) ou Brevo (API HTTP).
 * Transporte e credenciais vêm SÓ do .env — o painel não sobrescreve nada disso.
 */
const fs = require('node:fs');
const nodemailer = require('nodemailer');
const { parseEmailList } = require('./utils');

const BREVO_API = process.env.BREVO_API_URL || 'https://api.brevo.com/v3';
const TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 20000);

function text(value) {
  return String(value ?? '').trim();
}

function mailConfig() {
  const configured = text(process.env.MAIL_PROVIDER).toLowerCase();
  const autoDetected = !configured && process.env.BREVO_API_KEY && !process.env.SMTP_HOST ? 'brevo' : 'smtp';
  const provider = ['brevo', 'smtp'].includes(configured) ? configured : autoDetected;
  return {
    provider,
    from: text(process.env.MAIL_FROM) || text(process.env.SMTP_FROM) || text(process.env.SMTP_USER),
    brevoApiKey: text(process.env.BREVO_API_KEY),
    smtp: {
      host: text(process.env.SMTP_HOST),
      port: Number(process.env.SMTP_PORT || 587),
      secure: text(process.env.SMTP_SECURE).toLowerCase() === 'true',
      user: text(process.env.SMTP_USER),
      pass: text(process.env.SMTP_PASS)
    }
  };
}

function mailProvider() {
  return mailConfig().provider;
}

function providerLabel() {
  return mailConfig().provider === 'brevo' ? 'Brevo (API HTTP)' : 'SMTP';
}

function senderAddress() {
  const from = mailConfig().from;
  if (!from) throw new Error('Configure MAIL_FROM no .env com o remetente.');
  return from;
}

function mailConfigured() {
  const config = mailConfig();
  if (!config.from) return false;
  return config.provider === 'brevo' ? Boolean(config.brevoApiKey) : Boolean(config.smtp.host);
}

function parseAddress(value) {
  const raw = text(value);
  const match = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (!match) return { email: raw };
  const name = match[1].trim().replace(/^["']|["']$/g, '').trim();
  return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
}

function addressList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : parseEmailList(value);
  return items.map(parseAddress).filter((item) => item.email);
}

function transport(config = mailConfig()) {
  if (!config.smtp.host) throw new Error('SMTP_HOST não configurado no .env.');
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined
  });
}

async function readBody(res) {
  const body = await res.text();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return { message: body.slice(0, 300) }; }
}

async function brevoRequest(pathname, options = {}, config = mailConfig()) {
  if (!config.brevoApiKey) throw new Error('BREVO_API_KEY não configurada no .env.');
  let res;
  try {
    res = await fetch(`${BREVO_API}${pathname}`, {
      ...options,
      headers: { 'api-key': config.brevoApiKey, accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    throw new Error(`Não foi possível falar com a API do Brevo: ${err.message}`);
  }
  const body = await readBody(res);
  if (!res.ok) throw new Error(`Brevo respondeu HTTP ${res.status}: ${body?.message || body?.code || 'sem detalhe na resposta'}`);
  return body;
}

async function brevoSend(message, config) {
  const payload = {
    sender: parseAddress(message.from),
    to: addressList(message.to),
    subject: message.subject,
    textContent: message.text
  };
  if (!payload.to.length) throw new Error('Nenhum destinatário válido para o envio.');
  const bcc = addressList(message.bcc);
  if (bcc.length) payload.bcc = bcc;
  const attachment = (message.attachments || [])
    .filter((item) => item?.path && fs.existsSync(item.path))
    .map((item) => ({ name: item.filename, content: fs.readFileSync(item.path).toString('base64') }));
  if (attachment.length) payload.attachment = attachment;

  const body = await brevoRequest('/smtp/email', { method: 'POST', body: JSON.stringify(payload) }, config);
  return {
    provider: 'brevo',
    messageId: body?.messageId || body?.messageIds?.[0] || null,
    accepted: payload.to.map((item) => item.email),
    rejected: []
  };
}

async function smtpSend(message, config) {
  const info = await transport(config).sendMail({
    from: message.from,
    to: message.to,
    bcc: message.bcc || undefined,
    subject: message.subject,
    text: message.text,
    attachments: message.attachments || []
  });
  return {
    provider: 'smtp',
    messageId: info.messageId || null,
    accepted: info.accepted || [],
    rejected: info.rejected || []
  };
}

async function sendMail(message) {
  const config = mailConfig();
  return config.provider === 'brevo' ? brevoSend(message, config) : smtpSend(message, config);
}

async function verifyMailer() {
  const config = mailConfig();
  senderAddress();
  if (config.provider === 'brevo') {
    const account = await brevoRequest('/account', {}, config);
    return { ok: true, provider: 'brevo', account: account?.email || account?.companyName || null };
  }
  await transport(config).verify();
  return { ok: true, provider: 'smtp', account: config.smtp.user || null };
}

async function sendTestEmail(to) {
  const recipients = parseEmailList(to);
  if (!recipients.length) throw new Error('Informe ao menos um e-mail de destino para o teste.');
  const config = mailConfig();
  const result = await sendMail({
    from: senderAddress(),
    to: recipients.join(', '),
    subject: 'Teste de e-mail · NFS-e Auto',
    text: [
      'Este é um e-mail de teste do NFS-e Auto Panel.',
      '',
      `Provedor: ${config.provider === 'brevo' ? 'Brevo (API HTTP)' : 'SMTP'}`,
      `Remetente: ${config.from}`,
      '',
      'Nenhuma NFS-e foi emitida para gerar esta mensagem.'
    ].join('\n')
  });
  return { ok: true, provider: result.provider, messageId: result.messageId, recipients };
}

module.exports = {
  mailConfig,
  mailProvider,
  providerLabel,
  mailConfigured,
  senderAddress,
  parseAddress,
  addressList,
  sendMail,
  verifyMailer,
  sendTestEmail
};
