/*
 * Selectors/flow adapted from the MIT-licensed Sutil/Emissor-NFS-e-bot
 * (copyright 2026 Eduardo Sutil). See /licenses and THIRD_PARTY_NOTICES.md.
 * Extra fallbacks were added because the Emissor Nacional is not a public API
 * and its HTML may change without notice.
 */

const { formatPortalMoney } = require('../utils');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readValidationErrors(page) {
  return page.$$eval(
    '.field-validation-error, .validation-summary-errors, .alert-danger, .text-danger',
    (els) => [...new Set(els.map((e) => (e.textContent || '').trim()).filter(Boolean))]
  ).catch(() => []);
}

// O portal esconde o <input type="radio"> e mostra um controle estilizado no
// lugar. Clicar no input (mesmo com force) falha com "Element is not visible",
// então tentamos, em ordem: o label que embrulha o input (é o que o portal
// renderiza), o label[for=id], o próprio input quando visível e, por último,
// marcar no DOM disparando os eventos que o script da página escuta.
async function setRadio(page, name, value, { optional = false } = {}) {
  const selector = `input[name="${name}"][value="${value}"]`;
  const input = page.locator(selector).first();
  if (!(await input.count().catch(() => 0))) {
    if (optional) return false;
    throw new Error(`Campo de opção ${name}=${value} não encontrado no Emissor Nacional.`);
  }
  const isChecked = () => input.isChecked().catch(() => false);
  if (await isChecked()) return true;

  const id = await input.getAttribute('id').catch(() => null);
  const candidates = [page.locator(`label:has(${selector})`).first()];
  if (id) candidates.push(page.locator(`label[for="${id}"]`).first());
  candidates.push(input);

  for (const target of candidates) {
    if (!(await target.count().catch(() => 0))) continue;
    if (!(await target.isVisible().catch(() => false))) continue;
    try {
      await target.click({ timeout: 5000 });
      if (await isChecked()) return true;
    } catch {}
  }

  await input.evaluate((el) => {
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).catch(() => {});
  if (await isChecked()) return true;

  if (optional) return false;
  throw new Error(`Não foi possível marcar ${name}=${value}: o portal não aceitou clique nem no rótulo nem no campo.`);
}

async function selectSelect2(page, selectId, searchText, expectedText) {
  const select = page.locator(`#${selectId}`);
  if (!(await select.count())) throw new Error(`Campo #${selectId} não encontrado.`);
  const widget = select.locator('xpath=following-sibling::span[contains(@class,"select2-container")]').first();
  if (!(await widget.count())) throw new Error(`Widget de seleção #${selectId} não encontrado.`);
  await widget.click({ timeout: 8000 });
  const search = page.locator('.select2-search__field').last();
  await search.fill(searchText || expectedText || '');
  await page.locator('.select2-results__option').filter({ hasNotText: 'Buscando' }).first()
    .waitFor({ state: 'visible', timeout: 10000 });
  const options = page.locator('.select2-results__option').filter({ hasText: expectedText });
  if (!(await options.count())) throw new Error(`Opção "${expectedText}" não encontrada em #${selectId}.`);
  await options.first().click({ timeout: 8000 });
}

async function selectChosen(page, selectId, expectedText, { optional = false } = {}) {
  const container = page.locator(`#${selectId}_chosen`);
  if (!(await container.count())) {
    const native = page.locator(`#${selectId}`);
    if (await native.count()) {
      const options = await native.locator('option').allTextContents();
      const target = options.find((v) => v.includes(expectedText));
      if (target) { await native.selectOption({ label: target }); return true; }
    }
    if (optional) return false;
    throw new Error(`Campo ${selectId} não encontrado.`);
  }
  const single = container.locator('a.chosen-single');
  for (let i = 0; i < 3; i++) {
    await single.click({ timeout: 8000 });
    await page.waitForTimeout(250);
    const className = await container.getAttribute('class');
    if (className?.includes('chosen-with-drop')) break;
  }
  const option = container.locator('.chosen-results li').filter({ hasText: expectedText });
  if (!(await option.count())) {
    if (optional) return false;
    throw new Error(`Opção "${expectedText}" não encontrada em ${selectId}.`);
  }
  await option.first().click({ timeout: 8000 });
  return true;
}

// Alguns selects do portal são <select style="display:none"> com um widget
// Chosen por cima. Tentamos o caminho humano (abrir o widget e clicar na opção)
// e, se ele não pegar, escrevemos o valor no select nativo avisando a página.
async function selectChosenValue(page, selectId, value, textFragment, { optional = false } = {}) {
  const select = page.locator(`#${selectId}`);
  if (!(await select.count().catch(() => 0))) {
    if (optional) return false;
    throw new Error(`Campo ${selectId} não encontrado.`);
  }
  const wanted = String(value ?? '').trim();
  if (!wanted) {
    if (optional) return false;
    throw new Error(`Nenhum valor configurado para ${selectId}.`);
  }
  const current = () => select.inputValue().catch(() => '');
  if (await current() === wanted) return true;

  if (textFragment) {
    await selectChosen(page, selectId, textFragment, { optional: true }).catch(() => {});
    if (await current() === wanted) return true;
  }

  await select.evaluate((el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.jQuery) window.jQuery(el).trigger('chosen:updated').trigger('change');
  }, wanted).catch(() => {});
  if (await current() === wanted) return true;

  // O campo existe e é obrigatório: falhar aqui é melhor que quebrar no Avançar.
  throw new Error(`Não foi possível selecionar a opção "${wanted}" em ${selectId}.`);
}

