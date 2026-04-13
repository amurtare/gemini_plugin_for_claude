# Gemini Plugin for Claude Code

Google Gemini CLI를 Claude Code 안에서 사용할 수 있는 플러그인입니다.
코드 리뷰, 작업 위임, 질의응답을 Gemini에 맡길 수 있습니다.

## 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/gemini:ask` | Gemini에게 질문 (경량 직접 호출, read-only) |
| `/gemini:task` | 작업 직접 실행 (write 가능, 서브에이전트 없이 빠름) |
| `/gemini:review` | 코드 리뷰 |
| `/gemini:adversarial-review` | 공격적 설계 리뷰 |
| `/gemini:rescue` | 작업 위임 (서브에이전트가 프롬프트 다듬어서 실행) |
| `/gemini:status` | 백그라운드 작업 상태 확인 |
| `/gemini:result` | 완료된 작업 결과 조회 |
| `/gemini:cancel` | 실행 중인 작업 취소 |
| `/gemini:setup` | 설치 상태 및 인증 확인 |

## 요구사항

- **Gemini CLI** (`npm install -g @google/gemini-cli`)
- **인증** — 아래 중 하나:
  - Google OAuth (`gemini` 실행 후 브라우저 로그인)
  - `GEMINI_API_KEY` 환경변수
  - Vertex AI (`GOOGLE_API_KEY` + `GOOGLE_GENAI_USE_VERTEXAI=true`)
- **Node.js 18.18 이상**

## 설치

Claude Code에서:

```
/plugin marketplace add amurtare/gemini_plugin_for_claude
/plugin install gemini@gemini-plugin-for-claude
/reload-plugins
/gemini:setup
```

## 사용법

### 질문하기

```
/gemini:ask 이 프로젝트의 아키텍처를 설명해줘
/gemini:ask React와 Vue 중 뭐가 나아?
```

### 코드 리뷰

```
/gemini:review
/gemini:review --base main
/gemini:review --background
```

### 설계 리뷰

```
/gemini:adversarial-review
/gemini:adversarial-review --base main 캐싱 설계가 맞는지 검토해줘
```

### 작업 직접 실행

```
/gemini:task 이 타입에러 수정해줘
/gemini:task --model flash README 오타 수정해줘
/gemini:task --background 테스트 실패 수정해줘
```

### 작업 위임 (서브에이전트)

```
/gemini:rescue 테스트가 왜 실패하는지 조사해줘
/gemini:rescue 실패하는 테스트를 최소한의 패치로 수정해줘
/gemini:rescue --model flash 빠르게 확인해줘
/gemini:rescue --background 회귀 조사해줘
```

### 모델 별칭

| 별칭 | 모델 |
|------|------|
| `flash` | gemini-2.5-flash |
| `pro` | gemini-2.5-pro |
| `flash-3` | gemini-2.5-flash-preview-04-17 |
| `pro-3` | gemini-2.5-pro-preview-03-25 |

### 작업 관리

```
/gemini:status
/gemini:result
/gemini:cancel task-abc123
```

## 인증 방법

| 방법 | 설정 |
|------|------|
| Google OAuth (무료) | `gemini` 실행 후 브라우저 로그인 |
| API Key | `export GEMINI_API_KEY="your-key"` |
| Vertex AI (엔터프라이즈) | `export GOOGLE_API_KEY="your-key"` + `GOOGLE_GENAI_USE_VERTEXAI=true` |

## 아키텍처

플러그인은 ACP (Agent Client Protocol) 모드로 Gemini CLI와 통신합니다:

- `gemini --acp`로 상주 프로세스를 유지하여 두 번째 요청부터 빠른 응답
- ACP 실패 시 `gemini -p` CLI spawn으로 자동 폴백
- 대화 히스토리를 디스크에 저장하여 세션 이어가기 지원
- `/gemini:ask`는 경량 직접 호출로 브로커/데몬 스택 우회

## 데이터 저장 정책

### 저장 위치

| 데이터 | 위치 | 형식 |
|--------|------|------|
| 대화 히스토리 | `<CLAUDE_PLUGIN_DATA>/threads/<threadId>/history.jsonl` | JSONL (평문) |
| 스레드 메타데이터 | `<CLAUDE_PLUGIN_DATA>/threads/<threadId>/metadata.json` | JSON |
| 작업 상태 | `<CLAUDE_PLUGIN_DATA>/state.json` | JSON |
| 작업 로그 | `<CLAUDE_PLUGIN_DATA>/jobs/<jobId>.log` | 텍스트 |

`CLAUDE_PLUGIN_DATA`는 Claude Code가 플러그인별로 할당하는 로컬 디렉토리입니다.

### 저장 범위

- **대화 히스토리**: 사용자 프롬프트와 Gemini 응답 텍스트 (세션 이어가기용)
- **작업 메타데이터**: job ID, 상태, 타임스탬프, threadId (대화 내용 미포함)
- **로그**: 진행 상황 메시지 (대화 내용 미포함)

### 보존 제한

- 대화 히스토리: 스레드당 최대 **500턴** — 초과 시 오래된 절반 자동 삭제
- 작업 레코드: 워크스페이스당 최대 **50개** — 초과 시 오래된 것부터 정리
- 세션 종료 시 해당 세션의 작업 레코드 자동 정리

### 외부 전송

- 모든 데이터는 **로컬 디스크에만** 저장됩니다
- Google 서버에 세션이 저장되지 않습니다 (클라우드 세션 resume 미사용)
- Gemini API 호출 시 프롬프트만 전송되며, 히스토리는 로컬에서 프롬프트에 포함하여 전달합니다

## FAQ

### Gemini CLI 인증이 안 되어 있으면?

`/gemini:setup`을 실행하면 상태를 확인할 수 있습니다.
Google OAuth, API Key, Vertex AI 중 하나로 인증하세요.

### Review Gate란?

`/gemini:setup --enable-review-gate`로 활성화하면, Claude가 응답을 완료하기 전에 Gemini가 코드 리뷰를 수행합니다.
리소스를 많이 소모하므로 세션을 모니터링할 때만 사용하세요.

## 라이선스

Apache-2.0
