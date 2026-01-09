import type { Intent, Suggestion } from "./types";

type Vector = Map<string, number>;

function normalizeWhitespace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function toNgrams(text: string, n = 3): string[] {
  const t = normalizeWhitespace(text.toLowerCase());
  if (!t) return [];
  // 한글 형태소 분석 없이도 어느 정도 먹히는 방법: 문자 n-gram
  const padded = ` ${t} `;
  const grams: string[] = [];
  for (let i = 0; i <= padded.length - n; i++) grams.push(padded.slice(i, i + n));
  return grams;
}

function tf(tokens: string[]): Vector {
  const v: Vector = new Map();
  for (const tok of tokens) v.set(tok, (v.get(tok) ?? 0) + 1);
  // log-tf
  for (const [k, c] of v) v.set(k, 1 + Math.log(c));
  return v;
}

function cosine(a: Vector, b: Vector): number {
  let dot = 0;
  let na = 0;
  let nb = 0;

  for (const [, av] of a) na += av * av;
  for (const [, bv] of b) nb += bv * bv;

  // iterate smaller map for dot
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [k, sv] of small) {
    const lv = large.get(k);
    if (lv) dot += sv * lv;
  }

  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function softmax(scores: number[], temperature = 0.18): number[] {
  // temperature 낮을수록 top1이 더 강해짐
  const t = Math.max(0.05, temperature);
  const max = Math.max(...scores, 0);
  const exps = scores.map((s) => Math.exp((s - max) / t));
  const sum = exps.reduce((acc, v) => acc + v, 0) || 1;
  return exps.map((v) => v / sum);
}

export function suggestReplies(params: {
  intents: Intent[];
  question: string;
  topK?: number;
}): Suggestion[] {
  const { intents, question } = params;
  const topK = Math.max(1, Math.min(params.topK ?? 3, 5));

  const qTokens = toNgrams(question);
  const qVec = tf(qTokens);

  const scored = intents
    .map((intent) => {
      // intent 문서 벡터는 examples 전체를 합친 텍스트로 구성
      const doc = intent.examples.join(" / ") + " " + intent.title;
      const dVec = tf(toNgrams(doc));
      const score = cosine(qVec, dVec);
      return { intent, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const probs = softmax(scored.map((s) => s.score));

  return scored.map(({ intent, score }, idx) => ({
    intentId: intent.id,
    title: intent.title,
    answer: intent.answer,
    confidencePct: Math.round(probs[idx] * 100),
    score,
    tags: intent.tags
  }));
}


