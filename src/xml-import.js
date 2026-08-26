/*
 * Leitor do XML da NFS-e nacional (leiaute do Sistema Nacional NFS-e,
 * XSD v1.01 de fev/2026, namespace http://www.sped.fazenda.gov.br/nfse).
 *
 * Caminhos usados:
 *   NFSe/infNFSe            -> Id (chave), nNFSe, dhProc, xLocPrestacao, xTribNac, xNBS
 *   NFSe/infNFSe/emit       -> CNPJ|CPF, IM, xNome, xFant
 *   .../DPS/infDPS          -> dhEmi, dCompet, serie, nDPS
 *   .../infDPS/prest        -> CNPJ, IM, xNome, regTrib(opSimpNac, regApTribSN, regEspTrib)
 *   .../infDPS/toma         -> CNPJ|CPF, xNome, email
 *   .../infDPS/serv         -> locPrest/cLocPrestacao, cServ(cTribNac, cTribMun, xDescServ, cNBS)
 *   .../infDPS/valores      -> vServPrest/vServ, vDescCondIncond(vDescIncond, vDescCond),
 *                              trib/tribMun(tribISSQN, tpRetISSQN, pAliq, exigSusp),
 *                              trib/tribFed(piscofins(pAliqPis, pAliqCofins, tpRetPisCofins), vRetIRRF, vRetCSLL, vRetCP),
 *                              trib/totTrib(pTotTribSN)
 *
 * Aceita tanto o XML da NFS-e emitida quanto o XML só da DPS.
 */
const { digits } = require('./utils');

const REGIMES_ESPECIAIS = {
  '0': 'Nenhum',
  '1': 'Ato Cooperado (Cooperativa)',
  '2': 'Estimativa',
  '3': 'Microempresa Municipal',
  '4': 'Notário ou Registrador',
  '5': 'Profissional Autônomo',
  '6': 'Sociedade de Profissionais'
};

function block(xml, name) {
  if (!xml) return null;
  const match = String(xml).match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i'));
  return match ? match[1] : null;
}

function value(xml, name) {
  const raw = block(xml, name);
  if (raw === null) return null;
  const text = raw.trim();
  return text && !text.includes('<') ? text : null;
}

function attr(xml, tagName, attrName) {
  if (!xml) return null;
  const match = String(xml).match(new RegExp(`<(?:[\\w.-]+:)?${tagName}\\s[^>]*${attrName}="([^"]+)"`, 'i'));
  return match ? match[1] : null;
}

function number(xml, name) {
  const raw = value(xml, name);
  if (raw === null) return null;
  const parsed = Number(String(raw).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function cents(amount) {
  return amount === null || amount === undefined ? null : Math.round(amount * 100);
}

function formatCnpjCpf(raw) {
  const d = digits(raw);
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return d || null;
}

// cTribNac tem 6 dígitos (LC 116/2003): 010101 -> 01.01.01
function formatTribNac(code) {
  const d = digits(code);
  if (d.length !== 6) return d || null;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
}

function competenceFromXml(raw) {
  const d = digits(raw);
  if (d.length >= 6) return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
  return null;
}

function firstWord(text) {
  return String(text || '').split(/[\s/,-]+/).filter(Boolean)[0] || null;
}

function clean(obj) {
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined || val === '') continue;
    out[key] = val;
  }
  return out;
}

