import { NextResponse } from "next/server";
import { INTENTS } from "../../../lib/intents";
import { suggestReplies } from "../../../lib/similarity";
import { applyGeminiRanking, rankWithGemini } from "../../../lib/gemini";

function normalize(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function containsAny(hay: string, needles: string[]) {
  return needles.some((n) => hay.includes(n));
}

function intentText(intent: (typeof INTENTS)[number]) {
  return normalize(
    `${intent.title} ${(intent.tags ?? []).join(" ")} ${intent.examples.join(" ")} ${intent.answer}`.toLowerCase()
  );
}

function routeIntentsByKeywords(question: string, intents: (typeof INTENTS)[number][]) {
  const q = normalize(question).toLowerCase();

  // “한도/증액” 류는 무조건 보증금/입찰한도 관련 답변이 먼저 떠야 함 (룰 기반 후보 축소)
  const limitKw = ["한도", "입찰한도", "증액", "추가입금", "추가 입금", "한도증액", "한도 증액"];
  if (containsAny(q, limitKw)) {
    const picked = intents.filter((it) => {
      const t = intentText(it);
      return containsAny(t, ["보증금", "한도", "입찰한도", "증액", "입금"]);
    });
    if (picked.length) return picked;
  }

  // “사이즈/보증서/사진” 류
  const productInfoKw = ["사이즈", "크기", "보증서", "보증서 사진", "사진", "캡쳐", "캡처", "제품명", "이미지"];
  if (containsAny(q, productInfoKw)) {
    const picked = intents.filter((it) => {
      const t = intentText(it);
      return containsAny(t, ["사이즈", "크기", "보증서", "사진", "캡쳐", "캡처", "제품명", "이미지", "전달해주시면", "확인"]);
    });
    if (picked.length) return picked;
  }

  // “감정서/미도착/재발급” 류
  const certKw = ["감정서", "재발급", "안왔", "미도착", "배송", "발송"];
  if (containsAny(q, certKw)) {
    const picked = intents.filter((it) => {
      const t = intentText(it);
      return containsAny(t, ["감정서", "cas", "발급", "재발급", "발송", "배송"]);
    });
    if (picked.length) return picked;
  }

  return intents;
}

function verdictFrom(confidencePct: number, score: number) {
  // score는 텍스트 유사도(0~1)에 가까운 값. 운영하면서 임계값은 조정 가능.
  // A안: 확정 표현을 피하고, 3단계로만 라벨링.
  if (confidencePct >= 90 && score >= 0.22) return "strong";
  if (confidencePct >= 70 && score >= 0.18) return "normal";
  return "low";
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question : "";

  const trimmed = question.trim();
  if (!trimmed) {
    return NextResponse.json(
      { suggestions: [], error: "question_required" },
      { status: 400 }
    );
  }

  // 1) 기본: 로컬 유사도 기반 후보 생성 (Gemini가 있어도 "후보 집합"은 이걸 사용)
  const routedIntents = routeIntentsByKeywords(trimmed, INTENTS);
  const baseSuggestions = suggestReplies({ intents: routedIntents, question: trimmed, topK: 5 });

  // 2) Gemini가 있으면: 후보 5개를 Top3로 재랭킹(+ confidence/근거)
  const intentsById = new Map(INTENTS.map((i) => [i.id, i]));
  const baseCandidateIntents = baseSuggestions
    .map((s) => intentsById.get(s.intentId))
    .filter(Boolean) as (typeof INTENTS)[number][];

  let modelUsed: "gemini" | "local" = "local";
  let geminiStatus: "missing_key" | "failed" | "ok" = "missing_key";
  let suggestions = baseSuggestions.slice(0, 3);

  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  if (hasGeminiKey) geminiStatus = "failed";

  const geminiRanked = hasGeminiKey
    ? await rankWithGemini({
        question: trimmed,
        candidates: baseCandidateIntents
      }).catch(() => null)
    : null;

  if (geminiRanked?.ranked?.length) {
    suggestions = applyGeminiRanking({
      intentsById,
      baseSuggestions: baseSuggestions.slice(0, 5),
      ranked: geminiRanked.ranked
    });
    modelUsed = "gemini";
    geminiStatus = "ok";
  }

  const top1 = suggestions[0];
  const verdict = top1 ? verdictFrom(top1.confidencePct, top1.score) : "low";

  return NextResponse.json({
    suggestions,
    meta: {
      verdict,
      modelUsed,
      geminiStatus,
      thresholds: {
        strong: ">=90% (and score>=0.22)",
        normal: ">=70% (and score>=0.18)",
        low: "else"
      }
    }
  });
}


