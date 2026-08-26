const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../db');
const { baseUrl } = require('./auth');
const { safeFilename } = require('../utils');

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
  const result = { xmlPath: null, pdfPath: null, warnings: [] };

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

  const xmlLink = links.find((x) => /xml/i.test(`${x.text} ${x.href}`));
  const xmlPath = path.join(dir, `${safeFilename(accessKey)}.xml`);
  if (xmlLink) {
    if (await requestAndSave(context, xmlLink.href, xmlPath, 'xml').catch(() => false)) result.xmlPath = xmlPath;
    else result.warnings.push('O link autenticado de XML foi encontrado, mas o download falhou.');
  } else {
    result.warnings.push('O portal não exibiu link de XML na visualização autenticada.');
  }

  const printLink = links.find((x) => /Visualizar\/Impressao/i.test(x.href) || /imprimir|impress[aã]o/i.test(x.text));
  if (printLink) {
    const pdfPath = path.join(dir, `${safeFilename(accessKey)}-danfse.pdf`);
    try {
      await page.goto(printLink.href, { waitUntil: 'networkidle', timeout: 30000 });
      const body = await page.locator('body').innerText().catch(() => '');
      if (/captcha/i.test(body)) {
        result.warnings.push('A página de impressão exigiu CAPTCHA; o sistema não tenta contorná-lo.');
      } else {
        await page.emulateMedia({ media: 'print' }).catch(() => {});
        await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
        result.pdfPath = pdfPath;
      }
    } catch (err) {
      result.warnings.push(`Falha ao gerar PDF pela visualização autenticada: ${err.message}`);
    }
  } else {
    result.warnings.push('O portal não exibiu a rota autenticada de impressão do DANFSe.');
  }

  return result;
}

module.exports = { extractAccessKey, extractNfseNumber, discoverMetadata, archiveDocuments };
