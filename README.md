# NFS-e Auto Panel

Mini sistema para automatizar **NFS-e no Emissor Nacional**, pensado para poucas notas recorrentes por mês e acesso por **CNPJ/CPF + senha**, sem depender de certificado A1 para o fluxo Web.

Ele combina um painel Web, SQLite, agenda mensal, automação da **Emissão Completa** com Playwright, histórico/idempotência, tentativa de arquivar XML/DANFSe pela sessão autenticada e envio de e-mail por **SMTP ou Brevo**.

> **Importante:** o Emissor Nacional é um portal Web, não uma API pública estável para este método de autenticação. O projeto nasce com **cron desligado** e **emissão real bloqueada**. Faça uma prévia na sua conta e confira os campos antes de habilitar emissão automática.

## Base técnica usada

A automação da Emissão Completa foi adaptada do projeto MIT `Sutil/Emissor-NFS-e-bot`, que em agosto/2026 já cobre o fluxo Pessoas → Serviço → Tributação → Emitir com login CPF/CNPJ + senha. O aviso/licença está em `licenses/` e `THIRD_PARTY_NOTICES.md`.

Também foram usados como referência de arquitetura/comportamento:

- `kursku/emissor-nfse`: fila, idempotência, contratos recorrentes e arquivamento (MIT; usa A1/API oficial, portanto não é o motor de emissão deste projeto).
- `cleitonleonel/emissor_nfse`: comportamento observável de login, consulta e visualização/download no portal. **Nenhum código foi copiado**, pois o repositório consultado não declara licença.

## O que tem no projeto

- Painel Web em `http://localhost:3000`, com tela de login própria e sessão por cookie.
- Visualizador de imagem com zoom e arraste para a prévia e para os screenshots de erro.
- Importação do cadastro a partir do XML de uma NFS-e já emitida.
- Cadastro de empresa, CNPJ, inscrição municipal, CNAE e NBS.
- Configuração padrão do serviço:
  - município de prestação;
  - Código de Tributação Nacional;
  - descrição com `{MES}`, `{ANO}`, `{CLIENTE}` etc.
- Configuração geral de tributos:
  - Simples Nacional;
  - suspensão/retenção/benefício de ISS;
  - PIS/COFINS;
  - IRRF;
  - CSLL;
  - contribuição previdenciária;
  - tributos aproximados federal/estadual/municipal.
- Cadastro de clientes PJ/PF.
- Automações mensais por cliente:
  - dia do mês;
  - valor do serviço;
  - **desconto incondicional**;
  - desconto condicionado;
  - descrição/código/município específicos;
  - envio de e-mail ligado/desligado;
  - algumas sobrescritas tributárias.
- SQLite criado automaticamente em `./data/nfse.sqlite`.
- Histórico e eventos de cada tentativa.
- Proteção de duplicidade por `automação + competência`.
- Envio de e-mail por SMTP **ou** pela API HTTP do Brevo, escolhido pela flag `MAIL_PROVIDER` no `.env`.
- Retry de e-mail separado da emissão.
- Aviso para você sempre que a nota é enviada ao cliente (e-mail separado e/ou cópia oculta).
- Dockerfile + Docker Compose.
- Screenshots de prévia/erro em `./data/debug`.
- XML/PDF em `./data/files` quando o portal permitir obtê-los pela sessão autenticada.

## Importar XML da NFS-e

No card *Empresa* existe **Importar XML da NFS-e**: você baixa o XML de uma nota já emitida no portal, joga aqui e o painel preenche o cadastro a partir dela.

O leitor segue o leiaute do Sistema Nacional NFS-e (XSD **v1.01**, fev/2026, namespace `http://www.sped.fazenda.gov.br/nfse`) e aproveita que o `<infNFSe>` traz as **descrições oficiais**, que é justamente o texto que o portal mostra nos campos de busca:

