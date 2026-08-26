const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNfseXml, formatTribNac, formatCnpjCpf, competenceFromXml } = require('../src/xml-import');

// Estrutura do leiaute nacional (XSD v1.01, fev/2026).
const NFSE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">
  <infNFSe Id="NFS3531803000000000000000000000000000000000000123">
    <xLocEmi>Neves Paulista/SP</xLocEmi>
    <xLocPrestacao>Neves Paulista/SP</xLocPrestacao>
    <nNFSe>123</nNFSe>
    <cLocIncid>3531803</cLocIncid>
    <xLocIncid>Neves Paulista/SP</xLocIncid>
    <xTribNac>Análise e desenvolvimento de sistemas</xTribNac>
    <xNBS>Serviços de análise de sistemas</xNBS>
    <dhProc>2026-08-05T10:12:33-03:00</dhProc>
    <emit>
      <CNPJ>11222333000181</CNPJ>
      <IM>987654</IM>
      <xNome>EXEMPLO SERVICOS LTDA</xNome>
      <xFant>Exemplo</xFant>
    </emit>
    <valores><vBC>1500.00</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>30.00</vISSQN><vLiq>1350.00</vLiq></valores>
    <DPS><infDPS Id="DPS3531803000000112223330001810000100000045">
      <tpAmb>1</tpAmb>
      <dhEmi>2026-08-05T10:10:00-03:00</dhEmi>
      <serie>00001</serie><nDPS>45</nDPS>
      <dCompet>2026-08-01</dCompet>
      <prest>
        <CNPJ>11222333000181</CNPJ><IM>987654</IM>
        <regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib>
      </prest>
      <toma><CNPJ>11222333000144</CNPJ><xNome>ACME COMERCIO LTDA</xNome><email>financeiro@acme.com.br</email></toma>
      <serv>
        <locPrest><cLocPrestacao>3531803</cLocPrestacao></locPrest>
        <cServ>
          <cTribNac>010101</cTribNac><cTribMun>010101</cTribMun>
          <xDescServ>Serviços de desenvolvimento de sistemas - agosto/2026</xDescServ>
          <cNBS>115011000</cNBS>
        </cServ>
      </serv>
      <valores>
        <vServPrest><vServ>1500.00</vServ></vServPrest>
        <vDescCondIncond><vDescIncond>100.00</vDescIncond><vDescCond>50.00</vDescCond></vDescCondIncond>
        <trib>
          <tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN><pAliq>2.00</pAliq><exigSusp>0</exigSusp></tribMun>
          <tribFed><piscofins><CST>01</CST><pAliqPis>0.65</pAliqPis><pAliqCofins>3.00</pAliqCofins><tpRetPisCofins>1</tpRetPisCofins></piscofins></tribFed>
          <totTrib><pTotTribSN>6.00</pTotTribSN></totTrib>
        </trib>
      </valores>
    </infDPS></DPS>
  </infNFSe>
