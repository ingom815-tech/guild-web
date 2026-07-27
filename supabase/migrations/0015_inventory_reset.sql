-- 0015: 결사 합병 초기화 3탄 — 재고(inventory) 아카이브 후 전체 삭제
--
-- 사용자 요청: "재고까지 비워줘" — 합병 결사는 창고도 빈 상태에서 시작.
-- 반드시 0014(분배 데이터 리셋) 실행 후에 돌릴 것 — item_requests가 inventory를
-- 참조하므로 신청 이력이 남아 있으면 삭제가 실패한다(그 실패가 곧 순서 보호 장치).
--
-- 보전: item_master(품목 사전/카테고리 정의)는 재고가 아니라 기준 데이터라 유지.
-- 아카이브 테이블이 이미 존재하면 실패한다(중복 실행 방지 겸용).

BEGIN;

CREATE TABLE inventory_archive AS SELECT * FROM inventory;
ALTER TABLE inventory_archive ENABLE ROW LEVEL SECURITY;

DELETE FROM inventory;

COMMIT;

-- ── 검증 (실행 후 결과 확인용) ───────────────────────────────
SELECT 'inventory' AS t, (SELECT COUNT(*) FROM inventory_archive) AS 아카이브, (SELECT COUNT(*) FROM inventory) AS 본테이블;
