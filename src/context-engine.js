// ============================================================
// LiveContextEngine — Real-time Indian ecosystem awareness
// Fetches trending topics, UPI status, startup news so
// "Rahul-from-Pune" sounds like he read the news today,
// not like he's hallucinating from 2024 training data.
// ============================================================

const CONTEXT_TTL = 3 * 60 * 60 * 1000; // Refresh every 3 hours
const INSHORTS_CATEGORIES = ['business', 'technology', 'startups'];

// Curated Indian tech/business RSS-style endpoints
const FEED_SOURCES = [
  {
    name: 'YourStory',
    url: 'https://yourstory.com/feed',
    tags: ['startup', 'funding', 'founder']
  },
  {
    name: 'Inc42',
    url: 'https://inc42.com/feed/',
    tags: ['startup', 'india', 'tech']
  }
];

// ---- Indian tech context that's always semi-relevant ----
const STATIC_CONTEXT_POOL = [
  { topic: 'UPI', refs: ['UPI crossed 18B transactions last month', 'UPI Lite X offline payments rolling out', 'UPI Circle for delegated payments getting traction'] },
  { topic: 'Startup Ecosystem', refs: ['D2C brands struggling with unit economics post-quick-commerce', 'Zepto dark stores reshaping last-mile logistics', 'EV startup funding dried up compared to 2021-22 peak'] },
  { topic: 'Jobs', refs: ['Mass layoffs continuing in mid-stage startups', 'IIT grads choosing startups over MNCs at lower rates', 'FAANG hiring freeze affecting IIM placements'] },
  { topic: 'AI in India', refs: ['Sarvam AI model getting adoption in govt schemes', 'Krutrim competing with OpenAI on Hindi reasoning', 'AI tools replacing BPO jobs faster than predicted'] },
  { topic: 'Remote Work', refs: ['TCS RTO mandate causing attrition spike', 'Bengaluru traffic making hybrid unworkable for many', 'Tier-2 city talent pipelines maturing'] }
];

// ---- Detect contextually relevant references for a post ----
function selectContextForPost(postText) {
  const lower = postText.toLowerCase();
  const relevant = [];

  // Topic matching
  if (/upi|payment|fintech|gpay|phonepe/i.test(lower)) {
    relevant.push(...STATIC_CONTEXT_POOL[0].refs);
  }
  if (/startup|funding|founder|vc|series/i.test(lower)) {
    relevant.push(...STATIC_CONTEXT_POOL[1].refs);
  }
  if (/layoff|job|hiring|career|fired/i.test(lower)) {
    relevant.push(...STATIC_CONTEXT_POOL[2].refs);
  }
  if (/ai|llm|ml|artificial intelligence|automation/i.test(lower)) {
    relevant.push(...STATIC_CONTEXT_POOL[3].refs);
  }
  if (/remote|wfh|office|return to office|rto|hybrid/i.test(lower)) {
    relevant.push(...STATIC_CONTEXT_POOL[4].refs);
  }

  // Always add 1 random current ref to avoid stale vibes
  const allRefs = STATIC_CONTEXT_POOL.flatMap(c => c.refs);
  if (relevant.length === 0) {
    relevant.push(allRefs[Math.floor(Math.random() * allRefs.length)]);
  }

  return relevant.slice(0, 2); // Max 2 context anchors per comment
}

// ---- Fetch live headlines via RSS/JSON ----
async function fetchLiveHeadlines() {
  const headlines = [];

  try {
    // Inshorts API (public, no key needed)
    const res = await fetch(
      'https://inshorts.com/api/en/news?category=business&max_limit=5&include_card_data=true',
      { headers: { 'Accept': 'application/json' } }
    );
    if (res.ok) {
      const data = await res.json();
      const items = data?.data?.news_list || [];
      items.slice(0, 5).forEach(item => {
        const h = item.news_obj;
        if (h) headlines.push({
          title: h.title,
          summary: h.bottom_headline || h.content?.slice(0, 120),
          source: h.source_name,
          time: h.created_at
        });
      });
    }
  } catch (e) {
    console.log('[Context] Inshorts fetch failed, using static pool');
  }

  return headlines;
}

