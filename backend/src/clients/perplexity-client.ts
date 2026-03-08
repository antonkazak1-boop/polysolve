import axios from 'axios';

const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';
function getApiKey() { return process.env.PERPLEXITY_API_KEY; }

// ─── Legacy news interface (kept for backward compat) ────────────────────────

export interface NewsResult {
  summary: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  sentimentScore: number;
  relevance: number;
  sources: string[];
  keyPoints: string[];
  query: string;
  fetchedAt: string;
}

// ─── NEW: MarketAnalysis — Perplexity-driven side selection ──────────────────

export interface MarketAnalysis {
  active: boolean;
  side: 'YES' | 'NO' | 'NEUTRAL';
  sideConfidence: number; // 0-100
  relevance: number;      // 0-100
  reason: string;
}

export interface MarketCandidate {
  marketQuestion: string;
  eventTitle: string;
  endDate?: string;
  yesPrice: number;
  noPrice: number;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const analysisCache = new Map<string, { data: MarketAnalysis; ts: number }>();
const newsCache = new Map<string, { data: NewsResult; ts: number }>();

// 2 hours — новости не меняются каждую минуту, экономим токены
const CACHE_TTL = 2 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 300;

function cacheKey(q: string): string {
  return (q || '').slice(0, 100).toLowerCase().replace(/\s+/g, ' ').trim();
}

function evictIfNeeded(cache: Map<string, { data: any; ts: number }>) {
  if (cache.size <= MAX_CACHE_SIZE) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toRemove = Math.min(50, entries.length);
  for (let i = 0; i < toRemove; i++) cache.delete(entries[i][0]);
}

// ─── analyzeMarket: ask Perplexity for side selection on a single market ─────

export async function analyzeMarket(candidate: MarketCandidate): Promise<MarketAnalysis> {
  const key = cacheKey(candidate.marketQuestion);
  const cached = analysisCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data; // cache hit — no API call
  }

  const apiKey = getApiKey();
  if (!apiKey) return fallbackAnalysis();

  const today = new Date().toISOString().split('T')[0];
  const endStr = candidate.endDate
    ? new Date(candidate.endDate).toISOString().split('T')[0]
    : 'no end date';

  const prompt = `You are a prediction market analyst. Analyze this market using the LATEST real-world news.

Market: "${candidate.marketQuestion}"
Event: "${candidate.eventTitle}"
End date: ${endStr}
Current YES price: ${(candidate.yesPrice * 100).toFixed(1)}¢, NO price: ${(candidate.noPrice * 100).toFixed(1)}¢
Today: ${today}

Based on LATEST news:
1. Is this event still ACTIVE and not already resolved? (yes/no)
2. Which side do current NEWS and facts support: YES, NO, or NEUTRAL?
3. How confident are you in this side based on news? (0-100)
4. How well can you assess this event from available news? (relevance 0-100, low = obscure/no data)
5. Brief reason for your recommendation (1-2 sentences).

Respond ONLY with valid JSON:
{"active":true,"side":"YES","sideConfidence":65,"relevance":70,"reason":"..."}`;

