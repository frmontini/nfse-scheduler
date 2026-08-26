const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { parseNotaHtml, dadosDanfse, parseEndereco } = require('../src/danfse-parse');

// qrcode fica só no container; aqui interessa o que vai dentro do QR.
let conteudoDoQr = null;
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'qrcode') {
    return { toString: async (texto) => { conteudoDoQr = texto; return '<svg class="qr"></svg>'; } };
  }
  return originalLoad.call(this, request, ...rest);
};
const { renderDanfseHtml, CONSULTA_PUBLICA } = require('../src/danfse');
Module._load = originalLoad;

// Recorte da página de visualização do Emissor Nacional (dados fictícios).
const VISUALIZACAO = `
<h3>Identificação da NFS-e</h3>
<div class="form-group"><label class="control-label"><span>Chave de acesso</span></label><span class="form-control-static texto">35325042211222333000181000000000009326083197738985</span></div>
<div class="form-group"><label class="control-label"><span>Data de geração</span></label><span class="form-control-static texto">26/08/2026 às 14:17:33-03:00</span></div>
<h3>Identificação do DPS</h3>
<div class="form-group"><label class="control-label"><span>Número</span></label><span class="form-control-static texto">35</span></div>
<div class="form-group"><label class="control-label"><span>Série</span></label><span class="form-control-static texto">70000</span></div>
<h3>Emitente</h3>
<div class="form-group"><label class="control-label"><span>Razão Social</span></label><span class="form-control-static texto">EXEMPLO SERVICOS LTDA</span></div>
<div class="form-group"><label class="control-label"><span>CNPJ</span></label><span class="form-control-static texto">11.222.333/0001-81</span></div>
<div class="form-group"><label class="control-label"><span>Endereço do Estabelecimento/Domicílio</span></label><span class="form-control-static texto">RUA DAS FLORES , 120 , Bairro CENTRO , CEP 15120182 , Neves Paulista/SP</span></div>
<h3>Tributação Municipal</h3>
<div class="form-group"><label class="control-label"><span>Valor do Serviço</span></label><div class="input-group"><span class="input-group-addon">R$</span><span class="form-control-static texto">198,00</span></div></div>
<div class="form-group"><label class="control-label"><span>Desconto incondicionado</span></label><div class="input-group"><span class="input-group-addon">R$</span><span class="form-control-static texto">14,85</span></div></div>
<div class="form-group"><label class="control-label"><span>Retenção</span></label><span class="form-control-static texto">1 - Não Retido</span></div>
<h3>Tomador</h3>
<div class="form-group"><label class="control-label"><span>CNPJ</span></label><span class="form-control-static texto">44.555.666/0001-22</span></div>
<div class="form-group"><label class="control-label"><span>Nome/Razão Social</span></label><span class="form-control-static texto">ACME COMERCIO LTDA</span></div>
<div class="form-group"><label class="control-label"><span>Endereço do Estabelecimento/Domicílio</span></label><span class="form-control-static texto">AV BRASIL , 260 , Bairro OURO PRETO , CEP 31310480 , Belo Horizonte/MG</span></div>
<h3>Serviço Prestado</h3>
<div class="form-group"><label class="control-label"><span>Código de Tributação Nacional</span></label><span class="form-control-static texto">140201 - Assistência técnica.</span></div>
<div class="form-group"><label class="control-label"><span>Descrição do serviço</span></label><span class="form-control-static texto">Prestação de serviços</span></div>
<h3>Outras Informações</h3>
<div class="form-group"><label class="control-label"><span>Situação da NFS-e</span></label><span class="form-control-static texto">100 - NFS-e Gerada</span></div>`;

test('separa os campos por seção da visualização', () => {
  const d = parseNotaHtml(VISUALIZACAO);
  assert.equal(d['Emitente']['CNPJ'], '11.222.333/0001-81');
  assert.equal(d['Tomador']['CNPJ'], '44.555.666/0001-22', 'CNPJ repetido não pode vazar de uma seção para outra');
  assert.equal(d['Identificação do DPS']['Número'], '35');
});

test('não deixa um campo engolir o título da seção seguinte', () => {
  const d = dadosDanfse(VISUALIZACAO);
  assert.equal(d.servico.descricao, 'Prestação de serviços');
  assert.equal(d.issqn.retencao, '1 - Não Retido');
});

test('lê valores que vêm dentro do input-group com R$', () => {
  const d = dadosDanfse(VISUALIZACAO);
  assert.equal(d.issqn.valorServico, '198,00');
  assert.equal(d.issqn.descontoIncondicionado, '14,85');
});

test('quebra o endereço numa linha só em partes', () => {
  const e = parseEndereco('RUA DAS FLORES , 120 , Bairro CENTRO , CEP 15120182 , Neves Paulista/SP');
  assert.equal(e.logradouro, 'RUA DAS FLORES');
  assert.equal(e.numero, '120');
  assert.equal(e.bairro, 'CENTRO');
  assert.equal(e.cep, '15120-182');
  assert.equal(e.municipio, 'Neves Paulista/SP');
});

test('o DANFSe sai com chave, QR de consulta pública e os valores', async () => {
  const d = dadosDanfse(VISUALIZACAO);
  d.numero = '93';
  d.competencia = 'agosto/2026';
  const html = await renderDanfseHtml(d);
  assert.match(html, /DANFSe v2\.0/);
  assert.match(html, /3532 5042 2112 2233 3000 1810/, 'chave agrupada de 4 em 4');
  assert.match(html, /<svg[\s\S]*<\/svg>/, 'QR code embutido');
  assert.equal(conteudoDoQr, `${CONSULTA_PUBLICA}${d.chave}`, 'QR aponta para a consulta pública com a chave');
  assert.match(conteudoDoQr, /^https:\/\/www\.nfse\.gov\.br\/ConsultaPublica\/\?tpc=1&chave=\d{50}$/);
  assert.match(html, /R\$ 198,00/);
  assert.match(html, /ACME COMERCIO LTDA/);
  assert.match(html, /Tributação IBS\/CBS/, 'bloco exigido pelo leiaute v2.0');
});

test('campo ausente vira traço, sem inventar valor', async () => {
  const html = await renderDanfseHtml({ chave: '123', emitente: {}, tomador: {}, servico: {}, issqn: {}, federal: {} });
  assert.match(html, /<span class="val">-<\/span>/);
});

test('número e líquido saem da nota, não do registro local', async () => {
  const { nfseNumberFromKey } = require('../src/utils');
  // a chave da nota carrega o número, mesmo quando a tela não mostra
  assert.equal(nfseNumberFromKey('35325042211222333000181000000000009426081172450721'), '94');

  const d = dadosDanfse(VISUALIZACAO);
  // valor 198,00 com desconto de 14,85 -> líquido 183,15, calculado da nota
  const servico = Number(d.issqn.valorServico.replace(',', '.'));
  const desconto = Number(d.issqn.descontoIncondicionado.replace(',', '.'));
  assert.equal((servico - desconto).toFixed(2), '183.15');
});
