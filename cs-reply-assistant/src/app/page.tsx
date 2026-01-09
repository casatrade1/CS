"use client";

import { useMemo, useState } from "react";

type Suggestion = {
  intentId: string;
  title: string;
  answer: string;
  confidencePct: number;
  score: number;
  reason?: string;
  tags?: string[];
};

export default function HomePage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [verdict, setVerdict] = useState<"strong" | "normal" | "low" | null>(null);
  const [modelUsed, setModelUsed] = useState<"gemini" | "local" | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<
    "missing_key" | "failed" | "ok" | "skipped" | null
  >(null);
  const [geminiError, setGeminiError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pctClass = (pct: number) => {
    if (pct >= 75) return "pctGood";
    if (pct >= 55) return "pctWarn";
    return "pctBad";
  };

  const verdictLabel = (v: "strong" | "normal" | "low") => {
    if (v === "strong") return "강추천";
    if (v === "normal") return "추천";
    return "확신 낮음";
  };

  const verdictHint = (v: "strong" | "normal" | "low") => {
    if (v === "strong") return "대부분 이 답변이 맞을 가능성이 높습니다. 그래도 고객 상황(개인/사업자/캠페인)에 따라 예외 확인 권장.";
    if (v === "normal") return "가능성이 높지만, 핵심 조건(금액/기간/정책)을 한 번 더 확인 권장.";
    return "질문이 애매하거나 데이터가 부족합니다. 질문을 구체화하거나 태그를 선택해 주세요.";
  };

  const canSubmit = useMemo(() => question.trim().length >= 2 && !loading, [question, loading]);

  async function onSuggest() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question })
      });
      const json = (await res.json()) as
        | {
            suggestions: Suggestion[];
            meta?: {
              verdict?: "strong" | "normal" | "low";
              modelUsed?: "gemini" | "local";
              geminiStatus?: "missing_key" | "failed" | "ok" | "skipped";
              geminiError?: string;
            };
          }
        | { error: string };

      if (!res.ok) {
        setSuggestions([]);
        setVerdict(null);
        setError("추천에 실패했습니다. 질문을 조금 더 구체적으로 적어주세요.");
        return;
      }

      setSuggestions((json as any).suggestions ?? []);
      setVerdict(((json as any).meta?.verdict as any) ?? null);
      setModelUsed(((json as any).meta?.modelUsed as any) ?? null);
      setGeminiStatus(((json as any).meta?.geminiStatus as any) ?? null);
      setGeminiError(((json as any).meta?.geminiError as any) ?? null);
    } catch {
      setError("네트워크/서버 오류로 추천에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1 className="title">CS 답변 추천기</h1>
      <p className="subtitle">
        고객 질문을 그대로 붙여넣으면, 가장 그럴듯한 “표준 답변”을 <b>확률(%)</b>로 추천합니다.
        <br />
        (현재 버전은 로컬 유사도 기반 MVP이며, A안 기준으로 <b>강추천/추천/확신 낮음</b> 라벨을 제공합니다.)
      </p>

      <div className="panel">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="예) 보증금은 왜 필요한가요? / 현장경매는 어떻게 진행되나요? / 세금계산서 발행되나요?"
        />
        <div className="row">
          <button className="btn" onClick={onSuggest} disabled={!canSubmit}>
            {loading ? "추천 중..." : "답변 추천"}
          </button>
          <div className="hint">
            {verdict ? (
              <span>
                현재 결과: <b>{verdictLabel(verdict)}</b>
                {modelUsed ? (
                  <>
                    {" "}
                    (판단: <b>{modelUsed === "gemini" ? "Gemini" : "Local"}</b>)
                  </>
                ) : null}{" "}
                {modelUsed === "local" && geminiStatus && geminiStatus !== "ok" ? (
                  <>
                    {" "}
                    <span style={{ opacity: 0.8 }}>
                      [AI 상태:{" "}
                      {geminiStatus === "missing_key"
                        ? "연결 전"
                        : geminiStatus === "skipped"
                          ? "안정(로컬 사용)"
                        : geminiStatus === "failed"
                          ? "점검 중(로컬 사용)"
                          : "정상"}
                      ]
                    </span>
                  </>
                ) : null}
                {modelUsed === "local" && geminiStatus === "failed" && geminiError ? (
                  <>
                    {" "}
                    <span style={{ opacity: 0.75, fontSize: "0.85em" }}>
                      {geminiError.includes("quota_exceeded") ? " (사용량이 많아 로컬 엔진이 대신 답변합니다)" : ""}
                    </span>
                  </>
                ) : null}
                — {verdictHint(verdict)}
              </span>
            ) : (
              <span>Top3를 보여줍니다. (운영하면서 예문을 늘리면 정확도↑)</span>
            )}
          </div>
        </div>
      </div>

      {error ? (
        <p className="subtitle" style={{ marginTop: 14 }}>
          {error}
        </p>
      ) : null}

      {suggestions.length ? (
        <section className="cards" aria-label="추천 답변 목록">
          {suggestions.map((s) => (
            <article key={s.intentId} className="card">
              <div className="cardTop">
                <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                  <div style={{ fontWeight: 800 }}>{s.title}</div>
                  <span className="badge">{s.intentId}</span>
                  {s.tags?.length ? <span className="badge">{s.tags.join(" · ")}</span> : null}
                </div>
                <div style={{ fontWeight: 900 }} className={pctClass(s.confidencePct)}>
                  {s.confidencePct}%
                </div>
              </div>
              <div className="answer">{s.answer}</div>
              <div className="meta">
                {s.reason ? (
                  <>
                    reason: {s.reason}
                    {" · "}
                  </>
                ) : null}
                score: {s.score.toFixed(3)}
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </main>
  );
}


