const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'debug'), { recursive: true });

// Sem volume montado, o banco vive dentro do container e some no próximo
// deploy. Detectar isso é a diferença entre perder o histórico e ser avisado.
function dataIsPersistent() {
  try {
    const alvo = path.resolve(DATA_DIR);
    const mounts = fs.readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((linha) => linha.split(' ')[1])
      .filter(Boolean);
    return mounts.some((m) => m === alvo || alvo.startsWith(`${m}/`) && m !== '/');
  } catch {
    return null; // fora de Linux/container não dá para saber
  }
}

const DB_PATH = path.join(DATA_DIR, 'nfse.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');
db.exec('PRAGMA busy_timeout=5000;');

const DEFAULT_SETTINGS = {
  company: {
    name: '',
    cnpj: '',
    municipalRegistration: '',
    cnaePrimary: '',
    nbsCode: ''
  },
  portal: {
    municipalitySearch: '',
    municipalityName: '',
    taxCodeSearch: '',
    taxCodeName: '',
    serviceDescription: 'Prestação de serviços referente a {MES}/{ANO}.',
    fillIbsCbs: false,
    governmentPurchase: false,
    recipientIsBuyer: true,
    ibsCbsTipoOperacao: '5',
    ibsCbsCodigoIndOp: '',
    ibsCbsCst: '',
    ibsCbsClassTrib: ''
  },
  tax: {
    simpleNational: true,
    snApuracaoRegime: '1',
    specialRegime: 'Nenhum',
    issSuspension: false,
    issRetention: false,
    municipalBenefit: false,
    pisCofinsSituacao: '1',
    pisCofinsRetencao: '0',
    pisRate: 0,
    cofinsRate: 0,
    irrfRate: 0,
    csllRate: 0,
    cpRate: 0,
    snTotalRate: 0,
    approxMode: 'sn',
    approxFederal: 0,
    approxState: 0,
    approxMunicipal: 0
  },
  scheduler: {
    enabled: false,
    emissionEnabled: false,
    startHour: 8,
    startMinute: 30,
    endHour: 17,
    endMinute: 30
  },
  email: {
    enabled: true,
    subject: 'NFS-e {MES}/{ANO} - {CLIENTE}',
    body: 'Olá,\n\nSegue em anexo a NFS-e referente a {MES}/{ANO}.\n\nAtenciosamente.',
    requirePdf: true,
    attachXml: true,
    notifyOnSent: true,
    notifyMode: 'separate',
    notifyTo: '',
    notifyAttach: false,
    notifySubject: 'NFS-e {NUMERO} enviada para {CLIENTE}',
    notifyBody: 'A NFS-e de {MES}/{ANO} foi enviada para {CLIENTE} ({EMAIL}) em {DATA}.\n\nNúmero: {NUMERO}\nChave: {CHAVE}\nValor: {VALOR}\n\nMensagem automática do NFS-e Auto Panel.'
  }
};

function nowIso() {
  return new Date().toISOString();
}

