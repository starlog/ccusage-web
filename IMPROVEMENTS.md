# 코드 리뷰 및 개선 보고서

## 1. 프로젝트 개요
- 프로젝트 유형: Node.js (Express)
- 언어, 프레임워크, DB: JavaScript(Node.js 22, ESM) · Express 5 · MongoDB(공식 `mongodb` 드라이버 7) · 대시보드는 순수 HTML/CSS/JS + Chart.js
- 진입점: `server/src/server.js` (루트 `package.json`의 `npm start`)
- 주요 파일
  - `server/src/`: `server.js`(라우트), `ingest.js`(업로드 검증·저장), `stats.js`(통계 집계), `export.js`(엑셀 보고서), `client-package.js`(클라이언트 패키지 빌드), `db.js`, `config.js`, `dates.js`
  - `server/public/`: 대시보드(`index.html`, `app.js`, `style.css`)
  - `client/`: 팀원 컴퓨터에서 실행하는 `cc-usage` CLI. 서버가 `npm pack`으로 묶어 한 줄 설치 명령으로 배포합니다.
  - `server/scripts/seed-sample.js`: UI 확인용 샘플 데이터 생성
- Docker Manager 배포 준비 상태: **준비 완료** (배포 시 환경변수 설정 필요 — 6장 참고)
- 원본 커밋: `2ef7925`
- 이번 작업 중 사용자 요청으로 **Python 클라이언트(`ccusage_report.py`)를 삭제**하고 Node.js 클라이언트만 남겼습니다.

## 2. Docker Manager 호환성 결과
| 항목 | 상태 | 비고 |
|------|------|------|
| 프로젝트 유형 감지 | 통과 | `server/package.json`과 lock 파일을 루트로 옮겨 Node.js 유형으로 인식됨 |
| start 스크립트 | 통과 | `npm start` → `node --env-file-if-exists=.env server/src/server.js` |
| 포트 설정 | 통과 | 기본값 3200 → 3000 (`PORT`로 변경 가능) |
| 헬스체크 (GET /health) | 통과 | 새로 추가. 인증·DB 없이 200 `{"status":"ok"}` |
| 0.0.0.0 바인딩 | 통과 | `HOST` 기본값 `0.0.0.0` |
| 절대경로 -> 상대경로 | 통과 | 리소스·API 경로는 원래 상대경로. 설치 안내 명령의 서브패스 누락을 수정 |
| .env.example | 통과 | 루트로 옮기고 코드가 실제 쓰는 6개 변수만, 공유 MongoDB 기준으로 작성 |
| 하드코딩 DB 연결 제거 | 통과 | `mongodb://localhost:27017` 기본값 제거. `MONGODB_URI` 필수 |

## 3. 우선순위별 발견 사항 및 수정 내용

