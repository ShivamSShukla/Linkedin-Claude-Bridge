// Ghost Engine — Popup Controller v3
const $ = id => document.getElementById(id);
const msg = (data) => new Promise(r => chrome.runtime.sendMessage(data, res => r(chrome.runtime.lastError ? null : res)));
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let _headlines = [];
let _currentDraft = null;
let _settings = {};

// ============================================================
// BOOT
// ============================================================
async function init() {
  setupTabs();
  setupToggles();
  await loadSettings();
  await refreshAll();
  setupListeners();
  setupMessageBridge();
}

// ============================================================
// TABS
// ============================================================
function setupTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('on'));
      t.classList.add('on');
      $(t.dataset.tab).classList.add('on');
      if (t.dataset.tab === 'queue') renderQueue();
    });
  });
}

// ============================================================
// REFRESH ALL (command center)
// ============================================================
async function refreshAll() {
  await Promise.all([refreshStats(), refreshModeStatus(), refreshScheduled()]);
}

async function refreshStats() {
  const stats = await msg({ type: 'GET_STATS' });
  if (!stats) return;

  $('sComments').textContent = stats.commentsSent || 0;
  $('sPosts').textContent = stats.postsPublished || 0;
  $('sSkipped').textContent = stats.aiPostsSkipped || 0;

  updateCircuitUI(stats.circuit);
}

async function refreshModeStatus() {
  const [status, settings] = await Promise.all([
    msg({ type: 'GET_MODE_STATUS' }),
    chrome.storage.local.get(['activePersona', 'installationId', 'killSwitchActive', 'killSwitchMessage'])
  ]);

  // Engine state dot
  const dot = $('eDot'), stateEl = $('eState');
  if (status) {
    if (status.mode === 'API') { dot.className = 'pulse-dot on'; stateEl.textContent = 'ACTIVE'; }
    else if (status.mode === 'TAB_BRIDGE') { dot.className = 'pulse-dot warn'; stateEl.textContent = 'BRIDGE'; }
    else { dot.className = 'pulse-dot warn'; stateEl.textContent = 'TEMPLATE'; }

    const modeColors = { API: 'vg', TAB_BRIDGE: 'vw', TEMPLATE: 'vd' };
    $('st-mode').innerHTML = `<span class="${modeColors[status.mode] || 'vx'}">${status.icon} ${status.label}</span>`;
  }

  // Kill switch
  if (settings.killSwitchActive) {
    $('killAlert').classList.add('on');
    $('killMsg').textContent = settings.killSwitchMessage || 'Extension paused remotely.';
    $('eDot').className = 'pulse-dot off';
    $('eState').textContent = 'KILLED';
  }

  // Persona variant
  if (settings.activePersona && settings.installationId) {
    const variantId = settings.installationId.slice(0, 8).toUpperCase();
    const personaNames = {
      rahul_pune: 'RAHUL-PUNE',
      priya_bangalore: 'PRIYA-BLR',
      arjun_mumbai: 'ARJUN-MUM'
    };
    const name = personaNames[settings.activePersona] || settings.activePersona.toUpperCase();
    $('st-persona').innerHTML = `<span class="vp">🧬 ${name}-${variantId.slice(0,4)}</span>`;
    $('st-engine').innerHTML = settings.killSwitchActive
      ? `<span class="vd">🔴 KILLED</span>`
      : `<span class="vg">🟢 ACTIVE (STEALTH)</span>`;
  }
}

async function refreshScheduled() {
  const res = await msg({ type: 'GET_SCHEDULED_POSTS' });
  const posts = res?.posts || [];
  const nextPending = posts.filter(p => p.status === 'SCHEDULED').sort((a,b) => a.scheduledFor - b.scheduledFor)[0];

  if (nextPending) {
    const t = new Date(nextPending.scheduledFor).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
    });
    $('st-nextpost').innerHTML = `<span class="vb">⏳ QUEUED (${t})</span>`;
  } else {
    $('st-nextpost').innerHTML = `<span class="vx">None scheduled</span>`;
  }
}