function deepMerge(base, extra) {
  if (Array.isArray(base) || Array.isArray(extra)) return extra ?? base;
  if (typeof base !== 'object' || base === null) return extra ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Transporte de e-mail vive só no .env; nada de credencial no banco.
const DROPPED_EMAIL_FIELDS = ['provider', 'from', 'brevoApiKey', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass', 'secrets'];

function stripTransportFields(settings) {
  if (settings?.email) {
    for (const field of DROPPED_EMAIL_FIELDS) delete settings.email[field];
  }
  // Fuso é do container (TZ no .env); nunca mais guardado no banco.
  if (settings?.scheduler) {
    delete settings.scheduler.timezone;
    // v0.3 trocou horário único por janela; migra o valor antigo para o início.
    if (settings.scheduler.hour !== undefined) {
      settings.scheduler.startHour = Number(settings.scheduler.hour);
      delete settings.scheduler.hour;
    }
    if (settings.scheduler.minute !== undefined) {
      settings.scheduler.startMinute = Number(settings.scheduler.minute);
      delete settings.scheduler.minute;
    }
  }
  return settings;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      document TEXT NOT NULL UNIQUE,
      email TEXT,
      type TEXT NOT NULL DEFAULT 'PJ' CHECK (type IN ('PJ', 'PF')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
      start_date TEXT,
      value_cents INTEGER NOT NULL CHECK (value_cents > 0),
      discount_incond_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_incond_cents >= 0),
      discount_cond_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cond_cents >= 0),
      -- Mantida por compatibilidade com bancos criados antes da v0.3; não é mais lida.
      competence_mode TEXT NOT NULL DEFAULT 'CURRENT',
      service_description TEXT,
      municipality_search TEXT,
      municipality_name TEXT,
      tax_code_search TEXT,
      tax_code_name TEXT,
      email_enabled INTEGER NOT NULL DEFAULT 1,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      competence TEXT NOT NULL,
      scheduled_date TEXT NOT NULL,
      status TEXT NOT NULL,
      value_cents INTEGER NOT NULL,
      discount_incond_cents INTEGER NOT NULL DEFAULT 0,
      discount_cond_cents INTEGER NOT NULL DEFAULT 0,
      nfse_number TEXT,
      access_key TEXT,
      xml_path TEXT,
      pdf_path TEXT,
      issue_url TEXT,
      submitted_at TEXT,
      issued_at TEXT,
      email_sent_at TEXT,
      email_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (automation_id, competence),
      FOREIGN KEY (automation_id) REFERENCES automations(id),
      FOREIGN KEY (client_id) REFERENCES clients(id)
    );

    CREATE TABLE IF NOT EXISTS invoice_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(enabled, day_of_month);
    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_competence ON invoices(competence);
  `);

  // Bancos criados antes da v0.3 não têm start_date.
  const colunas = db.prepare('PRAGMA table_info(automations)').all().map((c) => c.name);
  if (!colunas.includes('start_date')) db.exec('ALTER TABLE automations ADD COLUMN start_date TEXT');

  // Notas emitidas antes de o número ser extraído da chave ficaram sem ele.
  db.exec(`
    UPDATE invoices
       SET nfse_number = CAST(substr(access_key, 24, 13) AS INTEGER)
     WHERE nfse_number IS NULL
       AND access_key IS NOT NULL
       AND length(access_key) = 50
       AND CAST(substr(access_key, 24, 13) AS INTEGER) > 0;
  `);

  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO settings(id, data, updated_at) VALUES(1, ?, ?)')
      .run(JSON.stringify(DEFAULT_SETTINGS), nowIso());
  } else {
    const merged = stripTransportFields(deepMerge(DEFAULT_SETTINGS, JSON.parse(row.data)));
    db.prepare('UPDATE settings SET data = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(merged), nowIso());
  }
}

migrate();

function getSettings() {
  const row = db.prepare('SELECT data FROM settings WHERE id = 1').get();
  return stripTransportFields(deepMerge(DEFAULT_SETTINGS, row ? JSON.parse(row.data) : {}));
}

function saveSettings(data) {
  const current = getSettings();
  const incoming = stripTransportFields(JSON.parse(JSON.stringify(data || {})));
  const merged = stripTransportFields(deepMerge(DEFAULT_SETTINGS, deepMerge(current, incoming)));
  db.prepare('UPDATE settings SET data = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(merged), nowIso());
  return merged;
}

function listClients({ includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM clients ORDER BY active DESC, name COLLATE NOCASE'
    : 'SELECT * FROM clients WHERE active = 1 ORDER BY name COLLATE NOCASE';
  return db.prepare(sql).all().map(normalizeClient);
}

function normalizeClient(row) {
  if (!row) return null;
  return { ...row, active: Boolean(row.active) };
}

function getClient(id) {
  return normalizeClient(db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(id)));
}

function validateClientInput(input) {
  const name = String(input.name || '').trim();
  const document = String(input.document || '').replace(/\D/g, '');
  if (!name) throw new Error('Nome do cliente é obrigatório.');
  if (![11, 14].includes(document.length)) throw new Error('CPF/CNPJ do cliente deve ter 11 ou 14 dígitos.');
  return { name, document };
}

function createClient(input) {
  const validated = validateClientInput(input);
  const ts = nowIso();
  const result = db.prepare(`
    INSERT INTO clients(name, document, email, type, active, created_at, updated_at)
    VALUES(?, ?, ?, ?, 1, ?, ?)
  `).run(
    validated.name,
    validated.document,
    String(input.email || '').trim() || null,
    input.type === 'PF' ? 'PF' : 'PJ',
    ts,
    ts
  );
  return getClient(Number(result.lastInsertRowid));
}

function updateClient(id, input) {
  const current = getClient(id);
  if (!current) return null;
  const validated = validateClientInput({ name: input.name ?? current.name, document: input.document ?? current.document });
  db.prepare(`
    UPDATE clients SET name = ?, document = ?, email = ?, type = ?, active = ?, updated_at = ? WHERE id = ?
  `).run(
    validated.name,
    validated.document,
    String(input.email ?? current.email ?? '').trim() || null,
    (input.type ?? current.type) === 'PF' ? 'PF' : 'PJ',
    (input.active ?? current.active) ? 1 : 0,
    nowIso(),
    Number(id)
  );
  return getClient(id);
}

function deactivateClient(id) {
  db.prepare('UPDATE clients SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), Number(id));
  return getClient(id);
}

function normalizeAutomation(row) {
  if (!row) return null;
  let overrides = {};
  try { overrides = JSON.parse(row.overrides_json || '{}'); } catch {}
  return {
    ...row,
    enabled: Boolean(row.enabled),
    email_enabled: Boolean(row.email_enabled),
    overrides
  };
}

function listAutomations() {
  return db.prepare(`
    SELECT a.*, c.name AS client_name, c.document AS client_document, c.email AS client_email, c.type AS client_type, c.active AS client_active
    FROM automations a
    JOIN clients c ON c.id = a.client_id
    ORDER BY a.enabled DESC, a.day_of_month, a.name COLLATE NOCASE
  `).all().map(normalizeAutomation);
}

function getAutomation(id) {
  return normalizeAutomation(db.prepare(`
    SELECT a.*, c.name AS client_name, c.document AS client_document, c.email AS client_email, c.type AS client_type, c.active AS client_active
    FROM automations a
    JOIN clients c ON c.id = a.client_id
    WHERE a.id = ?
  `).get(Number(id)));
}

// A automação passa a ser cadastrada pela data da primeira emissão: o dia do
// mês sai dela, e nada é emitido antes dessa data — assim dá para cadastrar
// hoje uma recorrência que só começa no mês que vem.
function normalizeStartDate(value) {
  const texto = String(value || '').trim();
  if (!texto) return null;
  const m = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Data da primeira emissão inválida. Use o formato AAAA-MM-DD.');
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function validateAutomationInput(input) {
  const startDate = normalizeStartDate(input.startDate ?? input.start_date);
  const day = startDate ? Number(startDate.slice(8, 10)) : Number(input.dayOfMonth ?? input.day_of_month);
  const valueCents = Number(input.valueCents ?? input.value_cents);
  const discountIncondCents = Number(input.discountIncondCents ?? input.discount_incond_cents ?? 0);
  const discountCondCents = Number(input.discountCondCents ?? input.discount_cond_cents ?? 0);
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Dia do mês deve estar entre 1 e 31.');
  if (!Number.isInteger(valueCents) || valueCents <= 0) throw new Error('Valor deve ser maior que zero.');
  if (discountIncondCents < 0 || discountCondCents < 0) throw new Error('Descontos não podem ser negativos.');
  if (discountIncondCents + discountCondCents >= valueCents) throw new Error('A soma dos descontos deve ser menor que o valor do serviço.');
  return { day, valueCents, discountIncondCents, discountCondCents, startDate };
}

function createAutomation(input) {
  const v = validateAutomationInput(input);
  const ts = nowIso();
  const result = db.prepare(`
    INSERT INTO automations(
      client_id, name, enabled, day_of_month, start_date, value_cents, discount_incond_cents, discount_cond_cents,
      service_description, municipality_search, municipality_name, tax_code_search, tax_code_name,
      email_enabled, overrides_json, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(input.clientId ?? input.client_id),
    String(input.name || '').trim(),
    input.enabled === false ? 0 : 1,
    v.day,
    v.startDate,
    v.valueCents,
    v.discountIncondCents,
    v.discountCondCents,
    String(input.serviceDescription || '').trim() || null,
    String(input.municipalitySearch || '').trim() || null,
    String(input.municipalityName || '').trim() || null,
    String(input.taxCodeSearch || '').trim() || null,
    String(input.taxCodeName || '').trim() || null,
    input.emailEnabled === false ? 0 : 1,
    JSON.stringify(input.overrides || {}),
    ts,
    ts
  );
  return getAutomation(Number(result.lastInsertRowid));
}

