// ============================================================
// VoyagerClient — LinkedIn's internal API wrapper
// Randomized headers, jitter timing, fingerprint rotation.
// Every request looks like it came from a slightly different
// organic browser session.
// ============================================================

const BASE = 'https://www.linkedin.com';

// Rotate these to avoid static fingerprint detection
const PROTOCOL_VERSIONS = ['2.0.0', '1.0.0'];
const TRACK_IDS = () => ({
  clientVersion: '1.13.5390',
  osName: 'web',
  timezoneOffset: 5.5,
  timezone: 'Asia/Kolkata',
  deviceFormFactor: 'DESKTOP',
  mpName: 'voyager-web',
  displayDensity: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
  displayWidth: [1280, 1366, 1440, 1920][Math.floor(Math.random() * 4)],
  displayHeight: [720, 768, 900, 1080][Math.floor(Math.random() * 4)],
  osVersion: 'undefined',
  clientId: 'voyager-web',
  mpVersion: '1.13.5390'
});

function jitter(baseMs, spreadMs) {
  return baseMs + (Math.random() * spreadMs * 2) - spreadMs;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getCsrfToken() {
  return new Promise(resolve => {
    chrome.cookies.get(
      { url: 'https://www.linkedin.com', name: 'JSESSIONID' },
      cookie => resolve(cookie?.value?.replace(/"/g, '') || '')
    );
  });
}

export async function voyagerFetch(path, options = {}) {
  // Human-like pre-request pause: 400ms–2.2s
  await sleep(jitter(1300, 900));

  const csrf = await getCsrfToken();
  const track = TRACK_IDS();

  const headers = {
    'Accept': 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
    'Content-Type': 'application/json',
    'csrf-token': csrf,
    'x-li-lang': 'en_US',
    'x-li-track': JSON.stringify(track),
    'x-li-page-instance': `urn:li:page:d_flagship3_feed;${Math.random().toString(36).slice(2)}`,
    'x-restli-protocol-version': PROTOCOL_VERSIONS[Math.floor(Math.random() * PROTOCOL_VERSIONS.length)],
    'Referer': `${BASE}/feed/`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...options.headers
  };

  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const err = new Error(`Voyager ${response.status}: ${response.statusText}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

// ---- Specific API calls ----
export async function fetchFeedPosts(start = 0, count = 10) {
  return voyagerFetch(
    `/voyager/api/feed/updates?moduleKey=feed-conversation-list-with-social-detail&count=${count}&start=${start}`
  );
}

export async function postComment(activityUrn, commentText) {
  // Human-like typing delay before submitting: 8-25 seconds
  const charCount = commentText.length;
  const typingTime = (charCount * rand(180, 320)) + rand(2000, 5000);
  await sleep(Math.min(typingTime, 25000));

  return voyagerFetch('/voyager/api/socialActions/' + encodeURIComponent(activityUrn) + '/comments', {
    method: 'POST',
    body: {
      actor: `urn:li:member:${await getMyMemberId()}`,
      message: {
        text: commentText,
        attributes: []
      }
    }
  });
}

async function getMyMemberId() {
  const { memberId } = await chrome.storage.local.get('memberId');
  if (memberId) return memberId;

  const me = await voyagerFetch('/voyager/api/me');
  const id = me?.data?.miniProfile?.entityUrn?.split(':').pop() || '';
  await chrome.storage.local.set({ memberId: id });
  return id;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}
