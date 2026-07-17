# 프라시아 전기 — 결사 관리 (guild-web)

정적 HTML/CSS/JS + Supabase Edge Function 기반 결사 관리 시스템. **1단계(파일럿)** 범위는
로그인 + 재고 관리(등록/조회/수정/삭제)뿐이며, **운영진 테스트 전용**입니다. 결사원 계정은
로그인만 되고 나머지 화면은 전부 "준비중"으로 표시됩니다.

기존 Streamlit 앱(별도 저장소)의 Supabase Postgres DB(members/inventory/item_requests 등
20개 테이블, 이미 이전 완료)를 그대로 사용합니다.

## 아키텍처 요약

- **Supabase Auth를 쓰지 않습니다.** `members` 테이블의 자체 로그인(아이디/비밀번호)을 그대로
  이식했습니다. 비밀번호는 기존 SHA256 방식으로 먼저 검증하고, 성공 시 bcrypt로 자동
  재해시하여 점진적으로 업그레이드합니다.
- **모든 테이블 RLS 활성화 + 정책 0개** — anon(publishable) 키로는 어떤 테이블도 직접
  읽거나 쓸 수 없습니다. 읽기·쓰기 전부 Edge Function을 경유하며, Edge Function 내부에서만
  `SUPABASE_SERVICE_ROLE_KEY`(자동 주입)로 RLS를 우회해 실제 쿼리를 수행합니다.
- 프론트엔드는 `js/config.js`에 있는 **anon(publishable) 키만** 사용합니다. 이 키는 공개되어도
  안전합니다(RLS가 전부 막고 있으므로). **service_role 키는 절대 프론트 코드에 넣지 마세요.**

## 1. Supabase 값 입력 위치

`js/config.js` 파일을 열어 아래 두 값을 채워주세요 (Supabase 대시보드 → Project Settings →
API Keys에서 확인):

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://<프로젝트-ref>.supabase.co",
  SUPABASE_ANON_KEY: "<anon 또는 publishable 키>",
};
```

- `SUPABASE_URL`은 프로젝트 ref가 `wlvbuvuoopmdlytkhydr`이면 `https://wlvbuvuoopmdlytkhydr.supabase.co` 형태입니다.
- 프로젝트가 레거시 `anon` JWT 키를 쓰든, 신규 `sb_publishable_...` 키를 쓰든 그대로 넣으면 됩니다(이 프로젝트 설계는 두 포맷 다 지원).
- **service_role/secret 키는 여기에 절대 넣지 마세요.** Edge Function 환경변수에는 이미 자동으로 주입되어 있어 별도 설정이 필요 없습니다.

## 2. DB 마이그레이션 (이미 적용 완료)

`supabase/migrations/` 아래 3개 SQL 파일은 이미 이 세션에서 직접 실행해 적용해뒀습니다:

- `0001_enable_rls.sql` — 20개 테이블 전체 RLS 활성화, 정책 없음
- `0002_delete_inventory_rpc.sql` — 재고 삭제를 원자적으로 처리하는 `delete_inventory_item` RPC
- `0003_inventory_view.sql` — 재고 목록 + 아이템명 기준 신청 인원 집계 뷰(`inventory_with_counts`)

DB를 새로 만들거나 롤백 후 다시 적용해야 한다면, Supabase 대시보드 **SQL Editor**에 파일
내용을 순서대로 붙여넣어 실행하면 됩니다.

## 3. Edge Function 배포

로컬에 Node/Deno/Docker가 없어도 배포할 수 있습니다. **Supabase 대시보드의 Edge Functions
웹 에디터**를 사용하세요 (Dashboard → Edge Functions → Create/Deploy):

1. `supabase/functions/` 아래 각 폴더(`login`, `logout`, `change-password`, `inventory`)의
   `index.ts`를 함수 이름 그대로 대시보드에서 생성해 붙여넣습니다. 대시보드 에디터의
   멀티파일 지원 여부가 불확실해서, **각 함수는 외부 파일 import 없이 완전히 단일 파일로
   작성**해뒀습니다(cors/세션검증/비밀번호검증 로직이 4개 파일에 각각 인라인되어 있어
   약간의 코드 중복은 있지만, 그대로 복사/붙여넣기만 하면 됩니다).
2. 각 함수 설정에서 **"Enforce JWT Verification"을 끄세요.** 이 프로젝트는 Supabase Auth
   JWT가 아니라 자체 세션 토큰(`X-Session-Token` 헤더)을 쓰기 때문에, 플랫폼 JWT 검증을
   켜두면 정상 요청도 막힙니다.