// ============================================================
// CIRCUIT UI
// ============================================================
function updateCircuitUI(circuit) {
  if (!circuit) return;
  const alertEl = $('circuitAlert');

  if (circuit.state === 'OPEN') {
    alertEl.classList.add('on');
    $('eDot').className = 'pulse-dot off';
    $('eState').textContent = `PAUSED ${circuit.hoursRemaining}H`;
    $('st-engine').innerHTML = `<span class="vd">🔴 CIRCUIT OPEN (${circuit.hoursRemaining}h)</span>`;

    const ul = $('pivotList');
    ul.innerHTML = '';
    (circuit.pivotActions || []).forEach(a => {
      const div = document.createElement('div');
      div.className = 'pivot-item';
      div.innerHTML = `<a href="${esc(a.url)}" target="_blank" style="text-decoration:none;color:inherit">
        <div class="pivot-label">${esc(a.label)}</div>
        <div class="pivot-why">${esc(a.description)}</div>
        <div class="pivot-why" style="color:var(--b);margin-top:3px">↳ ${esc(a.why)}</div>
      </a>`;
      div.addEventListener('click', () => div.classList.toggle('done'));
      ul.appendChild(div);
    });
  } else {
    alertEl.classList.remove('on');
  }
}

// ============================================================
// POST GENERATOR
// ============================================================
async function setupPostGenerator() {
  $('fetchHlBtn').addEventListener('click', async () => {
    $('fetchHlBtn').textContent = '...';
    $('fetchHlBtn').disabled = true;

    // We ask background to generate news context — it returns headlines
    const settings = await chrome.storage.local.get('activePersona');
    const res = await msg({ type: 'GENERATE_POST', personaId: settings.activePersona || 'rahul_pune', options: { headlinesOnly: true } });

    if (res?.ok && res.postData?.headlines) {
      _headlines = res.postData.headlines;
      renderHeadlines(_headlines);
      $('genDraftBtn').disabled = false;
      _currentDraft = res.postData; // Store full draft too if returned
      if (res.postData.postText) showDraft(res.postData);
    } else {
      // Fallback: show static headlines
      _headlines = [
        { title: 'Sensex crashes 900pts — West Asia conflict escalates', source: 'ET', category: 'business' },
        { title: 'LPG supply disruptions hit Pune, Noida kitchens', source: 'BS', category: 'business' },
        { title: 'India clinches Hockey World Cup berth with 3-1 win', source: 'TOI', category: 'sports' }
      ];
      renderHeadlines(_headlines);
      $('genDraftBtn').disabled = false;
    }

    $('fetchHlBtn').textContent = '↓ Fetch Headlines';
    $('fetchHlBtn').disabled = false;
  });

  $('genDraftBtn').addEventListener('click', async () => {
    $('genDraftBtn').textContent = '✦ Drafting...';
    $('genDraftBtn').disabled = true;

    const settings = await chrome.storage.local.get('activePersona');
    const tone = $('toneSelect').value;
    const res = await msg({
      type: 'GENERATE_POST',
      personaId: settings.activePersona || 'rahul_pune',
      options: { tone }
    });

    if (res?.ok && res.postData?.postText) {
      _currentDraft = res.postData;
      showDraft(res.postData);
    } else {
      toast('Draft generation failed — check API key');
    }

    $('genDraftBtn').textContent = '✦ Generate Draft';
    $('genDraftBtn').disabled = false;
  });

  $('regenBtn').addEventListener('click', async () => {
    $('regenBtn').textContent = '...';
    const settings = await chrome.storage.local.get('activePersona');
    const tone = $('toneSelect').value;
    const res = await msg({
      type: 'GENERATE_POST',
      personaId: settings.activePersona || 'rahul_pune',
      options: { tone }
    });
    if (res?.ok && res.postData) {
      _currentDraft = res.postData;
      showDraft(res.postData);
    }
    $('regenBtn').textContent = '↺ Regen';
  });

  $('scheduleBtn').addEventListener('click', async () => {
    if (!_currentDraft) return;
    const editedText = $('postDraftText').innerText.trim();
    _currentDraft.postText = editedText;

    const settings = await chrome.storage.local.get('activePersona');
    $('scheduleBtn').textContent = '⏳ Scheduling...';
    $('scheduleBtn').disabled = true;

    const res = await msg({
      type: 'SCHEDULE_POST',
      postData: _currentDraft,
      personaId: settings.activePersona || 'rahul_pune'
    });

    if (res?.ok) {
      $('schedBar').style.display = 'flex';
      $('schedTimeDisplay').textContent = res.scheduled.scheduledForDisplay;
      $('schedWaitDisplay').textContent = 'Session warm during wait';
      $('st-nextpost').innerHTML = `<span class="vb">⏳ QUEUED (${res.scheduled.scheduledForDisplay})</span>`;
      toast(`✓ Post scheduled for ${res.scheduled.scheduledForDisplay}`);
      await refreshScheduled();
    } else {
      toast('Schedule failed: ' + (res?.error || 'unknown'));
    }

    $('scheduleBtn').textContent = '⏳ Schedule';
    $('scheduleBtn').disabled = false;
  });

  $('discardBtn').addEventListener('click', () => {
    $('draftSection').style.display = 'none';
    $('schedBar').style.display = 'none';
    _currentDraft = null;
    toast('Draft discarded');
  });

  $('toneSelect').addEventListener('change', () => {
    if (_currentDraft) toast('Re-generate to apply new tone');
  });
}

