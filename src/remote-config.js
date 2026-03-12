// ============================================================
// RemoteConfig — Hotfix selectors without a Store update.
// LinkedIn changes CSS classes on every deploy. A real product
// can't wait 48hrs for Chrome Web Store review to fix a button.
// Config lives on GitHub Gist. Extension fetches on startup.
// ============================================================

// ---- Config sources (fallback chain) ----
// Primary: GitHub Gist (free, no auth, fast CDN)
// Secondary: jsDelivr CDN mirror of same gist
// Tertiary: hardcoded fallback (last known good)
const CONFIG_SOURCES = [
  'https://gist.githubusercontent.com/ghost-engine-config/raw/linkedin-selectors.json',
  // Replace with your actual Gist raw URL ↑
  // Format: https://gist.githubusercontent.com/{username}/{gist_id}/raw/{filename}
];

const CONFIG_TTL = 30 * 60 * 1000; // 30 min cache — balance freshness vs network calls

// ---- Last Known Good Selectors (hardcoded fallback) ----
// When remote fetch fails, fall back to these.
// These become stale — that's okay, they're the last line of defense.
const FALLBACK_CONFIG = {
  version: 'fallback-2026-03-12',
  selectors: {
    feedPost: [
      '.feed-shared-update-v2',
      '[data-urn*="activity"]',
      '.occludable-update',
      '.feed-shared-update'
    ],
    postText: [
      '.feed-shared-text span[dir="ltr"]',
      '.feed-shared-text .break-words',
      '.update-components-text span',
      '.feed-shared-update-v2__description'
    ],
    authorName: [
      '.feed-shared-actor__name',
      '.update-components-actor__name span',
      '.feed-shared-actor__title'
    ],
    commentBox: [
      '.comments-comment-box__form textarea',
      '.comments-comment-texteditor__content',
      '[contenteditable="true"][role="textbox"]'
    ],
    commentSubmit: [
      'button.comments-comment-box__submit-button',
      'button[type="submit"].comments-comment-box__submit-button--cr'
    ],
    likeButton: [
      'button[aria-label*="React Like"]',
      'button.react-button__trigger',
      'button[data-control-name="like"]'
    ],
    postUrn: {
      attribute: 'data-urn',
      fallbackAttribute: 'data-id'
    }
  },
  // Feature flags — can toggle features remotely without code deploy
  flags: {
    ghostScrollEnabled: true,
    aiDetectionEnabled: true,
    liveContextEnabled: true,
    maxPostsPerCycle: 3,
    minDwellMs: 2000,
    maxDwellMs: 8000
  },
  // Emergency kill switch — if LinkedIn detects mass automation,
  // set this to true to soft-disable all extension activity remotely
  killSwitch: false,
  killSwitchMessage: null
};

// ---- Remote config fetcher ----
async function fetchRemoteConfig() {
  for (const url of CONFIG_SOURCES) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) continue;

      const config = await response.json();

      // Validate minimum required shape
      if (!config.selectors || !config.version) {
        console.warn('[RemoteConfig] Invalid shape from', url);
        continue;
      }

      console.log(`[RemoteConfig] Loaded v${config.version} from remote`);
      return config;

    } catch (e) {
      console.warn('[RemoteConfig] Fetch failed from', url, e.message);
    }
  }

  return null;
}

// ---- Main export: get config (cached → remote → fallback) ----
export async function getConfig(forceRefresh = false) {
  // Check cache
  if (!forceRefresh) {
    try {
      const { remoteConfig, remoteConfigFetchedAt } = await chrome.storage.local.get([
        'remoteConfig', 'remoteConfigFetchedAt'
      ]);

      if (remoteConfig && remoteConfigFetchedAt) {
        const age = Date.now() - remoteConfigFetchedAt;
        if (age < CONFIG_TTL) {
          return mergeWithFallback(remoteConfig);
        }
      }
    } catch (e) {}
  }

  // Fetch remote
  const remote = await fetchRemoteConfig();

  if (remote) {
    await chrome.storage.local.set({
      remoteConfig: remote,
      remoteConfigFetchedAt: Date.now()
    });
    return mergeWithFallback(remote);
  }

  // Fallback
  console.warn('[RemoteConfig] Using hardcoded fallback selectors');
  return FALLBACK_CONFIG;
}

// Merge remote with fallback — remote wins, fallback fills gaps
function mergeWithFallback(remote) {
  return {
    ...FALLBACK_CONFIG,
    ...remote,
    selectors: { ...FALLBACK_CONFIG.selectors, ...(remote.selectors || {}) },
    flags: { ...FALLBACK_CONFIG.flags, ...(remote.flags || {}) }
  };
}

// ---- Selector resolver: tries each selector in priority order ----
export function resolveSelector(config, selectorKey) {
  const candidates = config.selectors[selectorKey];
  if (!candidates) return null;
  if (Array.isArray(candidates)) return candidates;
  return [candidates];
}

export function findElement(config, selectorKey, root = document) {
  const selectors = resolveSelector(config, selectorKey);
  if (!selectors) return null;

  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function findAllElements(config, selectorKey, root = document) {
  const selectors = resolveSelector(config, selectorKey);
  if (!selectors) return [];

  for (const sel of selectors) {
    const els = root.querySelectorAll(sel);
    if (els.length > 0) return Array.from(els);
  }
  return [];
}

// ---- Config health check (run on startup) ----
export async function runConfigHealthCheck() {
  const config = await getConfig(true); // Force refresh on startup

  if (config.killSwitch) {
    console.error('[RemoteConfig] KILL SWITCH ACTIVE:', config.killSwitchMessage);
    await chrome.storage.local.set({ killSwitchActive: true, killSwitchMessage: config.killSwitchMessage });
    return { healthy: false, reason: 'kill_switch', message: config.killSwitchMessage };
  }

  await chrome.storage.local.set({ killSwitchActive: false });

  // Test selectors against a real LinkedIn tab if open
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  if (tabs.length === 0) {
    return { healthy: true, tested: false, version: config.version };
  }

  // Inject a quick selector test
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: (selectors) => {
        const results = {};
        for (const [key, candidates] of Object.entries(selectors)) {
          if (!Array.isArray(candidates)) continue;
          results[key] = candidates.some(sel => document.querySelector(sel) !== null);
        }
        return results;
      },
      args: [config.selectors]
    });

    const health = results[0]?.result || {};
    const failedSelectors = Object.entries(health)
      .filter(([, works]) => !works)
      .map(([key]) => key);

    if (failedSelectors.length > 0) {
      console.warn('[RemoteConfig] Broken selectors detected:', failedSelectors);
    }

    return {
      healthy: failedSelectors.length === 0,
      failedSelectors,
      version: config.version,
      tested: true
    };
  } catch (e) {
    return { healthy: true, tested: false, version: config.version };
  }
}

// ---- Format for GitHub Gist (documentation) ----
export const GIST_TEMPLATE = JSON.stringify({
  version: '2026-03-12-001',
  selectors: {
    feedPost: ['.feed-shared-update-v2', '[data-urn*="activity"]'],
    postText: ['.feed-shared-text span[dir="ltr"]', '.update-components-text span'],
    authorName: ['.feed-shared-actor__name', '.update-components-actor__name span'],
    commentBox: ['.comments-comment-box__form textarea', '[contenteditable="true"][role="textbox"]'],
    commentSubmit: ['button.comments-comment-box__submit-button']
  },
  flags: {
    ghostScrollEnabled: true,
    aiDetectionEnabled: true,
    liveContextEnabled: true,
    maxPostsPerCycle: 3
  },
  killSwitch: false,
  killSwitchMessage: null
}, null, 2);
