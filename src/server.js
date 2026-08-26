const fs = require('node:fs');
const path = require('node:path');

try {
  const envFile = path.join(process.cwd(), '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') process.loadEnvFile(envFile);
} catch (err) {
  console.warn('Não foi possível carregar .env:', err.message);
}

const express = require('express');
const {
  DATA_DIR,
  DB_PATH,
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
  listInvoiceEvents,
  getDashboardCounts
} = require('./db');
const {
  processDueAutomations,
  previewAutomation,
  runAutomationNow,
  processInvoice,
  retryDocuments,
  retryEmail
} = require('./service');
const { testPortalLogin } = require('./emitter/national');
const { testMailer, sendTestEmail } = require('./email');
const { mailProvider, providerLabel, mailConfigured, mailConfig } = require('./mailer');

const mailFrom = () => mailConfig().from || null;
const { parseNfseXml } = require('./xml-import');
const { defaultTimezone } = require('./utils');
const session = require('./session');
const { startScheduler, intervalMinutes } = require('./scheduler');

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(process.cwd(), 'public');
const isProduction = process.env.NODE_ENV === 'production';
const allowNoAuth = process.env.ALLOW_NO_AUTH === '1';

if (isProduction && !process.env.APP_ADMIN_PASSWORD && !allowNoAuth) {
  console.error('APP_ADMIN_PASSWORD vazio em produção. Defina a senha do painel ou use ALLOW_NO_AUTH=1 se ele estiver atrás de outra proteção.');
  process.exit(1);
}

if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);

app.use(express.json({ limit: '4mb' }));

// Rotas públicas: healthcheck do Dokploy, tela e API de login, e os estáticos
// (a tela de login precisa do CSS). O index.html fica atrás do guard.
app.get('/api/health', (req, res) => res.json({ ok: true, version: '0.2.0', uptime: Math.round(process.uptime()) }));

app.get('/login', (req, res) => {
  if (!session.authRequired() || session.currentUser(req)) return res.redirect('/');
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.post('/api/login', (req, res) => {
  if (!session.authRequired()) return res.json({ ok: true, authRequired: false });
  const key = req.ip || 'desconhecido';
  if (session.tooManyAttempts(key)) {
    return res.status(429).json({ error: 'Muitas tentativas seguidas. Espere um minuto e tente de novo.' });
  }
  const { user, password } = req.body || {};
  if (!session.checkCredentials(user, password)) {
    session.registerFailure(key);
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  session.clearFailures(key);
  session.setSessionCookie(req, res, String(user));
  res.json({ ok: true, user: String(user) });
});

app.post('/api/logout', (req, res) => {
  session.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  const current = session.currentUser(req);
  res.json({
    authenticated: Boolean(current),
    authRequired: session.authRequired(),
    user: current?.u || null
  });
});

app.use(express.static(publicDir, { index: false }));

app.use(session.guard);

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    version: '0.2.0',
    dbPath: DB_PATH,
    dataDir: DATA_DIR,
    counts: getDashboardCounts(),
    portalConfigured: Boolean(process.env.NFSE_LOGIN && process.env.NFSE_PASSWORD),
    mail: { provider: mailProvider(), label: providerLabel(), configured: mailConfigured(), from: mailFrom() },
    authRequired: session.authRequired(),
    timezone: defaultTimezone(),
    workerIntervalMinutes: intervalMinutes(),
    settings: getSettings()
  });
});

app.get('/api/settings', (req, res) => res.json(getSettings()));
app.put('/api/settings', (req, res) => res.json(saveSettings(req.body || {})));