| Campo do painel | Origem no XML |
| --- | --- |
| Razão social / CNPJ / Inscrição municipal | `infNFSe/emit` → `xNome`, `CNPJ`, `IM` |
| NBS | `cServ/cNBS` |
| Nome exato do município | `infNFSe/xLocPrestacao` |
| Busca do município | primeira palavra do nome |
| Nome exato do Código de Tributação Nacional | `infNFSe/xTribNac` |
| Busca do Código de Tributação Nacional | `cServ/cTribNac` formatado (`010101` → `01.01`) |
| Descrição do serviço | `cServ/xDescServ` |
| Alíquota do Simples Nacional (%) | `trib/totTrib/pTotTribSN` |
| Regime de Apuração no Simples | `prest/regTrib/regApTribSN` |
| Simples Nacional | `prest/regTrib/opSimpNac` (≠1 = optante) |
| Regime especial | `regTrib/regEspTrib` |
| ISS retido / suspenso | `tribMun/tpRetISSQN`, `tribMun/exigSusp` |
| PIS / COFINS | `piscofins/pAliqPis`, `pAliqCofins`, `tpRetPisCofins` |

Também aceita o XML só da **DPS** (pré-nota), avisando que ali não existem as descrições de município e código de tributação — só os códigos.

O mesmo arquivo serve nos outros dois cadastros, com o botão *Preencher com XML da NFS-e*:

- **Clientes → Novo cliente**: lê o bloco `toma` e preenche nome, CPF/CNPJ (escolhendo PF ou PJ pelo tamanho do documento) e e-mail. Quando a nota não traz `toma/email` — o que é comum —, o aviso deixa isso explícito, porque sem e-mail a automação não consegue enviar a NFS-e.
- **Automações → Nova automação**: preenche valor (`vServ`), os dois descontos, a descrição do serviço e o dia do mês (o dia em que aquela nota foi emitida). O cliente é selecionado sozinho quando o CNPJ do tomador já está cadastrado; se não estiver, o aviso diz isso antes de você salvar. Município e código de tributação só entram como exceção da automação quando **diferem** do padrão geral — senão ficam em branco, herdando a configuração.

Duas garantias: **nada é salvo automaticamente** (o botão preenche o formulário, você revisa e clica em *Salvar configurações*) e **nada é inventado** — campo que não veio no XML vira aviso, não chute. O resumo mostra número, competência, tomador e valor da nota lida, para você confirmar que subiu o arquivo certo.

## IBS/CBS

Existe um interruptor em *Empresa e tributos → Serviço*. Desligado (padrão), a automação responde **Não** à pergunta do portal. O calendário de obrigatoriedade:

| Segmento | A partir de |
| --- | --- |
| NF-e / NFC-e (produtos, regime normal) | 03/08/2026 |
| NFS-e — Grupo 1 | 01/10/2026 |
| NFS-e — Grupo 2 | 01/12/2026 |
| **Simples Nacional** | **01/01/2027** |
| Tributação monofásica e importação | 01/01/2027 |

Nesta fase o preenchimento é informativo, com alíquota-teste de 1% (0,1% de IBS e 0,9% de CBS), e a ausência dos campos não gera rejeição nem multa automática. Para optante do Simples o prazo é **01/01/2027**.

O modo foi mapeado contra o portal e validado por Prévia. Ligá-lo muda o fluxo em três pontos:

1. **Etapa Pessoas** ganha duas perguntas obrigatórias — `EhCompraGovernamental` e `DestinatarioEhOAdquirente`, ambas configuráveis. Elas só podem ser respondidas **depois** do lookup do CNPJ do tomador: o portal desabilita o formulário enquanto busca e descarta marcações feitas antes.
2. **Etapa Serviço** passa a exigir `ServicoPrestado.CodigoTpOper` (tipo de operação) e `ServicoPrestado.CodigoIndOp` (código indicador da operação).
3. **Etapa Valores** passa a exigir `ValorTributos.CodigoSituacaoTributaria` (CST do IBS/CBS) e `ValorTributos.CodigoClassificacaoTributaria`, cujas opções o portal filtra pelo CST escolhido.

Os três últimos são **decisão fiscal, não configuração de software**: definem local de incidência e enquadramento. O projeto não escolhe nenhum por você — com o modo ligado e algum deles vazio, a emissão para antes de abrir o navegador, dizendo qual falta. Na Prévia de validação, o portal calculou IBS de R$ 0,18 e CBS de R$ 1,65 sobre base de R$ 183,15, com as alíquotas de teste.

## Município e Código de Tributação: por que existem dois campos

As duas listas dessa etapa no portal são widgets **Select2 com busca no servidor**: a lista não vem pronta, é preciso digitar um termo, esperar o AJAX responder e então clicar na opção certa. Daí o par de campos, herdado do `Sutil/Emissor-NFS-e-bot`: um termo alimenta a busca, o outro identifica a opção no resultado.

