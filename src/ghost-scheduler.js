// ============================================================
// GhostScheduler — Post at human times, not bot times.
// Optimal windows + jitter so 500 installs don't spike
// LinkedIn's anomaly detection at :00 simultaneously.
// Keeps session warm during wait with passive ghost scrolls.
// ============================================================

import { db } from './db.js';
import { calculatePostTime } from './content-gen.js';

const SCHEDULE_STORE_KEY = 'scheduledPosts';

// ---- Schedule a generated post ----
export async function schedulePost(postData, personaId) {
  const timing = calculatePostTime();

  const scheduled = {
    id: `sched_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    personaId,
    postText: postData.postText,
    headlines: postData.headlines,
    tone: postData.tone,
    scheduledFor: timing.scheduledFor,
    scheduledForDisplay: timing.scheduledForDisplay,
    status: 'SCHEDULED', // SCHEDULED → WARMING → POSTING → POSTED | FAILED
    createdAt: Date.now()
  };

  // Persist to IndexedDB
  await db.tx('queue', 'readwrite', s => s.put({
    ...scheduled,
    postData: { text: postData.postText, isOriginalPost: true }
  }));

  // Set a chrome alarm for the exact fire time
  const alarmName = `post_${scheduled.id}`;
  const delayMinutes = Math.max(1, Math.ceil(timing.waitMs / 60000));

  chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes });

  console.log(`[Scheduler] Post scheduled for ${timing.scheduledForDisplay} (${delayMinutes}min from now)`);

  return scheduled;
}

// ---- Called when alarm fires ----
export async function handleScheduledPost(alarmName) {
  if (!alarmName.startsWith('post_')) return false;

  const schedId = alarmName.replace('post_', '');

  // Find the scheduled item
  const all = await db.getAll();
  const item = all.find(i => i.id === schedId);

  if (!item) {
    console.warn('[Scheduler] Alarm fired but item not found:', schedId);
    return false;
  }

  if (item.status !== 'SCHEDULED') {
    console.log('[Scheduler] Item already processed:', item.status);
    return false;
  }

  await db.updateStatus(item.id, 'WARMING');

  // Phase 1: Warm the session (ghost scroll for 2-3 min before posting)
  const warmResult = await warmSession();
  if (!warmResult) {
    console.warn('[Scheduler] Could not warm session — no LinkedIn tab');
    // Don't abort — try posting anyway, just flag it
  }

  // Phase 2: Additional human delay (30s–90s after warming)
  const humanDelay = 30000 + Math.random() * 60000;
  await sleep(humanDelay);

  await db.updateStatus(item.id, 'POSTING');

  // Phase 3: Inject and post
  const result = await executePost(item);

  if (result.success) {
    await db.updateStatus(item.id, 'POSTED');
    await db.incrementStat('postsPublished');
    chrome.notifications.create(`post_done_${schedId}`, {
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: '✅ Ghost Engine — Post Published',
      message: `Your scheduled post is live. Session warm, timing clean.`
    });
  } else {
    await db.updateStatus(item.id, 'FAILED', { error: result.error });
    chrome.notifications.create(`post_fail_${schedId}`, {
      type: 'basic',
      iconUrl: '../icons/icon48.png',
      title: '⚠️ Ghost Engine — Post Failed',
      message: result.error || 'Unknown error. Check queue.'
    });
  }

  return true;
}

// ---- Warm the session with passive ghost scroll ----
async function warmSession() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) return false;

  try {
    await chrome.tabs.sendMessage(tabs[0].id, {
      type: 'GHOST_SCROLL_START',
      count: 5 // Light scroll — just enough to generate telemetry
    });
    // Wait 90s for ghost scroll to complete
    await sleep(90000);
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Execute the actual post injection ----
async function executePost(item) {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' });

  let tab;
  if (tabs.length === 0) {
    // Open LinkedIn feed
    tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false });
    await sleep(4000); // Wait for page load
  } else {
    tab = tabs[0];
  }

  try {
    // Ensure human-injector is loaded
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/human-injector.js']
    });

    await sleep(1000);

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'INJECT_POST',
      text: item.postText,
      options: {
        typingProfile: 'normal',
        dryRun: false
      }
    });

    return result || { success: false, error: 'No response from injector' };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---- Execute a comment injection ----
export async function executeComment(item, selectors) {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) return { success: false, error: 'No LinkedIn tab' };

  const tab = tabs[0];

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['src/human-injector.js']
    });

    await sleep(800);

    return await chrome.tabs.sendMessage(tab.id, {
      type: 'INJECT_COMMENT',
      text: item.draftedReply,
      postUrn: item.postData?.urn,
      selectors
    });

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ---- Get all scheduled posts status ----
export async function getScheduledPosts() {
  const all = await db.getAll();
  return all.filter(i => i.postData?.isOriginalPost);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
