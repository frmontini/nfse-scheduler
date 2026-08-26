const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../db');
const { baseUrl } = require('./auth');
const { safeFilename, competenceParts, MONTHS_PT } = require('../utils');
const { dadosDanfse } = require('../danfse-parse');
const { renderDanfseHtml } = require('../danfse');

function extractAccessKey(text) {
  const clean = String(text || '').replace(/[.\s-]/g, ' ');
  const candidates = clean.match(/\b\d{44,60}\b/g) || [];
  return candidates.sort((a, b) => b.length - a.length)[0] || null;
}

function extractNfseNumber(text) {
  const source = String(text || '');
  const patterns = [
    /NFS-?e\s*(?:n[º°o.]?|n[uú]mero)?\s*[:#-]?\s*(\d{1,20})/i,
    /N[uú]mero\s+da\s+NFS-?e\s*[:#-]?\s*(\d{1,20})/i
  ];
  for (const p of patterns) {
    const m = source.match(p);
    if (m) return m[1];
  }
  return null;
}

async function discoverMetadata(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  const hrefs = await page.locator('a[href]').evaluateAll((els) => els.map((e) => e.href)).catch(() => []);
  const fromHref = hrefs.map((h) => {
    const m = h.match(/Visualizar\/Index\/(\d{44,60})/i);
    return m?.[1];
  }).find(Boolean);
  return {
    accessKey: fromHref || extractAccessKey(body),
    nfseNumber: extractNfseNumber(body),
    issueUrl: page.url(),
    bodyText: body
  };
}

async function requestAndSave(context, url, filePath, expected = null) {
  const response = await context.request.get(url, { timeout: 30000, failOnStatusCode: false });
  if (!response.ok()) return false;
  const body = await response.body();
  const type = (response.headers()['content-type'] || '').toLowerCase();
  if (expected === 'xml' && !(type.includes('xml') || body.toString('utf8', 0, Math.min(body.length, 200)).includes('<?xml'))) return false;
  fs.writeFileSync(filePath, body);
  return true;
}

async function archiveDocuments({ page, context, invoice, accessKey }) {
  const dir = path.join(DATA_DIR, 'files', invoice.competence, `invoice-${invoice.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const result = { xmlPath: null, pdfPath: null, warnings: [], notes: [] };

  if (!accessKey) {
    result.warnings.push('Chave da NFS-e não identificada na tela pós-emissão; documentos não foram arquivados automaticamente.');
    return result;
  }

  const viewUrl = `${baseUrl()}/EmissorNacional/Notas/Visualizar/Index/${accessKey}`;
  await page.goto(viewUrl, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

  const links = await page.locator('a[href]').evaluateAll((els) => els.map((e) => ({
    href: e.href,
    text: (e.textContent || '').trim()
  }))).catch(() => []);

  const xmlLink = links.find((x) => /Download\/NFSe/i.test(x.href) || /xml/i.test(`${x.text} ${x.href}`));
  const xmlPath = path.join(dir, `${safeFilename(accessKey)}.xml`);
  if (xmlLink) {
    if (await requestAndSave(context, xmlLink.href, xmlPath, 'xml').catch(() => false)) result.xmlPath = xmlPath;
    else result.notes.push('O XML oficial exige CAPTCHA no portal; use o botão "Portal" no histórico para baixá-lo quando precisar.');
  } else {
    result.notes.push('O portal não exibiu link de XML na visualização autenticada.');
  }

  // O DANFSe oficial fica atrás de hCaptcha no portal. Desde a NT 008/2026 quem
  // emite gera o documento auxiliar por conta própria: montamos com os dados da
  // própria visualização, que abre normalmente pela sessão autenticada.
  const pdfPath = path.join(dir, `${safeFilename(accessKey)}-danfse.pdf`);
  try {
    const dados = dadosDanfse(await page.content());
    dados.numero = invoice.nfse_number || dados.numero || '';
    dados.competencia = competenciaExtenso(invoice.competence);
    dados.valorLiquido = dados.valorLiquido || moeda(liquido(invoice));
    dados.descontoCondicionado = moeda(invoice.discount_cond_cents);
    if (!dados.chave) dados.chave = accessKey;

    const html = await renderDanfseHtml(dados);
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
    result.pdfPath = pdfPath;
    result.danfseGerado = true;
  } catch (err) {
    result.warnings.push(`Falha ao gerar o DANFSe local: ${err.message}`);
  }

  return result;
}

function moeda(cents) {
  return (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}

function liquido(invoice) {
  return Number(invoice.value_cents || 0) - Number(invoice.discount_incond_cents || 0) - Number(invoice.discount_cond_cents || 0);
}

function competenciaExtenso(competence) {
  try {
    const { year, month } = competenceParts(competence);
    return `${MONTHS_PT[month - 1]}/${year}`;
  } catch {
    return String(competence || '');
  }
}

module.exports = { extractAccessKey, extractNfseNumber, discoverMetadata, archiveDocuments };
