-- 0024: 전력판 — 배치된 인원의 전위/중위/후위 섹터 저장
-- NULL = 전력판 미배치. 역할 배치 해제(war_roles 행 삭제) 시 함께 사라짐.
ALTER TABLE war_roles ADD COLUMN IF NOT EXISTS line text CHECK (line IN ('front', 'mid', 'rear'));