</NFSe>`;

test('formata código de tributação e documentos', () => {
  assert.equal(formatTribNac('010101'), '01.01.01');
  assert.equal(formatTribNac('0101'), '0101');
  assert.equal(formatCnpjCpf('11222333000181'), '11.222.333/0001-81');
  assert.equal(formatCnpjCpf('12345678901'), '123.456.789-01');
  assert.equal(competenceFromXml('2026-08-01'), '2026-08');
  assert.equal(competenceFromXml('20260801'), '2026-08');
});

test('lê a empresa do XML da NFS-e', () => {
  const { suggestion } = parseNfseXml(NFSE_XML);
  assert.deepEqual(suggestion.company, {
    name: 'EXEMPLO SERVICOS LTDA',
    cnpj: '11.222.333/0001-81',
    municipalRegistration: '987654',
    nbsCode: '115011000'
  });
});

test('usa as descrições oficiais do infNFSe para município e código de tributação', () => {
  const { suggestion } = parseNfseXml(NFSE_XML);
  assert.equal(suggestion.portal.municipalityName, 'Neves Paulista/SP');
  assert.equal(suggestion.portal.municipalitySearch, 'Neves');
  assert.equal(suggestion.portal.taxCodeName, 'Análise e desenvolvimento de sistemas');
  assert.equal(suggestion.portal.taxCodeSearch, '01.01');
  assert.equal(suggestion.portal.serviceDescription, 'Serviços de desenvolvimento de sistemas - agosto/2026');
});

test('traduz o regime tributário e as retenções', () => {
  const { suggestion } = parseNfseXml(NFSE_XML);
  assert.equal(suggestion.tax.simpleNational, true, 'opSimpNac=3 é optante');
  assert.equal(suggestion.tax.specialRegime, 'Nenhum');
  assert.equal(suggestion.tax.snApuracaoRegime, '1', 'regApTribSN vira o regime de apuração exigido pelo portal');
  assert.equal(suggestion.tax.issRetention, false, 'tpRetISSQN=1 é não retido');
  assert.equal(suggestion.tax.issSuspension, false);
  assert.equal(suggestion.tax.pisRate, 0.65);
  assert.equal(suggestion.tax.cofinsRate, 3);
  assert.equal(suggestion.tax.pisCofinsSituacao, '1', 'CST 01 vira o value 1 do select do portal');
  assert.equal(suggestion.tax.pisCofinsRetencao, '0', 'tpRetPisCofins 1 (não retido) vira o value 0');
  assert.equal(suggestion.tax.snTotalRate, 6, 'pTotTribSN vira o percentual total do Simples');
});

test('CST 00 (sem PIS/COFINS) chega como "0", que é o "00 - Nenhum" do portal', () => {
  const semTributo = NFSE_XML.replace('<CST>01</CST>', '<CST>00</CST>').replace('<tpRetPisCofins>1</tpRetPisCofins>', '');
  const { suggestion } = parseNfseXml(semTributo);
  assert.equal(suggestion.tax.pisCofinsSituacao, '0');
  assert.equal(suggestion.tax.pisCofinsRetencao, undefined, 'sem tpRetPisCofins, não mexe na retenção');
});

test('nota sem inscrição municipal não inventa o campo', () => {
  const semIM = NFSE_XML.replaceAll('<IM>987654</IM>', '');
  const { suggestion } = parseNfseXml(semIM);
  assert.equal(suggestion.company.municipalRegistration, undefined);
  assert.equal(suggestion.company.name, 'EXEMPLO SERVICOS LTDA');
});

test('devolve valores, tomador e identificação da nota', () => {
  const { values, client, source, warnings } = parseNfseXml(NFSE_XML);
  assert.equal(values.valueCents, 150000);
  assert.equal(values.discountIncondCents, 10000);
  assert.equal(values.discountCondCents, 5000);
  assert.equal(client.name, 'ACME COMERCIO LTDA');
  assert.equal(client.document, '11.222.333/0001-44');
  assert.equal(client.email, 'financeiro@acme.com.br');
  assert.equal(source.nfseNumber, '123');
  assert.equal(source.competence, '2026-08');
  assert.equal(source.kind, 'NFS-e');
  assert.match(source.accessKey, /^NFS\d+$/);
  assert.deepEqual(warnings, []);
});

test('funciona com prefixo de namespace', () => {
  const prefixed = NFSE_XML.replace(/<(\/?)(infNFSe|emit|xNome|CNPJ)\b/g, '<$1nfse:$2');
  const { suggestion } = parseNfseXml(prefixed);
  assert.equal(suggestion.company.name, 'EXEMPLO SERVICOS LTDA');
});

test('aceita XML só de DPS, avisando o que falta', () => {
  const dpsOnly = NFSE_XML.slice(NFSE_XML.indexOf('<DPS>'), NFSE_XML.indexOf('</DPS>') + 6);
  const { suggestion, warnings, source } = parseNfseXml(dpsOnly);
  assert.equal(source.kind, 'DPS');
  assert.equal(suggestion.portal.taxCodeName, '01.01.01', 'sem xTribNac cai no código formatado');
  assert.equal(suggestion.portal.municipalityName, undefined);
  assert.ok(warnings.some((w) => /DPS \(pré-nota\)/.test(w)));
  assert.ok(warnings.some((w) => /Município de prestação/.test(w)));
});

test('rejeita arquivo que não é NFS-e nacional', () => {
  assert.throws(() => parseNfseXml('<nota><algo>1</algo></nota>'), /não parece um XML de NFS-e/);
  assert.throws(() => parseNfseXml(''), /não é XML|não parece/);
});