3. 배포 후 대시보드의 "Test" 패널로 각 함수를 직접 호출해 확인하세요 (아래 5번 참고).

> ⚠️ 대시보드 에디터는 버전 관리가 없습니다. **이 저장소의 `supabase/functions/*/index.ts`가
> 원본**이니, 수정은 항상 로컬 파일 → 대시보드에 복사/붙여넣기 → 배포 → 커밋 순서를
> 지켜주세요.

## 4. 로컬에서 프론트 확인하기

빌드 과정이 없습니다. `js/config.js`를 채운 뒤 **`index.html`을 브라우저로 그냥 열면
됩니다** (더블클릭 또는 `Start-Process index.html`). CORS가 모든 origin을 허용하도록
설정되어 있어 `file://`에서도 정상 동작합니다.

## 5. 테스트 체크리스트

1. **Edge Function 개별 테스트** (대시보드 Test 패널, 또는 PowerShell):
   ```powershell
   Invoke-RestMethod -Method Post -Uri "https://<ref>.supabase.co/functions/v1/login" `
     -Headers @{ apikey = "<anon key>" } -ContentType "application/json" `
     -Body '{"user_id":"운영진아이디","password":"비밀번호"}'
   ```
   반환된 `token`을 `X-Session-Token` 헤더에 넣어 `inventory` 함수(GET)도 호출해보세요.
2. **로그인 실패 케이스**: 틀린 비밀번호, 존재하지 않는 아이디 → 둘 다 동일한 401 메시지인지 확인.
3. **권한 체크**: 결사원 계정 토큰으로 `inventory` POST/PUT/DELETE 호출 시 403이 나오는지 확인.
4. **재고 등록 중복 규칙**: 같은 아이템명으로 두 번 등록하면 새 행이 아니라 기존 행의 수량이
   합산되는지 SQL Editor에서 확인.
5. **삭제 2단계 확인**: `confirm=false`(기본) 호출 시 삭제되지 않고 신청 인원만 반환되는지,
   `confirm=true`로 재호출해야 실제 삭제되는지 확인.
6. **브라우저 통합 테스트**: `index.html`을 열어 운영진 계정으로 로그인 → 재고 관리 탭에서
   목록 확인 → 드랍 등록 탭에서 아이템 등록 → 재고 관리에서 수정/삭제까지 전체 플로우를
   DevTools 네트워크 탭으로 상태코드 확인하며 수행. 결사원 계정으로도 로그인해 "재고 관리"/
   "드랍 등록" 탭이 아예 안 보이는지, 나머지 탭은 "준비중"으로 뜨는지 확인.

## 6. GitHub Pages 배포

```bash
git init
git add .
git commit -m "guild-web 1단계: 로그인 + 재고 관리"
git branch -M main
git remote add origin https://github.com/ingom815-tech/guild-web.git
git push -u origin main
```

이후 GitHub 저장소 **Settings → Pages → Source: `main` 브랜치 / `(root)`** 로 설정하면
`https://ingom815-tech.github.io/guild-web/`에서 접속할 수 있습니다.

> `.nojekyll` 파일이 이미 포함되어 있어 GitHub Pages의 Jekyll 처리를 건너뜁니다
> (별도 조치 불필요).

## 파일 구조

```
guild-web/
  index.html              로그인 화면 + 메인 앱 셸(탭 구조)
  css/style.css            시안 색상/컴포넌트 재사용 + 로그인/모달 스타일
  js/config.js              Supabase URL/anon 키 (직접 입력 필요)
  js/api.js                 Edge Function fetch 래퍼
  js/auth.js                로그인/로그아웃/세션유지/비밀번호변경
  js/inventory.js           재고 목록/필터/등록/수정/삭제
  js/app.js                 탭 네비게이션 + 부트스트랩
  supabase/
    functions/
      login/                로그인 (SHA256→bcrypt 점진 업그레이드), 단일 파일
      logout/                단일 파일
      change-password/       단일 파일
      inventory/             GET/POST/PUT/DELETE, 단일 파일
    migrations/               0001~0003 (적용 완료)
```

## 다음 단계 (2단계 이후 예정)

분배 신청 / 분배 현황 / 결과 / 이력 화면과 결사원 오픈. 지금은 탭만 자리를 잡아두고
"준비중"으로 표시되어 있습니다.
