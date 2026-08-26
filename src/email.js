const fs = require('node:fs');
const { getSettings, getInvoice, updateInvoice, addInvoiceEvent } = require('./db');
const { renderTemplate, parseEmailList, formatDateTimePtBr } = require('./utils');
const { sendMail, verifyMailer, senderAddress, mailProvider, sendTestEmail } = require('./mailer');

async function testMailer() {
  return verifyMailer();
}

function noticeMode(settings) {
  if (!settings.email.notifyOnSent) return 'off';
  const mode = String(settings.email.notifyMode || 'separate');
  return ['separate', 'bcc', 'both'].includes(mode) ? mode : 'separate';
}

function noticeRecipients(settings) {
  const configured = parseEmailList(settings.email.notifyTo);
  if (configured.length) return configured;
  try {
    return [senderAddress()];
  } catch {
    return [];
  }
}

async function sendSentNotice(settings, tplData, attachments) {
  const recipients = noticeRecipients(settings);
  if (!recipients.length) throw new Error('Nenhum destinatário de aviso configurado; preencha “Avisar quem” ou MAIL_FROM.');
  const info = await sendMail({
    from: senderAddress(),
    to: recipients.join(', '),
    subject: renderTemplate(settings.email.notifySubject, tplData),
    text: renderTemplate(settings.email.notifyBody, tplData),
    attachments: settings.email.notifyAttach ? attachments : []
  });
  return { recipients, messageId: info.messageId };
}

async function sendInvoiceEmail(invoiceId) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) throw new Error('Nota não encontrada.');
  const settings = getSettings();
  if (!settings.email.enabled || !invoice.email_enabled) return { skipped: true, reason: 'Envio de e-mail desabilitado.' };
  if (!invoice.client_email) throw new Error('Cliente não possui e-mail cadastrado.');
  if (settings.email.requirePdf && (!invoice.pdf_path || !fs.existsSync(invoice.pdf_path))) {
    throw new Error('PDF/DANFSe ainda não está disponível; e-mail não enviado.');
  }

  const sentAt = new Date();
  const tplData = {
    competence: invoice.competence,
    clientName: invoice.client_name,
    clientDocument: invoice.client_document,
    clientEmail: invoice.client_email,
    nfseNumber: invoice.nfse_number,
    accessKey: invoice.access_key,
    valueCents: invoice.value_cents,
    sentAtLabel: formatDateTimePtBr(sentAt)
  };
  const attachments = [];
  if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) attachments.push({ filename: 'DANFSe.pdf', path: invoice.pdf_path });
  if (settings.email.attachXml && invoice.xml_path && fs.existsSync(invoice.xml_path)) attachments.push({ filename: 'NFS-e.xml', path: invoice.xml_path });

  const from = senderAddress();
  const mode = noticeMode(settings);
  const bcc = mode === 'bcc' || mode === 'both' ? noticeRecipients(settings) : [];

  updateInvoice(invoiceId, { email_attempts: Number(invoice.email_attempts || 0) + 1 });
  const info = await sendMail({
    from,
    to: invoice.client_email,
    bcc: bcc.length ? bcc.join(', ') : undefined,
    subject: renderTemplate(settings.email.subject, tplData),
    text: renderTemplate(settings.email.body, tplData),
    attachments
  });

  const rejected = (info.rejected || []).map((entry) => String(entry?.address || entry).toLowerCase());
  if (rejected.includes(String(invoice.client_email).toLowerCase())) {
    throw new Error(`O servidor SMTP rejeitou o destinatário ${invoice.client_email}.`);
  }

  updateInvoice(invoiceId, { status: 'SENT', email_sent_at: sentAt.toISOString(), last_error: null });
  addInvoiceEvent(invoiceId, 'EMAIL_SENT', `NFS-e enviada para ${invoice.client_email}.`, { provider: mailProvider(), messageId: info.messageId, bcc, rejected });

  const notice = { mode, ok: false };
  if (mode === 'bcc' || mode === 'both') {
    if (!bcc.length) {
      noticeFailed(invoiceId, notice, 'Cópia oculta não enviada: nenhum destinatário de aviso configurado.');
    } else {
      const bccRejected = bcc.filter((address) => rejected.includes(address.toLowerCase()));
      if (bccRejected.length) {
        noticeFailed(invoiceId, notice, `Cópia oculta rejeitada pelo servidor SMTP para: ${bccRejected.join(', ')}.`);
      } else {
        addInvoiceEvent(invoiceId, 'NOTIFY_SENT', `Cópia oculta do e-mail do cliente enviada para ${bcc.join(', ')}.`);
        notice.ok = true;
        notice.bcc = bcc;
      }
    }
  }
  if (mode === 'separate' || mode === 'both') {
    try {
      const sent = await sendSentNotice(settings, tplData, attachments);
      addInvoiceEvent(invoiceId, 'NOTIFY_SENT', `Aviso de envio entregue a ${sent.recipients.join(', ')}.`, { messageId: sent.messageId });
      notice.ok = true;
      notice.recipients = sent.recipients;
    } catch (err) {
      noticeFailed(invoiceId, notice, `NFS-e enviada ao cliente, mas o aviso não saiu: ${err.message}`);
    }
  }

  return { ok: true, messageId: info.messageId, notice };
}

function noticeFailed(invoiceId, notice, message) {
  notice.error = message;
  addInvoiceEvent(invoiceId, 'NOTIFY_ERROR', message);
  updateInvoice(invoiceId, { last_error: message });
}

module.exports = { testMailer, sendInvoiceEmail, sendTestEmail };