function parseNfseXml(rawXml) {
  const xml = String(rawXml || '').replace(/^﻿/, '').trim();
  if (!xml.startsWith('<') && !xml.includes('<')) throw new Error('O arquivo enviado não é XML.');

  const infNFSe = block(xml, 'infNFSe');
  const infDPS = block(xml, 'infDPS');
  if (!infNFSe && !infDPS) {
    throw new Error('Não encontrei <infNFSe> nem <infDPS>: o arquivo não parece um XML de NFS-e do padrão nacional.');
  }

  const warnings = [];
  const emit = block(infNFSe, 'emit');
  const prest = block(infDPS, 'prest');
  const toma = block(infDPS, 'toma');
  const serv = block(infDPS, 'serv');
  const cServ = block(serv, 'cServ');
  const locPrest = block(serv, 'locPrest');
  const valores = block(infDPS, 'valores');
  const vServPrest = block(valores, 'vServPrest');
  const descontos = block(valores, 'vDescCondIncond');
  const trib = block(valores, 'trib');
  const tribMun = block(trib, 'tribMun');
  const tribFed = block(trib, 'tribFed');
  const piscofins = block(tribFed, 'piscofins');
  const totTrib = block(trib, 'totTrib');
  const regTrib = block(prest, 'regTrib');

  const company = clean({
    name: value(emit, 'xNome') || value(prest, 'xNome'),
    cnpj: formatCnpjCpf(value(emit, 'CNPJ') || value(emit, 'CPF') || value(prest, 'CNPJ') || value(prest, 'CPF')),
    municipalRegistration: value(emit, 'IM') || value(prest, 'IM'),
    nbsCode: value(cServ, 'cNBS') || value(infNFSe, 'xNBS')
  });

  // O infNFSe já traz as descrições oficiais; é o texto que o portal mostra nos selects.
  const municipalityName = value(infNFSe, 'xLocPrestacao') || value(infNFSe, 'xLocIncid');
  const tribNacCode = formatTribNac(value(cServ, 'cTribNac'));
  const tribNacName = value(infNFSe, 'xTribNac');
  const portal = clean({
    municipalityName,
    municipalitySearch: firstWord(municipalityName),
    taxCodeName: tribNacName || tribNacCode,
    taxCodeSearch: tribNacCode ? tribNacCode.split('.').slice(0, 2).join('.') : (tribNacName || null),
    serviceDescription: value(cServ, 'xDescServ')
  });

  const opSimpNac = value(regTrib, 'opSimpNac');
  const regApTribSN = value(regTrib, 'regApTribSN');
  const regEspTrib = value(regTrib, 'regEspTrib');
  const tpRetISSQN = value(tribMun, 'tpRetISSQN');
  const exigSusp = value(tribMun, 'exigSusp');
  const tpRetPisCofins = value(piscofins, 'tpRetPisCofins');
  const cstPisCofins = value(piscofins, 'CST');
  const tax = clean({
    simpleNational: opSimpNac === null ? null : opSimpNac !== '1',
    snApuracaoRegime: ['1', '2', '3'].includes(regApTribSN) ? regApTribSN : null,
    specialRegime: regEspTrib === null ? null : (REGIMES_ESPECIAIS[regEspTrib] || 'Nenhum'),
    issRetention: tpRetISSQN === null ? null : tpRetISSQN !== '1',
    issSuspension: exigSusp === null ? null : !['0', '', null].includes(exigSusp),
    pisRate: number(piscofins, 'pAliqPis'),
    cofinsRate: number(piscofins, 'pAliqCofins'),
    // CST do XML ("00") é o value do select do portal ("0").
    pisCofinsSituacao: cstPisCofins === null ? null : String(Number(cstPisCofins)),
    // tpRetPisCofins: 1 = não retido, 2 = retido -> 0 e 3 no portal.
    pisCofinsRetencao: tpRetPisCofins === null ? null : (tpRetPisCofins === '1' ? '0' : '3'),
    // pTotTribSN: percentual total de tributos do Simples Nacional (Lei da Transparência).
    snTotalRate: number(totTrib, 'pTotTribSN'),
    // O portal tem uma opção própria para isso no bloco "Valor aproximado dos tributos".
    approxMode: number(totTrib, 'pTotTribSN') !== null ? 'sn' : null
  });

  const valueAmount = number(vServPrest, 'vServ');
  const values = clean({
    valueCents: cents(valueAmount),
    discountIncondCents: cents(number(descontos, 'vDescIncond')),
    discountCondCents: cents(number(descontos, 'vDescCond')),
    issRate: number(tribMun, 'pAliq')
  });

  const client = clean({
    name: value(toma, 'xNome'),
    document: formatCnpjCpf(value(toma, 'CNPJ') || value(toma, 'CPF')),
    email: value(toma, 'email')
  });

  const source = clean({
    accessKey: attr(xml, 'infNFSe', 'Id'),
    nfseNumber: value(infNFSe, 'nNFSe'),
    issuedAt: value(infNFSe, 'dhProc') || value(infDPS, 'dhEmi'),
    competence: competenceFromXml(value(infDPS, 'dCompet')),
    kind: infNFSe ? 'NFS-e' : 'DPS'
  });

  if (!company.name) warnings.push('Razão social do prestador não veio no XML.');
  if (!portal.municipalityName) warnings.push('Município de prestação não veio no XML; preencha à mão.');
  if (!portal.taxCodeName) warnings.push('Código de Tributação Nacional não veio no XML; preencha à mão.');
  if (!portal.serviceDescription) warnings.push('Descrição do serviço não veio no XML.');
  if (!infNFSe) warnings.push('O arquivo é uma DPS (pré-nota): as descrições oficiais de município e código de tributação só existem no XML da NFS-e emitida.');

  return { source, suggestion: { company, portal, tax }, values, client, warnings };
}

module.exports = {
  parseNfseXml,
  formatCnpjCpf,
  formatTribNac,
  competenceFromXml,
  block,
  value,
  attr,
  REGIMES_ESPECIAIS
};