app.get('/api/clients', (req, res) => res.json(listClients({ includeInactive: req.query.all === '1' })));
app.post('/api/clients', (req, res, next) => {
  try { res.status(201).json(createClient(req.body || {})); } catch (err) { next(err); }
});
app.put('/api/clients/:id', (req, res, next) => {
  try {
    const item = updateClient(req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(item);
  } catch (err) { next(err); }
});
app.delete('/api/clients/:id', (req, res) => {
  const item = deactivateClient(req.params.id);
  if (!item) return res.status(404).json({ error: 'Cliente não encontrado.' });
  res.json(item);
});

app.get('/api/automations', (req, res) => res.json(listAutomations()));
app.post('/api/automations', (req, res, next) => {
  try { res.status(201).json(createAutomation(req.body || {})); } catch (err) { next(err); }
});
app.put('/api/automations/:id', (req, res, next) => {
  try {
    const item = updateAutomation(req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: 'Automação não encontrada.' });
    res.json(item);
  } catch (err) { next(err); }
});
app.post('/api/automations/:id/toggle', (req, res) => {
  const item = setAutomationEnabled(req.params.id, Boolean(req.body?.enabled));
  if (!item) return res.status(404).json({ error: 'Automação não encontrada.' });
  res.json(item);
});
app.post('/api/automations/:id/preview', asyncRoute(async (req, res) => {
  const result = await previewAutomation(req.params.id);
  const filename = path.basename(result.file);
  res.json({ ok: true, reviewUrl: result.url, screenshotUrl: `/api/debug/${encodeURIComponent(filename)}` });
}));
app.post('/api/automations/:id/run', asyncRoute(async (req, res) => {
  if (req.body?.confirmation !== 'EMITIR') return res.status(400).json({ error: 'Confirmação inválida. Envie confirmation="EMITIR".' });
  const item = await runAutomationNow(req.params.id, { confirmEmission: true });
  res.json(item);
}));

app.get('/api/invoices', (req, res) => res.json(listInvoices(Math.min(Number(req.query.limit || 200), 1000))));
app.get('/api/invoices/:id', (req, res) => {
  const item = getInvoice(req.params.id);
  if (!item) return res.status(404).json({ error: 'Nota não encontrada.' });
  res.json({ ...item, events: listInvoiceEvents(req.params.id) });
});
app.post('/api/invoices/:id/retry', asyncRoute(async (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).json({ error: 'Nota não encontrada.' });
  if (invoice.submitted_at) return res.status(409).json({ error: 'Essa nota já chegou à fronteira de submissão. Reemissão bloqueada; confira no portal.' });
  if (req.body?.confirmation !== 'EMITIR') return res.status(400).json({ error: 'Confirmação inválida.' });
  res.json(await processInvoice(invoice.id, { allowEmission: true }));
}));
app.post('/api/invoices/:id/retry-documents', asyncRoute(async (req, res) => res.json(await retryDocuments(req.params.id))));
app.post('/api/invoices/:id/retry-email', asyncRoute(async (req, res) => res.json(await retryEmail(req.params.id))));

app.get('/api/invoices/:id/file/:kind', (req, res) => {
  const invoice = getInvoice(req.params.id);
  if (!invoice) return res.status(404).send('Nota não encontrada.');
  const target = req.params.kind === 'xml' ? invoice.xml_path : req.params.kind === 'pdf' ? invoice.pdf_path : null;
  if (!target || !fs.existsSync(target)) return res.status(404).send('Arquivo não disponível.');
  const resolved = path.resolve(target);
  const allowed = path.resolve(path.join(DATA_DIR, 'files')) + path.sep;
  if (!resolved.startsWith(allowed)) return res.status(403).send('Caminho inválido.');
  res.download(resolved);
});

app.get('/api/debug/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const target = path.join(DATA_DIR, 'debug', filename);
  if (!fs.existsSync(target)) return res.status(404).send('Screenshot não encontrado.');
  res.sendFile(target);
});

app.post('/api/test-login', asyncRoute(async (req, res) => res.json(await testPortalLogin())));
app.post('/api/send-test-email', asyncRoute(async (req, res) => res.json(await sendTestEmail(req.body?.to))));
app.post('/api/import-xml', (req, res, next) => {
  try {
    const xml = String(req.body?.xml || '');
    if (!xml.trim()) return res.status(400).json({ error: 'Envie o conteúdo do XML.' });
    res.json({ ok: true, ...parseNfseXml(xml) });
  } catch (err) { next(err); }
});
app.post('/api/test-email', asyncRoute(async (req, res) => res.json(await testMailer())));
app.post('/api/run-now', asyncRoute(async (req, res) => res.json(await processDueAutomations({ manual: true }))));

app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  const message = err?.message || 'Erro interno.';
  const sqliteConflict = /UNIQUE constraint/i.test(message);
  res.status(sqliteConflict ? 409 : 500).json({ error: message });
});

startScheduler();
app.listen(port, '0.0.0.0', () => {
  console.log(`NFS-e Auto v0.2.0 em http://0.0.0.0:${port}`);
  console.log(`Banco: ${DB_PATH}`);
  console.log(`E-mail: ${providerLabel()}${mailConfigured() ? '' : ' (faltando configuração)'}`);
  if (!process.env.APP_ADMIN_PASSWORD) console.warn('AVISO: APP_ADMIN_PASSWORD vazio. Não exponha esta porta à internet sem autenticação/reverse proxy.');
});