function updateAutomation(id, input) {
  const current = getAutomation(id);
  if (!current) return null;
  const merged = {
    clientId: input.clientId ?? current.client_id,
    name: input.name ?? current.name,
    enabled: input.enabled ?? current.enabled,
    dayOfMonth: input.dayOfMonth ?? current.day_of_month,
    startDate: input.startDate ?? current.start_date,
    valueCents: input.valueCents ?? current.value_cents,
    discountIncondCents: input.discountIncondCents ?? current.discount_incond_cents,
    discountCondCents: input.discountCondCents ?? current.discount_cond_cents,
    serviceDescription: input.serviceDescription ?? current.service_description,
    municipalitySearch: input.municipalitySearch ?? current.municipality_search,
    municipalityName: input.municipalityName ?? current.municipality_name,
    taxCodeSearch: input.taxCodeSearch ?? current.tax_code_search,
    taxCodeName: input.taxCodeName ?? current.tax_code_name,
    emailEnabled: input.emailEnabled ?? current.email_enabled,
    overrides: input.overrides ?? current.overrides
  };
  const v = validateAutomationInput(merged);
  db.prepare(`
    UPDATE automations SET
      client_id = ?, name = ?, enabled = ?, day_of_month = ?, start_date = ?, value_cents = ?, discount_incond_cents = ?, discount_cond_cents = ?,
      service_description = ?, municipality_search = ?, municipality_name = ?, tax_code_search = ?, tax_code_name = ?,
      email_enabled = ?, overrides_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    Number(merged.clientId), String(merged.name).trim(), merged.enabled ? 1 : 0,
    v.day, v.startDate, v.valueCents, v.discountIncondCents, v.discountCondCents,
    String(merged.serviceDescription || '').trim() || null,
    String(merged.municipalitySearch || '').trim() || null,
    String(merged.municipalityName || '').trim() || null,
    String(merged.taxCodeSearch || '').trim() || null,
    String(merged.taxCodeName || '').trim() || null,
    merged.emailEnabled ? 1 : 0,
    JSON.stringify(merged.overrides || {}),
    nowIso(), Number(id)
  );
  return getAutomation(id);
}

function setAutomationEnabled(id, enabled) {
  db.prepare('UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nowIso(), Number(id));
  return getAutomation(id);
}

function listInvoices(limit = 200) {
  return db.prepare(`
    SELECT i.*, a.name AS automation_name, c.name AS client_name, c.document AS client_document, c.email AS client_email
    FROM invoices i
    JOIN automations a ON a.id = i.automation_id
    JOIN clients c ON c.id = i.client_id
    ORDER BY i.id DESC LIMIT ?
  `).all(Number(limit));
}

function getInvoice(id) {
  return db.prepare(`
    SELECT i.*, a.name AS automation_name, a.email_enabled, c.name AS client_name, c.document AS client_document, c.email AS client_email, c.type AS client_type
    FROM invoices i
    JOIN automations a ON a.id = i.automation_id
    JOIN clients c ON c.id = i.client_id
    WHERE i.id = ?
  `).get(Number(id));
}

function getInvoiceByAutomationCompetence(automationId, competence) {
  return db.prepare('SELECT * FROM invoices WHERE automation_id = ? AND competence = ?')
    .get(Number(automationId), competence);
}

// Nota emitida fora do painel (ou perdida num redeploy sem volume) precisa
// existir aqui, senão a trava automação+competência deixa passar uma segunda.
function registerIssuedInvoice({ automationId, competence, nfseNumber, accessKey, issuedAt }) {
  const automation = getAutomation(automationId);
  if (!automation) throw new Error('Automação não encontrada.');
  const existente = getInvoiceByAutomationCompetence(automationId, competence);
  if (existente) throw new Error(`Já existe nota registrada para essa automação em ${competence}.`);
  const ts = nowIso();
  const quando = issuedAt || ts;
  const result = db.prepare(`
    INSERT INTO invoices(
      automation_id, client_id, competence, scheduled_date, status, value_cents,
      discount_incond_cents, discount_cond_cents, nfse_number, access_key,
      submitted_at, issued_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, 'ISSUED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(automationId), Number(automation.client_id), competence, quando.slice(0, 10),
    Number(automation.value_cents), Number(automation.discount_incond_cents || 0), Number(automation.discount_cond_cents || 0),
    String(nfseNumber || '') || null, String(accessKey || '') || null, quando, quando, ts, ts
  );
  const id = Number(result.lastInsertRowid);
  addInvoiceEvent(id, 'REGISTERED', 'Nota emitida no portal registrada manualmente; a partir daqui a competência está protegida contra duplicidade.');
  return getInvoice(id);
}

function createInvoice({ automationId, clientId, competence, scheduledDate, valueCents, discountIncondCents, discountCondCents }) {
  const ts = nowIso();
  try {
    const result = db.prepare(`
      INSERT INTO invoices(
        automation_id, client_id, competence, scheduled_date, status, value_cents,
        discount_incond_cents, discount_cond_cents, created_at, updated_at
      ) VALUES(?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)
    `).run(
      Number(automationId), Number(clientId), competence, scheduledDate,
      Number(valueCents), Number(discountIncondCents || 0), Number(discountCondCents || 0), ts, ts
    );
    return getInvoice(Number(result.lastInsertRowid));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return getInvoiceByAutomationCompetence(automationId, competence);
    throw err;
  }
}

const ALLOWED_INVOICE_FIELDS = new Set([
  'status', 'nfse_number', 'access_key', 'xml_path', 'pdf_path', 'issue_url', 'submitted_at',
  'issued_at', 'email_sent_at', 'email_attempts', 'last_error'
]);

function updateInvoice(id, patch) {
  const entries = Object.entries(patch).filter(([key]) => ALLOWED_INVOICE_FIELDS.has(key));
  if (!entries.length) return getInvoice(id);
  const sets = entries.map(([key]) => `${key} = ?`);
  const values = entries.map(([, value]) => value);
  sets.push('updated_at = ?');
  values.push(nowIso(), Number(id));
  db.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getInvoice(id);
}

function addInvoiceEvent(invoiceId, type, message, details = null) {
  db.prepare('INSERT INTO invoice_events(invoice_id, type, message, details_json, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(Number(invoiceId), type, message, details ? JSON.stringify(details) : null, nowIso());
}

function listInvoiceEvents(invoiceId) {
  return db.prepare('SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY id DESC')
    .all(Number(invoiceId));
}

function listRetryableDocuments() {
  return db.prepare(`
    SELECT i.id
    FROM invoices i
    WHERE i.status = 'DOCUMENT_ERROR'
      AND i.submitted_at IS NOT NULL
      AND i.access_key IS NOT NULL
    ORDER BY i.id
    LIMIT 20
  `).all();
}

function listRetryableEmails() {
  return db.prepare(`
    SELECT i.id
    FROM invoices i
    JOIN automations a ON a.id = i.automation_id
    WHERE a.email_enabled = 1
      AND i.email_sent_at IS NULL
      AND i.status IN ('ISSUED', 'EMAIL_ERROR', 'DOCUMENT_ERROR')
    ORDER BY i.id
    LIMIT 50
  `).all();
}

function getDashboardCounts() {
  const clients = db.prepare('SELECT COUNT(*) AS n FROM clients WHERE active = 1').get().n;
  const automations = db.prepare('SELECT COUNT(*) AS n FROM automations WHERE enabled = 1').get().n;
  const issued = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('ISSUED','SENT','EMAIL_ERROR','DOCUMENT_ERROR')").get().n;
  const attention = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status IN ('ERROR_BEFORE_SUBMIT','REVIEW_REQUIRED','DOCUMENT_ERROR','EMAIL_ERROR')").get().n;
  return { clients, automations, issued, attention };
}

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  dataIsPersistent,
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  listClients,
  getClient,
  createClient,
  updateClient,
  deactivateClient,
  listAutomations,
  getAutomation,
  createAutomation,
  updateAutomation,
  setAutomationEnabled,
  listInvoices,
  getInvoice,
  getInvoiceByAutomationCompetence,
  createInvoice,
  registerIssuedInvoice,
  updateInvoice,
  addInvoiceEvent,
  listInvoiceEvents,
  listRetryableDocuments,
  listRetryableEmails,
  getDashboardCounts,
  nowIso
};
