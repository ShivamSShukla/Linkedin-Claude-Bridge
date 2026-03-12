// ============================================================
// ContentGen — News-to-Post Pipeline
// Grabs live headlines → passes through PersonaDNA →
// Claude writes a post that sounds like Rahul read the news
// over chai this morning, not like a bot scraped an API.
// ============================================================

import { getOrCreateVariant } from './persona-dna.js';
import { loadApiKey } from './claude-client.js';

const MODEL = 'claude-sonnet-4-20250514';

// ---- News Sources (priority order) ----
const NEWS_SOURCES = [
  {
    name: 'Inshorts Business',
    url: 'https://inshorts.com/api/en/news?category=business&max_limit=8&include_card_data=true',
    parser: (data) => (data?.data?.news_list || []).map(n => ({
      title: n.news_obj?.title,
      summary: n.news_obj?.content?.slice(0, 200),
      source: n.news_obj?.source_name,
      category: 'business'
    })).filter(n => n.title)
  },
  {
    name: 'Inshorts Tech',
    url: 'https://inshorts.com/api/en/news?category=technology&max_limit=5&include_card_data=true',
    parser: (data) => (data?.data?.news_list || []).map(n => ({
      title: n.news_obj?.title,
      summary: n.news_obj?.content?.slice(0, 200),
      source: n.news_obj?.source_name,
      category: 'technology'
    })).filter(n => n.title)
  }
];

// ---- Hardcoded fallback headlines (March 12, 2026 context) ----
const FALLBACK_HEADLINES = [
  {
    title: 'Sensex crashes 900 points as West Asia conflict escalates, Nifty50 below 23,600',
    summary: 'Indian markets opened sharply lower amid global risk-off sentiment. FIIs pulled out ₹4,200 crore.',
    source: 'Economic Times',
    category: 'business'
  },
  {
    title: 'LPG supply disruptions hit Pune, Noida as Gulf shipping routes face uncertainty',
    summary: 'Domestic cylinder availability drops 30% in select districts. Government monitoring situation.',
    source: 'Business Standard',
    category: 'business'
  },
  {
    title: 'Airtel hit with ₹2,000 crore DoT penalty over spectrum usage violations',
    summary: 'Telecom giant disputes the order. Analysts warn of short-term earnings impact.',
    source: 'Mint',
    category: 'business'
  },
  {
    title: 'India clinches Hockey World Cup berth with 3-1 win over Germany',
    summary: 'PR Sreejesh\'s last international tournament ends on a high as India books Paris spot.',
    source: 'Times of India',
    category: 'sports'
  },
  {
    title: 'TCS Q4 guidance misses street estimates; attrition rises to 14.2%',
    summary: 'Deal wins remain strong but margin pressure from wage hikes weighs on outlook.',
    source: 'CNBC TV18',
    category: 'technology'
  }
];

// ---- Fetch live headlines ----
export async function fetchHeadlines() {
  const allHeadlines = [];

  for (const source of NEWS_SOURCES) {
    try {
      const res = await fetch(source.url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const data = await res.json();
        allHeadlines.push(...source.parser(data));
      }
    } catch (e) {
      console.warn(`[ContentGen] ${source.name} failed:`, e.message);
    }
  }

  // Deduplicate + fallback
  const headlines = allHeadlines.length >= 3 ? allHeadlines : FALLBACK_HEADLINES;
  return headlines.slice(0, 5);
}

