import type { Intent, Suggestion } from "./types";

type GeminiRanked = {
  intentId: string;
  confidencePct: number;
  reason: string;
};

function buildPrompt(params: { question: string; candidates: Intent[] }) {
  const { question, candidates } = params;

  // 답변 "생성"이 아니라 "선택/랭킹"만 시키기(정책/금액 환각 방지)
  return `
너는 고객센터(CS) "답변 라우팅" 모델이다.
입력된 고객 질문에 대해, 아래 후보 답변(인텐트) 중에서 가장 적합한 것을 고르고 Top 3로 랭킹하라.

중요 규칙:
1) 반드시 후보 목록 안에서만 고른다. (새 답변 생성 금지)
2) 출력은 JSON만. 설명 텍스트/마크다운/코드펜스 금지.
3) confidencePct는 0~100 정수. Top3 합이 100이 되면 가장 좋다(필수는 아님).
4) reason은 1줄(20~60자 내)로 간단히 "왜 이 후보가 맞는지"만.

고객 질문:
${JSON.stringify(question)}

후보 목록(JSON):
${JSON.stringify(
    candidates.map((c) => ({
      id: c.id,
      title: c.title,
      // answer는 길어서 핵심만: 앞부분만 전달
      answerPreview: c.answer.slice(0, 220),
      examples: c.examples.slice(0, 6)
    })),
    null,
    2
  )}

반드시 아래 형태로만 응답:
{"ranked":[{"intentId":"...","confidencePct":90,"reason":"..."},{"intentId":"...","confidencePct":8,"reason":"..."},{"intentId":"...","confidencePct":2,"reason":"..."}]}
`.trim();
}

export async function rankWithGemini(params: {
  question: string;
  candidates: Intent[];
}): Promise<{ ranked: GeminiRanked[] } | { error: { status?: number; message: string } } | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // Google Generative Language API (v1beta)
  // 모델은 필요하면 바꿀 수 있음: gemini-1.5-flash / gemini-1.5-pro 등
  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = buildPrompt(params);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512
      }
    })
  });

  if (!res.ok) {
    const msgText = await res.text().catch(() => "");
    const snippet = msgText.slice(0, 300);
    return {
      error: {
        status: res.status,
        message: snippet || `Gemini request failed with status ${res.status}`
      }
    };
  }

  const data = (await res.json().catch(() => null)) as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") return null;

  // 모델 출력이 JSON만 오도록 요청했지만, 혹시를 대비해 JSON 부분만 최대한 추출
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;

  const jsonStr = text.slice(start, end + 1);
  const parsed = JSON.parse(jsonStr) as { ranked?: GeminiRanked[] };
  if (!parsed?.ranked || !Array.isArray(parsed.ranked)) return null;

  const ranked = parsed.ranked
    .filter(
      (r) =>
        typeof r?.intentId === "string" &&
        typeof r?.confidencePct === "number" &&
        typeof r?.reason === "string"
    )
    .map((r) => ({
      intentId: r.intentId,
      confidencePct: Math.max(0, Math.min(100, Math.round(r.confidencePct))),
      reason: r.reason.trim().slice(0, 120)
    }))
    .slice(0, 3);

  if (!ranked.length) return null;
  return { ranked };
}

export function applyGeminiRanking(params: {
  intentsById: Map<string, Intent>;
  baseSuggestions: Suggestion[];
  ranked: { intentId: string; confidencePct: number; reason: string }[];
}): Suggestion[] {
  const { intentsById, baseSuggestions, ranked } = params;
  const baseById = new Map(baseSuggestions.map((s) => [s.intentId, s]));

  const out: Suggestion[] = [];
  for (const r of ranked) {
    const intent = intentsById.get(r.intentId);
    if (!intent) continue;

    const base = baseById.get(r.intentId);
    out.push({
      intentId: intent.id,
      title: intent.title,
      answer: intent.answer,
      tags: intent.tags,
      score: base?.score ?? 0,
      confidencePct: r.confidencePct,
      reason: r.reason
    });
  }

  // Gemini가 3개를 못 채운 경우: baseSuggestions로 보충
  for (const s of baseSuggestions) {
    if (out.length >= 3) break;
    if (out.some((x) => x.intentId === s.intentId)) continue;
    out.push(s);
  }

  return out.slice(0, 3);
}


