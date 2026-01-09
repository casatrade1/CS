import fs from "node:fs";
import path from "node:path";

/**
 * CSV(카카오 상담 로그) -> intents.generated.ts 자동 생성기
 *
 * 입력:
 * - 기본: 프로젝트 상위 폴더(../)에서 *.csv 파일을 전부 읽음
 * - 커맨드로 경로 지정 가능: node scripts/generate-intents-from-csv.mjs /path/to/csvDir
 *
 * 출력:
 * - src/lib/intents.generated.ts
 *
 * 설계 원칙:
 * - “질문→답변” 쌍을 뽑고, 답변 템플릿(정규화된 answer) 기준으로 그룹핑
 * - 각 그룹의 상위 질문들을 examples로 넣어 추천 정확도 향상
 * - 개인/계좌/전화/메일 등 PII는 기본 마스킹(완벽하지 않음 → 추가 강화 가능)
 */

const ROOT = process.cwd();
const DEFAULT_SOURCE_DIR = path.resolve(ROOT, ".."); // /06_CS프로그램
const OUT_FILE = path.resolve(ROOT, "src/lib/intents.generated.ts");

function listCsvFilesInDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".csv"))
    .map((e) => path.join(dir, e.name));
}

function resolveInputs(args) {
  // args가 없으면 기본 디렉토리 1개
  const inputs = args.length ? args : [DEFAULT_SOURCE_DIR];

  const files = [];
  for (const input of inputs) {
    const p = path.resolve(input);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      files.push(...listCsvFilesInDir(p));
    } else if (st.isFile() && p.toLowerCase().endsWith(".csv")) {
      files.push(p);
    }
  }

  // 중복 제거
  return Array.from(new Set(files));
}

function parseCsv(content) {
  // RFC4180 스타일의 단순 state machine
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = content[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }

    if (ch === "\r") continue;

    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  // header 제거 + 3컬럼 강제
  const data = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx];
    if (idx === 0) continue; // DATE,USER,MESSAGE
    if (!r || r.length < 3) continue;
    const [DATE, USER, ...rest] = r;
    const MESSAGE = rest.join(","); // 혹시 콤마가 더 있으면 합치기
    data.push({
      DATE: (DATE ?? "").trim(),
      USER: (USER ?? "").trim(),
      MESSAGE: (MESSAGE ?? "").trim()
    });
  }
  return data;
}

function normalizeSpace(s) {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function isCompanyUser(user) {
  return String(user || "").includes("까사트레이드");
}

function isCustomerUser(user) {
  return user && !isCompanyUser(user);
}

function looksLikeAttachment(msg) {
  const m = normalizeSpace(msg).toLowerCase();
  return (
    m === "사진" ||
    m.endsWith(".pdf") ||
    m.endsWith(".jpg") ||
    m.endsWith(".jpeg") ||
    m.endsWith(".png") ||
    m.endsWith(".gif")
  );
}

function redactPII(text) {
  let t = String(text || "");

  // email
  t = t.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<EMAIL>");
  // phone (KR)
  t = t.replace(/\b(01[016789]|02|0[3-6][1-5])[-\s]?\d{3,4}[-\s]?\d{4}\b/g, "<PHONE>");
  // id/password 라벨 기반(공백/개행 포함 케이스)
  t = t.replace(/(비밀번호|password)\s*[:：]\s*[^\s,]+/gi, "$1: <PASSWORD>");
  t = t.replace(/(아이디|id)\s*[:：]\s*[^\s,]+/gi, "$1: <ID>");
  // 금액(원/엔) 일반화: 답변 템플릿을 “상황의존 값” 없이 재사용 가능하게
  t = t.replace(/\b\d{1,3}(,\d{3})+(원|¥)\b/g, "<AMOUNT>$2");
  t = t.replace(/\b\d+(원|¥)\b/g, "<AMOUNT>$1");
  // long digits (account/order/approval) - keep short amounts like 99,000
  t = t.replace(/\b\d{6,}\b/g, "<NUM>");
  // url
  t = t.replace(/https?:\/\/\S+/g, "<URL>");
  // usernames like @Reed1004
  t = t.replace(/@[A-Za-z0-9_]{3,}/g, "@<USER>");

  return t;
}

function normalizeForGrouping(answer) {
  // 그룹핑용: 숫자/URL 변형을 줄여 템플릿끼리 뭉치게
  let a = normalizeSpace(answer);
  a = redactPII(a);
  a = a.replace(/<NUM>/g, "<NUM>"); // noop (명시)
  // 날짜 형태도 뭉치기
  a = a.replace(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, "<DATE>");
  // 금액 “xx,xxx원”은 숫자만 마스킹
  a = a.replace(/\b\d{1,3}(,\d{3})+원\b/g, "<AMOUNT>원");
  return a;
}

function extractPairs(rows) {
  // 규칙:
  // - 고객 연속 메시지 블록 => 질문
  // - 다음 회사 연속 메시지 블록(메뉴/첨부 제외) => 답변
  const pairs = [];

  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (!isCustomerUser(r.USER)) {
      i++;
      continue;
    }

    // 질문 블록
    const qParts = [];
    let askedAt = r.DATE;
    let customer = r.USER;
    while (i < rows.length && isCustomerUser(rows[i].USER)) {
      const q = normalizeSpace(rows[i].MESSAGE);
      if (q && !looksLikeAttachment(q)) qParts.push(q);
      i++;
    }

    const question = redactPII(normalizeSpace(qParts.join(" ")));
    if (question.length < 2) continue;

    // 답변 블록
    const aParts = [];
    while (i < rows.length && isCompanyUser(rows[i].USER)) {
      const a = normalizeSpace(rows[i].MESSAGE);
      if (
        a &&
        !looksLikeAttachment(a) &&
        a !== "안녕하세요. 무엇을 도와드릴까요?" &&
        !a.startsWith("까사트레이드(메뉴)")
      ) {
        aParts.push(a);
      }
      i++;
    }

    const answer = redactPII(aParts.join("\n"));
    if (normalizeSpace(answer).length < 6) continue;

    pairs.push({ askedAt, customer, question, answer });
  }

  return pairs;
}

