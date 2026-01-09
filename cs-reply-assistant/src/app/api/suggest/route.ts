import { NextResponse } from "next/server";
import { INTENTS } from "@/lib/intents";
import { suggestReplies } from "@/lib/similarity";
import { applyGeminiRanking, rankWithGemini } from "@/lib/gemini";

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
  const baseSuggestions = suggestReplies({ intents: INTENTS, question: trimmed, topK: 5 });

  // 2) Gemini가 있으면: 후보 5개를 Top3로 재랭킹(+ confidence/근거)
  const intentsById = new Map(INTENTS.map((i) => [i.id, i]));
  const baseCandidateIntents = baseSuggestions
    .map((s) => intentsById.get(s.intentId))
    .filter(Boolean) as (typeof INTENTS)[number][];

  let modelUsed: "gemini" | "local" = "local";
  let suggestions = baseSuggestions.slice(0, 3);

  const geminiRanked = await rankWithGemini({
    question: trimmed,
    candidates: baseCandidateIntents
  });

  if (geminiRanked?.ranked?.length) {
    suggestions = applyGeminiRanking({
      intentsById,
      baseSuggestions: baseSuggestions.slice(0, 3),
      ranked: geminiRanked.ranked
    });
    modelUsed = "gemini";
  }

  const top1 = suggestions[0];
  const verdict = top1 ? verdictFrom(top1.confidencePct, top1.score) : "low";

  return NextResponse.json({
    suggestions,
    meta: {
      verdict,
      modelUsed,
      thresholds: {
        strong: ">=90% (and score>=0.22)",
        normal: ">=70% (and score>=0.18)",
        low: "else"
      }
    }
  });
}


