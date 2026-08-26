const state = { settings: null, clients: [], automations: [], invoices: [], status: null };

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

async function api(url, options = {}) {
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  const res = await fetch(url, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (res.status === 401 && data?.login) { location.href = '/login'; throw new Error('Sessão expirada.'); }
  if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
  return data;
}

// sticky = aviso de operação em andamento: fica na tela até o resultado chegar.
function toast(message, error = false, sticky = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${error ? ' error' : ''}${sticky ? ' working' : ''}`;
  clearTimeout(toast.timer);
  if (!sticky) toast.timer = setTimeout(() => el.classList.add('hidden'), 6000);
}

// Confirmação no visual do painel, em vez do confirm() do navegador.
function confirmar({ title, message, detail = '', confirmLabel = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const dialog = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    const box = $('#confirmDetail');
    box.hidden = !detail;
    box.textContent = detail;
    const ok = $('#confirmOk');
    ok.textContent = confirmLabel;
    ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    const aoFechar = () => {
      dialog.removeEventListener('close', aoFechar);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.addEventListener('close', aoFechar);
    dialog.returnValue = '';
    dialog.showModal();
    ok.focus();
  });
}

// Botão vira "carregando" durante a operação: sem isso a tela fica muda.
async function comCarregando(botao, texto, tarefa) {
  if (!botao) return tarefa();
  const original = botao.textContent;
  botao.disabled = true;
  botao.classList.add('is-loading');
  if (texto) botao.textContent = texto;
  try {
    return await tarefa();
  } finally {
    botao.disabled = false;
    botao.classList.remove('is-loading');
    botao.textContent = original;
  }
}

function money(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(cents || 0) / 100);
}

function cents(value) { return Math.round(Number(String(value || 0).replace(',', '.')) * 100); }
function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

const statusLabels = {
  PENDING: ['Pendente', 'neutral'], PROCESSING: ['Preenchendo', 'info'], ERROR_BEFORE_SUBMIT: ['Erro antes de emitir', 'error'],
  SUBMITTING: ['Enviando', 'warn'], REVIEW_REQUIRED: ['Conferir no portal', 'error'], ISSUED: ['Emitida', 'ok'],
  DOCUMENT_ERROR: ['Documento pendente', 'warn'], EMAIL_ERROR: ['E-mail pendente', 'warn'], SENT: ['Enviada', 'ok']
};
const eventLabels = { NOTIFY_SENT: 'AVISO ENVIADO', NOTIFY_ERROR: 'AVISO FALHOU', REGISTERED: 'NOTA REGISTRADA' };
function badgeStatus(status) { const [label, kind] = statusLabels[status] || [status, 'neutral']; return `<span class="badge ${kind}">${esc(label)}</span>`; }

function setByPath(obj, path, value) {
  const keys = path.split('.'); let cur = obj;
  keys.slice(0, -1).forEach((k) => cur = cur[k] ??= {});
  cur[keys.at(-1)] = value;
}
function getByPath(obj, path) { return path.split('.').reduce((v, k) => v?.[k], obj); }

const tabTitles = {
  dashboard: ['Visão geral', 'Acompanhe automações, notas e pendências.'],
  settings: ['Empresa e tributos', 'Padrões usados na Emissão Completa.'],
  clients: ['Clientes', 'Cadastre os tomadores das notas.'],
  automations: ['Automações', 'Defina recorrência, valores, descontos e exceções.'],
  alerts: ['Alertas', 'Provedor de e-mail, aviso de envio e mensagem ao cliente.'],
  history: ['Histórico', 'Auditoria, arquivos e tentativas de envio.']
};

function showTab(name) {
  $$('.nav[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  $('#pageTitle').textContent = tabTitles[name][0];
  $('#pageSubtitle').textContent = tabTitles[name][1];
}

function fillForm(form) {
  $$('[name]', form).forEach((field) => {
    const value = getByPath(state.settings, field.name);
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else if (field.type === 'password') field.value = '';
    else if (value !== undefined && value !== null) field.value = value;
  });
}

function collectForm(form) {
  const obj = JSON.parse(JSON.stringify(state.settings || {}));
  $$('[name]', form).forEach((field) => {
    let value;
    if (field.type === 'checkbox') value = field.checked;
    else if (field.type === 'number') value = Number(field.value || 0);
    else value = field.value;
    setByPath(obj, field.name, value);
  });
  return obj;
}

function fillAllForms() {
  fillForm($('#settingsForm'));
  fillForm($('#alertsForm'));
  fillForm($('#schedulerForm'));
  syncApproxFields();
  syncIbsCbsFields();
  renderMailStatus();
}

// Cada modo do portal usa campos diferentes; mostrar só os que valem — e sem
// deixar buraco na grade: o seletor ocupa meia linha quando está sozinho.
function syncApproxFields() {
  const mode = $('#settingsForm [name="tax.approxMode"]').value;
  const detalhado = ['percent', 'value'].includes(mode);
  ['#approxFederalField', '#approxStateField', '#approxMunicipalField'].forEach((sel) => { $(sel).hidden = !detalhado; });
  $('#snRateField').hidden = mode !== 'sn';
  $('#approxModeField').classList.toggle('span-2', !detalhado);
}

function syncIbsCbsFields() {
  const ligado = $('#settingsForm [name="portal.fillIbsCbs"]').checked;
  $('#ibsCbsFields').hidden = !ligado;
  const badge = $('#ibsCbsState');
  badge.textContent = ligado ? 'Ligado' : 'Desligado até 01/01/2027 (Simples)';
  badge.className = `badge ${ligado ? 'warn' : 'neutral'}`;
}

function renderMailStatus() {
  const mail = state.status?.mail || {};
  $('#providerBadge').textContent = mail.label || '—';
  $('#mailStatusBox').innerHTML = `
    <div class="safety-row"><span>Serviço (MAIL_PROVIDER)</span><strong>${esc(mail.label || '—')}</strong></div>
    <div class="safety-row"><span>Remetente (MAIL_FROM)</span><strong>${esc(mail.from || 'não configurado')}</strong></div>
    <div class="safety-row"><span>Credenciais</span>${mail.configured ? '<span class="badge ok">Completas no .env</span>' : '<span class="badge warn">Faltando no .env</span>'}</div>`;
}

function applySuggestion(suggestion) {
  const applied = [];
  for (const [group, values] of Object.entries(suggestion || {})) {
    for (const [key, value] of Object.entries(values || {})) {
      if (value === null || value === undefined || value === '') continue;
      const field = $(`#settingsForm [name="${group}.${key}"]`);
      if (!field) continue;
      if (field.type === 'checkbox') field.checked = Boolean(value);
      else field.value = value;
      applied.push((field.previousSibling?.textContent || '').trim() || `${group}.${key}`);
    }
  }
  return applied;
}