Nesta versão o **termo de busca é opcional**: quando fica vazio, ele é deduzido do nome exato — município sem a UF (`Neves Paulista/SP` → `Neves Paulista`) e código de tributação pelo número (`01.01.01 - Análise...` → `01.01.01`), que é como o portal indexa cada lista. O painel mostra só o nome; o termo fica em *Ajuste fino da busca*, para o caso raro de a dedução não achar a opção.

A emissão agora exige apenas **município**, **código de tributação** e **descrição** preenchidos.

## CNAE e NBS

CNAE e NBS ficam persistidos como **dados cadastrais/referência**. No fluxo Web atual da Emissão Completa, o campo operacional que a automação seleciona é o **Código de Tributação Nacional do serviço**. O projeto não injeta CNAE/NBS em campos inexistentes só para “preencher tudo”.

Existe um campo `ServicoPrestado_CodigoNBS` no portal, mas ele aparece no fluxo de **exportação/serviço internacional**, que este projeto não automatiza — conferido contra `Sutil/Emissor-NFS-e-bot`, que só o usa em `EmitirInternacional`.

## Valor aproximado dos tributos

O portal oferece quatro opções nesse bloco, e o painel usa exatamente as mesmas:

| Opção | `ValorTributos.TipoValorTributos` | Campo preenchido |
| --- | --- | --- |
| Informar alíquota do Simples Nacional | 4 | `ValorTributos.AliquotaSN` |
| Configurar valores percentuais | 2 | `PercentualTotalFederal/Estadual/Municipal` |
| Preencher valores monetários | 1 | `ValorTotalFederal/Estadual/Municipal` |
| Não informar (Decreto 8.264/2014) | 3 | — |

Para optante do Simples o portal **já marca a opção 4** e mostra o campo de alíquota; é o padrão do projeto, alimentado pelo `pTotTribSN` do XML.

## Simples Nacional

Para optante, o portal exige na etapa Pessoas o **Regime de Apuração dos Tributos no Simples Nacional** (`SimplesNacional.RegimeApuracaoTributosSN`), um campo obrigatório que não existia nas versões anteriores do fluxo:

| Valor | Significado |
| --- | --- |
| 1 | Tributos federais e municipal pelo Simples Nacional |
| 2 | Federais pelo Simples Nacional e ISSQN pela NFS-e, conforme a legislação municipal |
| 3 | Federais e municipal pela NFS-e, conforme a legislação de cada tributo |

Ele fica em *Empresa e tributos → Tributos* e vem preenchido pelo `regApTribSN` do XML importado. É um `<select>` escondido atrás de um widget Chosen: a automação tenta abrir o widget e clicar na opção e, se o widget não responder, escreve o valor no select nativo disparando `change`. Como o campo é obrigatório, falhar nele **para antes do Avançar**, com mensagem própria, em vez de esbarrar no "Campo obrigatório" genérico do portal.

Quando o portal deixa campos de tributação federal bloqueados/`readonly`, o sistema **não força alteração**. Ele tenta preencher apenas campos editáveis. Isso evita sobrescrever valores que o próprio Emissor calcula/preenche para o regime tributário do prestador.

## Desconto incondicional

Há campo específico por automação. Na etapa Valores, a automação procura o campo do portal usando os IDs conhecidos e um fallback pelo rótulo “Desconto incondicional”. Se o portal mudar e o campo não puder ser localizado, a emissão para **antes do clique final** com `ERROR_BEFORE_SUBMIT`.

## Várias notas para o mesmo cliente

O cliente é cadastrado **uma vez** (CPF/CNPJ é único, porque é a mesma empresa). Quem gera nota é a **automação**, e um cliente pode ter quantas automações você quiser:

```text
ACME COMERCIO LTDA (cadastrado uma vez)
├── ACME - mensalidade do contrato        R$ 3.500,00   sem desconto
└── ACME - consultoria avulsa             R$ 1.200,00   desc. incondicional R$ 200 + condicionado R$ 100
```

Na competência 2026-08 isso vira **duas NFS-e separadas**, cada uma com seus valores, descontos, descrição, município e código de tributação. Valor, desconto incondicional e desconto condicionado são campos **de cada automação** — e a aba *Tributos avançados* de cada uma ainda sobrescreve ISS/PIS/COFINS/IRRF/CSLL quando aquela nota específica precisa.