### 높음 (배포 필수/보안/안정성)
| # | 에이전트 | 문제 | 파일 | 수정 내용 | 상태 |
|---|---------|------|------|----------|------|
| 1 | F, B | 루트에 `package.json`이 없어 배포 불가 | `package.json`, `package-lock.json` | server에서 루트로 이동, 스크립트 경로에 `server/` 추가, `server/node_modules` 대신 루트에 설치 | 완료 |
| 2 | F | `GET /health` 없음(404) | `server/src/server.js` | DB 검사 없는 `/health` 추가 | 완료 |
| 3 | F, B | 기본 포트 3200 | `server/src/config.js` | 기본값 3000 | 완료 |
| 4 | F | chart.js 경로가 `server/node_modules`에 고정(구조 변경 시 차트 깨짐) | `server/src/server.js` | 패키지 진입점 위치에서 `chart.umd.js`를 찾도록 변경 | 완료 |
| 5 | C, B, D, F | 설치 안내 명령이 `location.origin`을 써서 `/c/프로젝트명` 서브패스가 빠짐 → 설치·업로드 실패 | `server/public/app.js` | 현재 페이지 기준 디렉터리 URL로 명령 생성 | 완료 |
| 6 | B, F | MongoDB 접속 정보 localhost 하드코딩 | `server/src/config.js`, `db.js`, `.env.example` | 기본값 제거, 없으면 명확한 오류로 종료, `.env.example`은 `shared-mongo` 기준 | 완료 |
| 7 | E | 숫자 필드 상한 없음 → `1e308`로 합계가 Infinity가 되어 대시보드·엑셀 파손 | `server/src/ingest.js` | 토큰·세션은 안전 정수만, 합계 검사, `cacheHitRate`는 0~1 | 완료 |
| 8 | E | 업로드 날짜의 달력 검증·기간 길이 제한 없음 → 기간을 넓혀 한 머신의 일별 통계 전체 삭제 가능 | `server/src/ingest.js`, `server/src/dates.js` | 실제 달력 날짜 검사, 기간 최대 5000일 | 완료 |
| 9 | A, D | 업로드 저장이 삭제 후 upsert 순서의 여러 쓰기 → 중간 실패 시 데이터 누락 | `server/src/ingest.js` | upsert 먼저, 0이 된 날 삭제는 나중에, 한 번의 ordered `bulkWrite`로 통합 | 완료 |
| 10 | D, E | 오류 처리기가 4xx(잘못된 URL 인코딩 등)를 500으로 응답, 응답 전송 후 오류 미처리 | `server/src/server.js` | 4xx는 해당 상태로, `headersSent` 확인 | 완료 |
| 11 | D, E | `dailyTotals`에 null 원소가 오면 500 | `server/src/ingest.js` | 객체인지 먼저 검사해 400 | 완료 |
| 12 | D | `npm pack`에 타임아웃 없음, 실패 시 요청마다 재실행 | `server/src/client-package.js` | 60초 타임아웃, 실패 후 1분간 재시도 억제(이전 패키지 재사용), 쓰기 불가 시 임시 폴더 사용 | 완료 |
| 13 | G, F | engines `>=20.6`이지만 mongodb 7은 20.19+, `--env-file-if-exists`는 22.9+ | `package.json` | `>=22.9` | 완료 |

### 중간 (성능/운영)
| # | 에이전트 | 문제 | 파일 | 수정 내용 | 상태 |
|---|---------|------|------|----------|------|
| 1 | A | 대시보드 머신 목록 집계가 매번 보고 이력 전체를 스캔 | `server/src/stats.js` | 복합 인덱스 순서로 정렬(결과 동일) | 완료 |
| 2 | A | 보고 이력의 사용자/머신 필터, 엑셀 기간 겹침 조회에 맞는 인덱스 없음 | `server/src/db.js` | `{user, receivedAt}`, `{machineId, receivedAt}`, `{until, since}` 인덱스 추가 | 완료 |
| 3 | A | 사용자 순위 집계가 daily 전체 COLLSCAN | `server/src/stats.js`, `db.js` | `{user, totalTokens}` 인덱스 + 정렬 후 그룹 | 완료 |
| 4 | A, F | MongoClient 타임아웃 미설정(장애 시 30초 대기) | `server/src/db.js` | `serverSelectionTimeoutMS`/`connectTimeoutMS` 10초, `appName` | 완료 |
| 5 | B | URI에 적은 DB 이름이 `MONGODB_DB` 기본값에 가려짐 | `server/src/config.js` | `MONGODB_DB` → URI의 DB 이름 → `cc_usage` 순서 | 완료 |
| 6 | B | 빈 문자열 환경변수가 그대로 쓰임(`PORT=` → 0번 포트) | `server/src/config.js` | 빈 값은 미설정으로 처리 | 완료 |
| 7 | E, C, F, D | 보안 헤더 없음, `trust proxy` 미설정(로그 IP가 프록시 IP) | `server/src/server.js` | `X-Content-Type-Options`, `Referrer-Policy`, CSP, `trust proxy` | 완료 |
| 8 | E | 조회 API의 3년 제한을 잘못된 날짜(`9999-99-99`)로 우회 | `server/src/server.js` | 달력 날짜 검증 공통 함수 사용 | 완료 |
| 9 | D | 엑셀 시각이 서버 시간대(컨테이너는 UTC) 기준 | `server/src/config.js`, `export.js` | `REPORT_TIMEZONE` 환경변수 | 완료 |
| 10 | F | 없는 `/api/*` 경로가 HTML 404 | `server/src/server.js` | JSON `{"error":"not found"}` | 완료 |
| 11 | A, D | 종료 처리에 예외 처리·강제 종료 없음 | `server/src/server.js` | `once` 등록, 10초 강제 종료, DB close 오류 처리 | 완료 |
| 12 | G | `uuid` override가 전역 적용 | `package.json` | `exceljs` 하위로 범위 한정(`npm ls`로 확인) | 완료 |
| 13 | A | 같은 범위의 daily를 요청당 여러 번 집계 | `server/src/stats.js`, `export.js` | `$facet` 통합은 결과 문서 16MB 제한 위험이 있어 보류 | 보류 |
| 14 | F | 목록 API 페이지 넘김 없음, 응답 형식 차이 | `server/src/server.js` | 클라이언트가 현재 형식에 맞춰 동작하므로 유지 | 보류 |