function humanInterval(minutes) {
  const n = Number(minutes || 0);
  if (!n) return '—';
  if (n % 60 === 0) return `${n / 60}h`;
  if (n > 60) return `${Math.floor(n / 60)}h${String(n % 60).padStart(2, '0')}`;
  return `${n} min`;
}

function renderStats() {
  const c = state.status.counts;
  $('#stats').innerHTML = [
    ['Clientes ativos', c.clients], ['Automações ativas', c.automations], ['Notas processadas', c.issued], ['Precisam atenção', c.attention]
  ].map(([label, value]) => `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`).join('');
  const s = state.settings.scheduler;
  const em = state.settings.email;
  const notifyTarget = (em.notifyTo || '').trim() || 'remetente configurado';
  const notifyModes = { separate: 'Aviso separado', bcc: 'Cópia oculta', both: 'Aviso + cópia' };
  $('#safetyBox').innerHTML = `
    <div class="safety-row"><span>Cron</span>${s.enabled ? '<span class="badge ok">Ligado</span>' : '<span class="badge neutral">Desligado</span>'}</div>
    <div class="safety-row"><span>Emissão real</span>${s.emissionEnabled ? '<span class="badge error">Permitida</span>' : '<span class="badge ok">Bloqueada</span>'}</div>
    <div class="safety-row"><span>Janela</span><strong>${String(s.startHour).padStart(2,'0')}:${String(s.startMinute).padStart(2,'0')} às ${String(s.endHour).padStart(2,'0')}:${String(s.endMinute).padStart(2,'0')} · ${esc(state.status.timezone)}</strong></div>
    <div class="safety-row"><span>Ciclo do worker</span><strong>${humanInterval(state.status.workerIntervalMinutes)} · 1 nota por vez</strong></div>
    <div class="safety-row"><span>Portal</span>${state.status.portalConfigured ? '<span class="badge ok">Credenciais configuradas</span>' : '<span class="badge warn">Configurar .env</span>'}</div>
    <div class="safety-row"><span>E-mail</span>${state.status.mail.configured ? `<span class="badge ok">${esc(state.status.mail.label)}</span>` : `<span class="badge warn">${esc(state.status.mail.label)} · incompleto</span>`}</div>
    <div class="safety-row"><span>Build no ar</span><strong class="mono" title="Muda a cada deploy com alteração de código">${esc(state.status.build || '—')}</strong></div>
    <div class="safety-row"><span>Aviso de envio</span>${em.notifyOnSent ? `<span class="badge ok">${esc(notifyModes[em.notifyMode] || 'Aviso separado')} → ${esc(notifyTarget)}</span>` : '<span class="badge neutral">Desligado</span>'}</div>`;
}

// Sem volume montado, o banco vive dentro do container e some no redeploy.
function renderPersistWarning() {
  const box = $('#persistWarning');
  const ok = state.status?.dataPersistent;
  box.hidden = ok !== false;
  if (ok === false) {
    box.innerHTML = `<strong>Os dados não estão em volume.</strong> O banco está dentro do container, em <code>${esc(state.status.dataDir)}</code>, e será perdido no próximo deploy — junto com o histórico e a proteção contra nota duplicada. Monte um volume nesse caminho no Dokploy (Mounts) antes de emitir.`;
  }
}

function renderRecent() {
  const rows = state.invoices.slice(0, 8);
  $('#recentInvoices').innerHTML = rows.length ? rows.map((i) => `<tr><td>${esc(i.competence)}</td><td>${esc(i.client_name)}</td><td>${money(i.value_cents)}</td><td>${badgeStatus(i.status)}</td><td>${botaoDanfse(i)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">Nenhuma nota processada.</td></tr>';
}

function automationsOf(clientId) {
  return state.automations.filter((a) => a.client_id === clientId);
}

function renderClients() {
  const rows = state.clients;
  $('#clientsTable').innerHTML = rows.length ? rows.map((c) => {
    const list = automationsOf(c.id);
    return `<tr>
    <td><strong>${esc(c.name)}</strong></td><td>${esc(c.document)}</td><td>${c.type}</td><td>${esc(c.email || '—')}</td>
    <td>${list.length ? `<span class="badge info">${list.length} ${list.length === 1 ? 'automação' : 'automações'}</span>` : '<span class="badge neutral">nenhuma</span>'}</td>
    <td>${c.active ? '<span class="badge ok">Ativo</span>' : '<span class="badge neutral">Inativo</span>'}</td>
    <td><div class="actions">${c.active ? `<button class="btn secondary small" onclick="newAutomationFor(${c.id})">+ Automação</button>` : ''}<button class="btn secondary small" onclick="editClient(${c.id})">Editar</button>${c.active ? `<button class="btn danger small" onclick="deactivateClientAction(${c.id})">Desativar</button>` : ''}</div></td>
  </tr>`;
  }).join('') : '<tr><td colspan="7" class="empty">Nenhum cliente cadastrado.</td></tr>';
  const select = $('#automationForm [name="clientId"]');
  select.innerHTML = state.clients.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.document)}</option>`).join('');
}

