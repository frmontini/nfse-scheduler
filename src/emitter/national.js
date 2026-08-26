const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { DATA_DIR, getSettings, updateInvoice, addInvoiceEvent, getInvoice } = require('../db');
const { login, baseUrl } = require('./auth');
const {
  setRadio,
  selectSelect2,
  selectChosen,
  selectChosenValue,
  advance,
  fillIfEditable,
  fillByLabelOrCandidates,
  screenshot,
  formatPortalMoney
} = require('./dom');
const { moneyFromCents, todayPtBr, renderTemplate, searchTermFor } = require('../utils');
const { discoverMetadata, archiveDocuments } = require('./documents');

// Trechos que identificam cada opção de SimplesNacional.RegimeApuracaoTributosSN
// no widget Chosen (as três começam igual, então o recorte precisa ser o final).
const SN_APURACAO_TEXTO = {
  '1': 'municipal pelo Simples Nacional',
  '2': 'ISSQN pela NFS-e',
  '3': 'municipal pela NFS-e'
};

function boolOverride(overrides, key, fallback) {
  return Object.prototype.hasOwnProperty.call(overrides || {}, key) ? Boolean(overrides[key]) : Boolean(fallback);
}

function numberOverride(overrides, key, fallback) {
  const value = Object.prototype.hasOwnProperty.call(overrides || {}, key) ? Number(overrides[key]) : Number(fallback || 0);
  return Number.isFinite(value) ? value : Number(fallback || 0);
}

function textOverride(overrides, key, fallback) {
  const value = Object.prototype.hasOwnProperty.call(overrides || {}, key) ? overrides[key] : fallback;
  return String(value ?? '').trim();
}

function buildEmissionData(automation, invoice, settings) {
  const o = automation.overrides || {};
  const client = {
    id: automation.client_id,
    name: automation.client_name,
    document: automation.client_document,
    email: automation.client_email,
    type: automation.client_type
  };
  const serviceDescription = automation.service_description || settings.portal.serviceDescription;
  const municipalityName = automation.municipality_name || settings.portal.municipalityName;
  const municipalitySearch = automation.municipality_search || settings.portal.municipalitySearch;
  const taxCodeName = automation.tax_code_name || settings.portal.taxCodeName;
  const taxCodeSearch = automation.tax_code_search || settings.portal.taxCodeSearch;
  return {
    client,
    competence: invoice.competence,
    // Data de Competência do portal = dia da geração, não o primeiro dia do mês.
    emissionDate: todayPtBr(),
    value: moneyFromCents(invoice.value_cents),
    discountIncond: moneyFromCents(invoice.discount_incond_cents),
    discountCond: moneyFromCents(invoice.discount_cond_cents),
    municipalitySearch: municipalitySearch || searchTermFor(municipalityName),
    municipalityName,
    taxCodeSearch: taxCodeSearch || searchTermFor(taxCodeName),
    taxCodeName,
    serviceDescription: renderTemplate(serviceDescription, {
      competence: invoice.competence,
      clientName: client.name,
      clientDocument: client.document,
      valueCents: invoice.value_cents
    }),
    fillIbsCbs: boolOverride(o, 'fillIbsCbs', settings.portal.fillIbsCbs),
    governmentPurchase: boolOverride(o, 'governmentPurchase', settings.portal.governmentPurchase),
    recipientIsBuyer: boolOverride(o, 'recipientIsBuyer', settings.portal.recipientIsBuyer),
    ibsCbsTipoOperacao: textOverride(o, 'ibsCbsTipoOperacao', settings.portal.ibsCbsTipoOperacao),
    ibsCbsCodigoIndOp: textOverride(o, 'ibsCbsCodigoIndOp', settings.portal.ibsCbsCodigoIndOp),
    ibsCbsCst: textOverride(o, 'ibsCbsCst', settings.portal.ibsCbsCst),
    ibsCbsClassTrib: textOverride(o, 'ibsCbsClassTrib', settings.portal.ibsCbsClassTrib),
    issSuspension: boolOverride(o, 'issSuspension', settings.tax.issSuspension),
    issRetention: boolOverride(o, 'issRetention', settings.tax.issRetention),
    municipalBenefit: boolOverride(o, 'municipalBenefit', settings.tax.municipalBenefit),
    pisCofinsSituacao: textOverride(o, 'pisCofinsSituacao', settings.tax.pisCofinsSituacao),
    pisCofinsRetencao: textOverride(o, 'pisCofinsRetencao', settings.tax.pisCofinsRetencao),
    pisRate: numberOverride(o, 'pisRate', settings.tax.pisRate),
    cofinsRate: numberOverride(o, 'cofinsRate', settings.tax.cofinsRate),
    irrfRate: numberOverride(o, 'irrfRate', settings.tax.irrfRate),
    csllRate: numberOverride(o, 'csllRate', settings.tax.csllRate),
    cpRate: numberOverride(o, 'cpRate', settings.tax.cpRate),
    approxMode: textOverride(o, 'approxMode', settings.tax.approxMode || 'percent'),
    approxFederal: numberOverride(o, 'approxFederal', settings.tax.approxFederal),
    approxState: numberOverride(o, 'approxState', settings.tax.approxState),
    approxMunicipal: numberOverride(o, 'approxMunicipal', settings.tax.approxMunicipal),
    snTotalRate: numberOverride(o, 'snTotalRate', settings.tax.snTotalRate),
    simpleNational: Boolean(settings.tax.simpleNational),
    nbsCode: String(settings.company.nbsCode || '').trim(),
    snApuracaoRegime: textOverride(o, 'snApuracaoRegime', settings.tax.snApuracaoRegime)
  };
}

