const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'node-cron') return { schedule: () => ({}) };
  if (request === './db') return { getSettings: () => ({ scheduler: {} }) };
  if (request === './service') return { processDueAutomations: async () => ({}) };
  return originalLoad.call(this, request, ...rest);
};
const { insideWindow, intervalMinutes } = require('../src/scheduler');
Module._load = originalLoad;

const janela = { startHour: 8, startMinute: 30, endHour: 17, endMinute: 30 };
const em = (hour, minute) => insideWindow({ hour, minute }, janela);

test('worker só trabalha dentro da janela', () => {
  assert.equal(em(8, 29), false, 'um minuto antes ainda não');
  assert.equal(em(8, 30), true, 'começa no minuto exato');
  assert.equal(em(12, 0), true);
  assert.equal(em(17, 30), true, 'termina no minuto exato');
  assert.equal(em(17, 31), false);
  assert.equal(em(3, 0), false, 'nada de nota de madrugada');
});

test('janela que atravessa a meia-noite', () => {
  const noturna = { startHour: 22, startMinute: 0, endHour: 6, endMinute: 0 };
  assert.equal(insideWindow({ hour: 23, minute: 0 }, noturna), true);
  assert.equal(insideWindow({ hour: 2, minute: 0 }, noturna), true);
  assert.equal(insideWindow({ hour: 12, minute: 0 }, noturna), false);
});

test('intervalo vem do .env, com padrão de 4 horas', () => {
  delete process.env.WORKER_INTERVAL_MINUTES;
  assert.equal(intervalMinutes(), 240);
  process.env.WORKER_INTERVAL_MINUTES = '15';
  assert.equal(intervalMinutes(), 15);
  process.env.WORKER_INTERVAL_MINUTES = 'abc';
  assert.equal(intervalMinutes(), 240, 'valor inválido cai no padrão');
  process.env.WORKER_INTERVAL_MINUTES = '0';
  assert.equal(intervalMinutes(), 240, 'zero desligaria o intervalo: cai no padrão');
  delete process.env.WORKER_INTERVAL_MINUTES;
});