function automationCard(a) {
  return `<div class="automation-card">
    <div><div class="automation-title"><h3>${esc(a.name)}</h3>${a.enabled ? '<span class="badge ok">Ativa</span>' : '<span class="badge neutral">Pausada</span>'}</div>
      <div class="automation-meta"><span>Todo dia ${a.day_of_month}</span>${a.start_date ? `<span>a partir de ${esc(a.start_date.split('-').reverse().join('/'))}</span>` : ''}<span>${money(a.value_cents)}</span>${a.discount_incond_cents ? `<span class="tag-discount">Desc. incond. ${money(a.discount_incond_cents)}</span>` : ''}${a.discount_cond_cents ? `<span class="tag-discount">Desc. cond. ${money(a.discount_cond_cents)}</span>` : ''}${a.email_enabled ? '<span>E-mail</span>' : ''}</div>
    </div>
    <div class="actions"><button class="btn secondary small" onclick="previewAutomationAction(${a.id},this)">Prévia</button><button class="btn secondary small" onclick="editAutomation(${a.id})">Editar</button><button class="btn secondary small" onclick="duplicateAutomation(${a.id})">Duplicar</button><button class="btn secondary small" onclick="toggleAutomation(${a.id},${!a.enabled})">${a.enabled ? 'Pausar' : 'Ativar'}</button><button class="btn danger small" onclick="emitNow(${a.id},this)">Emitir agora</button></div>
  </div>`;
}

// Uma automação = uma nota por competência. Agrupar por cliente deixa visível
// que a mesma empresa pode ter várias notas no mesmo mês.
function renderAutomations() {
  if (!state.automations.length) {
    $('#automationsList').innerHTML = '<div class="empty">Nenhuma automação cadastrada.</div>';
    return;
  }
  const groups = new Map();
  for (const a of state.automations) {
    if (!groups.has(a.client_id)) groups.set(a.client_id, []);
    groups.get(a.client_id).push(a);
  }
  const sorted = [...groups.values()].sort((x, y) => x[0].client_name.localeCompare(y[0].client_name, 'pt-BR'));
  $('#automationsList').innerHTML = sorted.map((list) => {
    const first = list[0];
    const total = list.reduce((sum, a) => sum + a.value_cents, 0);
    return `<div class="automation-group">
      <div class="group-head">
        <div><h3>${esc(first.client_name)}</h3><p>${esc(first.client_document)} · ${list.length} ${list.length === 1 ? 'nota por competência' : 'notas por competência'} · ${money(total)}/mês</p></div>
        <button class="btn secondary small" onclick="newAutomationFor(${first.client_id})">+ Outra nota para este cliente</button>
      </div>
      ${list.map(automationCard).join('')}
    </div>`;
  }).join('');
}

// O número da NFS-e sai das tabelas: o que interessa no dia a dia é o
// documento, que abre aqui mesmo. O número segue nos Detalhes e no DANFSe.
function botaoDanfse(i) {
  if (!i.pdf_path) return '<span class="hint">—</span>';
  return `<button class="btn secondary small" onclick="abrirDanfse(${i.id}, '${esc(i.competence)}', '${esc(i.client_name)}')">Ver DANFSe</button>`;
}

window.abrirDanfse = function(id, competencia, cliente) {
  const url = `/api/invoices/${id}/file/pdf`;
  $('#pdfTitle').textContent = `DANFSe · ${cliente} · ${competencia}`;
  $('#pdfDownload').href = url;
  $('#pdfOpen').href = url;
  $('#pdfFrame').src = `${url}?inline=1#view=FitH&navpanes=0`;
  $('#pdfDialog').showModal();
};

function renderHistory() {
  $('#historyTable').innerHTML = state.invoices.length ? state.invoices.map((i) => `<tr>
    <td>${esc(i.scheduled_date)}</td><td>${esc(i.competence)}</td><td>${esc(i.client_name)}</td><td>${money(i.value_cents)}</td><td>${badgeStatus(i.status)}</td>
    <td><div class="file-links">${botaoDanfse(i)}${i.xml_path ? `<a class="btn secondary small" href="/api/invoices/${i.id}/file/xml">XML</a>` : ''}</div></td>
    <td><div class="actions"><button class="btn secondary small" onclick="showInvoice(${i.id})">Detalhes</button>${i.access_key ? `<a class="btn secondary small" href="https://www.nfse.gov.br/EmissorNacional/Notas/Visualizar/Index/${esc(i.access_key)}" target="_blank" rel="noopener" title="Abrir a nota no Emissor Nacional (para baixar XML/DANFSe oficiais)">Portal</a>` : ''}${i.access_key ? `<button class="btn secondary small" onclick="retryDocumentsAction(${i.id},this)" title="Lê a nota no portal e gera o DANFSe de novo">Gerar DANFSe</button>` : ''}${['ISSUED','EMAIL_ERROR','DOCUMENT_ERROR'].includes(i.status) ? `<button class="btn secondary small" onclick="retryEmailAction(${i.id},this)">E-mail</button>` : ''}${i.status === 'ERROR_BEFORE_SUBMIT' ? `<button class="btn danger small" onclick="retryEmission(${i.id},this)">Tentar emissão</button>` : ''}</div></td>
  </tr>`).join('') : '<tr><td colspan="7" class="empty">Sem histórico.</td></tr>';
}