function validateEmissionData(data) {
  const required = [
    ['Município de prestação', data.municipalityName],
    ['Código de Tributação Nacional', data.taxCodeName],
    ['Descrição do serviço', data.serviceDescription]
  ];
  const missing = required.filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
  if (missing.length) throw new Error(`Configuração incompleta: ${missing.join(', ')}.`);
  // Decisão fiscal: define onde o IBS/CBS incide. O projeto não escolhe por você.
  if (data.fillIbsCbs) {
    const faltando = [
      !data.ibsCbsCodigoIndOp && '"Código indicador da operação" (define o local de incidência)',
      !data.ibsCbsCst && '"Código de Situação Tributária do IBS/CBS"',
      !data.ibsCbsClassTrib && '"Código de Classificação Tributária do IBS/CBS"'
    ].filter(Boolean);
    if (faltando.length) {
      throw new Error(`IBS/CBS ligado exige ${faltando.join(' e ')} em Empresa e tributos → Serviço. São decisões fiscais: escolha com seu contador antes de emitir.`);
    }
  }
  if (!data.client.document) throw new Error('Cliente sem CPF/CNPJ.');

}

async function fillPeople(page, data) {
  await page.goto(`${baseUrl()}/EmissorNacional/DPS/Pessoas`, { waitUntil: 'networkidle', timeout: 30000 });
  await setRadio(page, 'PreencherInfoIBSCBS', data.fillIbsCbs ? '1' : '0', { optional: true });
  await page.waitForTimeout(300);
  // Só aparece para optantes do Simples Nacional, e aí é obrigatório.
  await selectChosenValue(
    page,
    'SimplesNacional_RegimeApuracaoTributosSN',
    data.snApuracaoRegime,
    SN_APURACAO_TEXTO[data.snApuracaoRegime],
    { optional: true }
  );
  await page.waitForTimeout(300);
  await page.fill('#DataCompetencia', data.emissionDate);
  await page.locator('#DataCompetencia').blur();
  await setRadio(page, 'Tomador.LocalDomicilio', '1');
  await page.waitForTimeout(300);
  await page.fill('#Tomador_Inscricao', data.client.document);
  await page.locator('#Tomador_Inscricao').blur();
  await page.waitForTimeout(4000);
  const name = await page.locator('#Tomador_Nome').inputValue().catch(() => '');
  if (!name) throw new Error(`O portal não retornou nome/endereço para ${data.client.document}.`);

  // Só existem no modo IBS/CBS, e só depois do lookup do tomador: o portal
  // desabilita o formulário enquanto busca o CNPJ e perde marcações feitas antes.
  if (data.fillIbsCbs) {
    await setRadio(page, 'EhCompraGovernamental', data.governmentPurchase ? '1' : '0');
    await page.waitForTimeout(1200);
    await setRadio(page, 'DestinatarioEhOAdquirente', data.recipientIsBuyer ? '1' : '0');
    await page.waitForTimeout(1200);
  }
  await advance(page, 'Etapa Pessoas');
}