### 낮음 (품질/관리)
| # | 에이전트 | 문제 | 파일 | 수정 내용 | 상태 |
|---|---------|------|------|----------|------|
| 1 | E | hostname·timezone·ccusage 버전에 제어 문자(줄바꿈, RLO) 허용 → 로그 위조 가능 | `server/src/ingest.js` | 제어·서식 문자 거부 | 완료 |
| 2 | E | Windows 설치 경로에서 서버가 준 URL이 cmd 명령줄에 그대로 들어감 | `client/src/cli.js` | 패키지 경로와 설치 URL 형식 검증 | 완료 |
| 3 | E | 설정 파일(토큰 포함)이 잠깐 기본 권한으로 생성 | `client/src/config.js` | 폴더 0700, 파일 0600으로 처음부터 생성 | 완료 |
| 4 | E | cron 줄에서 `%`가 줄바꿈으로 해석 | `client/src/schedule.js` | `%` 이스케이프 | 완료 |
| 5 | D | `setup --machine-id`가 받아들여지지만 저장되지 않음 | `client/src/cli.js` | 설정에 저장 | 완료 |
| 6 | D | readline 내부 API가 없을 때 대화형 설정 전체가 죽음 | `client/src/prompt.js` | 없으면 입력 가리기만 생략 | 완료 |
| 7 | D | client-package의 빌드 시각 기록·임시 파일 정리 | `server/src/client-package.js` | 빌드 시작 시각 기록, 실패 시 임시 tgz 삭제 | 완료 |
| 8 | D | 사용량 필드 헬퍼가 export.js에 중복 | `server/src/stats.js`, `export.js` | `USAGE_FIELDS`/`sumUsage`/`keepUsage` 공유 | 완료 |
| 9 | D | 날짜 함수 중복, 추세 계산 이중 구현, 쓰이지 않는 `intercept` | `server/src/dates.js`, `stats.js`, `public/app.js` | `dates.js`로 공통화, 미사용 값·export 제거, 양쪽에 상호 참조 주석 | 완료 |
| 10 | D | app.js 차트 선택 저장 코드 중복, 항상 거짓인 분기 | `server/public/app.js` | `persistChoice` 공통 함수, 죽은 분기 제거 | 완료 |
| 11 | D | 서버와 대시보드에서 `displayName`이 다른 의미로 쓰임 | `server/src/ingest.js` | 서버 쪽을 `normalizeName`으로 변경 | 완료 |
| 12 | D | 엑셀 보고 이력이 2만 건에서 조용히 잘림 | `server/src/export.js` | 잘렸으면 요약 시트에 표시 | 완료 |
| 13 | A | seed 스크립트 `--clean`의 연결 정리·타임아웃 | `server/scripts/seed-sample.js` | try/finally, 공통 연결 옵션 | 완료 |
| 14 | B | 시작 로그 주소가 localhost로 고정 | `server/src/server.js` | 실제 바인딩 주소·포트 출력 | 완료 |
| 15 | D | Python 클라이언트 인코딩·예외 처리 | `ccusage_report.py` | 사용자 요청으로 Python 클라이언트를 삭제해 해당 없음 | 해당 없음 |
| 16 | C, F | 끝 슬래시 없이 `/c/프로젝트명`으로 접속하면 상대경로가 깨질 수 있음 | (프록시) | CSP가 인라인 스크립트를 막으므로 코드 보정 대신 프록시 리다이렉트 확인 필요 | 수동 조치 |
| 17 | G | exceljs 하위 의존성 일부 deprecated(현재 취약점 0건) | `package-lock.json` | 올릴 버전 없음. 정기적으로 `npm audit` 확인 | 수동 조치 |

