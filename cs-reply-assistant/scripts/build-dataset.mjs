import fs from "node:fs";
import path from "node:path";

/**
 * 목적:
 * - 카카오 상담 CSV( DATE, USER, MESSAGE )에서
 *   "고객 질문 → 까사트레이드 답변" 후보를 뽑아 `data/extracted_qa.json`로 저장합니다.
 *
 * 주의:
 * - 자동 추출은 오탐이 있을 수 있어 “검수 후 인텐트에 반영”하는 흐름을 권장합니다.
 */

const ROOT = process.cwd();
const DEFAULT_SOURCE_DIR = path.resolve(ROOT, ".."); // 상위 폴더(현재 워크스페이스)에 CSV가 있음
const OUT_DIR = path.resolve(ROOT, "data");
const OUT_FILE = path.resolve(OUT_DIR, "extracted_qa.json");

function parseCsvLoose(content) {
  // 매우 단순한 파서: 현재 CSV는 줄 단위로 3컬럼이며 MESSAGE는 따옴표로 멀티라인이 있을 수 있음.
  // 여기서는 안전하게 "첫 번째 콤마 2개만 분리"하고 나머지는 MESSAGE로 취급.
  const lines = content.split(/\r?\n/);
  const rows = [];
  let headerSeen = false;

  for (let raw of lines) {
    if (!raw) continue;
    if (!headerSeen) {
      headerSeen = true;
      continue; // DATE,USER,MESSAGE
    }

    // 멀티라인 quoted 메시지를 완벽히 처리하려면 CSV 파서가 필요하지만,
    // 이 스크립트는 “후보 생성용”이므로 간단히 처리.
    const first = raw.indexOf(",");
    const second = first >= 0 ? raw.indexOf(",", first + 1) : -1;
    if (first < 0 || second < 0) continue;

    const DATE = raw.slice(0, first).trim();
    const USER = raw.slice(first + 1, second).trim();
    let MESSAGE = raw.slice(second + 1).trim();
    if (MESSAGE.startsWith('"') && MESSAGE.endsWith('"')) {
      MESSAGE = MESSAGE.slice(1, -1);
    }

    rows.push({ DATE, USER, MESSAGE });
  }
  return rows;
}

function isCustomerUser(user) {
  if (!user) return false;
  // "까사트레이드" 또는 "까사트레이드(메뉴)" 등은 회사측
  return !user.includes("까사트레이드");
}

function isCompanyUser(user) {
  return Boolean(user?.includes("까사트레이드"));
}

function normalizeMessage(msg) {
  return (msg ?? "").replace(/\s+/g, " ").trim();
}

function looksLikeAttachment(msg) {
  const m = normalizeMessage(msg).toLowerCase();
  return m === "사진" || m.endsWith(".pdf") || m.endsWith(".jpg") || m.endsWith(".png");
}

function extractPairs(rows) {
  // 단순 규칙:
  // - 고객 메시지(질문) 1개를 기준으로,
  // - 이후 등장하는 회사 메시지들을 연속으로 묶어 답변으로 취급(첨부/메뉴는 제외)
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isCustomerUser(r.USER)) continue;
    const q = normalizeMessage(r.MESSAGE);
    if (!q || looksLikeAttachment(q)) continue;
    if (q.length < 2) continue;

    // 다음 회사 답변 모으기
    const answers = [];
    let j = i + 1;
    while (j < rows.length) {
      const n = rows[j];
      // 다음 고객 메시지가 나오면 답변 블록 종료
      if (isCustomerUser(n.USER)) break;
      if (isCompanyUser(n.USER)) {
        const a = normalizeMessage(n.MESSAGE);
        // 메뉴 버튼/링크 단독/사진 단독 등은 제외
        if (a && !looksLikeAttachment(a)) answers.push(a);
      }
      j++;
    }

    const aText = answers
      .filter((x) => x !== "안녕하세요. 무엇을 도와드릴까요?")
      .join("\n");

    if (aText && aText.length >= 6) {
      pairs.push({
        askedAt: r.DATE,
        customer: r.USER,
        question: q,
        answer: aText
      });
    }
  }
  return pairs;
}

function listCsvFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".csv"))
    .map((e) => path.join(dir, e.name));
}

function main() {
  const sourceDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_SOURCE_DIR;
  const csvFiles = listCsvFiles(sourceDir);

  const allPairs = [];
  for (const file of csvFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const rows = parseCsvLoose(content);
    const pairs = extractPairs(rows).map((p) => ({ ...p, sourceFile: path.basename(file) }));
    allPairs.push(...pairs);
  }

  // 간단 중복 제거(질문+답변 기준)
  const uniq = new Map();
  for (const p of allPairs) {
    const key = `${p.question}||${p.answer}`;
    if (!uniq.has(key)) uniq.set(key, p);
  }

  const out = Array.from(uniq.values());
  out.sort((a, b) => (a.askedAt < b.askedAt ? -1 : 1));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf-8");

  console.log(`[ok] extracted pairs: ${out.length}`);
  console.log(`[ok] wrote: ${OUT_FILE}`);
  console.log(`[hint] source dir: ${sourceDir}`);
}

main();


