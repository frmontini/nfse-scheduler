const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledDay, competenceFor, renderTemplate, formatPortalMoney } = require('../src/utils');

test('dia 31 cai no último dia do mês', () => {
  assert.equal(scheduledDay(2026, 2, 31), 28);
  assert.equal(scheduledDay(2028, 2, 31), 29);
});

test('competência é sempre o mês corrente', () => {
  assert.equal(competenceFor({ year: 2026, month: 8 }), '2026-08');
  assert.equal(competenceFor({ year: 2026, month: 1 }), '2026-01');
});

test('template usa mês/ano/cliente', () => {
  assert.equal(renderTemplate('{CLIENTE} - {MES}/{ANO}', { competence: '2026-08', clientName: 'ACME' }), 'ACME - agosto/2026');
});

test('formata número no padrão do portal', () => {
  assert.equal(formatPortalMoney(1234.5), '1234,50');
});

test('lista de avisos aceita vírgula, ponto e vírgula e nome com e-mail', () => {
  const { parseEmailList } = require('../src/utils');
  assert.deepEqual(parseEmailList('a@x.com, b@y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(parseEmailList('Financeiro <a@x.com>;b@y.com'), ['Financeiro <a@x.com>', 'b@y.com']);
  assert.deepEqual(parseEmailList('  '), []);
  assert.deepEqual(parseEmailList('sem-arroba'), []);
});

test('aviso de envio resolve {EMAIL} e {DATA}', () => {
  const { renderTemplate, formatDateTimePtBr } = require('../src/utils');
  const data = formatDateTimePtBr(new Date('2026-08-26T11:05:00Z'), 'America/Sao_Paulo');
  assert.equal(data, '26/08/2026 08:05');
  assert.equal(
    renderTemplate('{CLIENTE} ({EMAIL}) em {DATA}', { clientName: 'ACME', clientEmail: 'fin@acme.com', sentAtLabel: data }),
    'ACME (fin@acme.com) em 26/08/2026 08:05'
  );
});

test('deriva o termo de busca do select2 a partir do nome exato', () => {
  const { searchTermFor } = require('../src/utils');
  assert.equal(searchTermFor('Neves Paulista/SP'), 'Neves Paulista', 'município entra sem a UF');
  assert.equal(searchTermFor('São José do Rio Preto/SP'), 'São José do Rio Preto');
  assert.equal(searchTermFor('Neves Paulista'), 'Neves Paulista');
  assert.equal(searchTermFor('01.01.01 - Análise e desenvolvimento de sistemas'), '01.01.01', 'código entra pelo código');
  assert.equal(searchTermFor('14.02 - Assistência técnica.'), '14.02');
  assert.equal(searchTermFor('Assistência técnica.'), 'Assistência técnica.', 'sem código, usa o texto');
  assert.equal(searchTermFor(''), '');
});

test('data de competência do portal é a data de hoje no fuso configurado', () => {
  const { todayPtBr } = require('../src/utils');
  // 26/08/2026 00:30 UTC ainda é dia 25 em São Paulo (UTC-3).
  assert.equal(todayPtBr('America/Sao_Paulo', new Date('2026-08-26T00:30:00Z')), '25/08/2026');
  assert.equal(todayPtBr('America/Sao_Paulo', new Date('2026-08-26T12:00:00Z')), '26/08/2026');
  assert.match(todayPtBr('America/Sao_Paulo'), /^\d{2}\/\d{2}\/\d{4}$/);
});

test('automação só vence a partir da data da primeira emissão', () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === './db') return { getSettings: () => ({ scheduler: {} }), listAutomations: () => [], getAutomation: () => null, getInvoice: () => null, getInvoiceByAutomationCompetence: () => null, createInvoice: () => null, updateInvoice: () => null, addInvoiceEvent: () => null, listRetryableDocuments: () => [], listRetryableEmails: () => [] };
    if (request === './emitter/national') return { previewInvoice: async () => ({}), issueInvoice: async () => ({}), retrieveDocuments: async () => ({}) };
    if (request === './email') return { sendInvoiceEmail: async () => ({}) };
    return originalLoad.call(this, request, ...rest);
  };
  const { dueInfo } = require('../src/service');
  Module._load = originalLoad;

  const hoje = { year: 2026, month: 8, day: 26 };
  const so_mes_que_vem = { day_of_month: 5, start_date: '2026-09-05' };
  const ja_valendo = { day_of_month: 5, start_date: '2026-08-05' };
  const sem_data = { day_of_month: 5 };

  assert.equal(dueInfo(so_mes_que_vem, hoje).due, false, 'cadastrada hoje para setembro não pode emitir agosto');
  assert.equal(dueInfo(so_mes_que_vem, { year: 2026, month: 9, day: 5 }).due, true, 'em setembro, no dia, vence');
  assert.equal(dueInfo(ja_valendo, hoje).due, true);
  assert.equal(dueInfo(sem_data, hoje).due, true, 'automação antiga sem data segue como antes');
});