A trava de duplicidade é por `automação + competência`, e não por cliente: duas automações do mesmo cliente **não** brigam entre si, mas a mesma automação nunca emite duas vezes no mesmo mês.

No painel:

- a lista de **Automações** vem agrupada por cliente, mostrando quantas notas por competência e o total mensal;
- **+ Outra nota para este cliente** (no grupo ou na aba *Clientes*) abre o cadastro já com o cliente escolhido;
- **Duplicar** copia uma automação existente para você só trocar o desconto/valor e salvar.

## Data de Competência

O campo **Data de Competência** do portal recebe sempre a **data da geração da nota**, no timezone configurado — igual ao que o portal preenche quando você emite à mão, e igual ao `Sutil/Emissor-NFS-e-bot`. Não existe data de competência guardada nem derivada.

A *competência* que continua no banco é outra coisa: o **mês de referência** (`2026-08`), sempre o mês corrente. Ela não vai para esse campo; serve para

- os placeholders `{MES}`/`{MES_NUM}`/`{ANO}` da descrição do serviço e do e-mail;
- a trava `automação + competência`, que impede duas notas da mesma automação no mesmo mês;
- a organização de `data/files` e do histórico.

Não há mais escolha de *mês atual / mês anterior*: como a data enviada ao portal é sempre a da emissão, o mês de referência acompanha. A coluna `competence_mode` continua no schema por compatibilidade com bancos antigos, mas não é lida.

## Segurança contra nota duplicada

Existem duas camadas:

1. SQLite impede mais de um registro para a mesma `automação + competência`.
2. Imediatamente antes de clicar em **Emitir NFS-e**, o registro recebe `submitted_at` e status `SUBMITTING`.

Depois dessa fronteira, qualquer timeout, mudança de HTML ou resposta incerta vira `REVIEW_REQUIRED`. O worker **não tenta emitir de novo automaticamente**. Primeiro confira no portal.

Principais status:

- `PENDING`: registrada, ainda não enviada;
- `ERROR_BEFORE_SUBMIT`: falhou antes do clique final; pode ser repetida com segurança após correção;
- `SUBMITTING`: fronteira do clique final;
- `REVIEW_REQUIRED`: resultado incerto; conferir manualmente;
- `ISSUED`: emissão confirmada por chave capturada;
- `DOCUMENT_ERROR`: nota emitida, mas PDF/XML ainda não recuperados;
- `EMAIL_ERROR`: nota emitida, falha apenas no SMTP;
- `SENT`: e-mail enviado.

## PDF/DANFSe e CAPTCHA

O projeto **não resolve, burla nem tenta contornar CAPTCHA**.

Depois da emissão ele usa a mesma sessão autenticada para abrir a visualização da NFS-e pela chave. Quando o portal fornece a rota de impressão, o Chromium gera um PDF dessa visualização. Se a página exigir CAPTCHA ou a rota mudar, a nota fica em `DOCUMENT_ERROR`; ela **não é reemitida**. O painel permite tentar recuperar os documentos novamente.

O XML é baixado somente se um link autenticado válido for encontrado e o conteúdo retornado for realmente XML.

Existem rotas diretas no ADN (`https://adn.nfse.gov.br/xml/{chave}` e `/danfse/{chave}`), mas elas exigem certificado A1/mTLS — no `cleitonleonel/emissor_nfse` só são usadas quando há `.pfx` configurado. Sem A1 sobra o portal, e a NT 008/2026 descontinuou a API oficial de DANFSe em 01/07/2026: quem emite passa a gerar o documento localmente. É o que este projeto faz, imprimindo a visualização autenticada pelo Chromium.

## Acesso ao painel

O painel tem tela de login própria (`/login`). A sessão é um cookie `HttpOnly` assinado com HMAC-SHA256, válido por 12 horas (`APP_SESSION_HOURS`), com `Secure` automático atrás de HTTPS. O segredo da assinatura sai de `APP_SESSION_SECRET` ou, na falta dele, da própria senha do painel — **trocar `APP_ADMIN_PASSWORD` derruba as sessões abertas**.

