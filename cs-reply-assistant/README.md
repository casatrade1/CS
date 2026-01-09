# CS 답변 추천기 (MVP)

고객 질문을 입력하면, 내부 “표준 답변” 후보를 **신뢰도(%)**와 함께 Top N으로 추천해주는 웹앱입니다.  
Vercel 배포를 전제로 `Next.js`(App Router)로 구성했습니다.

## 핵심 컨셉

- 질문 → 인텐트(질문 유형) 후보 Top3 추천
- 신뢰도(%)는 모델의 “정답 보장”이 아니라 **유사도 기반 점수의 확률화(softmax)** 입니다.
- 초기 MVP는 외부 API 없이 동작(로컬 유사도 기반). 이후 OpenAI/Claude 등을 붙이면 정확도 급상승.

## 로컬 실행

```bash
cd cs-reply-assistant
npm install
npm run dev
```

브라우저에서 `http://localhost:3000` 접속

## 데이터 보강(선택)

현재는 `src/lib/intents.ts`에 인텐트/예문/답변을 수동으로 넣는 방식입니다.  
CSV 로그에서 Q/A 후보를 뽑아 참고 데이터로 만들려면:

```bash
cd cs-reply-assistant
npm run build-dataset
```

생성물: `data/extracted_qa.json` (추천 엔진에는 아직 “자동 반영”하지 않고, 사람이 검수 후 인텐트에 반영하는 흐름을 추천)

## Vercel 배포(초보용)

1. GitHub에 `cs-reply-assistant` 폴더를 레포로 올립니다(Private 추천).
2. Vercel에서 **New Project → Import Git Repository**
3. Framework는 자동으로 Next.js 인식
4. (선택) Gemini를 쓰려면 Vercel 프로젝트 Settings → Environment Variables에 아래 추가
   - `GEMINI_API_KEY`: Google AI Studio에서 발급한 API Key
   - `GEMINI_MODEL`: (선택) 기본값 `gemini-1.5-flash`
5. Deploy 클릭

## 보안 메모(중요)

CSV 대화에는 계좌/아이디/비번 등 민감정보가 섞일 수 있습니다.
- 이 MVP는 “질문 입력”만 처리하고, CSV 원문을 서버에 업로드/저장하지 않습니다.
- 나중에 CSV 업로드 기능을 넣을 경우, **마스킹/권한/감사로그**는 필수로 넣어야 합니다.

## Gemini 연동 동작 방식(중요)

- API Key가 **있으면**: 로컬 유사도로 뽑은 후보 5개를 Gemini가 **Top3로 재랭킹**하고 %를 제공합니다.
- API Key가 **없으면/에러면**: 기존 로컬 유사도 기반 추천으로 자동 fallback됩니다.



