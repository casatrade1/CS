import type { Intent, Suggestion } from "./types";

type GeminiRanked = {
  intentId: string;
  confidencePct: number;
  reason: string;
};

let cachedModelNames: string[] | null = null;
let cachedModelNamesAt = 0;

type GeminiResult =
  | { ranked: GeminiRanked[] }
  | { error: { status?: number; message: string } }
  | null;

const geminiCache = new Map<string, { at: number; value: GeminiResult }>();
const GEMINI_CACHE_TTL_MS = 10 * 60 * 1000;

let geminiCircuitOpenUntil = 0;
const GEMINI_CIRCUIT_TTL_MS = 5 * 60 * 1000;

function cacheKey(params: { question: string; candidates: Intent[] }) {
  const ids = params.candidates.map((c) => c.id).join(",");
  return `${params.question.trim()}\n::${ids}`;
}

async function listAvailableModelNames(apiKey: string): Promise<string[] | null> {
  const now = Date.now();
  if (cachedModelNames && now - cachedModelNamesAt < 5 * 60 * 1000) return cachedModelNames;

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
    apiKey
  )}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return null;

  const data = (await res.json().catch(() => null)) as any;
  const models = Array.isArray(data?.models) ? data.models : [];

  const supported = models
    .filter((m: any) => {
      const methods = m?.supportedGenerationMethods;
      if (!Array.isArray(methods)) return true;
      return methods.includes("generateContent");
    })
    .map((m: any) => String(m?.name || ""))
    .filter(Boolean)
    .map((n: string) => (n.startsWith("models/") ? n.slice("models/".length) : n))
    .filter((n: string) => n && n.includes("gemini"));

  cachedModelNames = supported;
  cachedModelNamesAt = now;
  return supported;
}

function preferModels(names: string[]): string[] {
  const score = (n: string) => {
    const s = n.toLowerCase();
    let v = 0;
    if (s.includes("flash")) v += 50;
    if (s.includes("pro")) v += 30;
    if (s.includes("latest")) v += 20;
    if (s.includes("3") || s.includes("2")) v += 10; // 숫자는 힌트 정도
    if (s.includes("exp") || s.includes("preview")) v -= 5;
    return -v;
  };
  return Array.from(new Set(names)).sort((a, b) => score(a) - score(b));
}

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
}): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const now = Date.now();
  if (now < geminiCircuitOpenUntil) {
    return {
      error: {
        status: 429,
        message: "quota_exceeded (circuit_open)"
      }
    };
  }

  const key = cacheKey(params);
  const hit = geminiCache.get(key);
  if (hit && now - hit.at < GEMINI_CACHE_TTL_MS) return hit.value;

  // Google Generative Language API (v1beta)
  // 모델은 필요하면 바꿀 수 있음: gemini-1.5-flash / gemini-1.5-pro 등
  const prompt = buildPrompt(params);

  const hardcodedTryModels = [
    process.env.GEMINI_MODEL,
    // 실무에서 가장 흔히 통하는 별칭들(환경/시점에 따라 일부는 404가 날 수 있음 → 순차 fallback)
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash-001",
    "gemini-1.5-flash",
    "gemini-1.5-pro-latest",
    "gemini-1.5-pro-001",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite"
  ].filter(Boolean) as string[];

  let lastErr: { status?: number; message: string } | undefined;
  let data: any = null;

  const callWithModel = async (model: string) => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

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

    if (res.ok) {
      data = (await res.json().catch(() => null)) as any;
      // 성공하면 여기서 break
      lastErr = undefined;
      return { done: true };
    }

    // 모델명 404면 다음 후보로 fallback
    const msgText = await res.text().catch(() => "");
    const snippet = msgText.slice(0, 220);
    const isQuota =
      res.status === 429 ||
      snippet.toLowerCase().includes("exceeded your current quota") ||
      snippet.includes('"code": 429');
    lastErr = {
      status: res.status,
      message:
        (isQuota ? "quota_exceeded " : "") +
        `model=${model} ` +
        (snippet || `Gemini request failed with status ${res.status}`)
    };

    if (isQuota) {
      // 더 두드리면 더 막히기만 하니 잠깐 서킷 오픈
      geminiCircuitOpenUntil = Date.now() + GEMINI_CIRCUIT_TTL_MS;
      return { done: true };
    }

    if (res.status === 404) {
      // 404면 다음 모델로 시도
      return { done: false };
    }
    // 401/403 등은 모델 바꿔도 해결 안 될 가능성이 높으니 즉시 종료
    return { done: true };
  };

  // 1) 먼저 하드코딩 후보들만 시도 (모델 목록 조회는 쿼터/레이트에 영향을 줄 수 있어 최소화)
  for (const model of hardcodedTryModels) {
    const r = await callWithModel(model);
    if (r?.done) break;
  }

  // 2) 하드코딩이 전부 404였던 경우에만: API에서 실제 모델 목록을 조회해서 시도
  if (!data && lastErr?.status === 404) {
    const available = (await listAvailableModelNames(apiKey).catch(() => null)) || [];
    const discoveredTryModels = preferModels(available).slice(0, 12);
    for (const model of discoveredTryModels) {
      const r = await callWithModel(model);
      if (r?.done) break;
    }
  }

  if (!data) {
    const out = lastErr ? ({ error: lastErr } as const) : null;
    geminiCache.set(key, { at: now, value: out });
    return out;
  }

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
  const out = { ranked } as const;
  geminiCache.set(key, { at: now, value: out });
  return out;
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