- 5 tentativas erradas por minuto, por IP, e o login trava por um minuto.
- `Authorization: Basic` continua aceito nas rotas `/api/*`, para script e `curl`.
- `/api/health` fica fora da autenticação (é o healthcheck do Dokploy) e não devolve nada sensível.
- Sem `APP_ADMIN_PASSWORD` o painel abre sem login — o que só é permitido fora de produção, como descrito no deploy.

## Subindo com Docker

```bash
cp .env.example .env
```

Edite `.env`:

```env
APP_ADMIN_USER=admin
APP_ADMIN_PASSWORD=coloque-uma-senha-forte

NFSE_LOGIN=00000000000000
NFSE_PASSWORD=sua_senha_do_emissor

SMTP_HOST=smtp.seudominio.com.br
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=financeiro@seudominio.com.br
SMTP_PASS=sua_senha_smtp
SMTP_FROM=financeiro@seudominio.com.br
```

Depois:

```bash
docker compose up -d --build
```

Abra:

```text
http://IP-DO-SERVIDOR:3000
```

Logs:

```bash
docker compose logs -f nfse-auto
```

Parar:

```bash
docker compose down
```

Os dados ficam no diretório `./data`, montado como volume/bind mount, portanto recriar o container não apaga banco, PDFs/XML nem screenshots.

## Deploy no Dokploy

Use o arquivo `docker-compose.dokploy.yml`. Ele difere do compose local em três pontos: não publica portas (quem entrega é o Traefik do Dokploy), guarda `/data` em **volume nomeado** em vez de bind mount, e declara a rede externa `dokploy-network`, que é por onde o Traefik alcança o container.

1. No Dokploy: **Create Service → Compose**, aponte para o repositório e defina `docker-compose.dokploy.yml` como Compose Path.
2. Na aba **Environment**, cole o conteúdo do `.env.example` já preenchido. Em produção o `APP_ADMIN_PASSWORD` é **obrigatório**: sem ele o processo encerra na subida, porque o painel emite nota fiscal e ficaria aberto na internet. Se o painel já estiver atrás de outra proteção, `ALLOW_NO_AUTH=1` desliga essa exigência.
3. Na aba **Domains**, aponte seu domínio para o serviço `nfse-auto`, porta `3000`, com HTTPS ligado.
4. Deploy. O healthcheck bate em `/api/health` (rota pública, sem Basic Auth, sem dado sensível) — é o que o Dokploy usa para saber que subiu.

O volume `nfse-data` guarda `nfse.sqlite`, PDFs/XML e screenshots: **não apague o volume em redeploy**, senão perde histórico e a proteção de duplicidade por `automação + competência`.

Rodando atrás do Traefik, o app já usa `trust proxy` (desligue com `TRUST_PROXY=0` se algum dia servir direto).

Para testar na sua máquina antes, o `docker-compose.yml` normal continua valendo: bind mount em `./data` e porta `3000` publicada.

## Primeiro uso recomendado

1. Preencha `.env` e suba o container.
2. Entre em **Empresa e tributos**, clique em **Importar XML da NFS-e** e suba o XML de uma nota já emitida; confira e complete o que faltar.
3. Clique em **Testar login NFS-e**.
4. Em **Alertas**, confira o provedor lido do `.env`, clique em **Testar conexão** e use **Enviar teste** para ver o e-mail chegando.
5. Cadastre um cliente.
6. Cadastre uma automação com os valores reais.
7. Clique em **Prévia**. O robô preenche a Emissão Completa até a revisão, tira screenshot e **não emite**.
8. Compare a prévia com uma nota correta que você já emitiu manualmente.
9. Só então ligue **Permitir emissão real**.
10. Depois ligue **Cron habilitado**.

## Agendamento

Fica no menu lateral, em **Agendamento**, logo abaixo de Automações, e abre em modal: cron, janela de trabalho e a trava de emissão real valem para todas as automações. O fuso horário vem do `TZ` do `.env` (o mesmo do container) e não é guardado no banco — o modal só mostra qual está ativo.

O worker trabalha por **janela**, não por horário exato:

- a janela (início e fim) fica no painel — fora dela ele não emite nem manda e-mail, então nada de nota chegando ao cliente de madrugada;
- dentro da janela ele acorda a cada `WORKER_INTERVAL_MINUTES` (padrão 240 = 4 em 4 horas), definido no `.env`;
- **cada ciclo processa no máximo uma nota**. As outras ficam registradas como pendentes e saem nos ciclos seguintes.

