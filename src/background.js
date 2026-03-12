// ============================================================
// Background Service Worker — MV3 Orchestrator
// Uses chrome.alarms (ONLY MV3-compliant scheduler).
// Wakes up, reads IndexedDB, executes, dies. Stateless by design.
// ============================================================

import { db } from './db.js';
import { breaker } from './circuit-breaker.js';
import { buildLiveContext, scoreAILikelihood } from './context-engine.js';
import { buildPersonaPrompt, getPersonaById } from './personas.js';
import { classifyPost, generateComment } from './claude-client.js';
import { getOrCreateVariant, buildVariantSystemPrompt, getRelevantCurrentEvent } from './persona-dna.js';
import { getConfig, runConfigHealthCheck } from './remote-config.js';
import { generateWithDegradation, getModeStatus, detectAvailableMode } from './degradation-engine.js';
import { generateNewsPost, calculatePostTime } from './content-gen.js';
import { schedulePost, handleScheduledPost, executeComment, getScheduledPosts } from './ghost-scheduler.js';

// ---- Alarm Setup ----
chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('queueProcessor', { periodInMinutes: 5 });
  chrome.alarms.create('contextRefresh', { periodInMinutes: 180 });
  chrome.alarms.create('configRefresh', { periodInMinutes: 30 });
  console.log('[Ghost Engine] Installed. Alarms set.');

  // Run startup checks
  const health = await runConfigHealthCheck();
  console.log('[Ghost Engine] Config health:', health);

  const mode = await detectAvailableMode();
  console.log('[Ghost Engine] Starting in mode:', mode);
});

// ---- Alarm Handler (re-hydrates from IndexedDB on every wake) ----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'queueProcessor') await processQueue();
  if (alarm.name === 'contextRefresh') await refreshContext();
  if (alarm.name === 'configRefresh') {
    const health = await runConfigHealthCheck();
    broadcastToPopup({ type: 'CONFIG_HEALTH', data: health });
  }
  // Scheduled post alarms
  if (alarm.name.startsWith('post_')) {
    const fired = await handleScheduledPost(alarm.name);
    if (fired) broadcastToPopup({ type: 'QUEUE_UPDATED' });
  }
});

// ---- Queue Processor ----
async function processQueue() {
  console.log('[Ghost Engine] Wake. Processing queue...');

  // Check circuit before anything
  const circuitStatus = await breaker.getStatus();
  if (circuitStatus.state === 'OPEN') {
    console.log(`[Ghost Engine] Circuit OPEN. ${circuitStatus.hoursRemaining}h remaining.`);
    broadcastToPopup({ type: 'CIRCUIT_STATUS', data: circuitStatus });
    return;
  }

  const pending = await db.getByStatus('PENDING');
  console.log(`[Ghost Engine] ${pending.length} pending items.`);

  // Get active persona from settings
  const { activePersona = 'rahul_pune', autoSend = false } = 
    await chrome.storage.local.get(['activePersona', 'autoSend']);

  // Get cached context
  const cachedContext = await db.getContext();

  for (const item of pending.slice(0, 3)) { // Max 3 per cycle — stay stealthy
    await processItem(item, activePersona, cachedContext, autoSend);
    
    // Inter-item jitter: 45s–3min between posts
    await sleep(jitter(90000, 75000));
  }

  broadcastToPopup({ type: 'QUEUE_UPDATED' });
}

async function processItem(item, personaId, cachedContext, autoSend) {
  const postText = item.postData.text;
  await db.updateStatus(item.id, 'PROCESSING');

  try {
    // Step 1: Kill switch check
    const { killSwitchActive, killSwitchMessage } = await chrome.storage.local.get(['killSwitchActive', 'killSwitchMessage']);
    if (killSwitchActive) {
      await db.updateStatus(item.id, 'FAILED', { error: 'kill_switch: ' + killSwitchMessage });
      broadcastToPopup({ type: 'KILL_SWITCH', message: killSwitchMessage });
      return;
    }

    // Step 2: AI Detection
    const aiScore = scoreAILikelihood(postText);
    if (aiScore.isLikelyAI) {
      await db.updateStatus(item.id, 'SKIPPED_AI', { aiScore });
      await db.incrementStat('aiPostsSkipped');
      return;
    }

    // Step 3: Sentiment gate
    const classification = await classifyPost(postText);
    if (classification.action === 'HOLD_FOR_REVIEW') {
      await db.updateStatus(item.id, 'REVIEW', { classification, aiScore });
      await db.incrementStat('heldForReview');
      return;
    }

    // Step 4: Build persona variant (unique per install — no community poisoning)
    const variant = await getOrCreateVariant(personaId);
    const basePersona = getPersonaById(personaId);
    const variantSystemPrompt = buildVariantSystemPrompt(variant, basePersona.systemPrompt);

    // Step 5: Build live context + inject current events
    const liveContext = await buildLiveContext(postText, cachedContext);
    const currentEvent = getRelevantCurrentEvent(postText);
    if (currentEvent) {
      liveContext.promptFragment = (liveContext.promptFragment || '') +
        `\nTODAY'S SPECIFIC EVENT (use if genuinely relevant): ${currentEvent.ref}`;
    }
    if (!cachedContext || liveContext.cachedAt > (cachedContext?.cachedAt || 0)) {
      await db.setContext(liveContext);
    }

    // Step 6: Build final prompt with variant system prompt
    const personaPrompt = {
      system: variantSystemPrompt + (liveContext.promptFragment ? '\n\n' + liveContext.promptFragment : ''),
      user: `Write a LinkedIn comment on this post:\n\n"${postText.slice(0, 600)}${postText.length > 600 ? '...' : ''}"\n\nComment:`
    };

    // Step 7: Generate with graceful degradation
    const { result: draftedReply, mode, isTemplate } = await breaker.call(() =>
      generateWithDegradation(postText, personaPrompt, variant, classification)
    );

    if (!draftedReply) {
      await db.updateStatus(item.id, 'FAILED', { error: 'Empty reply' });
      return;
    }

    const newStatus = autoSend ? 'SENDING' : 'REVIEW';
    await db.updateStatus(item.id, newStatus, {
      draftedReply,
      classification,
      aiScore,
      generationMode: mode,
      isTemplate: isTemplate || false,
      variantId: variant.installationId?.slice(0, 8)
    });

    await db.incrementStat('draftsGenerated');
    if (isTemplate) await db.incrementStat('templateFallbacks');

    broadcastToPopup({ type: 'ITEM_DRAFTED', id: item.id, mode });

    if (autoSend && !isTemplate) await sendComment(item); // Never auto-send templates

  } catch (err) {
    console.error(`[Ghost Engine] Item ${item.id} failed:`, err);
    if (err.message === 'CIRCUIT_OPEN') {
      broadcastToPopup({ type: 'CIRCUIT_OPEN', data: err.circuitData });
      return;
    }
    await db.updateStatus(item.id, 'FAILED', { error: err.message });
  }
}

