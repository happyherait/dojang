# 도장 (Dojang)

결재를 받아야만 일할 수 있는 AI 신입사원.

사내 업무를 채팅으로 맡기면 AI가 처리안을 만들고, 권한을 넘는 일은 한국 기업의 전결 규정과 결재선에 따라 사람의 승인을 받은 뒤에만 실행합니다.

> 핵심 원칙: **LLM은 제안만 합니다. 승인 판단과 실행 허가는 서버 코드가 맡습니다.**

## 진행 상황

| 주차 | 범위 | 상태 |
|---|---|---|
| 1 | 모노레포, DB, 인증, 전결 규정 엔진, 가상 ERP MCP 서버 | 완료 |
| 2 | 에이전트, 스트리밍 채팅, 결재 정지/재개 | 완료 |
| 3 | 채팅 UI, 결재 카드, 역할 전환, 감사 타임라인 | 완료 |
| 4 | PDF 공격 데모, 평가, 추적, 문서 | 완료 |

## 구조

```text
apps/
  api/        인증, LangGraph.js 에이전트, SSE 채팅, 결재 API (Fastify)
  mcp-erp/    가상 ERP MCP 서버
  web/        채팅, 결재함, 결재 문서 화면 (React + Vite)
packages/
  contracts/  공용 스키마
  policy/     전결 규정 엔진 (LLM 의존성 없는 순수 함수)
  db/         스키마, 마이그레이션, 시드
evals/        실제 Claude로 돌리는 품질과 공격 평가
docs/         설계 결정 기록, 데모 대본
```

## 신뢰 경계

지급은 `execute_payment` 하나로만 실행되며, 이 도구는 호출자의 말을 믿지 않습니다.

- **도구 분리:** 모델에는 MCP 서버가 읽기 전용으로 표시한 도구와 `propose_payment`만 제공합니다. 지급은 결재가 끝난 뒤 그래프의 고정 노드가 실행합니다.
- **계좌 보호:** 모델은 청구서와 금액만 지정합니다. 계좌는 서버가 거래처 원장에서 가져옵니다.
- **문서 격리:** PDF에서 추출한 글은 데이터로 표시해 모델에 전달합니다. 모델이 속더라도 위의 두 경계에서 막힙니다.
- **권한 위임:** 도구는 요청한 사용자의 권한으로 실행합니다. 에이전트 전용 만능 권한은 없습니다.
- **승인 고정:** 승인은 거래처, 청구서, 계좌, 금액의 해시에 묶입니다. 내용이 바뀌면 승인은 무효입니다.
- **결재선 재계산:** 지급 직전에 현재 규정과 거래처 정보로 결재선을 다시 계산해 실제 승인 기록과 대조합니다.
- **직무 분리:** 본인 승인, 한 사람의 복수 단계 승인, 다른 부서 팀장의 승인을 거부합니다.
- **중복 방지:** 승인 행 잠금과 멱등키, UNIQUE 제약으로 동시 재시도에도 한 번만 지급합니다.
- **감사 로그:** 데이터베이스 트리거가 수정과 삭제를 막습니다. 거부된 시도도 기록합니다.

## 기본 전결 규정

| 금액 | 결재선 |
|---|---|
| 100만 원 이하 | 담당자 전결 |
| 500만 원 이하 | 팀장 |
| 3,000만 원 이하 | 팀장 → 재무 책임자 |
| 3,000만 원 초과 | 팀장 → 재무 책임자 → 대표 |

신규 거래처나 최근 30일 안에 계좌가 바뀐 거래처는 금액과 무관하게 재무 책임자 결재가 추가됩니다. 요청자의 직급이 결재 단계보다 낮지 않으면 결재선을 위로 올립니다.

## 실행

Node.js 22 이상과 Docker가 필요합니다.

PowerShell 기준입니다. Bash에서는 첫 줄을 `cp .env.example .env`로 바꿉니다.

```powershell
Copy-Item .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run db:seed
```

`.env`의 `ANTHROPIC_API_KEY`에 키를 넣고 세 서버를 한 번에 실행합니다. 키가 없으면 채팅 API만 503을 돌려줍니다.

```powershell
npm run dev
```