O motivo do limite de uma por ciclo é o Chromium: cada emissão sobe um navegador, usa ~200 MiB acima do repouso e o fecha em seguida. Uma fila de dez notas viraria dez ciclos de navegador em sequência, saturando uma VPS pequena por vários minutos; espalhadas pela janela, o pico é sempre o de uma nota só. Quando um ciclo não tem nada para emitir, nenhum navegador é aberto — ele só cuida de documento/e-mail atrasado.

Se o servidor estiver desligado no dia configurado, quando voltar ele considera a automação vencida no mês e cria/processa a competência pendente. Dia 29/30/31 é automaticamente ajustado para o último dia de meses menores.

O container roda com `init: true` (PID 1 que recolhe processos): sem isso o Chromium deixa processos zumbis a cada emissão, que não consomem memória mas entopem a tabela de processos com o tempo.

Por padrão:

- janela: `08:30` às `17:30`;
- ciclo do worker: 4 horas (`WORKER_INTERVAL_MINUTES=240`), uma nota por ciclo;
- cron: desligado;
- emissão real: bloqueada.

## E-mail

O provedor e as credenciais ficam no `.env`; assunto/corpo e regras ficam no banco.

Placeholders disponíveis:

- `{CLIENTE}`
- `{DOCUMENTO}`
- `{NUMERO}`
- `{CHAVE}`
- `{VALOR}`
- `{MES}`
- `{MES_NUM}`
- `{ANO}`
- `{EMAIL}` (e-mail do destinatário)
- `{DATA}` (data/hora do envio, no timezone do agendamento)

Se a emissão funcionar e o e-mail falhar, o retry mexe **somente no e-mail**. Nunca cria outra NFS-e.

## Provedor de e-mail: SMTP ou Brevo

Transporte e credenciais moram **só no `.env`** — o painel não sobrescreve nada disso, e nenhuma credencial é gravada no banco. A aba *Alertas* mostra o que está ativo e oferece os testes; para trocar, edite o `.env` (ou a aba Environment do Dokploy) e suba o container de novo.

A flag `MAIL_PROVIDER` decide quem entrega:

```env
MAIL_PROVIDER=brevo          # smtp | brevo
MAIL_FROM="NFS-e <financeiro@seudominio.com.br>"
BREVO_API_KEY=xkeysib-...    # quando brevo
```

- `brevo`: envia pela **API HTTP** (`POST https://api.brevo.com/v3/smtp/email`), na porta 443.
- `smtp`: usa `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` como antes.

Se `MAIL_PROVIDER` ficar vazio, o sistema usa Brevo quando só existir `BREVO_API_KEY`; caso contrário, SMTP.

**Por que Brevo na DigitalOcean:** a DO bloqueia as portas de SMTP (25, 465 e 587) por padrão em contas novas, e liberar depende de abrir ticket. Pela API HTTP do Brevo o envio sai pela 443 e não esbarra nesse bloqueio. Se um dia liberarem seu SMTP, é só trocar a flag para `smtp` — o resto (templates, aviso, retry, histórico) não muda.

O remetente sai de `MAIL_FROM` (aceita `Nome <email@dominio>`), com `SMTP_FROM`/`SMTP_USER` como fallback. No Brevo, esse endereço precisa estar validado como remetente na conta.

Em **Alertas** há dois testes: **Testar conexão** valida o provedor ativo (`verify()` no SMTP, `GET /v3/account` no Brevo) e **Enviar teste** dispara um e-mail de verdade para o endereço que você digitar — serve para conferir entrega e texto sem emitir nota nenhuma. O card **Segurança da automação** mostra qual provedor está em uso e se ele veio do painel ou do `.env`.

## Aviso quando a nota é enviada ao cliente

Na aba **Alertas → Aviso para mim** você define:

- `Quero ser avisado a cada nota enviada`: liga/desliga o aviso (vem ligado);
- `Avisar quem`: um ou mais e-mails separados por vírgula. Vazio = usa o `SMTP_FROM` do `.env`;
- `Como avisar`:
  - **Aviso separado** (padrão): uma mensagem só para você, com número, chave, valor, destinatário e horário;
  - **Cópia oculta (BCC)**: você recebe exatamente o mesmo e-mail que o cliente, com os mesmos anexos;
  - **Aviso separado + cópia oculta**: os dois;
