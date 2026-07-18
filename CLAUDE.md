# guild-web — 프라시아 전기 결사 관리 시스템 (신규 웹)

기존 Streamlit 앱(`C:\Users\82107\고니`)을 정적 HTML/CSS/JS + Supabase Edge Functions로 단계 이식하는 프로젝트. 같은 Supabase DB(서울 리전)를 기존 Streamlit 앱과 공유한다.

## 아키텍처 핵심

- **인증**: Supabase Auth 미사용. 자체 세션 토큰(`user_sessions` 테이블, `X-Session-Token` 헤더). 비밀번호는 레거시 SHA256 → 로그인 시 bcrypt로 점진 업그레이드.
- **보안**: 전 테이블 RLS 활성화 + 정책 0개(완전 차단). 읽기·쓰기 전부 Edge Function(service_role) 경유. anon 키는 `apikey` 헤더로만.
- **Edge Function**: 로컬 Node/Deno/Docker 없음 → Supabase Dashboard "Via Editor"에 붙여넣어 배포. 그래서 함수마다 헬퍼를 중복한 **자체완결 단일 파일** 구성(의도적 — DRY보다 배포 신뢰성 우선). "Verify JWT with legacy secret"는 항상 OFF. 코드 수정 시 로컬 파일(source of truth) → 사용자에게 전체 코드 출력 → 사용자가 대시보드에 붙여넣어 배포.
- **원자성 필요한 쓰기**: SECURITY DEFINER RPC(`supabase/migrations/000N_*.sql`) — anon/authenticated EXECUTE REVOKE.
- **캐시버스팅**: 정적 파일 수정 시 `index.html`의 `?v=N`을 반드시 +1 (현재 v=14).
- **로컬 미리보기**: `_devserver.ps1`(PowerShell HttpListener) → `http://localhost:8899`. 검증은 목 API(`Api.xxx = () => Promise.resolve(...)` 오버라이드)로 브라우저에서.
- **DB 값 표기는 전부 한글**: 등급(희귀/영웅/전설/신화/절대자), 자산(현금/다이아), 방향(입금/출금), 상태(대기/확정/반려/취소), 역할(결사원/운영진/관리자). 시간은 KST 벽시계값(timestamp without tz) — 비교 시 "문자열을 UTC로 해석한 epoch vs Date.now()+9h" 관례 사용.
- **이미지**: Supabase Storage 버킷 `screenshots`(public, 자동 생성). 클라 canvas 1280px/JPEG q0.82 전처리(원본 규칙) → base64 전송 → 서버 업로드 → URL JSON 배열을 `power_img_url`/`status_check_img_url`에 저장. 기존 base64(data:) 값도 `parseImgUrls`로 하위호환 표시.

## 절대 규칙

- **커밋/푸시는 반드시 사용자 확인 후에만.** (아직 원격 저장소 미연결 — 로컬 커밋만 쌓는 중. 1차 배포 때 GitHub 연결 + Pages 설정 예정)
- **참여점수 계산 로직 변경 금지**: `recalc_participation_scores` RPC의 공식(활동 로그 수 = 활동컬럼, participation_score = 합계×100, participation_rate = 참석 세션/전체 세션×100, contribution_score = round(참여×0.7+전투력×0.3))은 원본 그대로 유지. 새 지표는 항상 별도 계산으로.
- **긴급 데이/나이트 분류 기준**: `!긴급` 로그만 저장 시간으로 분류. 데이 = 09:00:00~17:59:59, 나이트 = 18:00:00~익일 08:59:59 (18:00 정각 = 나이트, 09:00 정각 = 데이). 다른 태그는 shift = null. 데이/나이트 지표는 참여점수에 합산되지 않는 참고 데이터.
- **조 변경 반영**: 최초 선택 = 현재 시즌 즉시, 변경 = 다음 시즌부터(`member_shift_history.effective_season`). "정산 회차" = 시즌.
- **시안 = 디자인 명세**: 색상/레이아웃/카드 구조는 시안 파일을 그대로 따른다. 데이터 로직 변경은 명시된 것만.
  - 전체 앱 구조 시안: `C:\Users\82107\고니\결사관리_확정구조_시안_v5.html`
  - 대시보드 시안(최신): `guild-web/대시보드_최종통합_시안_v2.html` (KPI 무채색 4칸, 밑줄 탭, 장비/아퀴 인셋 패널 470px 통일 등)
