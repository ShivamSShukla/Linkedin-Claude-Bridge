// ============================================================
// PersonaDNA — Procedural persona variation engine
// 500 installs of "Rahul" produce 500 linguistically distinct
// humans. Same archetype, never the same fingerprint.
// ============================================================

// ---- DNA Building Blocks ----

const DNA = {
  // City-level friction pools
  cities: {
    pune: {
      commute: ['Hinjewadi traffic', 'Baner-Balewadi stretch', 'SH-60 flyover mess', 'Wakad signal'],
      food: ['Vaishali', 'Café Goodluck', 'Maruti biryani from FC Road', 'tapri chai near office'],
      context: ['Pune startup bubble', 'Magarpatta crowd', 'Koregaon Park rent crisis', 'PMC potholes']
    },
    bangalore: {
      commute: ['Silk Board', 'ORR at 6pm', 'Bellandur lake smell', 'Hosur Road nightmare'],
      food: ['CTR on a Sunday', 'Meghana biryani', 'Brahmin coffee', 'Koshy's on MG Road'],
      context: ['Koramangala bubble', 'Bengaluru water crisis', 'metro line 3 delay', 'HSR Layout rents']
    },
    mumbai: {
      commute: ['Western line local', 'BKC cab surge', 'Bandra-Worli sealink toll', 'Andheri signal'],
      food: ['Kyani & Co Irani chai', 'Swati snacks queue', 'vada pav outside CST', 'Britannia berry pulao'],
      context: ['BKC startup corridor', 'Dharavi redevelopment', 'Mumbai monsoon chaos', 'Versova flooding']
    },
    hyderabad: {
      commute: ['Hitech City signal', 'PVNR Expressway toll', 'Gachibowli flyover', 'ORR toll'],
      food: ['Shah Ghouse biryani', 'Nimrah chai', 'Paradise lunch crowd', 'Chutneys idli'],
      context: ['HITEC City vs Cyberabad debate', 'Telangana startup push', 'Pharma City delays', 'Formula E track']
    }
  },

  // Writing style micro-variations
  openers: [
    'Interesting take —', 'Honestly,', 'This resonates.', 'Slightly different view here:',
    'Been thinking about this a lot.', 'Real talk:', 'Pushback, maybe:',
    'In my experience,', 'Disagree, partially.', 'This hits close.',
    'Worth unpacking —', 'Counterpoint:', 'Seen this play out firsthand.',
    '', // No opener — start direct
    '', '', '', '' // Weight toward no opener (natural)
  ],

  // Hedging styles (not "I agree 100%" but not "you're wrong" either)
  hedges: [
    'though in practice it\'s messier than this',
    'at least in the B2B context I\'ve seen',
    'though maybe I\'m biased by my Pune experience',
    'YMMV depending on sector',
    'at least that was the case when we tried it',
    'though the metric that actually matters differs by company size',
    'though I\'ve seen this go both ways',
    'in theory yes, in execution — different story',
    null, null, null // No hedge sometimes
  ],

  // Sign-offs (most are null — humans don't always have a CTA)
  signoffs: [
    null, null, null, null, null, null, // Most have no signoff
    'Curious what others have seen.',
    'Would love to hear from founders who tried this.',
    null
  ],

  // Code-switch patterns by language background
  codeSwitch: {
    marathi: ['yaar', 'ek second', 'matter karta hai', 'exactly na', 'bagh'],
    hindi: ['seedha baat', 'dekho', 'honestly bol raha hoon', 'sach mein', 'yaani'],
    tamil: ['seri', 'ippo', 'romba', 'solla vendam', null],
    telugu: ['ante', 'cheppali ante', 'kaadu', null, null],
    none: [null, null, null, null, null] // No code-switch
  },

  // Seniority-specific vocabulary
  seniority: {
    junior: {
      refs: ['my first job', 'when I was just starting out', 'my manager at the time', 'TCS/Infosys days'],
      avoid: ['our portfolio', 'series B dynamics', 'board-level conversations']
    },
    mid: {
      refs: ['my last startup', 'the team I built', 'when we were scaling from 20 to 80'],
      avoid: ['entry level stuff', 'I just googled this but']
    },
    senior: {
      refs: ['the third time I\'ve seen this cycle', 'companies I\'ve advised', 'our growth from 0 to 1'],
      avoid: ['I think maybe', 'not sure if this is right but']
    }
  },

  // Current events pool (March 2026 context)
  currentEvents: [
    { topic: 'markets', ref: 'markets down 800 points today', relevance: ['finance', 'startup', 'investment'] },
    { topic: 'lpg', ref: 'LPG shortage hitting Pune and Noida kitchens right now', relevance: ['cost', 'inflation', 'consumer'] },
    { topic: 'hockey', ref: 'India just clinched the World Cup hockey berth', relevance: ['sports', 'team', 'achievement', 'win'] },
    { topic: 'upi', ref: 'UPI was down for 2 hours yesterday — 18B transactions/month and still no SLA', relevance: ['fintech', 'payment', 'reliability', 'infra'] },
    { topic: 'rto', ref: 'TCS RTO mandate causing visible attrition in my network', relevance: ['remote', 'office', 'work', 'culture', 'hr'] },
    { topic: 'ai_jobs', ref: 'three BPO friends got "restructured" last month — AI\'s moving faster than the policy', relevance: ['ai', 'jobs', 'layoff', 'automation'] }
  ]
};

// ---- Seeded randomness: same user always gets same persona variant ----
function seededRandom(seed) {
  // Simple mulberry32
  let s = seed;
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// ---- Generate a unique persona from archetype + installation ID ----
export function generatePersonaVariant(archetypeId, installationId) {
  // Use installation ID as seed — stable across sessions, unique per install
  const seed = installationId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const rng = seededRandom(seed + archetypeId.length);

  const archetypes = {
    rahul_pune: {
      cityKey: 'pune',
      codeSwitchKey: Math.random() < 0.6 ? 'marathi' : 'hindi',
      seniorityKey: 'mid',
      domain: 'fintech PM',
      yearsExp: 4 + Math.floor(rng() * 5),
      companyStage: pick(['early-stage', 'Series A', 'Series B', 'bootstrapped'], rng)
    },
    priya_bangalore: {
      cityKey: 'bangalore',
      codeSwitchKey: Math.random() < 0.6 ? 'tamil' : 'none',
      seniorityKey: 'senior',
      domain: 'engineering leadership',
      yearsExp: 6 + Math.floor(rng() * 5),
      companyStage: pick(['B2B SaaS', 'enterprise', 'growth-stage', 'pre-IPO'], rng)
    },
    arjun_mumbai: {
      cityKey: 'mumbai',
      codeSwitchKey: 'hindi',
      seniorityKey: 'mid',
      domain: 'venture capital',
      yearsExp: 2 + Math.floor(rng() * 4),
      companyStage: pick(['seed to Series A', 'pre-seed', 'Series A/B'], rng)
    }
  };

  const arch = archetypes[archetypeId] || archetypes.rahul_pune;
  const city = DNA.cities[arch.cityKey];
  const codeSwitch = DNA.codeSwitch[arch.codeSwitchKey];
  const seniority = DNA.seniority[arch.seniorityKey];

  // Pick stable micro-choices for this install
  const variant = {
    archetypeId,
    installationId,
    cityRef: pick(city.commute, rng),        // Their specific commute reference
    foodRef: pick(city.food, rng),            // Their local food spot
    contextRef: pick(city.context, rng),      // Their city-specific friction
    preferredOpener: pick(DNA.openers, rng),
    preferredHedge: pick(DNA.hedges, rng),
    preferredSignoff: pick(DNA.signoffs, rng),
    codeSwitchWord: pick(codeSwitch.filter(Boolean), rng) || null,
    domainRef: pick(seniority.refs, rng),
    yearsExp: arch.yearsExp,
    companyStage: arch.companyStage,
    domain: arch.domain,

    // Stylistic quirks — unique per install
    usesEllipsis: rng() < 0.3,
    usesDash: rng() < 0.5,
    capsForEmphasis: rng() < 0.2,  // "the ACTUAL problem"
    asksClarifyingQuestion: rng() < 0.35,
    sharesFailureStory: rng() < 0.25
  };

  return variant;
}

// ---- Build the system prompt from a variant ----
export function buildVariantSystemPrompt(variant, basePersonaPrompt) {
  const quirks = [];

  if (variant.usesEllipsis) quirks.push('You occasionally use "..." to trail off mid-thought.');
  if (variant.usesDash) quirks.push('You use em-dashes to connect ideas — like this — instead of new sentences.');
  if (variant.capsForEmphasis) quirks.push('You occasionally CAPITALIZE one word for emphasis. Rarely.');
  if (variant.asksClarifyingQuestion) quirks.push('You often end with one specific clarifying question, not a generic "what do you think?"');
  if (variant.sharesFailureStory) quirks.push('When relevant, you briefly mention something that failed before the insight you\'re sharing.');
  if (variant.codeSwitchWord) quirks.push(`Your one natural code-switch: you sometimes say "${variant.codeSwitchWord}" mid-sentence.`);

  const groundingLines = [
    `You've been based in this city for ${variant.yearsExp} years. Your commute reality: ${variant.cityRef}.`,
    `Your local reference: ${variant.foodRef} is where deals happen, not WeWork.`,
    `You work in ${variant.domain} at a ${variant.companyStage} company.`,
    `When you need a personal reference, use: "${variant.domainRef}".`,
  ];

  return `${basePersonaPrompt}

GROUNDING (your specific variant — do not deviate):
${groundingLines.join('\n')}

STYLISTIC QUIRKS (yours specifically):
${quirks.length ? quirks.join('\n') : 'No special quirks — write clean, direct prose.'}

OPENER PREFERENCE: ${variant.preferredOpener || 'Start directly without a filler opener.'}
${variant.preferredHedge ? `HEDGE STYLE: Include a caveat like "${variant.preferredHedge}"` : ''}
${variant.preferredSignoff ? `OCCASIONAL SIGNOFF: "${variant.preferredSignoff}" (not every comment)` : ''}`;
}

// ---- Event context selector ----
export function getRelevantCurrentEvent(postText) {
  const lower = postText.toLowerCase();
  const match = DNA.currentEvents.find(e =>
    e.relevance.some(tag => lower.includes(tag))
  );
  // 40% chance to inject even on a weak match — humans bring up current events tangentially
  return match && Math.random() < 0.7 ? match : null;
}

// ---- Generate and cache variant per install ----
let _cachedVariant = null;

export async function getOrCreateVariant(archetypeId) {
  if (_cachedVariant && _cachedVariant.archetypeId === archetypeId) {
    return _cachedVariant;
  }

  // Get stable installation ID
  let { installationId } = await chrome.storage.local.get('installationId');
  if (!installationId) {
    installationId = crypto.randomUUID();
    await chrome.storage.local.set({ installationId });
  }

  _cachedVariant = generatePersonaVariant(archetypeId, installationId);
  return _cachedVariant;
}
