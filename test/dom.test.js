const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'playwright') return { chromium: {} };
  return originalLoad.call(this, request, ...rest);
};
const { setRadio } = require('../src/emitter/dom');
Module._load = originalLoad;

// Página falsa: o radio do portal existe mas é invisível; só o label que o
// embrulha aceita clique. `visible` lista os seletores clicáveis.
function fakePage({ exists = [], visible = [], checkOn = null, jsWorks = true } = {}) {
  const state = { checked: false, clicks: [], jsUsed: false };
  const node = (sel) => ({
    first: () => node(sel),
    count: async () => (exists.includes(sel) ? 1 : 0),
    isVisible: async () => visible.includes(sel),
    isChecked: async () => state.checked,
    getAttribute: async (attr) => (attr === 'id' ? 'PreencherInfoIBSCBS' : null),
    click: async () => {
      state.clicks.push(sel);
      if (!visible.includes(sel)) throw new Error('Element is not visible');
      if (checkOn === sel) state.checked = true;
    },
    evaluate: async () => {
      state.jsUsed = true;
      if (jsWorks) state.checked = true;
    }
  });
  return { locator: node, state };
}

const INPUT = 'input[name="PreencherInfoIBSCBS"][value="0"]';
const WRAP = `label:has(${INPUT})`;
const FOR = 'label[for="PreencherInfoIBSCBS"]';

test('marca pelo label que embrulha o input invisível', async () => {
  const page = fakePage({ exists: [INPUT, WRAP], visible: [WRAP], checkOn: WRAP });
  assert.equal(await setRadio(page, 'PreencherInfoIBSCBS', '0'), true);
  assert.deepEqual(page.state.clicks, [WRAP], 'não tenta clicar no input escondido');
  assert.equal(page.state.jsUsed, false, 'não precisa do fallback de DOM');
});

test('cai no label[for] quando não há label embrulhando', async () => {
  const page = fakePage({ exists: [INPUT, FOR], visible: [FOR], checkOn: FOR });
  assert.equal(await setRadio(page, 'PreencherInfoIBSCBS', '0'), true);
  assert.deepEqual(page.state.clicks, [FOR]);
});

test('marca no DOM quando nenhum alvo é clicável', async () => {
  const page = fakePage({ exists: [INPUT, WRAP], visible: [] });
  assert.equal(await setRadio(page, 'PreencherInfoIBSCBS', '0'), true);
  assert.deepEqual(page.state.clicks, [], 'nem tenta clicar no que está invisível');
  assert.equal(page.state.jsUsed, true);
});

test('não faz nada se o radio já está marcado', async () => {
  const page = fakePage({ exists: [INPUT, WRAP], visible: [WRAP] });
  page.state.checked = true;
  assert.equal(await setRadio(page, 'PreencherInfoIBSCBS', '0'), true);
  assert.deepEqual(page.state.clicks, []);
});

test('erra alto quando nada funciona, e silencia quando é opcional', async () => {
  const page = fakePage({ exists: [INPUT], visible: [], jsWorks: false });
  await assert.rejects(() => setRadio(page, 'PreencherInfoIBSCBS', '0'), /não aceitou clique/);
  const outra = fakePage({ exists: [INPUT], visible: [], jsWorks: false });
  assert.equal(await setRadio(outra, 'PreencherInfoIBSCBS', '0', { optional: true }), false);
});

test('campo inexistente: obrigatório falha, opcional passa', async () => {
  await assert.rejects(() => setRadio(fakePage({}), 'Qualquer', '1'), /não encontrado/);
  assert.equal(await setRadio(fakePage({}), 'Qualquer', '1', { optional: true }), false);
});
