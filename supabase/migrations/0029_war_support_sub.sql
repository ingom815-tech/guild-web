-- 0029: 전력 분석 서포터 하위 구분 — 깃발(flag) / 환방(hwan)
-- role은 그대로 'support' 유지 (짝지·전력판·메인 등 기존 기능 무영향), 하위 구분만 sub 컬럼에 저장.
-- sub는 서포터일 때만 의미 — 다른 역할로 바꾸면 members 함수가 null로 비운다.
-- 기존 서포터는 sub = null → 역할 보드에서 "미분류"로 표시되며 운영진이 깃발/환방으로 재지정.
ALTER TABLE war_roles ADD COLUMN IF NOT EXISTS sub text;
ALTER TABLE war_roles DROP CONSTRAINT IF EXISTS war_roles_sub_check;
ALTER TABLE war_roles ADD CONSTRAINT war_roles_sub_check
  CHECK (sub IS NULL OR sub IN ('flag', 'hwan'));