async function fillService(page, data) {
  await selectSelect2(page, 'LocalPrestacao_CodigoMunicipioPrestacao', data.municipalitySearch, data.municipalityName);
  await page.waitForTimeout(500);
  await selectSelect2(page, 'ServicoPrestado_CodigoTributacaoNacional', data.taxCodeSearch, data.taxCodeName);
  await page.waitForTimeout(500);
  // O select de NBS lista "código - descrição"; o código sozinho identifica a opção.
  if (data.nbsCode) {
    await selectChosenValue(page, 'ServicoPrestado_CodigoNBS', data.nbsCode, `${data.nbsCode} - `, { optional: true });
    await page.waitForTimeout(400);
  }
  await setRadio(page, 'ServicoPrestado.HaExportacaoImunidadeNaoIncidencia', '0', { optional: true });
  // Tipo de operação: só aparece no modo IBS/CBS e o portal não deixa avançar sem ele.
  if (data.fillIbsCbs) {
    if (data.ibsCbsTipoOperacao) {
      await selectChosenValue(page, 'ServicoPrestado_CodigoTpOper', data.ibsCbsTipoOperacao, `${data.ibsCbsTipoOperacao} - `, { optional: true });
      await page.waitForTimeout(500);
    }
    if (data.ibsCbsCodigoIndOp) {
      await selectChosenValue(page, 'ServicoPrestado_CodigoIndOp', data.ibsCbsCodigoIndOp, `${data.ibsCbsCodigoIndOp} - `, { optional: true });
      await page.waitForTimeout(500);
    }
  }
  await page.fill('#ServicoPrestado_Descricao', data.serviceDescription);
  await page.locator('#ServicoPrestado_Descricao').blur();
  await advance(page, 'Etapa Serviço');
}

async function fillDiscounts(page, data) {
  if (data.discountIncond > 0) {
    await fillByLabelOrCandidates(page, {
      labelRegex: /desconto\s+incondicional/i,
      selectors: [
        '#Valores_DescontoIncondicionado',
        '#Valores_ValorDescontoIncondicionado',
        'input[name="Valores.DescontoIncondicionado"]',
        'input[name*="DescontoIncond"]'
      ],
      value: formatPortalMoney(data.discountIncond)
    });
  }
  if (data.discountCond > 0) {
    await fillByLabelOrCandidates(page, {
      labelRegex: /desconto\s+condicionado/i,
      selectors: [
        '#Valores_DescontoCondicionado',
        '#Valores_ValorDescontoCondicionado',
        'input[name="Valores.DescontoCondicionado"]',
        'input[name*="DescontoCond"]'
      ],
      value: formatPortalMoney(data.discountCond)
    });
  }
}

async function setIssOptions(page, data) {
  await setRadio(page, 'ISSQN.HaSuspensao', data.issSuspension ? '1' : '0', { optional: true });
  await setRadio(page, 'ISSQN.HaRetencao', data.issRetention ? '1' : '0', { optional: true });
  await setRadio(page, 'ISSQN.HaBeneficioMunicipal', data.municipalBenefit ? '1' : '0', { optional: true });
  await page.waitForTimeout(800);
}

async function fillFederalIfEditable(page, data) {
  // No Simples Nacional o próprio Emissor pode preencher e bloquear estes campos.
  // Nunca forçamos campos readonly/disabled.
  // Situação tributária: value "0" aparece como "00 - Nenhum" na lista.
  if (data.pisCofinsSituacao) {
    await selectChosenValue(
      page,
      'TributacaoFederal_PISCofins_SituacaoTributaria',
      data.pisCofinsSituacao,
      `${String(data.pisCofinsSituacao).padStart(2, '0')} - `,
      { optional: true }
    );
    await page.waitForTimeout(400);
  }
  const base = Math.max(0, data.value - data.discountIncond);
  await fillIfEditable(page, '#TributacaoFederal_PISCofins_BaseDeCalculo', formatPortalMoney(base));
  if (data.pisRate > 0) await fillIfEditable(page, '#TributacaoFederal_PISCofins_AliquotaPIS', formatPortalMoney(data.pisRate));
  if (data.cofinsRate > 0) await fillIfEditable(page, '#TributacaoFederal_PISCofins_AliquotaCOFINS', formatPortalMoney(data.cofinsRate));

  if (data.pisCofinsRetencao) {
    await selectChosenValue(
      page,
      'TributacaoFederal_PISCofins_TipoRetencao',
      data.pisCofinsRetencao,
      `${data.pisCofinsRetencao} - `,
      { optional: true }
    );
  }

  if (data.irrfRate > 0) {
    await fillIfEditable(page, '#TributacaoFederal_ValorIRRF', formatPortalMoney(base * data.irrfRate / 100));
  }
  if (data.csllRate > 0) {
    await fillIfEditable(page, '#TributacaoFederal_ValorCSLL', formatPortalMoney(base * data.csllRate / 100));
  }
  if (data.cpRate > 0) {
    await fillByLabelOrCandidates(page, {
      labelRegex: /contribui[cç][aã]o\s+previdenci[aá]ria|\bCP\b/i,
      selectors: ['#TributacaoFederal_ValorCP', 'input[name*="ValorCP"]'],
      value: formatPortalMoney(base * data.cpRate / 100),
      optional: true
    });
  }
}

