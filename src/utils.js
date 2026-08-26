const MONTHS_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
];

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function moneyFromCents(cents) {
  return Number(cents || 0) / 100;
}

function formatPortalMoney(value) {
  return Number(value || 0).toFixed(2).replace('.', ',');
}

function formatBrlFromCents(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(moneyFromCents(cents));
}

// Fuso do container: vem do TZ no .env, sem cópia no banco.
function defaultTimezone() {
  return String(process.env.TZ || '').trim() || 'America/Sao_Paulo';
}

function zonedParts(date = new Date(), timeZone = defaultTimezone()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const out = {};
  for (const p of parts) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out;
}

function daysInMonth(year, month1to12) {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function scheduledDay(year, month, configuredDay) {
  return Math.min(Number(configuredDay), daysInMonth(year, month));
}

// Mês de referência da nota: sempre o mês em que ela é gerada.
function competenceFor({ year, month }) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function competenceParts(competence) {
  const [year, month] = String(competence).split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) throw new Error(`Competência inválida: ${competence}`);
  return { year, month };
}

// A Data de Competência do portal é sempre a data em que a nota é gerada.
function todayPtBr(timeZone = defaultTimezone(), date = new Date()) {
  const { year, month, day } = zonedParts(date, timeZone);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function formatDateTimePtBr(value = new Date(), timeZone = defaultTimezone()) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23'
  }).format(date).replace(',', '');
}

function parseEmailList(value) {
  return String(value || '')
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.includes('@'));
}

function renderTemplate(text, data = {}) {
  const competence = data.competence ? competenceParts(data.competence) : null;
  const values = {
    CLIENTE: data.clientName || '',
    DOCUMENTO: data.clientDocument || '',
    NUMERO: data.nfseNumber || '',
    CHAVE: data.accessKey || '',
    VALOR: data.valueCents != null ? formatBrlFromCents(data.valueCents) : '',
    EMAIL: data.clientEmail || '',
    DATA: data.sentAtLabel || '',
    MES: competence ? MONTHS_PT[competence.month - 1] : '',
    MES_NUM: competence ? String(competence.month).padStart(2, '0') : '',
    ANO: competence ? String(competence.year) : ''
  };
  return String(text || '').replace(/\{([A-Z_]+)\}/g, (_, key) => values[key] ?? `{${key}}`);
}

// O select2 do portal busca via AJAX: é preciso digitar algo para o servidor
// devolver opções, e só então casar pelo nome exato. Quando o operador não
// informa um termo de busca, derivamos um do próprio nome: código de tributação
// entra pelo código ("01.01.01 - Análise..." -> "01.01.01") e município entra
// sem a UF ("Neves Paulista/SP" -> "Neves Paulista"), que é o que o portal indexa.
function searchTermFor(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const code = raw.match(/^(\d{2}(?:\.\d{2})+)/);
  if (code) return code[1];
  return raw.replace(/\s*[/-]\s*[A-Z]{2}$/, '').trim();
}

// Regra de formação da chave (TSIdNFSe, leiaute nacional):
// Cód.Mun.(7) + Amb.(1) + Tipo Insc.(1) + Inscrição(14) + Nº NFS-e(13) + AAMM(4) + Cód.Num.(9) + DV(1)
// O portal não mostra o número na visualização, mas ele está aqui.
function nfseNumberFromKey(chave) {
  const d = digits(chave);
  if (d.length !== 50) return null;
  const numero = Number(d.slice(23, 36));
  return Number.isFinite(numero) && numero > 0 ? String(numero) : null;
}

function safeFilename(value) {
  return String(value || 'arquivo')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'arquivo';
}

module.exports = {
  MONTHS_PT,
  defaultTimezone,
  digits,
  moneyFromCents,
  formatPortalMoney,
  formatBrlFromCents,
  zonedParts,
  daysInMonth,
  scheduledDay,
  competenceFor,
  competenceParts,
  todayPtBr,
  formatDateTimePtBr,
  parseEmailList,
  nfseNumberFromKey,
  renderTemplate,
  searchTermFor,
  safeFilename
};
