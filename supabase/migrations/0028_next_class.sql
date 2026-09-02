-- 0028: 클래스변경(예정 클래스) — 내정보에서 선택, 전력 현황 > 클래스현황 탭에 반영 (2026-08-26)
-- NULL = 변경 없음(현재 직업 유지). 값 검증(직업 7종)은 profile 함수에서 수행.
ALTER TABLE members ADD COLUMN IF NOT EXISTS next_class text;