## 4. 에이전트별 분석 요약
| 에이전트 | 영역 | 상태 | 발견 문제 수 | 수정 완료 수 |
|---------|------|------|------------|------------|
| A | DB 커넥션/쿼리 | 문제 있음 | 9 | 8 |
| B | 환경변수/설정 | 문제 있음 | 9 | 9 |
| C | 경로 호환성 | 문제 있음 | 3 | 2 |
| D | 코드 품질 | 문제 있음 | 18 | 16 (2건은 Python 클라이언트 삭제로 해당 없음) |
| E | 보안 | 문제 있음 | 10 | 10 |
| F | Docker Manager 호환성 | 문제 있음 | 15 | 12 |
| G | 의존성 | 문제 있음 | 3 | 2 |

여러 에이전트가 같은 문제를 지적한 경우(서브패스 누락, trust proxy 등)는 한 번만 수정했습니다. 양호로 확인된 항목: NoSQL 인젝션 차단, 대시보드 XSS 없음, 엑셀 수식 인젝션 없음, 경로 탐색 차단, 토큰 비교(timing-safe), CSRF 해당 없음, 오류 응답에 내부 정보 노출 없음, 커넥션 재사용, N+1 없음, 의존성 취약점 0건.

## 5. 생성된 파일
- `.env.example` (server에서 루트로 옮기고 새로 작성)
- `RECOMMENDED-INDEXES.js` (서버 시작 시 자동 생성되는 인덱스의 참고용 목록)
- `server/src/dates.js` (날짜 검증·범위 공통 함수)
- 로컬 개발용 `.env` (git 제외, `PORT=3200`, 로컬 MongoDB)

삭제된 파일: `ccusage_report.py`(사용자 요청), `server/package.json`·`server/package-lock.json`·`server/.env.example`(루트로 이동)

