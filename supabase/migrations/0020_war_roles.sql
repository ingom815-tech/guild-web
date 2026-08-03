-- 0020: 전력 분석 탭 (쟁 오더 작전판) — 역할 배치/짝지 저장 테이블
--
-- member_id = members.user_id (1인 1행 — 배치 없으면 행 없음 = 미배치 풀)
-- role: tank | bruiser | healer | dealer | support
-- pair_no: 짝지 번호 (두 사람이 같은 번호 공유, 없으면 NULL)
-- 접근 제어: RLS 켜고 정책 0개 = anon 직접 접근 차단.
--            읽기/쓰기는 members 함수(운영진 게이트) 경유로만 — "운영진만" 요건 충족.
-- 표시 데이터(전투력/참여율/신화아퀴 등)는 기존 테이블에서 읽으므로 여기엔 저장하지 않음.

CREATE TABLE IF NOT EXISTS war_roles (
  member_id text PRIMARY KEY REFERENCES members(user_id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('tank', 'bruiser', 'healer', 'dealer', 'support')),
  pair_no integer,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE war_roles ENABLE ROW LEVEL SECURITY;
