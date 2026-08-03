-- 0021: 전력 분석 — 메인 지정 플래그 (칩 닉네임칸 음영 표시용)
ALTER TABLE war_roles ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;
