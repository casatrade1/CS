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

function actionlessPenalty(answer: string): number {
  const a = normalizeWhitespace(answer);
  // 너무 짧은 “확인/감사/가능” 류는 추천에서 뒤로 보내기
  if (a.length <= 18) return 0.35;
  if (a.length <= 35) return 0.55;

  const patterns = [
    /^네[,.\s]/,
    /^안녕하세요[,.\s]$/,
    /내용\s*전달\s*받았/,
    /감사합니다[.!]?$/,
    /확인\s*후\s*답변/,
    /가능합니다[.!]?$/,
    /확인했습니다[.!]?$/
  ];
  if (patterns.some((re) => re.test(a))) return 0.6;

  return 1;
}

function keywordBonus(params: { question: string; intent: Intent }): number {
  const q = normalizeWhitespace(params.question).toLowerCase();
  const hay = normalizeWhitespace(
    `${params.intent.title} ${params.intent.tags?.join(" ") ?? ""} ${params.intent.examples.join(" ")} ${
      params.intent.answer
    }`
  ).toLowerCase();

  // 운영에서 자주 쓰는 핵심 키워드들: 특정 키워드가 질문에 나오면, 그 키워드가 포함된 인텐트에 보너스
  const rules: Array<{ when: string[]; boostIfContains: string[]; bonus: number }> = [
    { when: ["배송", "출고", "송장", "도착"], boostIfContains: ["배송", "출고", "송장"], bonus: 0.15 },
    { when: ["한도", "증액", "보증금", "입금"], boostIfContains: ["한도", "증액", "보증금"], bonus: 0.15 },
    { when: ["감정", "cas", "발급"], boostIfContains: ["감정", "발급"], bonus: 0.1 },
    { when: ["수선", "수리"], boostIfContains: ["수선", "비용"], bonus: 0.1 }
  ];

  let bonus = 0;
  for (const r of rules) {
    if (!r.when.some((w) => q.includes(w))) continue;
    const hits = r.boostIfContains.filter((k) => hay.includes(k)).length;
    if (hits > 0) bonus += r.bonus;
  }
  return bonus;
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
      let score = cosine(qVec, dVec);
      score *= actionlessPenalty(intent.answer);
      score += keywordBonus({ question, intent });
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