// ---- Main: build full context object for Claude prompt injection ----
export async function buildLiveContext(postText, cachedContext = null) {
  // Use cache if fresh
  if (cachedContext && (Date.now() - cachedContext.cachedAt) < CONTEXT_TTL) {
    return injectContextForPost(cachedContext, postText);
  }

  let headlines = [];
  try {
    headlines = await fetchLiveHeadlines();
  } catch (e) {
    headlines = [];
  }

  const context = {
    headlines,
    generatedAt: new Date().toISOString(),
    cachedAt: Date.now()
  };

  return injectContextForPost(context, postText);
}

function injectContextForPost(contextObj, postText) {
  const postSpecificRefs = selectContextForPost(postText);
  const liveHeadlines = (contextObj.headlines || []).slice(0, 3);

  return {
    ...contextObj,
    postRefs: postSpecificRefs,
    liveHeadlines,
    promptFragment: buildPromptFragment(postSpecificRefs, liveHeadlines)
  };
}

function buildPromptFragment(postRefs, liveHeadlines) {
  const parts = [];

  if (liveHeadlines.length > 0) {
    parts.push('LIVE CONTEXT (today\'s headlines you\'re aware of):');
    liveHeadlines.forEach(h => parts.push(`- ${h.title} (${h.source})`));
  }

  if (postRefs.length > 0) {
    parts.push('RELEVANT GROUND-LEVEL CONTEXT (you can reference naturally):');
    postRefs.forEach(r => parts.push(`- ${r}`));
  }

  parts.push('Use 1-2 of these contextually if they add value. Never force-fit them.');

  return parts.join('\n');
}

// ---- AI Detection Heuristics ----
export function scoreAILikelihood(text) {
  if (!text || text.length < 50) return { score: 0, signals: [] };

  const signals = [];
  let score = 0;

  // Structural AI tells
  const bulletLines = (text.match(/^[•\-\*➡️✅]/gm) || []).length;
  const totalLines = text.split('\n').filter(l => l.trim()).length;
  if (bulletLines / Math.max(totalLines, 1) > 0.4) {
    signals.push('heavy_bullets'); score += 20;
  }

  // Hook patterns
  if (/^(Ever |Most people |Unpopular opinion|Hot take|Here's |I've |After \d)/i.test(text)) {
    signals.push('ai_hook'); score += 25;
  }

  // Emoji density
  const emojiCount = (text.match(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu) || []).length;
  const emojiDensity = emojiCount / text.length;
  if (emojiDensity > 0.015) { signals.push('emoji_heavy'); score += 15; }

  // CTA endings
  if (/follow for more|what do you think\?|drop a comment|tag someone|share this/i.test(text)) {
    signals.push('ai_cta'); score += 20;
  }

  // Numbered "X things/ways/lessons" structure
  if (/\b\d+\s+(things|ways|lessons|tips|rules|reasons|mistakes)\b/i.test(text)) {
    signals.push('listicle_format'); score += 20;
  }

  // Overly formal Indian English (training data tell)
  if (/as per my experience|I humbly request|kindly note|please do the needful/i.test(text)) {
    signals.push('formal_indian_english'); score += 10;
  }

  // Generic motivational closers
  if (/(consistency is key|work hard|never give up|keep going|hustle)/i.test(text)) {
    signals.push('motivational_filler'); score += 15;
  }

  return {
    score: Math.min(score, 100),
    isLikelyAI: score >= 55,
    signals,
    verdict: score >= 75 ? 'ALMOST_CERTAIN_AI' : score >= 55 ? 'LIKELY_AI' : score >= 30 ? 'POSSIBLY_AI' : 'LIKELY_HUMAN'
  };
}
