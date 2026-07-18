-- 긴급 데이/나이트 지표용 스키마 (사용자 승인 완료).
-- 중요: 참여점수 계산(recalc_participation_scores)은 일절 변경하지 않음 —
-- shift는 참여점수에 합산되지 않는 별도 참고 지표다.

-- 1) 참여 로그 shift ('day' | 'night' | null). !긴급 로그만 저장 시간 기준으로 분류:
--    09:00:00~17:59:59 = day, 18:00:00~익일 08:59:59 = night. 다른 태그는 null.
ALTER TABLE participation_logs ADD COLUMN IF NOT EXISTS shift text;

-- 2) 현재 선택 조 (표시용). 계산에 쓰는 조는 member_shift_history에서 결정.
ALTER TABLE members ADD COLUMN IF NOT EXISTS preferred_shift text;

-- 3) 조 변경 이력. effective_season부터 참여율 계산에 반영.
--    최초 선택 = 현재 시즌(즉시 반영), 변경 = 현재 시즌 + 1(다음 정산 회차부터).
CREATE TABLE IF NOT EXISTS member_shift_history (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  shift text NOT NULL,
  effective_season integer NOT NULL,
  changed_at timestamp DEFAULT (now() AT TIME ZONE 'Asia/Seoul')
);

-- 기존 테이블들과 동일 원칙: RLS 활성화 + 정책 0개 (Edge Function의 service_role만 접근)
ALTER TABLE member_shift_history ENABLE ROW LEVEL SECURITY;