function renderHeadlines(headlines) {
  const box = $('hlBox');
  if (!headlines?.length) {
    box.innerHTML = '<div style="color:var(--tx3);font-size:11px;text-align:center;padding:12px 0">No headlines loaded</div>';
    return;
  }
  box.innerHTML = headlines.map(h => `
    <div class="hl-item">
      <span class="hl-src">${esc(h.source || '—')}</span>
      <span class="hl-title">${esc(h.title)}</span>
    </div>
  `).join('');
}

function showDraft(postData) {
  $('draftSection').style.display = 'block';
  $('postDraftText').innerText = postData.postText;
  $('schedBar').style.display = 'none';
  $('postDraftText').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================
// QUEUE
// ============================================================
async function renderQueue() {
  const res = await msg({ type: 'GET_QUEUE' });
  const items = (res?.items || []).sort((a, b) => b.createdAt - a.createdAt);
  const list = $('qList');
  $('qCount').textContent = items.length;

  if (!items.length) {
    list.innerHTML = `<div class="empty"><div class="empty-ico">📭</div><p>Queue is empty.<br>Run a Ghost Scan to start.</p></div>`;
    return;
  }

  list.innerHTML = '';
  items.forEach(item => list.appendChild(buildCard(item)));
}

function buildCard(item) {
  const wrap = document.createElement('div');
  wrap.className = 'q-item';
  wrap.dataset.id = item.id;

  const isOrig = item.postData?.isOriginalPost;
  const sentiment = item.classification?.sentiment;
  const aiScore = item.aiScore;
  const modeTag = item.generationMode && item.generationMode !== 'API'
    ? `<span style="font-family:var(--mono);font-size:9px;color:var(--w);background:rgba(255,139,61,.1);padding:2px 6px;border-radius:4px">${item.isTemplate ? '📄 TPL' : '🌉 BRG'}</span>`
    : '';

  const sentimentTag = sentiment
    ? `<span style="font-family:var(--mono);font-size:9px;color:var(--tx3);background:var(--s2);padding:2px 6px;border-radius:4px">${sentiment}</span>`
    : '';

  const aiTag = aiScore?.score > 30
    ? `<span style="font-family:var(--mono);font-size:9px;color:${aiScore.isLikelyAI ? 'var(--w)' : 'var(--tx3)'};background:var(--s2);padding:2px 6px;border-radius:4px">🤖 ${aiScore.score}</span>`
    : '';

  const hasDraft = item.draftedReply || item.postText;
  const draftText = item.draftedReply || item.postText || '';
  const isReview = item.status === 'REVIEW';
  const isScheduled = item.status === 'SCHEDULED';
  const schedTime = item.scheduledForDisplay ? `<div style="font-family:var(--mono);font-size:10px;color:var(--b);margin-bottom:7px">⏳ ${item.scheduledForDisplay}</div>` : '';

  wrap.innerHTML = `
    <div class="q-meta">
      <span class="chip chip-${item.status}">${item.status}</span>
      ${isOrig ? '<span class="chip-orig">ORIG POST</span>' : ''}
      ${sentimentTag}${modeTag}${aiTag}
    </div>
    ${schedTime}
    <div class="q-preview">${esc(item.postData?.text || item.postText || '')}</div>
    ${hasDraft && !isOrig ? `
      <div class="q-draft" id="draft-${item.id}">${esc(draftText)}</div>
      <textarea class="q-edit" id="edit-${item.id}">${esc(draftText)}</textarea>
    ` : ''}
    ${item.status === 'SKIPPED_AI' ? `<div style="font-size:10px;color:var(--tx3);font-style:italic">Skipped: ${esc(aiScore?.signals?.join(', ') || 'AI detected')}</div>` : ''}
    ${isReview ? `
      <div class="q-actions">
        <button class="btn-s bg" data-act="post" data-id="${item.id}">✓ Post Now</button>
        <button class="btn-s bb" data-act="edit" data-id="${item.id}">✎ Edit</button>
        <button class="btn-s bd2" data-act="del" data-id="${item.id}">✕</button>
      </div>
    ` : ''}
    ${isScheduled ? `
      <div class="q-actions">
        <button class="btn-s bd2" data-act="del" data-id="${item.id}">✕ Cancel</button>
      </div>
    ` : ''}
  `;

  wrap.querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => handleQueueAction(btn.dataset.act, item.id, wrap));
  });

  return wrap;
}