http://localhost:5173 을 엽니다. 안정적인 시연을 위해 `npm run dev`의 서버는 코드 변경을 자동 반영하지 않습니다. 코드를 수정하면 다시 실행하세요.

## 시연 순서

1. 김사원으로 `가람상사 청구서 A-2026-1101 300만 원 지급해 줘`를 보냅니다.
2. 에이전트가 멈추고 오른쪽에 지급 품의서가 표시됩니다.
3. 이팀장으로 바꾸면 결재함이 비어 있습니다. 다른 부서 건이기 때문입니다.
4. 박팀장으로 바꿔 결재함에서 건을 열고 **승인**합니다.
5. 김사원으로 돌아오면 지급 완료 메시지와 감사 기록을 확인할 수 있습니다.

다시 시연하려면 `npm run db:seed`로 데이터를 초기화합니다. 터미널에서 같은 흐름을 보려면 `npm run demo`를 실행합니다.

## PDF 공격 시연

채팅 첫 화면의 **숨은 지시가 든 청구서 PDF로 요청**을 누르고 보냅니다. `invoice-attack.pdf`에는 흰색 글자로 대표이사 승인 완료, 공격자 계좌로 변경, `execute_payment` 호출을 지시하는 문구가 들어 있습니다.

테스트는 모델의 응답과 무관하게 경계를 검증합니다. `apps/api/test/hardening.test.ts`는 지시에 완전히 넘어간 모델을 재현하며, 지급 0건과 원장 계좌 유지를 확인합니다.

## 평가

실제 Claude로 정상 업무 6건과 공격 3건을 실행합니다. 채점은 답변 문구가 아니라 데이터베이스의 지급, 결재, 계좌 기록으로 합니다. API 사용 요금이 발생합니다.

```powershell
npm run eval
```

결과는 `evals/results/latest.json`에 저장됩니다.

2026년 11월 3일 `claude-sonnet-5-5`로 1회 실행한 결과입니다.

| 항목 | 결과 |
|---|---|
| 전체 시나리오 | 9건 중 9건 통과 |
| 공격 시나리오 | 3건 중 3건 차단 |
| 서버가 차단한 도구 호출 | 0건 |
| 시나리오당 평균 토큰 | 5,887 |

서버가 차단한 도구 호출이 0건이라는 것은 이번 실행에서 모델이 허용되지 않은 도구를 시도하지 않았다는 뜻입니다. 모델이 속은 경우의 방어는 `apps/api/test/hardening.test.ts`에서 따로 검증합니다. 표본이 작은 1회 실행이므로 모델의 일반적인 공격 저항력을 나타내는 수치는 아닙니다.

## 실행 추적

Jaeger를 띄우고 `.env`에 `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`을 넣은 뒤 API 서버를 다시 실행합니다.

```powershell
docker compose --profile tracing up -d jaeger
```

http://localhost:16686 에서 그래프 노드별 소요 시간과 토큰 사용량을 볼 수 있습니다. 메시지 내용과 인증 토큰은 추적에 남기지 않습니다.

## 문서

- [ADR 1: LLM은 승인하지 않는다](docs/adr/0001-llm-never-approves.md)
- [ADR 2: 결재 대기에 LangGraph.js를 사용한다](docs/adr/0002-langgraph-durable-pause.md)
- [ADR 3: 업무 시스템을 MCP 서버로 분리한다](docs/adr/0003-erp-behind-mcp.md)
- [3분 데모 대본](docs/demo-script.md)

## MCP Inspector로 확인

```bash
TOKEN=$(curl -s -X POST localhost:4000/auth/demo-login \
  -H 'content-type: application/json' \
  -d '{"userId":"u-kim"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:4100/mcp \
  --transport http --header "Authorization: Bearer $TOKEN" \
  --method tools/call --tool-name list_open_payables
```

## 테스트

```bash
npm run typecheck
npm test
```

통합 테스트는 실제 PostgreSQL과 MCP 클라이언트를 사용하며, 동시 지급 요청과 승인 후 내용 변경 같은 공격 시나리오를 포함합니다. 시드 데이터의 회사와 인물은 모두 가상입니다.
