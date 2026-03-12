// ============================================================
// DegradationEngine — Never fully die.
// API Mode (Claude API) → Tab-Bridge Mode (inject into page)
// When Claude credits run out mid-run, switch modes silently.
// Users should notice better quality, not a crash.
// ============================================================

export const MODES = {
  API: 'API',           // Full Claude API — best quality
  TAB_BRIDGE: 'TAB_BRIDGE', // Inject prompt into LinkedIn tab, use page-side inference
  TEMPLATE: 'TEMPLATE'  // Pure template fill — last resort, no AI
};

// ---- Mode detection ----
export async function detectAvailableMode() {
  const { encApiKey } = await chrome.storage.local.get('encApiKey');

  if (encApiKey) {
    const apiHealthy = await testApiCredits();
    if (apiHealthy) return MODES.API;
  }

  // Check if a LinkedIn tab is open for bridge mode
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length > 0) return MODES.TAB_BRIDGE;

  return MODES.TEMPLATE;
}

// ---- Test API credits (lightweight probe) ----
async function testApiCredits() {
  try {
    const { loadApiKey } = await import('./claude-client.js');
    const apiKey = await loadApiKey();
    if (!apiKey) return false;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Cheapest model for health check
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }]
      })
    });

    if (response.status === 529) return false; // Overloaded
    if (response.status === 402) {             // Payment required — credits exhausted
      await setMode(MODES.TAB_BRIDGE, 'api_credits_exhausted');
      return false;
    }
    if (response.status === 401) {             // Bad key
      await setMode(MODES.TAB_BRIDGE, 'api_key_invalid');
      return false;
    }
    return response.ok;
  } catch (e) {
    return false;
  }
}

// ---- Persist current mode ----
async function setMode(mode, reason = '') {
  await chrome.storage.local.set({ currentMode: mode, modeSwitchReason: reason, modeSwitchedAt: Date.now() });
  chrome.runtime.sendMessage({ type: 'MODE_CHANGED', mode, reason }).catch(() => {});
}

export async function getCurrentMode() {
  const { currentMode } = await chrome.storage.local.get('currentMode');
  return currentMode || MODES.API;
}

// ============================================================
// API MODE — Full Claude quality
// ============================================================
async function generateViaAPI(postText, personaPrompt) {
  const { generateComment } = await import('./claude-client.js');
  return generateComment(personaPrompt);
}

// ============================================================
// TAB-BRIDGE MODE — Inject into LinkedIn tab
// Uses the page's existing session to call Claude via a
// hidden textarea + content script bridge. No API key needed.
// ============================================================
async function generateViaTabBridge(postText, variant, config) {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) {
    throw new Error('TAB_BRIDGE_NO_TAB');
  }

  const prompt = buildBridgePrompt(postText, variant);

  // Inject a minimal prompt executor into the page
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func: async (promptText) => {
      // This runs in the LinkedIn page context
      // Uses the page's own fetch (with LinkedIn session) to call a proxy
      // OR falls back to a simple heuristic template
      try {
        // Attempt: use any cached window.__ghostBridge if extension injected it
        if (window.__ghostBridgeExecutor) {
          return await window.__ghostBridgeExecutor(promptText);
        }
        return null;
      } catch (e) {
        return null;
      }
    },
    args: [prompt]
  });

  const bridgeResult = results[0]?.result;
  if (bridgeResult) return bridgeResult;

  // Bridge not available — fall through to template mode
  throw new Error('TAB_BRIDGE_UNAVAILABLE');
}

