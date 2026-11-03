# 도장 (Dojang)

결재를 받아야만 일할 수 있는 AI 신입사원.

사내 업무를 채팅으로 맡기면 AI가 처리안을 만들고, 권한을 넘는 일은 한국 기업의 전결 규정과 결재선에 따라 사람의 승인을 받은 뒤에만 실행합니다.

> 핵심 원칙: **LLM은 제안만 합니다. 승인 판단과 실행 허가는 서버 코드가 맡습니다.**

## 진행 상황

| 주차 | 범위 | 상태 |
|---|---|---|
| 1 | 모노레포, DB, 인증, 전결 규정 엔진, 가상 ERP MCP 서버 | 완료 |
| 2 | 에이전트, 스트리밍 채팅, 결재 정지/재개 | 예정 |
| 3 | 채팅 UI, 결재 카드, 역할 전환, 감사 타임라인 | 예정 |
| 4 | PDF 공격 데모, 평가, 추적, 데모 영상 | 예정 |

## 구조

```text
apps/
  api/        인증 API (Fastify)
  mcp-erp/    가상 ERP MCP 서버
packages/
  contracts/  공용 스키마
  policy/     전결 규정 엔진 (LLM 의존성 없는 순수 함수)
  db/         스키마, 마이그레이션, 시드
```

## 신뢰 경계

지급은 `execute_payment` 하나로만 실행되며, 이 도구는 호출자의 말을 믿지 않습니다.

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

```bash
cp .env.example .env
npm install
npm run db:up
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:mcp
```

VS Code에서는 실행 및 디버그 패널의 **전체 서버**로 두 서버를 함께 띄울 수 있습니다.

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