- **신화 아퀴룬 직업별 매핑** (dashboard.js MYTHIC_RUNES — 표 컬럼명은 섹션 중립 "신화 1번/2번", 저장 섹션은 룬마다 다름):
  - 향사수: 향연의 덫(A3/PVP), 관통하는 화살(B4/지원)
  - 집행관: 맹렬한 돌격(C3/PVE), 신의 방패(A3/PVP)
  - 야만투사: 신수의 발톱(C3/PVE), 2번 없음("해당 없음")
  - 환영검사: 암기 투척(A6/PVP), 환영검 투척(C4/PVE)
  - 태양감시자: 점멸 습격(A6/PVP), 황금률의 파도(B4/지원)
  - 주문각인사: 유성 낙하(A4/PVP), 고양의 영역(B3/지원)
  - 심연추방자: 휘몰아치는 힘(A6/PVP), 심연의 등불(C6/PVE)
  - 신화 보유 판정 = `:m` 등급 저장분만(M1/M2 레거시 토큰 포함). 현재 데이터엔 :m 없음 — 신규 오픈 후 수집 예정. 아퀴 뷰는 DB 저장 섹션(ID 접두 A/B/C) 그대로 렌더링, 코드가 섹션을 임의 배치하지 말 것.

## 완료된 단계 (로컬 커밋)

| 커밋 | 내용 |
|---|---|
| a45a118 | 1~3단계: 로그인, 재고 관리/드랍 등록(텍스트 로그 파서 이식+장바구니), 결사원 관리 핵심 CRUD, 공금 관리(현금/다이아 수동 입출금+이력) |
| e1a8594 | 4단계: 대시보드(KPI/직업분포/주요아퀴/회원카드) |
| 718bc76 | 5~6단계: 분배 신청(기간 관리+자격 판정 이식+자동확정 RPC), 장비/아퀴 편집(결사원 관리 모달), 대시보드 리팩토링(시안 v2 — 정렬표+페이지네이션, 장비/아퀴 인셋 패널 카드) |
| 99ac4e2 | 신화 아퀴룬 보유 현황: 보유자만 표시 |
| 98918ca | 7단계: 참여율 관리(출석 로그 파싱·매칭·멱등 재계산·시즌 설정/마감) + 긴급 데이/나이트 지표(내 정보 탭 신설, KPI 3분할, 운영진 위젯). 과거 긴급 65건 분류(나이트42/데이23), 점수 불변 diff 0건 검증 완료 |
| aededbb | 8단계: 회원가입(스샷 포함 신청→승인) + 내 정보 5개 서브탭(기본/장비/아퀴/인증샷/분배이력, 분배기간 잠금) + Storage 이미지 전환 |
| 78dd497 | 결사원 관리 3뷰(스샷 보기/장비표/아퀴표) + members 함수 이미지 분리 조회 + CLAUDE.md |
| (이후) | 9단계: 분배 후반부 — 신청 현황(5분류·자격미달 일괄취소·수동확정), 결과(충돌해결 + 확정대기에서 다이아/현금 입력 → 승인 즉시 최종확인), 이력(필터·관리자 분배취소) + RPC 3개(0008). 분배 상위탭+하위 4탭 구조. 아퀴정보 목록 시안 적용(사람별/룬별, 룬 기준 미보유 탐색·참여점수 정렬·직업별 룬 그리드 메모), 아퀴 매핑 3직업 비교 모달 |

배포된 Edge Functions(11개): login, logout, change-password, inventory, item-master, members, treasury, dashboard, distribution, participation, profile, register. 적용된 마이그레이션: 0001(RLS)~0008(분배 후반부 RPC — confirm/finalize/cancel).

## 진행 중 / 다음 할 일

- **분배 후반부 참고**: UI는 확정 대기에서 다이아/현금 입력 → "나감 처리(승인)" = 즉시 finalize(이력+재고차감+장비/아퀴 갱신+공금 입금). mark_dispatched/undispatch 액션은 함수에 호환용으로만 남아 있고 UI는 사용 안 함. 되돌리기 = 이력 탭 분배취소(관리자, RPC 원자 역전).
- **8단계 E2E 미완**: 가입 신청→승인→새 계정 로그인→스샷 확인 실전 테스트 안 함. 첫 스샷 업로드 시 Storage `screenshots` 버킷 자동 생성 여부 실전 확인 필요.
- **분배 실전 E2E 미완**: 실제 분배 기간에서 신청→자동/수동확정→승인(최종확인)→공금 입금→분배취소 흐름을 소량으로 검증 필요.
- **1차 배포**: GitHub 원격 연결 + Pages 설정
- **미뤄둔 부가 기능**: 엑셀 업로드(결사원/참여율), 과거 닉네임 등록 UI, 계좌 DB, 관리자 참여 편집 탭, 전시즌 이월 블렌딩(분배 단계에서), 규정(guild_regulations) 편집 화면
- 참고: 분배 신청 테스트로 전설 아퀴 유찰 카운트가 +1 된 상태(원복 여부 미결). Supabase/Neon 비밀번호 로테이션 권고했으나 확인 안 됨.