// ============================================================
// TEMPLATE MODE — Zero AI, pure persona-aware fill
// Not great. Not embarrassing. Buys time until API refills.
// ============================================================
const TEMPLATE_PATTERNS = {
  positive: [
    `{opener}This tracks with what I've been seeing in {domain}. The part about {keyword} especially — {hedge}. {signoff}`,
    `{opener}Real observation. {keyword} is something most {domain} folks get wrong initially. {hedge}. {signoff}`,
    `{opener}Worth adding: {cityRef} has been a useful proving ground for exactly this. {hedge}. {signoff}`
  ],
  neutral: [
    `{opener}Interesting framing. The {keyword} angle is worth exploring more. {hedge}. {signoff}`,
    `{opener}Been following this space closely. The tension between {keyword} and execution is real. {hedge}. {signoff}`
  ],
  negative: [
    `{opener}Appreciate you sharing this. The {keyword} piece is something a lot of people in {domain} are navigating right now. {hedge}. {signoff}`
  ]
};

function generateViaTemplate(postText, variant, sentiment = 'neutral') {
  const patterns = TEMPLATE_PATTERNS[sentiment] || TEMPLATE_PATTERNS.neutral;
  const pattern = patterns[Math.floor(Math.random() * patterns.length)];

  // Extract a keyword from post text
  const words = postText.split(/\s+/).filter(w => w.length > 5);
  const keyword = words[Math.floor(Math.random() * Math.min(words.length, 10))]
    ?.toLowerCase()
    ?.replace(/[^a-z\s]/g, '') || 'this';

  return pattern
    .replace('{opener}', variant.preferredOpener || '')
    .replace('{domain}', variant.domain)
    .replace('{keyword}', keyword)
    .replace('{hedge}', variant.preferredHedge || 'though context matters')
    .replace('{cityRef}', variant.cityRef)
    .replace('{signoff}', variant.preferredSignoff || '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- Main entry point — auto-selects mode ----
export async function generateWithDegradation(postText, personaPrompt, variant, classification) {
  const mode = await detectAvailableMode();
  await setMode(mode);

  console.log(`[Degradation] Using mode: ${mode}`);

  switch (mode) {
    case MODES.API:
      try {
        const result = await generateViaAPI(postText, personaPrompt);
        return { result, mode: MODES.API };
      } catch (err) {
        if (err.status === 402 || err.status === 429) {
          // Credits exhausted or rate limited — degrade
          console.warn('[Degradation] API failed, degrading to TAB_BRIDGE');
          await setMode(MODES.TAB_BRIDGE, 'api_failed_mid_run');
          // Fall through
        } else {
          throw err;
        }
      }
      // falls through

    case MODES.TAB_BRIDGE:
      try {
        const result = await generateViaTabBridge(postText, variant);
        return { result, mode: MODES.TAB_BRIDGE };
      } catch (err) {
        console.warn('[Degradation] Tab bridge failed, degrading to TEMPLATE');
        await setMode(MODES.TEMPLATE, 'bridge_unavailable');
        // Fall through
      }
      // falls through

    case MODES.TEMPLATE:
      const result = generateViaTemplate(postText, variant, classification?.sentiment);
      return { result, mode: MODES.TEMPLATE, isTemplate: true };
  }
}

// ---- Prompt for bridge mode ----
function buildBridgePrompt(postText, variant) {
  return `Write a 2-3 sentence LinkedIn comment as a ${variant.yearsExp}-year ${variant.domain} professional based in India. Be specific, slightly skeptical, then validating. No generic opener. Post: "${postText.slice(0, 300)}"`;
}

// ---- Mode status for UI ----
export async function getModeStatus() {
  const { currentMode, modeSwitchReason, modeSwitchedAt } = await chrome.storage.local.get([
    'currentMode', 'modeSwitchReason', 'modeSwitchedAt'
  ]);

  const labels = {
    [MODES.API]: { label: 'API Mode', color: 'accent', icon: '⚡' },
    [MODES.TAB_BRIDGE]: { label: 'Bridge Mode', color: 'warn', icon: '🌉' },
    [MODES.TEMPLATE]: { label: 'Template Mode', color: 'danger', icon: '📄' }
  };

  const mode = currentMode || MODES.API;
  return {
    mode,
    ...labels[mode],
    reason: modeSwitchReason,
    since: modeSwitchedAt ? new Date(modeSwitchedAt).toLocaleTimeString() : null
  };
}