## 6. 수동 조치 필요 항목
- **Docker Manager 환경변수 설정**: `MONGODB_URI`(필수, 예: `mongodb://shared-mongo:27017/cc_usage`), `INGEST_TOKEN`(운영에서 필수 권장), `REPORT_TIMEZONE=Asia/Seoul`.
- **끝 슬래시 리다이렉트**: `/c/프로젝트명` 접속 시 Nginx가 `/c/프로젝트명/`으로 리다이렉트하는지 확인하세요. 없으면 대시보드 리소스가 404가 납니다.
- **업로드 인증**: `INGEST_TOKEN`이 없으면 누구나 업로드할 수 있습니다. 토큰을 설정해도 팀 공용 토큰 하나라서, 토큰을 가진 사람은 다른 사용자 이름으로 업로드할 수 있습니다. 사용자별 토큰이 필요한지 결정이 필요합니다.
- **조회 공개 범위**: 대시보드, `/api/stats`, `/api/reports`, `/api/export.xlsx`가 인증 없이 이메일·이름·호스트명·머신 ID·사용량을 보여줍니다. Nginx에서 IP 제한이나 Basic Auth를 걸지 결정하세요.
- **HTTPS**: HTTP로 운영하면 토큰과 설치 패키지가 가로채일 수 있습니다. HTTPS로만 노출하세요.
- **속도·저장량 제한**: 업로드(최대 10MB)와 조회에 제한이 없습니다. Nginx `limit_req` 등 운영 정책을 검토하세요.
- **토큰이 셸 기록에 남음**: 안내 창의 `--token YOUR_TOKEN`은 셸 기록에 남습니다. 토큰을 쓸 때는 대화형 `setup` 사용을 안내하는 편이 안전합니다.
- **MongoDB 트랜잭션**: 공유 MongoDB가 단일 노드라 업로드 저장을 트랜잭션으로 묶지 못했습니다(쓰기 순서로 데이터 누락은 방지). 레플리카셋이면 트랜잭션 적용을 검토할 수 있습니다.
- **기존 사용자**
  - 로컬에서 서버를 실행하던 방식이 바뀌었습니다: `cd server && npm start` → 저장소 루트에서 `npm install && npm start`.
  - Python 클라이언트를 쓰던 컴퓨터는 Node.js 클라이언트로 다시 설정해야 합니다(설정 파일·머신 ID가 같아 기록은 이어집니다).
  - 서버 주소가 바뀌어 배포되면(서브패스) 각 컴퓨터에서 `cc-usage setup`을 새 주소로 다시 실행해야 합니다.
- **Windows 클라이언트**: 설치·작업 스케줄러 등록 코드는 있으나 실제 Windows에서 검증하지 않았습니다.

## 7. 검증 결과
- DB 접속 환경: 접속 가능 (mongodb Docker 컨테이너)
- Sanity 테스트 결과: PASS (서버·대시보드·클라이언트·스크립트 전체 `node --check` 통과)
- 실행 검증 결과: PASS
  - 의존성 설치: 성공 (루트 `npm install`, 취약점 0건, `uuid`는 exceljs 하위에만 11.1.1)
  - 앱 실행: 성공 (루트 `npm start`)
  - 헬스체크 (GET /health): HTTP 200 `{"status":"ok"}`
  - 실행 오류 수정 횟수: 0회
  - 추가 확인
    - `PORT` 없이 실행하면 3000번에서 대기, `MONGODB_URI`가 없으면 안내 메시지와 함께 종료
    - 정적 파일, chart.js, 통계·사용자·클라이언트 정보 API, 엑셀 내보내기 200
    - 없는 API → JSON 404, 잘못된 URL 인코딩·날짜 → 400, 보안 헤더 적용
    - 업로드 검증: 정상 업로드 201, 큰 수·소수·잘못된 적중률·없는 날짜·5000일 초과·null 원소·제어 문자 7종 모두 400
    - 서브패스 시뮬레이션(`/c/cc-usage/` 프록시): 대시보드·차트 정상, CSP 콘솔 오류 없음, 설치 명령에 서브패스 포함
    - 그 설치 명령을 깨끗한 Linux 컨테이너에서 실행: 설치·첫 전송·`status` 정상, 설정 폴더 700·파일 600
    - `setup --machine-id` 저장, cron `%` 이스케이프 확인
- Docker Manager 호환성: PASS
- 절대 경로 잔존 검사: PASS
- 미해결 오류: 없음
- 롤백한 수정: 없음

## 8. 롤백 방법
문제 발생 시 원본 상태로 복구:
```bash
git diff 2ef7925           # 변경 내역 확인
git checkout 2ef7925 -- .  # 원본 파일로 복구 (새로 만든 파일은 직접 삭제)
```
