// ============================================================
// ClaudeClient — Encrypted key storage + API calls
// AES-GCM encryption using Extension ID as entropy.
// Plain-text key in chrome.storage is a security liability.
// ============================================================

const MODEL = 'claude-sonnet-4-20250514';

// ---- Key Encryption ----
async function getKeyMaterial() {
  const rawEntropy = new TextEncoder().encode(chrome.runtime.id + '_ghost_engine_v1');
  const hash = await crypto.subtle.digest('SHA-256', rawEntropy);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function storeApiKey(apiKey) {
  const keyMaterial = await getKeyMaterial();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(apiKey);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial, encoded);

  await chrome.storage.local.set({
    encApiKey: Array.from(new Uint8Array(encrypted)),
    encIv: Array.from(iv)
  });
}

export async function loadApiKey() {
  const { encApiKey, encIv } = await chrome.storage.local.get(['encApiKey', 'encIv']);
  if (!encApiKey || !encIv) return null;

  try {
    const keyMaterial = await getKeyMaterial();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(encIv) },
      keyMaterial,
      new Uint8Array(encApiKey)
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    console.error('[Claude] Key decryption failed:', e);
    return null;
  }
}

// ---- Sentiment Classifier ----
const SENSITIVE_PATTERNS = [
  /laid.?off|layoff|retrench|job.?loss|fired|let.?go/i,
  /passed away|RIP\b|condolence|demise|grief|mourning/i,
  /mental health|burnout|anxiety|depression|struggling/i,
  /scam|fraud|lawsuit|arrested|scandal/i,
  /harassment|assault|discrimination|toxic/i
];

export async function classifyPost(postText) {
  // Fast regex guard — no API call, no latency
  const flagged = SENSITIVE_PATTERNS.find(p => p.test(postText));
  if (flagged) {
    return { sentiment: 'sensitive', risk: 'high', action: 'HOLD_FOR_REVIEW',
             reason: 'sensitive_pattern_match' };
  }

  const apiKey = await loadApiKey();
  if (!apiKey) return { sentiment: 'neutral', risk: 'low', action: 'AUTO_DRAFT' };

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 150,
        system: `You are a sentiment classifier for LinkedIn posts. 
Respond ONLY with valid JSON, no markdown, no explanation.
Format: {"sentiment":"positive|neutral|negative|sarcastic|sensitive","risk":"low|medium|high","reason":"one brief phrase"}`,
        messages: [{
          role: 'user',
          content: `Classify this LinkedIn post:\n\n"${postText.slice(0, 400)}"`
        }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    const classification = JSON.parse(text.replace(/```json|```/g, '').trim());

    const action = ['negative', 'sarcastic', 'sensitive'].includes(classification.sentiment) ||
                   classification.risk === 'high'
      ? 'HOLD_FOR_REVIEW'
      : 'AUTO_DRAFT';

    return { ...classification, action };
  } catch (e) {
    console.error('[Claude] Classification failed:', e);
    return { sentiment: 'neutral', risk: 'low', action: 'AUTO_DRAFT' };
  }
}

// ---- Comment Generator ----
export async function generateComment(personaPrompt) {
  const apiKey = await loadApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: personaPrompt.system,
      messages: [{ role: 'user', content: personaPrompt.user }]
    })
  });

  if (!response.ok) {
    const err = new Error(`Claude API ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return data.content?.[0]?.text?.trim() || '';
}