async function sendComment(item) {
  // This would call voyager.postComment() — gated behind user confirmation in non-autoSend mode
  await db.updateStatus(item.id, 'SENT');
  await db.incrementStat('commentsSent');
}

async function refreshContext() {
  const { buildLiveContext } = await import('./context-engine.js');
  try {
    const fresh = await buildLiveContext('general refresh', null);
    await db.setContext(fresh);
    console.log('[Context] Refreshed live context cache.');
  } catch (e) {
    console.error('[Context] Refresh failed:', e);
  }
}

// ---- Message Handler (from popup) ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true; // async
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'GET_QUEUE':
      return { items: await db.getAll() };

    case 'GET_MODE_STATUS':
      return getModeStatus();

    case 'CONFIG_HEALTH_CHECK':
      return runConfigHealthCheck();

    case 'GET_STATS':
      return {
        draftsGenerated: await db.getStat('draftsGenerated'),
        commentsSent: await db.getStat('commentsSent'),
        aiPostsSkipped: await db.getStat('aiPostsSkipped'),
        heldForReview: await db.getStat('heldForReview'),
        postsPublished: await db.getStat('postsPublished'),
        templateFallbacks: await db.getStat('templateFallbacks'),
        circuit: await breaker.getStatus()
      };

    case 'GENERATE_POST':
      try {
        const postData = await generateNewsPost(msg.personaId, msg.options || {});
        return { ok: true, postData };
      } catch (err) {
        return { ok: false, error: err.message };
      }

    case 'SCHEDULE_POST':
      try {
        const scheduled = await schedulePost(msg.postData, msg.personaId);
        return { ok: true, scheduled };
      } catch (err) {
        return { ok: false, error: err.message };
      }

    case 'GET_SCHEDULED_POSTS':
      return { posts: await getScheduledPosts() };

    case 'APPROVE_AND_POST_COMMENT':
      try {
        const config = await getConfig();
        const item = (await db.getAll()).find(i => i.id === msg.id);
        if (!item) return { ok: false, error: 'Item not found' };
        const result = await executeComment(item, config.selectors);
        if (result.success) {
          await db.updateStatus(msg.id, 'SENT');
          await db.incrementStat('commentsSent');
        }
        return result;
      } catch (err) {
        return { ok: false, error: err.message };
      }

    case 'START_SCAN':
      await startScan(msg.personaId);
      return { ok: true };

    case 'APPROVE_ITEM':
      await db.updateStatus(msg.id, 'SENDING');
      await db.incrementStat('commentsSent');
      return { ok: true };

    case 'REJECT_ITEM':
      await db.remove(msg.id);
      return { ok: true };

    case 'EDIT_DRAFT':
      await db.updateStatus(msg.id, 'REVIEW', { draftedReply: msg.newDraft });
      return { ok: true };

    case 'MARK_PIVOT_DONE':
      await breaker.markPivotCompleted();
      return { ok: true };

    case 'SAVE_API_KEY':
      const { storeApiKey } = await import('./claude-client.js');
      await storeApiKey(msg.apiKey);
      return { ok: true };

    case 'FORCE_PROCESS':
      processQueue(); // don't await — fire and forget
      return { ok: true };

    default:
      return { error: 'Unknown message type' };
  }
}

async function startScan(personaId) {
  // Find a LinkedIn tab to inject ghost scroller
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  
  if (tabs.length === 0) {
    // Open LinkedIn if not open
    await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false });
    await sleep(3000);
    const newTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
    if (newTabs.length === 0) return;
    await ghostScrollTab(newTabs[0].id, personaId);
  } else {
    await ghostScrollTab(tabs[0].id, personaId);
  }
}

async function ghostScrollTab(tabId, personaId) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: 'GHOST_SCROLL_START',
    count: 10
  });

  if (response?.posts?.length) {
    const { activePersona } = await chrome.storage.local.get('activePersona');
    for (const post of response.posts) {
      await db.enqueue({ ...post, personaId: personaId || activePersona });
    }
    processQueue();
  }
}

function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // Popup may not be open
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(baseMs, spreadMs) { return baseMs + (Math.random() * spreadMs * 2) - spreadMs; }
