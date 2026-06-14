// ============================================
// Zule AI — Sentiment Analyzer & Coaching
// ============================================

export interface SentimentResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  score: number; // -1 to 1
  fillerCount: number;
  fillerWords: string[];
  wordsPerMinute: number;
  confidenceScore: number; // 0-100
}

const POSITIVE_WORDS = new Set([
  'great', 'excellent', 'amazing', 'fantastic', 'wonderful', 'perfect', 'love',
  'brilliant', 'outstanding', 'impressive', 'definitely', 'absolutely', 'excited',
  'thrilled', 'passionate', 'innovative', 'successful', 'achieved', 'accomplished',
  'strong', 'confident', 'effective', 'efficient', 'improved', 'growth', 'opportunity',
]);

const NEGATIVE_WORDS = new Set([
  'bad', 'terrible', 'awful', 'horrible', 'worst', 'hate', 'disappointed',
  'frustrated', 'confused', 'worried', 'concerned', 'unfortunately', 'failed',
  'struggling', 'difficult', 'problem', 'issue', 'wrong', 'mistake', 'error',
  'unclear', 'complicated', 'impossible', 'never', 'cannot',
]);

const FILLER_WORDS = [
  'um', 'uh', 'uhh', 'umm', 'like', 'you know', 'basically', 'actually',
  'literally', 'honestly', 'obviously', 'right', 'so yeah', 'I mean',
  'kind of', 'sort of', 'I guess', 'you see',
];

export function analyzeSentiment(text: string): Pick<SentimentResult, 'sentiment' | 'score'> {
  const words = text.toLowerCase().split(/\s+/);
  let positiveCount = 0;
  let negativeCount = 0;

  for (const word of words) {
    if (POSITIVE_WORDS.has(word)) positiveCount++;
    if (NEGATIVE_WORDS.has(word)) negativeCount++;
  }

  const total = positiveCount + negativeCount;
  if (total === 0) return { sentiment: 'neutral', score: 0 };

  const score = (positiveCount - negativeCount) / total;
  const sentiment = score > 0.1 ? 'positive' : score < -0.1 ? 'negative' : 'neutral';

  return { sentiment, score };
}

export function countFillers(text: string): { count: number; found: string[] } {
  const lower = text.toLowerCase();
  const found: string[] = [];
  let count = 0;

  for (const filler of FILLER_WORDS) {
    const regex = new RegExp(`\\b${filler}\\b`, 'gi');
    const matches = lower.match(regex);
    if (matches) {
      count += matches.length;
      for (let i = 0; i < matches.length; i++) {
        found.push(filler);
      }
    }
  }

  return { count, found };
}

export function calculateWPM(wordCount: number, durationSeconds: number): number {
  if (durationSeconds <= 0) return 0;
  return Math.round((wordCount / durationSeconds) * 60);
}

export function calculateConfidence(wpm: number, fillerRatio: number): number {
  // Ideal speaking pace: 120-160 WPM
  let paceScore = 100;
  if (wpm < 80) paceScore = 40 + (wpm / 80) * 30;
  else if (wpm < 120) paceScore = 70 + ((wpm - 80) / 40) * 20;
  else if (wpm <= 160) paceScore = 90 + ((wpm - 120) / 40) * 10;
  else if (wpm <= 200) paceScore = 100 - ((wpm - 160) / 40) * 15;
  else paceScore = 85 - ((wpm - 200) / 50) * 20;

  // Filler ratio penalty: 0% fillers = 100, 10%+ = significant penalty
  const fillerScore = Math.max(0, 100 - fillerRatio * 500);

  // Weighted combination
  const confidence = Math.round(paceScore * 0.4 + fillerScore * 0.6);
  return Math.max(0, Math.min(100, confidence));
}

export function getFullAnalysis(
  text: string,
  totalWordCount: number,
  durationSeconds: number
): SentimentResult {
  const { sentiment, score } = analyzeSentiment(text);
  const { count: fillerCount, found: fillerWords } = countFillers(text);
  const wordsPerMinute = calculateWPM(totalWordCount, durationSeconds);
  const wordCount = text.split(/\s+/).length;
  const fillerRatio = wordCount > 0 ? fillerCount / wordCount : 0;
  const confidenceScore = calculateConfidence(wordsPerMinute, fillerRatio);

  return {
    sentiment,
    score,
    fillerCount,
    fillerWords,
    wordsPerMinute,
    confidenceScore,
  };
}