function renderPending() {
  const itens = state.pending || [];
  const vencidas = itens.filter((p) => p.due);
  $('#pendingCount').textContent = vencidas.length ? `${vencidas.length} para processar` : 'nada vencido';
  $('#pendingCount').className = `badge ${vencidas.length ? 'warn' : 'ok'}`;
  if (!itens.length) {
    $('#pendingList').innerHTML = '<div class="empty">Nenhuma automação ativa aguardando processamento.</div>';
    return;
  }
  $('#pendingList').innerHTML = itens.map((p) => `<div class="pending-row${p.due ? '' : ' aguardando'}">
    <div>
      <strong>${esc(p.clientName)}</strong> · ${esc(p.automationName)}
      <div class="pending-meta">competência ${esc(p.competence)} · previsto para ${esc(p.scheduledDate.split('-').reverse().join('/'))} · ${money(p.valueCents)}${p.status === 'ERROR_BEFORE_SUBMIT' ? ' · <span class="danger-text">falhou antes de emitir</span>' : ''}</div>
    </div>
    ${p.due ? '<span class="badge warn">vencida</span>' : `<span class="badge neutral">a partir de ${esc((p.startDate || p.scheduledDate).split('-').reverse().join('/'))}</span>`}
  </div>`).join('');
}

async function refreshAll() {
  const [status, clients, automations, invoices, sessionInfo, pending] = await Promise.all([
    api('/api/status'), api('/api/clients?all=1'), api('/api/automations'), api('/api/invoices'), api('/api/session'), api('/api/pending')
  ]);
  state.status = status; state.settings = status.settings; state.clients = clients; state.automations = automations; state.invoices = invoices; state.pending = pending;
  $('#logoutBtn').hidden = !sessionInfo.authRequired;
  fillAllForms(); renderPersistWarning(); renderStats(); renderPending(); renderClients(); renderAutomations(); renderHistory(); renderRecent();
}

window.editClient = function(id) {
  const c = state.clients.find((x) => x.id === id); if (!c) return;
  const f = $('#clientForm'); f.reset();
  f.id.value = c.id; f.name.value = c.name; f.type.value = c.type; f.document.value = c.document; f.email.value = c.email || ''; f.active.checked = c.active;
  $('#clientImportResult').hidden = true;
  $('#clientDialogTitle').textContent = 'Editar cliente'; $('#clientDialog').showModal();
};
window.deactivateClientAction = async function(id) {
  const cliente = state.clients.find((c) => c.id === id);
  const ok = await confirmar({
    title: 'Desativar cliente',
    message: `${cliente?.name || 'Este cliente'} sai da lista e suas automações param de gerar nota. O histórico é mantido.`,
    confirmLabel: 'Desativar',
    danger: true
  });
  if (!ok) return;
  try { await api(`/api/clients/${id}`, { method:'DELETE' }); toast('Cliente desativado.'); await refreshAll(); } catch(e){toast(e.message,true);}
};

function openNewClient() { const f=$('#clientForm'); f.reset(); f.id.value=''; f.active.checked=true; $('#clientImportResult').hidden=true; $('#clientDialogTitle').textContent='Novo cliente'; $('#clientDialog').showModal(); }