- `Anexar PDF/XML no aviso separado`: por padrão o aviso vai sem anexo (o BCC sempre leva os anexos originais).

Regras de segurança do aviso:

- o aviso só sai **depois** que o servidor SMTP aceita o e-mail do cliente;
- se o aviso falhar, a nota **continua `SENT`**: a falha vira o evento `NOTIFY_ERROR` no histórico e aparece em “Último erro/aviso”. Nunca reemite nem reenvia a nota por causa disso;
- se o SMTP rejeitar o e-mail do cliente, a nota vai para `EMAIL_ERROR` como antes, e nenhum aviso é enviado;
- o botão **E-mail** do histórico reenvia a nota e dispara o aviso de novo.

Eventos gravados: `NOTIFY_SENT` (aviso entregue) e `NOTIFY_ERROR` (aviso falhou). O painel mostra o destino configurado no card **Segurança da automação**.

## Conferência contra os projetos de referência

Última conferência: **26/08/2026**, contra o `Sutil/Emissor-NFS-e-bot` no commit de 25/08/2026.

Batem exatamente com a referência: login (`#Inscricao`, `#Senha`, botão *Entrar*, espera sair de `/Login`), `/EmissorNacional/DPS/Pessoas`, `PreencherInfoIBSCBS=0`, `#DataCompetencia`, `Tomador.LocalDomicilio=1`, `#Tomador_Inscricao` com espera de 4s pelo lookup, os dois Select2 (`LocalPrestacao_CodigoMunicipioPrestacao`, `ServicoPrestado_CodigoTributacaoNacional`), `ServicoPrestado.HaExportacaoImunidadeNaoIncidencia=0`, `#ServicoPrestado_Descricao`, `#Valores_ValorServico`, os três `ISSQN.Ha*`, o bloco `TributacaoFederal_*` via Chosen (com `isEditable()` no CSLL), `ValorTributos.TipoValorTributos=2` com os três percentuais e o `#btnProsseguir` com a checagem de "ainda na tela".

**Sem respaldo na referência** — inferidos aqui, todos com fallback por rótulo e falha antes do clique final:

| Campo | Situação |
| --- | --- |
| `Valores_DescontoIncondicionado` / `...Condicionado` | o bot de referência não trata descontos |
| `ValorTributos_PercentualTotalTributosSN` / `pTotTribSN` | percentual do Simples; opcional, nunca forçado |
| `ValorTributos_ValorTotal*` (modo "Valores R$") | a referência só usa o modo percentual |
| `TributacaoFederal_ValorCP` | contribuição previdenciária; opcional |

Uma diferença de comportamento deliberada: a base de cálculo de PIS/COFINS aqui é *valor − desconto incondicional*, enquanto a referência usa o valor cheio (ela não tem descontos).

## Atualizações do portal

Como este modo automatiza o portal Web, mudanças de IDs, widgets ou fluxo do Governo podem quebrar seletores. O comportamento seguro é falhar antes de emitir ou, quando a falha ocorre após o clique final, pedir conferência manual.

Quando a Prévia ou a emissão falha **antes** do clique final, o sistema salva em `./data/debug` um `erro-*.png` (o que estava na tela) e um `erro-*.html` (o HTML da página naquele instante), e a mensagem de erro aponta o link do screenshot. É com esses dois arquivos que se descobre o que o portal mudou.

**Radios estilizados:** o portal esconde os `<input type="radio">` e mostra um controle próprio no lugar; clicar no input dá `Element is not visible`. A automação tenta, nesta ordem, o `<label>` que embrulha o input, o `label[for=…]`, o próprio input quando visível e, por último, marcar no DOM disparando `input`/`change`. Campos marcados como opcionais — `PreencherInfoIBSCBS`, por exemplo — não derrubam mais a emissão quando existem mas não aceitam clique.

Para atualizar o projeto depois de uma mudança do portal, os arquivos mais relevantes são:

```text
src/emitter/auth.js
src/emitter/dom.js
src/emitter/national.js
src/emitter/documents.js
```

## Testes locais

Sem precisar acessar o portal:

```bash
npm test
npm run check
```

Para testar de verdade a integração, use o botão **Prévia** do painel primeiro.
