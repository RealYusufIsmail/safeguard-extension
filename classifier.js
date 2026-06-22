'use strict';

// Pre-baked TF-IDF weights for adult URL tokens.
// Values represent inverse document frequency — higher means more discriminative.
// Derived from corpus analysis of adult vs. safe-browsing URL patterns.
const WEIGHTS = {
  // Tier 1 — unambiguous (9.0 – 10.0)
  porn:          9.5,  porno:         9.4,  pornographic:  9.5,
  xxx:           9.3,
  hentai:        9.4,
  nsfw:          9.2,
  cumshot:       9.8,  cum:           8.6,
  creampie:      9.7,
  gangbang:      9.8,
  blowjob:       9.8,  handjob:       9.7,  footjob:       9.6,
  threesome:     9.5,
  bdsm:          9.3,
  bondage:       9.0,
  upskirt:       9.5,
  voyeur:        9.0,
  incest:        9.8,
  orgasm:        9.5,
  masturbate:    9.6,  masturbation:  9.6,
  fellatio:      9.7,  cunnilingus:   9.8,
  pornstar:      9.5,  pornstars:     9.5,
  teenporn:      9.9,
  xrated:        9.0,

  // Tier 2 — strong signals (7.5 – 9.0)
  nude:          8.8,  nudity:        8.7,  naked:         8.6,  nudes:         9.0,
  erotic:        8.5,  erotica:       8.6,
  milf:          9.2,  gilf:          9.2,
  fetish:        8.5,
  escort:        7.8,  escorts:       7.9,
  stripper:      8.5,  striptease:    8.5,
  camgirl:       9.0,  camshow:       9.0,  sexcam:        9.5,
  onlyfans:      8.5,
  softcore:      8.5,  hardcore:      7.6,
  adultfilm:     9.5,  adultmovie:    9.5,
  sexvideo:      9.5,  sextape:       9.5,
  nudepics:      9.5,
  wankz:         9.5,  fap:           8.5,
  anal:          8.5,
  dildo:         9.5,
  boob:          8.0,  boobs:         8.0,
  tit:           7.5,  tits:          7.5,
  pussy:         8.5,
  cock:          7.5,
  nipple:        7.5,  nipples:       7.5,
  prostitute:    8.8,  prostitution:  8.8,
  swinger:       7.5,  swingers:      7.5,

  // Tier 3 — moderate signals (5.0 – 7.5)
  sex:           7.0,
  sexy:          6.5,
  sexual:        6.0,
  adult:         5.5,
  kink:          7.0,  kinky:         7.0,
  hookup:        6.5,
  amateur:       5.0,
  dick:          6.5,
  penis:         6.0,  vagina:        7.0,
  ass:           5.0,
  hotgirls:      8.0,  hotgirl:       8.0,

  // Tier 4 — platform / structural URL patterns (4.0 – 6.0)
  tube:          4.5,
  redtube:       9.5,  youporn:       9.5,
  xhamster:      9.5,  xnxx:          9.5,
  spankbang:     9.5,  beeg:          8.5,
  tnaflix:       9.5,  drtuber:       9.5,
  slutload:      9.5,  porndig:       9.5,
  freeporn:      9.5,  freeadult:     8.5,
  livecam:       6.5,  nudecam:       9.5,
  sexchat:       9.0,  adultchat:     9.0,
  bigboobs:      9.0,
};

const DOMAIN_MULT  = 1.5;
const PATH_MULT    = 1.0;
const QUERY_MULT   = 0.6;

// Single strong token in domain or path → definite adult
const THRESHOLD_SINGLE = 9.0;
// Multiple moderate signals summed → probable adult
const THRESHOLD_TOTAL  = 13.0;

function tokenize(str) {
  return str.toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
}

function scoreSegment(tokens, mult) {
  let segScore = 0;
  let segMax = 0;
  const matched = [];
  for (const t of tokens) {
    const w = (WEIGHTS[t] || 0) * mult;
    if (w > 0) {
      segScore += w;
      matched.push(t);
      if (w > segMax) segMax = w;
    }
  }
  return { segScore, segMax, matched };
}

// High-value substrings to scan for directly in the raw hostname.
// Catches compound words like "nhentai", "xporno", "sexhd" that tokenization
// can't split because there's no separator character between the parts.
const SUBSTRING_TERMS = [
  'porn', 'hentai', 'xxx', 'nsfw', 'nude', 'naked', 'milf',
  'cumshot', 'creampie', 'gangbang', 'blowjob', 'handjob',
  'bdsm', 'bondage', 'incest', 'orgasm', 'fetish', 'erotic',
  'escort', 'camgirl', 'onlyfans', 'sexcam', 'nudecam',
  'fap', 'wank', 'dildo', 'anal', 'pussy', 'cock',
];

// Returns { isAdult, score, confidence, matchedTokens }
function classifyURL(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return { isAdult: false, score: 0, confidence: 0, matchedTokens: [] }; }

  // Skip browser internal pages
  if (['chrome:', 'chrome-extension:', 'about:', 'data:'].includes(parsed.protocol)) {
    return { isAdult: false, score: 0, confidence: 0, matchedTokens: [] };
  }

  const hostClean = parsed.hostname.replace(/^www\./, '');
  const domSeg  = scoreSegment(tokenize(hostClean), DOMAIN_MULT);
  const pathSeg = scoreSegment(tokenize(parsed.pathname), PATH_MULT);
  const querSeg = scoreSegment(tokenize(parsed.search), QUERY_MULT);

  let totalScore = domSeg.segScore + pathSeg.segScore + querSeg.segScore;
  let maxToken   = Math.max(domSeg.segMax, pathSeg.segMax, querSeg.segMax);
  const matched  = [...new Set([...domSeg.matched, ...pathSeg.matched, ...querSeg.matched])];

  // Substring scan on the raw hostname — catches compound adult words that
  // tokenization misses (e.g. "nhentai" contains "hentai", "xporno" → "porn").
  const rawHost = hostClean.toLowerCase();
  for (const term of SUBSTRING_TERMS) {
    if (rawHost.includes(term) && !matched.includes(term)) {
      const w = (WEIGHTS[term] || 8.0) * DOMAIN_MULT;
      totalScore += w;
      if (w > maxToken) maxToken = w;
      matched.push(term + '*');  // * marks a substring match for logging
    }
  }

  const isAdult = maxToken >= THRESHOLD_SINGLE || totalScore >= THRESHOLD_TOTAL;
  const confidence = Math.min(1, totalScore / 18);

  return { isAdult, score: totalScore, confidence, matchedTokens: matched };
}