window.editAutomation = function(id) {
  const a = state.automations.find((x) => x.id === id); if (!a) return;
  const f = $('#automationForm'); f.reset();
  f.id.value=a.id; f.name.value=a.name; f.clientId.value=a.client_id;
  f.startDate.value=a.start_date || proximaData(a.day_of_month);
  f.value.value=(a.value_cents/100).toFixed(2); f.discountIncond.value=(a.discount_incond_cents/100).toFixed(2); f.discountCond.value=(a.discount_cond_cents/100).toFixed(2);
  f.enabled.checked=a.enabled; f.emailEnabled.checked=a.email_enabled; f.serviceDescription.value=a.service_description||''; f.municipalitySearch.value=a.municipality_search||''; f.municipalityName.value=a.municipality_name||''; f.taxCodeSearch.value=a.tax_code_search||''; f.taxCodeName.value=a.tax_code_name||'';
  $$('[data-override]',f).forEach((el)=>{el.checked=false}); $$('[data-override-number]',f).forEach((el)=>el.value='');
  for (const [k,v] of Object.entries(a.overrides||{})) { const b=f.querySelector(`[data-override="${k}"]`); if(b)b.checked=Boolean(v); const n=f.querySelector(`[data-override-number="${k}"]`); if(n)n.value=v; }
  $('#automationImportResult').hidden=true;
  $('#automationDialogTitle').textContent='Editar automação'; $('#automationDialog').showModal();
};
// Sugere a próxima ocorrência desse dia: se já passou no mês, joga para o mês seguinte.
function proximaData(dia) {
  const hoje = new Date();
  const d = Math.min(Number(dia) || 1, 28);
  let ano = hoje.getFullYear();
  let mes = hoje.getMonth();
  if (hoje.getDate() > d) { mes += 1; if (mes > 11) { mes = 0; ano += 1; } }
  return `${ano}-${String(mes + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

window.duplicateAutomation = function(id) {
  const a = state.automations.find((x) => x.id === id); if (!a) return;
  window.editAutomation(id);
  const f = $('#automationForm');
  f.id.value = '';
  f.name.value = `${a.name} (cópia)`;
  $('#automationDialogTitle').textContent = 'Duplicar automação';
  toast('Cópia aberta: ajuste os descontos/valor e salve como nova automação.');
};

window.newAutomationFor = function(clientId) {
  openNewAutomation();
  const f = $('#automationForm');
  f.clientId.value = String(clientId);
  const client = state.clients.find((c) => c.id === clientId);
  if (client) f.name.value = `${client.name} - `;
  f.name.focus();
};

function openNewAutomation(){ const f=$('#automationForm'); f.reset(); f.id.value=''; $('#automationImportResult').hidden=true; f.startDate.value=proximaData(new Date().getDate()); f.discountIncond.value='0'; f.discountCond.value='0'; f.enabled.checked=true; f.emailEnabled.checked=true; $('#automationDialogTitle').textContent='Nova automação'; $('#automationDialog').showModal(); }

window.toggleAutomation=async(id,enabled)=>{try{await api(`/api/automations/${id}/toggle`,{method:'POST',body:JSON.stringify({enabled})});toast(enabled?'Automação ativada.':'Automação pausada.');await refreshAll();}catch(e){toast(e.message,true)}};
window.previewAutomationAction=async(id,botao)=>{
  try{
    toast('Abrindo o portal e preenchendo a Emissão Completa até a revisão... isso leva alguns segundos.',false,true);
    const r=await comCarregando(botao,'Preenchendo...',()=>api(`/api/automations/${id}/preview`,{method:'POST',body:'{}'}));
    toast('Prévia concluída sem emitir. Confira os campos antes de liberar a emissão real.');
    window.openImage(r.screenshotUrl,'Prévia da NFS-e (não emitida)');
  }catch(e){toast(e.message,true);showErrorEvidence(e.message);}
};
window.emitNow=async(id,botao)=>{
  if(!state.settings.scheduler.emissionEnabled){toast('Ative “Permitir emissão real” no Agendamento antes.',true);return;}
  const a=state.automations.find((x)=>x.id===id);
  const ok=await confirmar({
    title:'Emitir NFS-e de verdade',
    message:`${a?.client_name||'Cliente'} · ${money(a?.value_cents)} — a nota será emitida agora no Emissor Nacional.`,
    detail:'Depois do clique final não há como desfazer pelo painel: um cancelamento tem que ser feito no portal.',
    confirmLabel:'Emitir agora',
    danger:true
  });
  if(!ok)return;
  try{
    toast('Emitindo no portal... não feche a página.',false,true);
    const r=await comCarregando(botao,'Emitindo...',()=>api(`/api/automations/${id}/run`,{method:'POST',body:JSON.stringify({confirmation:'EMITIR'})}));
    toast(`Processamento concluído: ${statusLabels[r.status]?.[0]||r.status}`);
    await refreshAll();
  }catch(e){toast(e.message,true);showErrorEvidence(e.message);}
};
window.retryDocumentsAction=async(id,botao)=>{try{toast('Lendo a nota no portal e gerando o DANFSe...',false,true);await comCarregando(botao,'Gerando...',()=>api(`/api/invoices/${id}/retry-documents`,{method:'POST',body:'{}'}));toast('DANFSe gerado a partir da nota no portal.');await refreshAll();}catch(e){toast(e.message,true)}};
window.retryEmailAction=async(id,botao)=>{try{toast('Enviando o e-mail...',false,true);await comCarregando(botao,'Enviando...',()=>api(`/api/invoices/${id}/retry-email`,{method:'POST',body:'{}'}));toast('E-mail enviado.');await refreshAll();}catch(e){toast(e.message,true)}};
window.retryEmission=async(id,botao)=>{
  if(!state.settings.scheduler.emissionEnabled){toast('Emissão real está bloqueada.',true);return;}
  const ok=await confirmar({
    title:'Tentar a emissão de novo',
    message:'Esta nota falhou antes do clique final, então repetir é seguro: nada foi enviado ao portal.',
    confirmLabel:'Tentar emitir',
    danger:true
  });
  if(!ok)return;
  try{
    toast('Emitindo no portal... não feche a página.',false,true);
    await comCarregando(botao,'Emitindo...',()=>api(`/api/invoices/${id}/retry`,{method:'POST',body:JSON.stringify({confirmation:'EMITIR'})}));
    toast('Nova tentativa concluída.');
    await refreshAll();
  }catch(e){toast(e.message,true);showErrorEvidence(e.message);}
};

window.showInvoice=async function(id){try{const i=await api(`/api/invoices/${id}`);$('#invoiceDialogSubtitle').textContent=`${i.client_name} · ${i.competence}`;$('#invoiceDetails').innerHTML=`
  <div class="form-grid cols-2"><div><strong>Status</strong><p>${badgeStatus(i.status)}</p></div><div><strong>Valor</strong><p>${money(i.value_cents)}</p></div><div><strong>NFS-e</strong><p>${esc(i.nfse_number||'—')}</p></div><div><strong>Chave</strong><p class="mono">${esc(i.access_key||'—')}</p></div><div class="span-2"><strong>Último erro/aviso</strong><p class="${i.last_error?'danger-text':''}">${esc(i.last_error||'Nenhum')}</p></div></div>
  <h3>Eventos</h3><div class="event-list">${i.events.length?i.events.map(e=>`<div class="event"><strong>${esc(eventLabels[e.type]||e.type)} · ${new Date(e.created_at).toLocaleString('pt-BR')}</strong>${esc(e.message)}</div>`).join(''):'<div class="empty">Sem eventos.</div>'}</div>`;$('#invoiceDialog').showModal();}catch(e){toast(e.message,true)}};

// --- visualizador de imagem: zoom e arraste, em vez de abrir aba nova ---
const viewer = { zoom: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 };

function applyViewer() {
  const img = $('#imageView');
  img.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.zoom})`;
  $('#zoomLabel').textContent = `${Math.round(viewer.zoom * 100)}%`;
}
function setZoom(value) {
  viewer.zoom = Math.min(6, Math.max(0.1, value));
  applyViewer();
}
function fitImage() {
  const stage = $('#imageStage');
  const img = $('#imageView');
  if (!img.naturalWidth) return;
  viewer.x = 0; viewer.y = 0;
  setZoom(Math.min(1, (stage.clientWidth - 24) / img.naturalWidth));
}
window.openImage = function(url, title = 'Prévia') {
  const img = $('#imageView');
  $('#imageTitle').textContent = title;
  $('#imageOpen').href = url;
  img.onload = fitImage;
  img.src = url;
  viewer.x = 0; viewer.y = 0; setZoom(1);
  $('#imageDialog').showModal();
};
$$('#imageDialog [data-zoom]').forEach((b) => b.addEventListener('click', () => {
  const kind = b.dataset.zoom;
  if (kind === 'fit') return fitImage();
  setZoom(viewer.zoom * (kind === '1' ? 1.25 : 0.8));
}));
$('#imageStage').addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    setZoom(viewer.zoom * (e.deltaY < 0 ? 1.12 : 0.89));
    return;
  }
  // A prévia é uma página inteira, bem mais alta que a janela: roda rola.
  viewer.y -= e.deltaY;
  viewer.x -= e.deltaX;
  applyViewer();
}, { passive: false });
// O ponteiro só é capturado quando o arraste começa de fato. Capturar em todo
// pointerdown fazia o stage engolir os cliques seguintes — inclusive o do X.
const stage = () => $('#imageStage');
stage().addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  viewer.pressed = true;
  viewer.dragging = false;
  viewer.moved = 0;
  viewer.startX = e.clientX - viewer.x;
  viewer.startY = e.clientY - viewer.y;
});
stage().addEventListener('pointermove', (e) => {
  if (!viewer.pressed) return;
  const nx = e.clientX - viewer.startX;
  const ny = e.clientY - viewer.startY;
  viewer.moved += Math.abs(nx - viewer.x) + Math.abs(ny - viewer.y);
  viewer.x = nx;
  viewer.y = ny;
  if (!viewer.dragging && viewer.moved > 4) {
    viewer.dragging = true;
    try { stage().setPointerCapture(e.pointerId); } catch {}
  }
  applyViewer();
});
function endDrag(e) {
  if (viewer.dragging) {
    try { stage().releasePointerCapture(e.pointerId); } catch {}
  }
  const foiClique = viewer.pressed && viewer.moved <= 4;
  viewer.pressed = false;
  viewer.dragging = false;
  return foiClique;
}
// A imagem mantém o tamanho natural no layout (o zoom é transform), então
// e.target é quase sempre ela. O que vale é a área que aparece na tela:
// getBoundingClientRect já vem com o transform aplicado.
function cliqueForaDaImagem(e) {
  const r = $('#imageView').getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}