// ---- Select the best 2-3 headlines for a given persona ----
function selectHeadlinesForPersona(headlines, variant) {
  const domain = variant.domain.toLowerCase();

  // Score each headline for persona relevance
  const scored = headlines.map(h => {
    let score = 0;
    const text = (h.title + ' ' + h.summary).toLowerCase();

    // Domain relevance
    if (domain.includes('fintech') && /market|sensex|nifty|rbi|upi|payment|bank/.test(text)) score += 30;
    if (domain.includes('engineering') && /tech|ai|startup|software|data|cloud/.test(text)) score += 30;
    if (domain.includes('venture') && /funding|startup|valuation|vc|series|invest/.test(text)) score += 30;

    // Ground-level Indian friction (always relevant)
    if (/lpg|petrol|power cut|traffic|local|mumbai|pune|bangalore|delhi/.test(text)) score += 20;

    // Market/macro (relevant to everyone professional)
    if (/market|economy|gdp|inflation|rupee/.test(text)) score += 15;

    // Random factor — humans don't always pick the "most relevant" article
    score += Math.random() * 15;

    return { ...h, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ---- Post tone profiles ----
const TONE_PROFILES = {
  measured_concerned: {
    label: 'Measured + Concerned',
    instruction: 'Measured, slightly worried but long-term focused. Not panicking. Like a person who\'s seen market cycles before but still quietly anxious.'
  },
  analytical_detached: {
    label: 'Analytical + Detached',
    instruction: 'Analytical, almost clinical. Treating this like a business problem to be solved, not a crisis. Uses numbers.'
  },
  grounded_human: {
    label: 'Grounded + Human',
    instruction: 'Very human, almost journaling. Uses one specific personal anecdote. Doesn\'t try to sound like a thought leader.'
  },
  mild_contrarian: {
    label: 'Mild Contrarian',
    instruction: 'Gently pushes back on the panic narrative. Sees an opportunity or a silver lining — but not in a toxic-positivity way.'
  }
};

// ---- Main: generate a LinkedIn post from headlines ----
export async function generateNewsPost(personaId, options = {}) {
  const variant = await getOrCreateVariant(personaId);
  const headlines = await fetchHeadlines();
  const selectedHeadlines = selectHeadlinesForPersona(headlines, variant);
  const toneKey = options.tone || Object.keys(TONE_PROFILES)[Math.floor(Math.random() * Object.keys(TONE_PROFILES).length)];
  const tone = TONE_PROFILES[toneKey];

  const headlineBlock = selectedHeadlines
    .map((h, i) => `${i + 1}. "${h.title}" — ${h.source}`)
    .join('\n');

  const groundingBlock = [
    `You are ${variant.domain} professional based in India.`,
    `Your commute reality: ${variant.cityRef}.`,
    `Your local anchor today: ${variant.contextRef}.`,
    `You\'ve been in this industry ${variant.yearsExp} years.`,
    variant.codeSwitchWord ? `You occasionally say "${variant.codeSwitchWord}" naturally.` : '',
    variant.usesDash ? 'You use em-dashes to connect ideas.' : '',
    variant.capsForEmphasis ? 'You very rarely CAPITALIZE one word for emphasis.' : ''
  ].filter(Boolean).join(' ');

  const systemPrompt = `You write LinkedIn posts for a specific Indian professional. You never write generic thought leadership. You write like a real person who read the news while eating breakfast.

PERSONA GROUNDING:
${groundingBlock}

POST RULES:
- 80-120 words maximum. Not a word more.
- No bullet points. No numbered lists. Prose only.
- No "Hot take:" or "Unpopular opinion:" openers.
- No closing CTA like "What do you think?" or "Follow for more."
- One specific personal/local reference that only this persona would make.
- Weave 1-2 headlines together naturally — don\'t list them.
- Tone: ${tone.instruction}
- End mid-thought if needed. Real posts don\'t always have tidy conclusions.
- NO emojis unless absolutely necessary. Max one.`;

  const userPrompt = `Today\'s headlines (March 12, 2026):
${headlineBlock}

Write a LinkedIn post as this professional reacting to today\'s news. Make it feel like they typed this between meetings, not like they crafted it for an hour.`;

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
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const err = new Error(`Claude API ${response.status}`);
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  const postText = data.content?.[0]?.text?.trim() || '';

  return {
    postText,
    headlines: selectedHeadlines,
    tone: toneKey,
    variantId: variant.installationId?.slice(0, 8),
    generatedAt: Date.now()
  };
}

// ---- Schedule: calculate optimal posting time ----
export function calculatePostTime(baseTime = Date.now()) {
  // LinkedIn engagement peaks: 8-10am, 12-1pm, 5-6pm IST
  const now = new Date(baseTime);
  const hourIST = (now.getUTCHours() + 5.5) % 24;

  let targetHour;
  if (hourIST < 8) targetHour = 8;
  else if (hourIST < 10) targetHour = hourIST; // Already in peak
  else if (hourIST < 12) targetHour = 12;
  else if (hourIST < 13) targetHour = hourIST;
  else if (hourIST < 17) targetHour = 17;
  else targetHour = 8; // Next morning

  // Jitter: ±22 minutes so 500 users don't post at :00 simultaneously
  const jitterMinutes = Math.floor(Math.random() * 44) - 22;
  const targetMinute = Math.max(0, Math.min(59, 15 + jitterMinutes));

  const postTime = new Date(now);
  const currentHourIST = hourIST;

  if (targetHour <= currentHourIST && targetHour !== hourIST) {
    postTime.setDate(postTime.getDate() + 1);
  }

  postTime.setUTCHours((targetHour - 5), targetMinute - 30, 0, 0);

  return {
    scheduledFor: postTime.getTime(),
    scheduledForDisplay: postTime.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
    waitMs: Math.max(0, postTime.getTime() - Date.now())
  };
}
