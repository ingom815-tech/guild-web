-- 0022: 전력 분석 — 메인 지정을 별 1~3개 등급으로 확장 (0 = 해제)
-- 기존 is_main(boolean, 0021)을 main_level(int)로 대체. 기존 지정자는 ★1로 이관.
-- 0021을 실행하지 않은 DB에서도 안전 (is_main이 없으면 이관 단계는 건너뜀).
ALTER TABLE war_roles ADD COLUMN IF NOT EXISTS main_level integer NOT NULL DEFAULT 0 CHECK (main_level BETWEEN 0 AND 3);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'war_roles' AND column_name = 'is_main'
  ) THEN
    UPDATE war_roles SET main_level = 1 WHERE is_main;
  END IF;
END $$;
ALTER TABLE war_roles DROP COLUMN IF EXISTS is_main;
