# Gemini Plugin for Claude Code

Google Gemini CLI를 Claude Code 안에서 사용할 수 있는 플러그인입니다.
코드 리뷰, 작업 위임, 질의응답을 Gemini에 맡길 수 있습니다.

## 커맨드

| 커맨드 | 설명 |
|--------|------|
| `/gemini:ask` | Gemini에게 질문 (경량 직접 호출) |
| `/gemini:review` | 코드 리뷰 |
| `/gemini:adversarial-review` | 공격적 설계 리뷰 |
| `/gemini:rescue` | 작업 위임 (버그 조사, 수정 등) |
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

### 작업 위임

```
/gemini:rescue 테스트가 왜 실패하는지 조사해줘
/gemini:rescue 실패하는 테스트를 최소한의 패치로 수정해줘
/gemini:rescue --model gemini-2.5-flash 빠르게 확인해줘
/gemini:rescue --background 회귀 조사해줘
```

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

플러그인은 자체 App Server 데몬을 통해 Gemini CLI와 통신합니다:

- `gemini -p` + `--output-format stream-json`으로 각 턴 실행
- 대화 히스토리를 디스크에 저장하여 세션 이어가기 지원
- Gemini의 JSONL 스트림을 JSON-RPC 알림으로 변환
- `/gemini:ask`는 경량 직접 호출로 브로커/데몬 스택 우회

## FAQ

### Gemini CLI 인증이 안 되어 있으면?

`/gemini:setup`을 실행하면 상태를 확인할 수 있습니다.
Google OAuth, API Key, Vertex AI 중 하나로 인증하세요.

### Review Gate란?

`/gemini:setup --enable-review-gate`로 활성화하면, Claude가 응답을 완료하기 전에 Gemini가 코드 리뷰를 수행합니다.
리소스를 많이 소모하므로 세션을 모니터링할 때만 사용하세요.

## 라이선스

Apache-2.0
