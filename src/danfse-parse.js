/*
 * Lê a página de visualização da NFS-e no Emissor Nacional e devolve os campos
 * em forma estruturada. O download do DANFSe e do XML oficiais está atrás de
 * hCaptcha, mas a visualização abre pela sessão autenticada — é daqui que sai
 * o conteúdo para gerar o documento auxiliar localmente (NT 008/2026).
 */

function limpar(texto) {
  return String(texto || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cada campo é <label class="control-label"><span>Rótulo</span></label> seguido
// do valor, que ora é um <span class="form-control-static">, ora um input-group
// com "R$" antes do número. Por isso lemos o texto até o próximo rótulo.
function parseNotaHtml(html) {
  const fonte = String(html || '');
  const marcadorSecao = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const secoes = [];
  for (const m of fonte.matchAll(marcadorSecao)) {
    secoes.push({ pos: m.index, nome: limpar(m[1]) });
  }
  const secaoDe = (pos) => {
    let atual = 'Geral';
    for (const s of secoes) {
      if (s.pos < pos) atual = s.nome;
      else break;
    }
    return atual;
  };

  const rotulo = /<label class="control-label"[^>]*>\s*<span>([\s\S]*?)<\/span>\s*<\/label>/gi;
  const achados = [...fonte.matchAll(rotulo)];
  const dados = {};
  achados.forEach((m, i) => {
    const inicio = m.index + m[0].length;
    // O valor termina no próximo rótulo ou no título da próxima seção — sem
    // esse segundo limite, o último campo de cada bloco engole o <h3> seguinte.
    const proximoRotulo = i + 1 < achados.length ? achados[i + 1].index : fonte.length;
    const proximaSecao = (secoes.find((s) => s.pos > m.index) || {}).pos ?? fonte.length;
    const fim = Math.min(proximoRotulo, proximaSecao, inicio + 600);
    const valor = limpar(fonte.slice(inicio, fim)).replace(/^R\$\s*/, '').trim();
    const secao = secaoDe(m.index);
    const nome = limpar(m[1]).replace(/\*$/, '').trim();
    if (!nome) return;
    dados[secao] = dados[secao] || {};
    if (dados[secao][nome] === undefined) dados[secao][nome] = valor === '-' ? '' : valor;
  });
  return dados;
}

const pega = (dados, secao, ...rotulos) => {
  for (const r of rotulos) {
    const v = dados?.[secao]?.[r];
    if (v) return v;
  }
  return '';
};

// Endereço vem numa linha só: "RUA X , 120 , Bairro Y , CEP 00000000 , Cidade/UF"
function parseEndereco(texto) {
  const partes = String(texto || '').split(',').map((p) => p.trim()).filter(Boolean);
  const cep = (partes.find((p) => /^CEP/i.test(p)) || '').replace(/^CEP\s*/i, '').trim();
  const bairro = (partes.find((p) => /^Bairro/i.test(p)) || '').replace(/^Bairro\s*/i, '').trim();
  const comUf = partes.find((p) => /\/[A-Z]{2}\b/.test(p)) || '';
  const municipio = (comUf.match(/(.*?\/[A-Z]{2})\b/) || [, ''])[1].trim();
  const logradouro = partes[0] || '';
  const numero = partes[1] && !/^Bairro|^CEP/i.test(partes[1]) ? partes[1] : '';
  return {
    logradouro,
    numero,
    bairro,
    cep: cep.replace(/^(\d{5})(\d{3})$/, '$1-$2'),
    municipio,
    linha: [logradouro, numero, bairro].filter(Boolean).join(', ')
  };
}

function dadosDanfse(html) {
  const d = parseNotaHtml(html);
  const emitente = parseEndereco(pega(d, 'Emitente', 'Endereço do Estabelecimento/Domicílio'));
  const tomador = parseEndereco(pega(d, 'Tomador', 'Endereço do Estabelecimento/Domicílio'));
  return {
    chave: pega(d, 'Identificação da NFS-e', 'Chave de acesso'),
    geradaEm: pega(d, 'Identificação da NFS-e', 'Data de geração'),
    versao: pega(d, 'Identificação da NFS-e', 'Versão'),
    dps: {
      numero: pega(d, 'Identificação do DPS', 'Número'),
      serie: pega(d, 'Identificação do DPS', 'Série'),
      emitidaEm: pega(d, 'Identificação do DPS', 'Data de emissão')
    },
    emitente: {
      nome: pega(d, 'Emitente', 'Razão Social'),
      documento: pega(d, 'Emitente', 'CNPJ', 'CPF'),
      inscricaoMunicipal: pega(d, 'Emitente', 'Inscrição Municipal'),
      simplesNacional: pega(d, 'Emitente', 'Situação Perante o Simples Nacional'),
      regimeEspecial: pega(d, 'Emitente', 'Regime Especial de Tributação'),
      telefone: pega(d, 'Emitente', 'Telefone'),
      email: pega(d, 'Emitente', 'Email'),
      ...emitente
    },
    tomador: {
      nome: pega(d, 'Tomador', 'Nome/Razão Social'),
      documento: pega(d, 'Tomador', 'CNPJ', 'CPF'),
      inscricaoMunicipal: pega(d, 'Tomador', 'Inscrição Municipal'),
      ...tomador
    },
    servico: {
      municipio: pega(d, 'Serviço Prestado', 'Município'),
      pais: pega(d, 'Serviço Prestado', 'País'),
      codigoTributacao: pega(d, 'Serviço Prestado', 'Código de Tributação Nacional'),
      nbs: pega(d, 'Serviço Prestado', 'Item da NBS correspondente ao serviço prestado'),
      descricao: pega(d, 'Serviço Prestado', 'Descrição do serviço')
    },
    issqn: {
      tributacao: pega(d, 'Tributação Municipal', 'Tributação do ISSQN'),
      municipioIncidencia: pega(d, 'Tributação Municipal', 'Município de Incidência'),
      valorServico: pega(d, 'Tributação Municipal', 'Valor do Serviço'),
      descontoIncondicionado: pega(d, 'Tributação Municipal', 'Desconto incondicionado'),
      deducoes: pega(d, 'Tributação Municipal', 'Total Deduções/Reduções'),
      beneficio: pega(d, 'Tributação Municipal', 'Total Benefício Municipal', 'Benefício Municipal - BM'),
      baseCalculo: pega(d, 'Tributação Municipal', 'Base de Cálculo'),
      aliquota: pega(d, 'Tributação Municipal', 'Alíquota'),
      valorIssqn: pega(d, 'Tributação Municipal', 'Valor do ISSQN'),
      retencao: pega(d, 'Tributação Municipal', 'Retenção')
    },
    federal: {
      situacaoPisCofins: pega(d, 'Tributação Federal', 'Situação tributária do PIS/COFINS'),
      retencoes: pega(d, 'Tributação Federal', 'Descrição Contribuições Sociais - Retidas')
    },
    complementares: pega(d, 'Informações Complementares', 'Informações complementares'),
    situacao: pega(d, 'Outras Informações', 'Situação da NFS-e'),
    ambiente: pega(d, 'Outras Informações', 'Ambiente Gerador'),
    aplicacao: pega(d, 'Outras Informações', 'Versão da Aplicação'),
    secoes: d
  };
}

module.exports = { parseNotaHtml, dadosDanfse, parseEndereco, limpar };