async function advance(page, context) {
  const before = page.url();
  const button = page.locator('button:has-text("Avançar"), a:has-text("Avançar")').first();
  if (!(await button.count())) throw new Error(`${context}: botão Avançar não encontrado.`);
  await button.click({ timeout: 10000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(500);
  const errors = await readValidationErrors(page);
  if (errors.length) throw new Error(`${context}: ${errors.join('; ')}`);
  if (page.url() === before && await button.isVisible().catch(() => false)) {
    // Some steps are AJAX driven and don't change URL; only warn by allowing the next selectors to prove success.
  }
}

// isEditable() só olha enabled/readonly: um campo escondido pelo portal (bloco
// colapsado, opção que não se aplica) passa por ele e trava o fill esperando
// visibilidade. Por isso a checagem de visível vem antes, e o fill tem prazo curto.
async function fillIfEditable(page, selector, value) {
  const field = page.locator(selector).first();
  if (!(await field.count().catch(() => 0))) return false;
  if (!(await field.isVisible().catch(() => false))) return false;
  if (!(await field.isEditable().catch(() => false))) return false;
  try {
    await field.fill(String(value), { timeout: 8000 });
  } catch {
    return false;
  }
  await field.blur().catch(() => {});
  return true;
}

async function fillFirstEditable(page, selectors, value) {
  for (const selector of selectors) {
    if (await fillIfEditable(page, selector, value)) return selector;
  }
  return null;
}

async function findInputByLabel(page, labelRegex) {
  const labels = page.locator('label');
  const count = await labels.count();
  for (let i = 0; i < count; i++) {
    const label = labels.nth(i);
    const text = (await label.innerText().catch(() => '')).trim();
    if (!labelRegex.test(text)) continue;
    const forId = await label.getAttribute('for');
    if (forId && await page.locator(`#${forId}`).count()) return page.locator(`#${forId}`).first();
    const nested = label.locator('input,textarea,select').first();
    if (await nested.count()) return nested;
    const nearby = label.locator('xpath=following::input[1]').first();
    if (await nearby.count()) return nearby;
  }
  return null;
}

async function fillByLabelOrCandidates(page, { labelRegex, selectors, value, optional = false }) {
  const selected = await fillFirstEditable(page, selectors || [], value);
  if (selected) return selected;
  const field = await findInputByLabel(page, labelRegex);
  if (field && await field.isVisible().catch(() => false) && await field.isEditable().catch(() => false)) {
    try {
      await field.fill(String(value), { timeout: 8000 });
      await field.blur().catch(() => {});
      return 'label';
    } catch {}
  }
  if (optional) return null;
  throw new Error(`Campo "${labelRegex}" não encontrado ou não editável.`);
}

async function screenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
}

module.exports = {
  wait,
  readValidationErrors,
  setRadio,
  selectSelect2,
  selectChosen,
  selectChosenValue,
  advance,
  fillIfEditable,
  fillFirstEditable,
  fillByLabelOrCandidates,
  screenshot,
  formatPortalMoney
};