function makeId(idx) {
  return `csv_${String(idx).padStart(3, "0")}`;
}

function guessTitle(keyAnswer, examples) {
  const a = keyAnswer;
  const pool = `${a} ${examples.join(" ")}`;
  const pick = (kw, title) => (pool.includes(kw) ? title : null);

  return (
    pick("보증금", "보증금/입찰한도 안내") ||
    pick("세금계산서", "세금계산서/현금영수증") ||
    pick("현장경매", "현장경매(3단계) 안내") ||
    pick("직접경매", "직접경매 안내") ||
    pick("수선", "수선 진행/비용 안내") ||
    pick("감정", "감정(CAS)/감정서 안내") ||
    pick("배송", "배송/출고 안내") ||
    pick("입점신청", "회원가입/입점신청 안내") ||
    pick("이용가이드", "이용가이드/링크 안내") ||
    pick("수수료", "수수료/결제 금액 안내") ||
    "기타 문의"
  );
}

function toTs(intentObjs) {
  const header = `// THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.\n// Generated by scripts/generate-intents-from-csv.mjs\n\nimport type { Intent } from "./types";\n\nexport const GENERATED_INTENTS: Intent[] = `;
  const body = JSON.stringify(intentObjs, null, 2);
  return `${header}${body} as Intent[];\n`;
}

function main() {
  // 사용법:
  // - 기본: (인자 없음) ../ 안의 *.csv
  // - 특정 폴더: node ... /path/to/dir
  // - 특정 파일: node ... /path/to/file.csv
  // - 여러 개: node ... /dir1 /file2.csv /dir3
  const csvFiles = resolveInputs(process.argv.slice(2));

  // Vercel/CI처럼 CSV가 레포에 없을 수 있음.
  // 이 경우 기존 intents.generated.ts를 "빈 값으로 덮어쓰면" 오히려 망하므로 아무 것도 하지 않고 종료.
  if (csvFiles.length === 0) {
    console.log(`[skip] no csv files found in inputs. default would be: ${DEFAULT_SOURCE_DIR}`);
    console.log(`[skip] keep existing: ${OUT_FILE}`);
    return;
  }

  const allPairs = [];
  for (const file of csvFiles) {
    const content = fs.readFileSync(file, "utf-8");
    const rows = parseCsv(content);
    const pairs = extractPairs(rows).map((p) => ({ ...p, sourceFile: path.basename(file) }));
    allPairs.push(...pairs);
  }

  // answer template 기준 그룹핑
  const groups = new Map(); // keyAnswer -> {count, answers[], questionsSet, sourcesSet}
  for (const p of allPairs) {
    const key = normalizeForGrouping(p.answer);
    if (!groups.has(key)) {
      groups.set(key, {
        keyAnswer: key,
        count: 0,
        answers: new Map(), // original answer -> count
        questions: new Set(),
        sources: new Set()
      });
    }
    const g = groups.get(key);
    g.count++;
    g.answers.set(p.answer, (g.answers.get(p.answer) ?? 0) + 1);
    g.questions.add(p.question);
    g.sources.add(p.sourceFile);
  }

  // 빈약한 그룹 제거(너무 짧거나 의미 없는 응답)
  const sorted = Array.from(groups.values())
    .filter((g) => g.keyAnswer.length >= 10 && g.questions.size >= 1)
    .sort((a, b) => b.count - a.count);

  const intents = [];
  let idx = 1;
  for (const g of sorted) {
    // canonical answer: 가장 많이 나온 원문 답변
    let bestAnswer = "";
    let bestCount = -1;
    for (const [ans, c] of g.answers.entries()) {
      if (c > bestCount) {
        bestCount = c;
        bestAnswer = ans;
      }
    }

    const examples = Array.from(g.questions)
      .map((q) => normalizeSpace(q))
      .filter(Boolean)
      .slice(0, 12);

    // tags 추정
    const title = guessTitle(g.keyAnswer, examples);
    const tags = title.split(/[\/() ]+/).filter(Boolean).slice(0, 4);

    intents.push({
      id: makeId(idx++),
      title,
      tags,
      examples,
      // bestAnswer는 원문이라 “현재 한도 100,000원” 같은 값이 섞일 수 있음 → 템플릿(answerKey)로 일반화
      answer: normalizeForGrouping(bestAnswer).replace(/\n{3,}/g, "\n\n"),
      // 디버깅용 메타는 타입에 없으니 answer에 넣지 않고 title/tags로만
      // sources/count는 필요하면 별도 파일로 확장 가능
    });
  }

  fs.writeFileSync(OUT_FILE, toTs(intents), "utf-8");

  console.log(`[ok] csv files: ${csvFiles.length}`);
  console.log(`[ok] pairs: ${allPairs.length}`);
  console.log(`[ok] intents: ${intents.length}`);
  console.log(`[ok] wrote: ${OUT_FILE}`);
}

main();


