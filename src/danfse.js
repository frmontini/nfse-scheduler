/*
 * Gera o DANFSe (Documento Auxiliar da NFS-e) localmente, no layout v2.0.
 *
 * Desde a NT 008/2026 a API oficial de DANFSe foi descontinuada e quem emite
 * gera o documento por conta própria. No Emissor Nacional o download do PDF
 * oficial ainda existe, mas está atrás de hCaptcha — que este projeto não
 * resolve. Então montamos o documento com os dados da própria nota, lidos da
 * visualização autenticada, e o QR aponta para a consulta pública pela chave.
 */
const QRCode = require('qrcode');

const CONSULTA_PUBLICA = 'https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=';

function esc(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ou = (valor) => (String(valor ?? '').trim() ? esc(valor) : '-');
const dinheiro = (valor) => (String(valor ?? '').trim() ? `R$ ${esc(valor)}` : '-');

function agrupaChave(chave) {
  return String(chave || '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();
}

function campo(rotulo, valor, { largura = 1 } = {}) {
  return `<div class="campo" style="--col:${largura}"><span class="rot">${esc(rotulo)}</span><span class="val">${valor}</span></div>`;
}

function bloco(titulo, campos) {
  return `<section class="bloco"><h2>${esc(titulo)}</h2><div class="linha">${campos.join('')}</div></section>`;
}

async function renderDanfseHtml(d) {
  const qr = await QRCode.toString(`${CONSULTA_PUBLICA}${d.chave}`, {
    type: 'svg', margin: 0, errorCorrectionLevel: 'M'
  });
  const emit = d.emitente || {};
  const toma = d.tomador || {};
  const serv = d.servico || {};
  const iss = d.issqn || {};
  const fed = d.federal || {};

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>DANFSe ${esc(d.numero || '')}</title>
<style>
  @page { size: A4; margin: 8mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Arial, Helvetica, sans-serif; font-size: 7.4pt; color:#000; }
  .topo { display:flex; align-items:center; gap:10px; border:1px solid #000; padding:6px 8px; }
  .marca { font-size:15pt; font-weight:700; letter-spacing:-.5px; white-space:nowrap; }
  .marca small { display:block; font-size:6pt; font-weight:400; letter-spacing:0; }
  .titulo { flex:1; text-align:center; font-weight:700; font-size:10pt; line-height:1.35; }
  .titulo span { display:block; font-size:7.4pt; font-weight:400; }
  .ambiente { text-align:right; font-size:6.6pt; line-height:1.4; white-space:nowrap; }
  .bloco { border:1px solid #000; border-top:0; }
  .bloco h2 { margin:0; padding:2px 6px; font-size:7pt; background:#e9e9e9; border-bottom:1px solid #000; text-transform:uppercase; }
  .linha { display:grid; grid-template-columns:repeat(4,1fr); }
  .campo { padding:3px 6px; border-right:1px solid #bbb; border-bottom:1px solid #ddd; grid-column:span var(--col); min-height:26px; }
  .campo:last-child { border-right:0; }
  .rot { display:block; font-size:5.9pt; color:#333; text-transform:uppercase; letter-spacing:.2px; }
  .val { display:block; font-size:7.6pt; margin-top:1px; word-break:break-word; }
  .val.grande { font-size:9pt; font-weight:700; }
  .chave { display:flex; gap:10px; align-items:center; border:1px solid #000; border-top:0; padding:6px 8px; }
  .chave .dados { flex:1; }
  .chave .cod { font-family:"Courier New",monospace; font-size:8.2pt; letter-spacing:.4px; word-break:break-all; }
  .chave svg { width:74px; height:74px; }
  .rodape { border:1px solid #000; border-top:0; padding:5px 8px; font-size:6.4pt; color:#333; line-height:1.45; }
  .assin { display:grid; grid-template-columns:repeat(3,1fr); border:1px solid #000; border-top:0; }
  .assin div { padding:14px 6px 4px; border-right:1px solid #bbb; font-size:6pt; text-transform:uppercase; }
  .assin div:last-child { border-right:0; }
</style></head>
<body>
  <div class="topo">
    <div class="marca">NFS<span style="color:#0a7d4b">e</span><small>Nota Fiscal de<br>Serviço eletrônica</small></div>
    <div class="titulo">DANFSe v2.0<span>Documento Auxiliar da NFS-e</span></div>
    <div class="ambiente">
      Município: ${ou(serv.municipio)}<br>
      Ambiente Gerador: ${ou(d.ambiente)}<br>
      Situação: ${ou(d.situacao)}
    </div>
  </div>

  <div class="chave">
    <div class="dados">
      <span class="rot">Chave de acesso da NFS-e</span>
      <div class="cod">${esc(agrupaChave(d.chave))}</div>
      <span class="rot" style="margin-top:4px">Consulta pública</span>
      <div style="font-size:6.4pt">nfse.gov.br/ConsultaPublica — a autenticidade pode ser verificada pelo QR Code ou pela chave</div>
    </div>
    ${qr}
  </div>

  ${bloco('Identificação da NFS-e', [
    campo('Número da NFS-e', `<span class="val grande">${ou(d.numero)}</span>`),
    campo('Competência', ou(d.competencia)),
    campo('Data e hora da emissão', ou(d.dps?.emitidaEm)),
    campo('Data e hora da geração', ou(d.geradaEm)),
    campo('Número da DPS', ou(d.dps?.numero)),
    campo('Série da DPS', ou(d.dps?.serie)),
    campo('Versão do leiaute', ou(d.versao)),
    campo('Emitente da NFS-e', 'Prestador')
  ])}

  ${bloco('Prestador / Fornecedor', [
    campo('Nome / Nome empresarial', ou(emit.nome), { largura: 2 }),
    campo('CNPJ / CPF', ou(emit.documento)),
    campo('Inscrição municipal', ou(emit.inscricaoMunicipal)),
    campo('Endereço', ou(emit.linha), { largura: 2 }),
    campo('Município / UF · CEP', `${ou(emit.municipio)} · ${ou(emit.cep)}`),
    campo('Telefone / E-mail', `${ou(emit.telefone)}<br>${ou(emit.email)}`),
    campo('Simples Nacional na data da competência', ou(emit.simplesNacional), { largura: 2 }),
    campo('Regime de apuração / Regime especial', `${ou(d.regimeApuracao)} · ${ou(emit.regimeEspecial)}`, { largura: 2 })
  ])}

  ${bloco('Tomador / Adquirente', [
    campo('Nome / Nome empresarial', ou(toma.nome), { largura: 2 }),
    campo('CNPJ / CPF', ou(toma.documento)),
    campo('Inscrição municipal', ou(toma.inscricaoMunicipal)),
    campo('Endereço', ou(toma.linha), { largura: 2 }),
    campo('Município / UF · CEP', `${ou(toma.municipio)} · ${ou(toma.cep)}`),
    campo('E-mail', ou(toma.email))
  ])}

  ${bloco('Serviço prestado', [
    campo('Código de tributação nacional / municipal', ou(serv.codigoTributacao), { largura: 2 }),
    campo('Código da NBS', ou(serv.nbs), { largura: 2 }),
    campo('Local da prestação / País', `${ou(serv.municipio)} · ${ou(serv.pais)}`, { largura: 2 }),
    campo('Município de incidência do ISSQN', ou(iss.municipioIncidencia), { largura: 2 }),
    campo('Descrição do serviço', ou(serv.descricao), { largura: 4 })
  ])}

  ${bloco('Tributação municipal (ISSQN)', [
    campo('Tipo de tributação do ISSQN', ou(iss.tributacao), { largura: 2 }),
    campo('Benefício municipal', dinheiro(iss.beneficio)),
    campo('Total deduções / reduções', dinheiro(iss.deducoes)),
    campo('Base de cálculo', dinheiro(iss.baseCalculo)),
    campo('Alíquota aplicada', ou(iss.aliquota)),
    campo('Retenção do ISSQN', ou(iss.retencao)),
    campo('ISSQN apurado', dinheiro(iss.valorIssqn))
  ])}

  ${bloco('Tributação federal', [
    campo('Situação tributária do PIS/COFINS', ou(fed.situacaoPisCofins), { largura: 2 }),
    campo('Contribuições sociais retidas', ou(fed.retencoes), { largura: 2 })
  ])}

  ${bloco('Tributação IBS/CBS', [
    campo('CST / cClassTrib', `${ou(d.ibsCbs?.cst)} · ${ou(d.ibsCbs?.classTrib)}`, { largura: 2 }),
    campo('Indicador de operação / Município de incidência', `${ou(d.ibsCbs?.indicadorOperacao)} · ${ou(d.ibsCbs?.municipioIncidencia)}`, { largura: 2 }),
    campo('Base de cálculo IBS/CBS', dinheiro(d.ibsCbs?.baseCalculo)),
    campo('Alíquota efetiva IBS', ou(d.ibsCbs?.aliquotaIbs)),
    campo('Alíquota efetiva CBS', ou(d.ibsCbs?.aliquotaCbs)),
    campo('Total IBS + CBS', dinheiro(d.ibsCbs?.total))
  ])}

  ${bloco('Valor total da NFS-e', [
    campo('Valor da operação / serviço', `<span class="val grande">${dinheiro(iss.valorServico)}</span>`),
    campo('Desconto incondicionado', dinheiro(iss.descontoIncondicionado)),
    campo('Desconto condicionado', dinheiro(d.descontoCondicionado)),
    campo('Total das retenções', dinheiro(d.totalRetencoes)),
    campo('Valor líquido da NFS-e', `<span class="val grande">${dinheiro(d.valorLiquido || iss.valorServico)}</span>`, { largura: 2 }),
    campo('Valor líquido + IBS/CBS', dinheiro(d.ibsCbs?.liquidoComIbsCbs || d.valorLiquido || iss.valorServico), { largura: 2 })
  ])}

  <div class="rodape" style="border-bottom:0;padding:3px 8px;font-size:6.2pt">
    ${esc(d.destinatarioIdentificado ? 'Destinatário da operação identificado na NFS-e.' : 'Destinatário da operação não identificado na NFS-e.')}
    ${esc(d.intermediarioIdentificado ? 'Intermediário identificado na NFS-e.' : 'Intermediário da operação não identificado na NFS-e.')}
  </div>

  <div class="rodape">
    <strong>Informações complementares:</strong> ${ou(d.complementares)}<br>
    ${esc(d.tributosAproximados || 'Totais aproximados dos tributos conforme Lei nº 12.741/2012 informados no portal.')}<br>
    Documento auxiliar gerado a partir dos dados da NFS-e no Emissor Nacional (${esc(d.aplicacao || 'Portal NFS-e')}). Confira a nota pela chave de acesso na consulta pública.
  </div>

  <div class="assin">
    <div>Data de cientificação</div>
    <div>Identificação e assinatura</div>
    <div>Nº NFS-e / Chave<br>${ou(d.numero)} / ${esc(String(d.chave || '').slice(-12))}</div>
  </div>
</body></html>`;
}

module.exports = { renderDanfseHtml, CONSULTA_PUBLICA };
