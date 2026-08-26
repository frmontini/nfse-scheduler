const {
  getSettings,
  listAutomations,
  getAutomation,
  getInvoice,
  getInvoiceByAutomationCompetence,
  createInvoice,
  updateInvoice,
  addInvoiceEvent,
  listRetryableDocuments,
  listRetryableEmails
} = require('./db');
const { zonedParts, scheduledDay, competenceFor, defaultTimezone } = require('./utils');
const { previewInvoice, issueInvoice, retrieveDocuments } = require('./emitter/national');
const { sendInvoiceEmail } = require('./email');

let workerBusy = false;

function todayContext() {
  const timezone = defaultTimezone();
  return { ...zonedParts(new Date(), timezone), timezone };
}

function dueInfo(automation, ctx) {
  const day = scheduledDay(ctx.year, ctx.month, automation.day_of_month);
  const scheduledDate = `${ctx.year}-${String(ctx.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const competence = competenceFor(ctx);
  // Cadastrar hoje uma automação que começa no mês que vem não pode disparar
  // a competência atual: a data agendada precisa alcançar a primeira emissão.
  const comecou = !automation.start_date || scheduledDate >= automation.start_date;
  return { day, scheduledDate, competence, startDate: automation.start_date || null, due: comecou && ctx.day >= day };
}

function ensureInvoiceForAutomation(automation, ctx, { ignoreDue = false } = {}) {
  const due = dueInfo(automation, ctx);
  if (!ignoreDue && !due.due) return null;
  return createInvoice({
    automationId: automation.id,
    clientId: automation.client_id,
    competence: due.competence,
    scheduledDate: due.scheduledDate,
    valueCents: automation.value_cents,
    discountIncondCents: automation.discount_incond_cents,
    discountCondCents: automation.discount_cond_cents
  });
}

async function processInvoice(invoiceId, { allowEmission = false } = {}) {
  let invoice = getInvoice(invoiceId);
  if (!invoice) throw new Error('Nota agendada não encontrada.');
  const automation = getAutomation(invoice.automation_id);
  if (!automation) throw new Error('Automação vinculada não encontrada.');

  if (['SENT', 'ISSUED', 'SUBMITTING', 'REVIEW_REQUIRED'].includes(invoice.status)) return invoice;
  if (invoice.submitted_at) {
    updateInvoice(invoice.id, { status: 'REVIEW_REQUIRED', last_error: 'Registro já ultrapassou a fronteira de envio ao portal; reemissão automática bloqueada.' });
    return getInvoice(invoice.id);
  }
  if (!allowEmission) return invoice;

  updateInvoice(invoice.id, { status: 'PROCESSING', last_error: null });
  addInvoiceEvent(invoice.id, 'PROCESSING', 'Iniciando preenchimento da Emissão Completa.');

  try {
    const result = await issueInvoice({ automation, invoice: getInvoice(invoice.id) });
    const missingPdf = !result.pdfPath;
    const status = missingPdf ? 'DOCUMENT_ERROR' : 'ISSUED';
    updateInvoice(invoice.id, {
      status,
      nfse_number: result.nfseNumber || null,
      access_key: result.accessKey || null,
      issue_url: result.issueUrl || null,
      xml_path: result.xmlPath || null,
      pdf_path: result.pdfPath || null,
      issued_at: new Date().toISOString(),
      last_error: result.warnings?.length ? result.warnings.join(' | ') : null
    });
    addInvoiceEvent(invoice.id, 'ISSUED', 'O portal concluiu a emissão da NFS-e.', {
      nfseNumber: result.nfseNumber || null,
      accessKey: result.accessKey || null,
      warnings: result.warnings || [],
      notes: result.notes || []
    });

    invoice = getInvoice(invoice.id);
    if (invoice.email_enabled) {
      try {
        await sendInvoiceEmail(invoice.id);
      } catch (emailErr) {
        invoice = getInvoice(invoice.id);
        updateInvoice(invoice.id, { status: invoice.pdf_path ? 'EMAIL_ERROR' : 'DOCUMENT_ERROR', last_error: emailErr.message });
        addInvoiceEvent(invoice.id, 'EMAIL_ERROR', emailErr.message);
      }
    }
    return getInvoice(invoice.id);
  } catch (err) {
    invoice = getInvoice(invoice.id);
    if (invoice?.submitted_at) {
      updateInvoice(invoice.id, { status: 'REVIEW_REQUIRED', last_error: err.message });
      addInvoiceEvent(invoice.id, 'REVIEW_REQUIRED', `Resultado incerto após início da submissão: ${err.message}`);
    } else {
      updateInvoice(invoice.id, { status: 'ERROR_BEFORE_SUBMIT', last_error: err.message });
      addInvoiceEvent(invoice.id, 'ERROR_BEFORE_SUBMIT', err.message);
    }
    return getInvoice(invoice.id);
  }
}

async function previewAutomation(automationId) {
  const automation = getAutomation(automationId);
  if (!automation) throw new Error('Automação não encontrada.');
  const settings = getSettings();
  const ctx = todayContext(settings);
  const due = dueInfo(automation, ctx);
  const fakeInvoice = {
    id: `preview-${automation.id}`,
    automation_id: automation.id,
    client_id: automation.client_id,
    competence: due.competence,
    scheduled_date: due.scheduledDate,
    value_cents: automation.value_cents,
    discount_incond_cents: automation.discount_incond_cents,
    discount_cond_cents: automation.discount_cond_cents
  };
  return previewInvoice({ automation, invoice: fakeInvoice });
}

async function runAutomationNow(automationId, { confirmEmission = false } = {}) {
  const automation = getAutomation(automationId);
  if (!automation) throw new Error('Automação não encontrada.');
  if (!automation.client_active) throw new Error('Cliente está inativo.');
  const settings = getSettings();
  const invoice = ensureInvoiceForAutomation(automation, todayContext(settings), { ignoreDue: true });
  if (!confirmEmission) return invoice;
  return processInvoice(invoice.id, { allowEmission: true });
}

async function retryDocuments(invoiceId) {
  const invoice = getInvoice(invoiceId);
  if (!invoice) throw new Error('Nota não encontrada.');
  if (!invoice.submitted_at) throw new Error('Essa nota ainda não foi submetida ao portal.');
  if (!invoice.access_key) throw new Error('A chave da NFS-e não foi capturada; confira manualmente antes de qualquer ação.');
  try {
    const docs = await retrieveDocuments(invoice);
    updateInvoice(invoice.id, {
      xml_path: docs.xmlPath || invoice.xml_path,
      pdf_path: docs.pdfPath || invoice.pdf_path,
      status: (docs.pdfPath || invoice.pdf_path) ? 'ISSUED' : 'DOCUMENT_ERROR',
      last_error: docs.warnings?.length ? docs.warnings.join(' | ') : null
    });
    addInvoiceEvent(invoice.id, 'DOCUMENT_RETRY', docs.pdfPath ? 'DANFSe gerado a partir da nota no portal.' : 'Nova tentativa não conseguiu gerar o DANFSe.', { warnings: docs.warnings, notes: docs.notes });
    return getInvoice(invoice.id);
  } catch (err) {
    updateInvoice(invoice.id, { status: 'DOCUMENT_ERROR', last_error: err.message });
    addInvoiceEvent(invoice.id, 'DOCUMENT_ERROR', err.message);
    return getInvoice(invoice.id);
  }
}

async function retryEmail(invoiceId) {
  try {
    return await sendInvoiceEmail(invoiceId);
  } catch (err) {
    const invoice = getInvoice(invoiceId);
    if (invoice) {
      updateInvoice(invoiceId, { status: invoice.pdf_path ? 'EMAIL_ERROR' : 'DOCUMENT_ERROR', last_error: err.message });
      addInvoiceEvent(invoiceId, 'EMAIL_ERROR', err.message);
    }
    throw err;
  }
}

async function maintenance() {
  for (const row of listRetryableDocuments()) {
    await retryDocuments(row.id).catch(() => {});
  }
  for (const row of listRetryableEmails()) {
    const invoice = getInvoice(row.id);
    if (invoice?.pdf_path || !getSettings().email.requirePdf) await retryEmail(row.id).catch(() => {});
  }
}

// limit = quantas notas este ciclo emite. O worker roda uma por vez para não
// deixar o Chromium ligado por vários minutos seguidos numa VPS pequena; as
// demais ficam registradas como pendentes e saem nos ciclos seguintes.
async function processDueAutomations({ manual = false, limit = Infinity } = {}) {
  if (workerBusy) return { skipped: true, reason: 'worker_busy' };
  workerBusy = true;
  try {
    const settings = getSettings();
    const ctx = todayContext();
    const allowEmission = manual ? Boolean(settings.scheduler.emissionEnabled) : Boolean(settings.scheduler.enabled && settings.scheduler.emissionEnabled);
    const results = [];
    let issued = 0;
    let pending = 0;
    for (const automation of listAutomations()) {
      if (!automation.enabled || !automation.client_active) continue;
      const due = dueInfo(automation, ctx);
      if (!due.due) continue;
      let invoice = getInvoiceByAutomationCompetence(automation.id, due.competence);
      if (!invoice) invoice = ensureInvoiceForAutomation(automation, ctx);
      if (!invoice) continue;
      if (['PENDING', 'ERROR_BEFORE_SUBMIT'].includes(invoice.status)) {
        if (issued >= limit) { pending += 1; results.push(invoice); continue; }
        invoice = await processInvoice(invoice.id, { allowEmission });
        if (allowEmission) issued += 1;
      }
      results.push(invoice);
    }
    // Só cuida de documento/e-mail atrasado quando não gastou o ciclo emitindo.
    if (allowEmission && issued === 0) await maintenance();
    return { ok: true, allowEmission, issued, pending, results };
  } finally {
    workerBusy = false;
  }
}

module.exports = {
  todayContext,
  dueInfo,
  ensureInvoiceForAutomation,
  processInvoice,
  previewAutomation,
  runAutomationNow,
  retryDocuments,
  retryEmail,
  processDueAutomations,
  maintenance
};