// "Valor aproximado dos tributos" no portal é um radio com quatro opções:
//   1 valores monetários | 2 percentuais | 3 não informar | 4 alíquota do Simples Nacional
// Para optante do Simples o portal já marca a 4 e mostra #ValorTributos_AliquotaSN.
const APPROX_MODE_RADIO = { value: '1', percent: '2', none: '3', sn: '4' };

async function fillApproxTaxes(page, data) {
  const radioValue = APPROX_MODE_RADIO[data.approxMode] || APPROX_MODE_RADIO.percent;
  const found = await setRadio(page, 'ValorTributos.TipoValorTributos', radioValue, { optional: true });
  if (!found) return;
  await page.waitForTimeout(400);

  if (data.approxMode === 'none') return;
  if (data.approxMode === 'sn') {
    if (data.snTotalRate > 0) {
      await fillIfEditable(page, '#ValorTributos_AliquotaSN', formatPortalMoney(data.snTotalRate));
    }
    return;
  }
  if (data.approxMode === 'percent') {
    await fillIfEditable(page, '#ValorTributos_PercentualTotalFederal', formatPortalMoney(data.approxFederal));
    await fillIfEditable(page, '#ValorTributos_PercentualTotalEstadual', formatPortalMoney(data.approxState));
    await fillIfEditable(page, '#ValorTributos_PercentualTotalMunicipal', formatPortalMoney(data.approxMunicipal));
    return;
  }
  await fillIfEditable(page, '#ValorTributos_ValorTotalFederal', formatPortalMoney(data.approxFederal));
  await fillIfEditable(page, '#ValorTributos_ValorTotalEstadual', formatPortalMoney(data.approxState));
  await fillIfEditable(page, '#ValorTributos_ValorTotalMunicipal', formatPortalMoney(data.approxMunicipal));
}

async function fillTax(page, data) {
  if (data.fillIbsCbs && data.ibsCbsCst) {
    await selectChosenValue(page, 'ValorTributos_CodigoSituacaoTributaria', data.ibsCbsCst, `${data.ibsCbsCst} - `, { optional: true });
    await page.waitForTimeout(800);
    // As opções deste são filtradas pelo CST acima, por isso ele vem depois.
    if (data.ibsCbsClassTrib) {
      await selectChosenValue(page, 'ValorTributos_CodigoClassificacaoTributaria', data.ibsCbsClassTrib, `${data.ibsCbsClassTrib} - `, { optional: true });
      await page.waitForTimeout(600);
    }
  }
  await page.fill('#Valores_ValorServico', formatPortalMoney(data.value));
  await page.locator('#Valores_ValorServico').blur();
  await page.waitForTimeout(700);
  await fillDiscounts(page, data);
  await setIssOptions(page, data);
  await fillFederalIfEditable(page, data);
  await fillApproxTaxes(page, data);
  await advance(page, 'Etapa Tributação/Valores');
}

function launchOptions() {
  const headless = String(process.env.PLAYWRIGHT_HEADLESS ?? 'true').toLowerCase() !== 'false';
  const slowMo = Number(process.env.BROWSER_SLOW_MO_MS || 0);
  return {
    headless,
    slowMo: Number.isFinite(slowMo) ? slowMo : 0,
    // Container sem shm_size grande (padrão de 64 MB) derruba o Chromium no meio
    // do formulário; com esta flag ele usa /tmp e não depende disso.
    args: ['--disable-dev-shm-usage']
  };
}