async function handleQueueAction(action, id, card) {
  if (action === 'post') {
    const btn = card.querySelector('[data-act="post"]');
    btn.textContent = '...'; btn.disabled = true;
    const res = await msg({ type: 'APPROVE_AND_POST_COMMENT', id });
    if (res?.success) {
      card.querySelector('.q-meta .chip').className = 'chip chip-SENT';
      card.querySelector('.q-meta .chip').textContent = 'SENT';
      card.querySelector('.q-actions')?.remove();
      toast('✓ Comment posted');
      refreshStats();
    } else {
      toast('Post failed: ' + (res?.error || 'unknown'));
      btn.textContent = '✓ Post Now'; btn.disabled = false;
    }
  }

  if (action === 'edit') {
    const draft = $(`draft-${id}`), edit = $(`edit-${id}`), btn = card.querySelector('[data-act="edit"]');
    if (edit.style.display === 'block') {
      await msg({ type: 'EDIT_DRAFT', id, newDraft: edit.value });
      draft.textContent = edit.value;
      draft.style.display = 'block'; edit.style.display = 'none';
      btn.textContent = '✎ Edit';
      toast('Draft saved');
    } else {
      draft.style.display = 'none'; edit.style.display = 'block';
      edit.focus(); btn.textContent = '✓ Save';
    }
  }

  if (action === 'del') {
    await msg({ type: 'REJECT_ITEM', id });
    card.style.opacity = '0'; card.style.transform = 'translateX(-8px)';
    setTimeout(() => { card.remove(); const l = $('qList'); if (!l.children.length) renderQueue(); }, 300);
    toast('Removed');
    refreshStats();
  }
}

// ============================================================
// SETTINGS
// ============================================================
async function loadSettings() {
  _settings = await chrome.storage.local.get([
    'activePersona', 'autoSend', 'aiDetect', 'liveContext', 'schedEnabled', 'installationId'
  ]);

  if (_settings.activePersona) $('personaSelect').value = _settings.activePersona;
  setTgl('tAutoSend', _settings.autoSend === true);
  setTgl('tAiDetect', _settings.aiDetect !== false);
  setTgl('tLiveCtx', _settings.liveContext !== false);
  setTgl('tSched', _settings.schedEnabled !== false);

  updateVariantDisplay(_settings.activePersona, _settings.installationId);
  $('st-config').innerHTML = `<span class="vg">✅ SYNCED</span>`;
}

function setTgl(id, on) {
  const t = $(id);
  if (!t) return;
  t.dataset.on = on.toString();
  t.classList.toggle('on', on);
}

function setupToggles() {
  document.querySelectorAll('.tgl').forEach(t => {
    t.addEventListener('click', () => {
      const on = t.dataset.on !== 'true';
      t.dataset.on = on.toString();
      t.classList.toggle('on', on);
    });
  });
}