  try {
    const response = await axios.post(
      PERPLEXITY_API_URL,
      {
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You are a prediction market analyst. Respond ONLY with valid JSON. No markdown.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.1,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );

    const content: string = response.data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(content);

    const result: MarketAnalysis = {
      active: parsed.active !== false,
      side: validateSide(parsed.side),
      sideConfidence: clamp(parseInt(parsed.sideConfidence) || 0, 0, 100),
      relevance: clamp(parseInt(parsed.relevance) || 0, 0, 100),
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
    };

    analysisCache.set(key, { data: result, ts: Date.now() });
    evictIfNeeded(analysisCache);
    return result;
  } catch (err: any) {
    console.warn('[perplexity] analyzeMarket error:', err.message);
    return fallbackAnalysis();
  }
}

// ─── analyzeMarketsBatch: parallel with concurrency limit ────────────────────

export async function analyzeMarketsBatch(
  candidates: MarketCandidate[],
  concurrency = 5,
): Promise<Map<string, MarketAnalysis>> {
  const results = new Map<string, MarketAnalysis>();
  if (!getApiKey()) {
    console.warn('[perplexity] No API key — all candidates get fallback');
    for (const c of candidates) results.set(cacheKey(c.marketQuestion), fallbackAnalysis());
    return results;
  }

  // Split into chunks
  const chunks: MarketCandidate[][] = [];
  for (let i = 0; i < candidates.length; i += concurrency) {
    chunks.push(candidates.slice(i, i + concurrency));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const promises = chunk.map(c => analyzeMarket(c).catch(() => fallbackAnalysis()));
    const chunkResults = await Promise.all(promises);
    for (let j = 0; j < chunk.length; j++) {
      results.set(cacheKey(chunk[j].marketQuestion), chunkResults[j]);
    }
    // Throttle between chunks to avoid 429 rate limits
    if (ci < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  console.log(`[perplexity] batch analyzed ${candidates.length} markets (${chunks.length} chunks)`);
  return results;
}

// ─── Legacy fetchNewsForEvent (still used by events/:id/news route) ──────────

export async function fetchNewsForEvent(
  eventTitle: string,
  eventDescription?: string
): Promise<NewsResult> {
  const key = cacheKey(eventTitle);
  const cached = newsCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const apiKey = getApiKey();
  if (!apiKey) return fallbackNewsResult(eventTitle);

  const query = buildQuery(eventTitle, eventDescription);

  try {
    const response = await axios.post(
      PERPLEXITY_API_URL,
      {
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You are a concise financial news analyst. Respond ONLY with valid JSON. No markdown.' },
          { role: 'user', content: `Analyze recent news about this prediction market event: "${query}"\n\nRespond with JSON:\n{\n  "summary": "2-3 sentence summary",\n  "sentiment": "BULLISH|BEARISH|NEUTRAL",\n  "sentimentScore": <-1 to 1>,\n  "relevance": <0-100>,\n  "keyPoints": ["point1","point2"],\n  "sources": ["source1"]\n}` },
        ],
        max_tokens: 400,
        temperature: 0.1,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    const content: string = response.data?.choices?.[0]?.message?.content ?? '';
    const parsed = extractJson(content);

    const result: NewsResult = {
      summary: parsed.summary ?? 'No summary available.',
      sentiment: validateSentiment(parsed.sentiment),
      sentimentScore: clamp(parseFloat(parsed.sentimentScore) || 0, -1, 1),
      relevance: clamp(parseInt(parsed.relevance) || 50, 0, 100),
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 4) : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 3) : [],
      query,
      fetchedAt: new Date().toISOString(),
    };

    newsCache.set(key, { data: result, ts: Date.now() });
    evictIfNeeded(newsCache);
    return result;
  } catch (err: any) {
    console.warn('Perplexity API error:', err.message);
    return fallbackNewsResult(eventTitle);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildQuery(title: string, description?: string): string {
  const base = title.length > 120 ? title.slice(0, 120) : title;
  if (description && description.length > 20) return `${base}. ${description.slice(0, 80)}`;
  return base;
}

function extractJson(text: string): any {
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch {} }
  return {};
}

function validateSide(s: any): 'YES' | 'NO' | 'NEUTRAL' {
  if (s === 'YES' || s === 'NO' || s === 'NEUTRAL') return s;
  return 'NEUTRAL';
}

function validateSentiment(s: any): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
  if (s === 'BULLISH' || s === 'BEARISH' || s === 'NEUTRAL') return s;
  return 'NEUTRAL';
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function fallbackAnalysis(): MarketAnalysis {
  return { active: true, side: 'NEUTRAL', sideConfidence: 0, relevance: 0, reason: '' };
}

function fallbackNewsResult(title: string): NewsResult {
  return {
    summary: 'News unavailable — Perplexity API key not configured or request failed.',
    sentiment: 'NEUTRAL', sentimentScore: 0, relevance: 0,
    keyPoints: [], sources: [], query: title, fetchedAt: new Date().toISOString(),
  };
}