// Falha no preenchimento vira evidência em disco: sem isso, quando o portal
// muda, sobra só a mensagem de erro e nenhuma pista do que estava na tela.
async function captureFailure(page, tag) {
  const stamp = Date.now();
  const name = `erro-${tag}-${stamp}`;
  await screenshot(page, path.join(DATA_DIR, 'debug', `${name}.png`));
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'debug', `${name}.html`), await page.content());
  } catch {}
  return `${name}.png`;
}

async function openFilledReview({ automation, invoice, captureSteps = false }) {
  const settings = getSettings();
  const data = buildEmissionData(automation, invoice, settings);
  validateEmissionData(data);
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ locale: 'pt-BR' });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept().catch(() => {}));
  const stamp = Date.now();
  // Na prévia guardamos o HTML de cada etapa: é a única forma de descobrir
  // campos novos do portal sem ficar adivinhando seletor.
  const capture = async (step) => {
    if (!captureSteps) return;
    try {
      fs.writeFileSync(path.join(DATA_DIR, 'debug', `etapa-${stamp}-${step}.html`), await page.content());
    } catch {}
  };
  try {
    await login(page);
    await fillPeople(page, data);
    await capture('servico');
    await fillService(page, data);
    await capture('valores');
    await fillTax(page, data);
    await capture('revisao');
    return { browser, context, page, data };
  } catch (err) {
    const evidence = await captureFailure(page, `automacao-${automation.id}`).catch(() => null);
    await browser.close().catch(() => {});
    if (evidence) err.message = `${err.message} (o que estava na tela: /api/debug/${evidence})`;
    throw err;
  }
}

async function previewInvoice({ automation, invoice }) {
  const { browser, page, data } = await openFilledReview({ automation, invoice, captureSteps: true });
  const file = path.join(DATA_DIR, 'debug', `preview-${automation.id}-${Date.now()}.png`);
  try {
    await screenshot(page, file);
    return { file, url: page.url(), data };
  } finally {
    await browser.close();
  }
}

async function issueInvoice({ automation, invoice }) {
  const { browser, context, page } = await openFilledReview({ automation, invoice });
  const debugFile = path.join(DATA_DIR, 'debug', `review-${invoice.id}-${Date.now()}.png`);
  try {
    await screenshot(page, debugFile);
    const submit = page.locator('#btnProsseguir').first();
    if (!(await submit.count())) throw new Error('Botão final "Emitir NFS-e" (#btnProsseguir) não foi encontrado.');

    // Critical idempotency boundary: after this timestamp, the worker never auto-reissues.
    updateInvoice(invoice.id, { status: 'SUBMITTING', submitted_at: new Date().toISOString(), last_error: null });
    addInvoiceEvent(invoice.id, 'SUBMITTING', 'Clique final de emissão iniciado. A partir daqui não há reemissão automática.');

    await submit.click({ timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const sameButton = await page.locator('#btnProsseguir').count();
    if (sameButton > 0) {
      throw new Error('O portal permaneceu na tela final após o clique. O resultado da emissão é incerto e exige conferência manual.');
    }

    const metadata = await discoverMetadata(page);
    if (!metadata.accessKey) {
      throw new Error('O portal saiu da tela de emissão, mas a chave da NFS-e não pôde ser confirmada. Confira a nota no portal; reemissão automática foi bloqueada.');
    }
    const latest = getInvoice(invoice.id);
    const docs = await archiveDocuments({
      page,
      context,
      invoice: latest,
      accessKey: metadata.accessKey
    });

    return { ...metadata, ...docs, debugFile };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function retrieveDocuments(invoice) {
  if (!invoice?.access_key) throw new Error('Chave de acesso não disponível.');
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ locale: 'pt-BR' });
  const page = await context.newPage();
  try {
    await login(page);
    return await archiveDocuments({ page, context, invoice, accessKey: invoice.access_key });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function testPortalLogin() {
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ locale: 'pt-BR' });
  const page = await context.newPage();
  try {
    await login(page);
    return { ok: true, url: page.url() };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  buildEmissionData,
  validateEmissionData,
  previewInvoice,
  issueInvoice,
  retrieveDocuments,
  testPortalLogin
};