function updateVariantDisplay(personaId, installationId) {
  if (!personaId || !installationId) return;
  const vid = installationId.slice(0, 8).toUpperCase();
  const names = { rahul_pune: 'RAHUL-PUNE', priya_bangalore: 'PRIYA-BLR', arjun_mumbai: 'ARJUN-MUM' };
  const name = names[personaId] || personaId.toUpperCase();
  $('variantDisplay').textContent = `🧬 ${name}-${vid.slice(0,4)} · Seeded variant active · Stable across sessions`;
}

// ============================================================
// SCAN + PROCESS BUTTONS
// ============================================================
function setupListeners() {
  $('scanBtn').addEventListener('click', async () => {
    const btn = $('scanBtn');
    btn.disabled = true; btn.textContent = '⟳  Scanning...';
    $('eDot').className = 'pulse-dot warn';
    $('eState').textContent = 'SCANNING';

    const settings = await chrome.storage.local.get('activePersona');
    await msg({ type: 'START_SCAN', personaId: settings.activePersona || 'rahul_pune' });

    setTimeout(async () => {
      btn.disabled = false; btn.textContent = '⟳ \u00A0Run Ghost Scan';
      await refreshAll();
      toast('👻 Ghost scan complete');
    }, 2500);
  });

  $('forceBtn').addEventListener('click', async () => {
    await msg({ type: 'FORCE_PROCESS' });
    toast('▶ Queue processing started');
    setTimeout(refreshAll, 1500);
  });

  $('genPostBtn').addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('on'));
    document.querySelector('[data-tab="post"]').classList.add('on');
    $('post').classList.add('on');
  });

  $('pivotDoneBtn').addEventListener('click', async () => {
    await msg({ type: 'MARK_PIVOT_DONE' });
    $('circuitAlert').classList.remove('on');
    $('eDot').className = 'pulse-dot warn';
    $('eState').textContent = 'PROBING';
    toast('✓ Pivot logged. Engine probing LinkedIn...');
  });

  $('saveBtn').addEventListener('click', async () => {
    const apiKey = $('apiKeyInput').value.trim();
    if (apiKey) {
      await msg({ type: 'SAVE_API_KEY', apiKey });
      $('apiKeyInput').value = '';
    }
    const persona = $('personaSelect').value;
    await chrome.storage.local.set({
      activePersona: persona,
      autoSend: $('tAutoSend').dataset.on === 'true',
      aiDetect: $('tAiDetect').dataset.on === 'true',
      liveContext: $('tLiveCtx').dataset.on === 'true',
      schedEnabled: $('tSched').dataset.on === 'true'
    });

    const { installationId } = await chrome.storage.local.get('installationId');
    updateVariantDisplay(persona, installationId);
    toast('✓ Settings saved');
  });

  $('personaSelect').addEventListener('change', async () => {
    const { installationId } = await chrome.storage.local.get('installationId');
    updateVariantDisplay($('personaSelect').value, installationId);
  });

  $('configCheckBtn').addEventListener('click', async () => {
    $('configCheckBtn').textContent = '...';
    const health = await msg({ type: 'CONFIG_HEALTH_CHECK' });
    const ver = health?.version || '—';
    $('configVerBadge').textContent = ver;
    $('st-config').innerHTML = health?.healthy
      ? `<span class="vg">✅ SYNCED (${ver})</span>`
      : `<span class="vw">⚠ ${health?.failedSelectors?.join(', ')}</span>`;
    toast(health?.healthy ? `✓ Selectors OK (${ver})` : `⚠ Broken selectors detected`);
    $('configCheckBtn').textContent = '↺ Check Selectors';
  });

  setupPostGenerator();
}

// ============================================================
// BACKGROUND MESSAGE BRIDGE
// ============================================================
function setupMessageBridge() {
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === 'QUEUE_UPDATED' || m.type === 'ITEM_DRAFTED') refreshAll();
    if (m.type === 'CIRCUIT_STATUS' || m.type === 'CIRCUIT_OPEN') updateCircuitUI(m.data);
    if (m.type === 'MODE_CHANGED') { refreshModeStatus(); toast(`Mode: ${m.mode}${m.reason ? ' — '+m.reason.replace(/_/g,' ') : ''}`); }
    if (m.type === 'KILL_SWITCH') { refreshModeStatus(); toast('☠️ Kill switch activated', 5000); }
  });
}

// ============================================================
// TOAST
// ============================================================
let _toastTimer;
function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

init();