stage().addEventListener('pointerup', (e) => {
  // Clique na moldura (fora da imagem) fecha, como em qualquer lightbox.
  if (endDrag(e) && cliqueForaDaImagem(e)) $('#imageDialog').close();
});
stage().addEventListener('pointercancel', endDrag);

// Erro do portal vem com o caminho do screenshot: mostra a tela junto do aviso.
function showErrorEvidence(message) {
  const found = String(message).match(/\/api\/debug\/[\w.-]+\.png/);
  if (found) window.openImage(found[0], 'O que estava na tela quando falhou');
}

// --- diálogos: fechar nunca dispara validação de formulário ---
document.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-close]');
  if (closer) { event.preventDefault(); closer.closest('dialog')?.close(); }
});
$$('dialog').forEach((dialog) => {
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
});

$$('.nav[data-tab]').forEach((b)=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
$('#confirmOk').addEventListener('click',()=>$('#confirmDialog').close('ok'));
$('#openSchedulerBtn').addEventListener('click',()=>{fillForm($('#schedulerForm'));$('#schedulerTz').textContent=state.status?.timezone||'—';$('#schedulerInterval').textContent=humanInterval(state.status?.workerIntervalMinutes);$('#schedulerDialog').showModal();});
$('#newClientBtn').addEventListener('click',openNewClient);
$('#newAutomationBtn').addEventListener('click',openNewAutomation);
$('#refreshHistoryBtn').addEventListener('click',()=>refreshAll().catch(e=>toast(e.message,true)));
$('#registerInvoiceBtn').addEventListener('click',()=>{
  const f=$('#registerForm');f.reset();
  f.automationId.innerHTML=state.automations.map((a)=>`<option value="${a.id}">${esc(a.name)} · ${esc(a.client_name)}</option>`).join('');
  const hoje=new Date();f.competence.value=`${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
  $('#registerDialog').showModal();
});
$('#registerForm').addEventListener('submit',async(e)=>{
  e.preventDefault();const f=e.currentTarget;
  try{
    await api('/api/invoices/registrar',{method:'POST',body:JSON.stringify({automationId:Number(f.automationId.value),competence:f.competence.value.trim(),nfseNumber:f.nfseNumber.value.trim(),accessKey:f.accessKey.value.trim()})});
    $('#registerDialog').close();toast('Nota registrada. Essa competência está protegida contra duplicidade.');await refreshAll();
  }catch(err){toast(err.message,true)}
});

$('#clientForm').addEventListener('submit',async(e)=>{e.preventDefault();const f=e.currentTarget;const payload={name:f.name.value,type:f.type.value,document:f.document.value,email:f.email.value,active:f.active.checked};try{if(f.id.value)await api(`/api/clients/${f.id.value}`,{method:'PUT',body:JSON.stringify(payload)});else await api('/api/clients',{method:'POST',body:JSON.stringify(payload)});$('#clientDialog').close();toast('Cliente salvo.');await refreshAll();}catch(err){toast(err.message,true)}});

$('#automationForm').addEventListener('submit',async(e)=>{e.preventDefault();const f=e.currentTarget;const overrides={};$$('[data-override]',f).forEach((el)=>{if(el.checked)overrides[el.dataset.override]=true});$$('[data-override-number]',f).forEach((el)=>{if(el.value!=='')overrides[el.dataset.overrideNumber]=Number(el.value)});const payload={name:f.name.value,clientId:Number(f.clientId.value),startDate:f.startDate.value,valueCents:cents(f.value.value),discountIncondCents:cents(f.discountIncond.value),discountCondCents:cents(f.discountCond.value),enabled:f.enabled.checked,emailEnabled:f.emailEnabled.checked,serviceDescription:f.serviceDescription.value,municipalitySearch:f.municipalitySearch.value,municipalityName:f.municipalityName.value,taxCodeSearch:f.taxCodeSearch.value,taxCodeName:f.taxCodeName.value,overrides};try{if(f.id.value)await api(`/api/automations/${f.id.value}`,{method:'PUT',body:JSON.stringify(payload)});else await api('/api/automations',{method:'POST',body:JSON.stringify(payload)});$('#automationDialog').close();toast('Automação salva.');await refreshAll();}catch(err){toast(err.message,true)}});

async function saveSettingsFrom(form, message) {
  state.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(collectForm(form)) });
  toast(message);
  await refreshAll();
}
$('#settingsForm').addEventListener('submit',async(e)=>{e.preventDefault();try{await saveSettingsFrom(e.currentTarget,'Configurações salvas.');}catch(err){toast(err.message,true)}});
$('#settingsForm [name="tax.approxMode"]').addEventListener('change',syncApproxFields);
$('#settingsForm [name="portal.fillIbsCbs"]').addEventListener('change',syncIbsCbsFields);
$('#alertsForm').addEventListener('submit',async(e)=>{e.preventDefault();try{await saveSettingsFrom(e.currentTarget,'Alertas salvos.');}catch(err){toast(err.message,true)}});
$('#schedulerForm').addEventListener('submit',async(e)=>{e.preventDefault();try{await saveSettingsFrom(e.currentTarget,'Agendamento salvo.');$('#schedulerDialog').close();}catch(err){toast(err.message,true)}});

// --- automação a partir do XML: valores, descontos, descrição e serviço ---
$('#importAutomationXmlBtn').addEventListener('click',()=>$('#automationXmlInput').click());
$('#automationXmlInput').addEventListener('change',async(event)=>{
  const file=event.target.files?.[0];
  event.target.value='';
  if(!file)return;
  const box=$('#automationImportResult');
  box.className='notice info';
  try{
    const xml=await file.text();
    const r=await api('/api/import-xml',{method:'POST',body:JSON.stringify({xml})});
    const f=$('#automationForm');
    const v=r.values||{}, sug=r.suggestion?.portal||{}, doc=(r.client?.document||'').replace(/\D/g,'');
    const notas=[];

    const cliente=state.clients.find((c)=>c.document===doc);
    if(cliente&&state.clients.some((c)=>c.id===cliente.id&&c.active)){f.clientId.value=String(cliente.id);notas.push(`cliente <strong>${esc(cliente.name)}</strong>`);}
    else if(r.client?.name)notas.push(`<strong>${esc(r.client.name)} ainda não está cadastrado</strong> — cadastre em Clientes (dá para usar o mesmo XML) antes de salvar`);

    if(v.valueCents){f.value.value=(v.valueCents/100).toFixed(2);notas.push(`valor ${money(v.valueCents)}`);}
    f.discountIncond.value=((v.discountIncondCents||0)/100).toFixed(2);
    f.discountCond.value=((v.discountCondCents||0)/100).toFixed(2);
    if(v.discountIncondCents)notas.push(`desc. incondicional ${money(v.discountIncondCents)}`);
    if(v.discountCondCents)notas.push(`desc. condicionado ${money(v.discountCondCents)}`);

    const dia=String(r.source?.issuedAt||'').match(/^\d{4}-\d{2}-(\d{2})/)?.[1];
    if(dia){f.startDate.value=proximaData(Number(dia));notas.push(`primeira emissão em ${f.startDate.value.split('-').reverse().join('/')} (dia da nota)`);}
    if(sug.serviceDescription){f.serviceDescription.value=sug.serviceDescription;notas.push('descrição do serviço');}
    if(!f.name.value&&r.client?.name)f.name.value=r.client.name;

    // Município/código só viram exceção da automação quando diferem do padrão geral.
    const padrao=state.settings?.portal||{};
    if(sug.municipalityName&&sug.municipalityName!==padrao.municipalityName){f.municipalityName.value=sug.municipalityName;notas.push('município diferente do padrão');}
    if(sug.taxCodeName&&sug.taxCodeName!==padrao.taxCodeName){f.taxCodeName.value=sug.taxCodeName;notas.push('código de tributação diferente do padrão');}

    box.hidden=false;
    box.innerHTML=`Lido de <strong>${esc(file.name)}</strong>${r.source?.nfseNumber?` · NFS-e ${esc(r.source.nfseNumber)}`:''}: ${notas.join(', ')}.<br>Ajuste o que for recorrente e salve.`;
    toast('Automação preenchida pelo XML. Confira e salve.');
  }catch(err){
    box.hidden=false; box.className='notice warning'; box.textContent=err.message; toast(err.message,true);
  }
});

// --- cliente a partir do XML: usa o tomador da nota ---
$('#importClientXmlBtn').addEventListener('click',()=>$('#clientXmlInput').click());
$('#clientXmlInput').addEventListener('change',async(event)=>{
  const file=event.target.files?.[0];
  event.target.value='';
  if(!file)return;
  const box=$('#clientImportResult');
  box.className='notice info';
  try{
    const xml=await file.text();
    const r=await api('/api/import-xml',{method:'POST',body:JSON.stringify({xml})});
    const c=r.client||{};
    if(!c.name && !c.document) throw new Error('Esse XML não traz os dados do tomador.');
    const f=$('#clientForm');
    if(c.name)f.name.value=c.name;
    if(c.document){f.document.value=c.document;f.type.value=c.document.replace(/\D/g,'').length===11?'PF':'PJ';}
    if(c.email)f.email.value=c.email;
    box.hidden=false;
    box.innerHTML=`Tomador lido de <strong>${esc(file.name)}</strong>${r.source?.nfseNumber?` · NFS-e ${esc(r.source.nfseNumber)}`:''}.${c.email?'':' <strong>O XML não traz e-mail do tomador</strong> — preencha à mão, senão a automação não consegue enviar a nota.'}`;
    toast('Dados do tomador preenchidos. Confira e salve.');
  }catch(err){
    box.hidden=false; box.className='notice warning'; box.textContent=err.message; toast(err.message,true);
  }
});

// --- importar XML da NFS-e ---
$('#importXmlBtn').addEventListener('click',()=>$('#xmlFileInput').click());
$('#xmlFileInput').addEventListener('change',async(event)=>{
  const file=event.target.files?.[0];
  event.target.value='';
  if(!file)return;
  const box=$('#importResult');
  box.className='notice info';
  try{
    const xml=await file.text();
    const r=await api('/api/import-xml',{method:'POST',body:JSON.stringify({xml})});
    const applied=applySuggestion(r.suggestion);
    const s=r.source||{};
    const v=r.values||{};
    box.hidden=false;
    box.innerHTML=`<strong>${esc(file.name)}</strong> — ${esc(s.kind||'XML')}${s.nfseNumber?` nº ${esc(s.nfseNumber)}`:''}${s.competence?` · competência ${esc(s.competence)}`:''}${r.client?.name?` · tomador ${esc(r.client.name)}`:''}${v.valueCents?` · ${money(v.valueCents)}`:''}.
      <br><strong>Preenchidos:</strong> ${applied.length?esc(applied.join(', ')):'nenhum campo'}.
      ${(r.warnings||[]).length?`<br><strong>Confira à mão:</strong> ${esc(r.warnings.join(' '))}`:''}
      <br>Nada foi salvo ainda — revise e clique em <strong>Salvar configurações</strong>.`;
    toast(applied.length?`${applied.length} campo(s) preenchido(s) pelo XML. Confira e salve.`:'O XML não trouxe campos aproveitáveis.',!applied.length);
  }catch(err){
    box.hidden=false; box.className='notice warning'; box.textContent=err.message; toast(err.message,true);
  }
});

// --- testes e sessão ---
$('#testLoginBtn').addEventListener('click',async(e)=>{try{toast('Testando login no portal...',false,true);await comCarregando(e.currentTarget,'Testando...',()=>api('/api/test-login',{method:'POST',body:'{}'}));toast('Login no Emissor Nacional OK.');}catch(err){toast(err.message,true)}});
async function verifyMail(botao){try{toast('Testando provedor de e-mail...',false,true);const r=await comCarregando(botao,'Testando...',()=>api('/api/test-email',{method:'POST',body:'{}'}));toast(r.provider==='brevo'?`Brevo autenticado${r.account?` (${r.account})`:''}.`:'SMTP autenticado com sucesso.');}catch(e){toast(e.message,true)}}
$('#testMailBtn').addEventListener('click',(e)=>verifyMail(e.currentTarget));
$('#verifyMailBtn').addEventListener('click',(e)=>verifyMail(e.currentTarget));
$('#sendTestMailBtn').addEventListener('click',async(e)=>{const to=$('#testEmailTo').value.trim();if(!to){toast('Informe o e-mail de destino do teste.',true);return;}try{toast('Enviando e-mail de teste...',false,true);const r=await comCarregando(e.currentTarget,'Enviando...',()=>api('/api/send-test-email',{method:'POST',body:JSON.stringify({to})}));toast(`E-mail de teste enviado para ${r.recipients.join(', ')}.`);}catch(err){toast(err.message,true)}});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST',body:'{}'});}catch{}location.href='/login';});
$('#runDueBtn').addEventListener('click',async(e)=>{
  const botao=e.currentTarget;
  const vaiEmitir=state.settings.scheduler.emissionEnabled;
  const ok=await confirmar({
    title:vaiEmitir?'Processar pendências e emitir':'Processar pendências',
    message:vaiEmitir
      ? 'A emissão real está permitida: as notas vencidas serão emitidas agora no Emissor Nacional, uma por vez.'
      : 'As competências vencidas serão registradas como pendentes. Nada será emitido, porque a emissão real está bloqueada.',
    detail:vaiEmitir?'Cada nota abre o navegador no portal; pode levar alguns minutos.':'',
    confirmLabel:vaiEmitir?'Processar e emitir':'Processar',
    danger:vaiEmitir
  });
  if(!ok)return;
  try{
    toast('Processando as pendências... isso pode levar alguns minutos.',false,true);
    const r=await comCarregando(botao,'Processando...',()=>api('/api/run-now',{method:'POST',body:'{}'}));
    toast(r.allowEmission?`Pendências processadas: ${r.issued||0} emitida(s), ${r.pending||0} na fila.`:'Pendências registradas; emissão real está bloqueada.');
    await refreshAll();
  }catch(e){toast(e.message,true);showErrorEvidence(e.message);}
});

refreshAll().catch((e)=>toast(e.message,true));
