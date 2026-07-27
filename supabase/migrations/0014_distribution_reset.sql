-- 0014: 결사 합병 초기화 2탄 — 분배 데이터 아카이브 후 리셋
--
-- 0013(참여+공금) 실행 후 사용자 추가 요청: "분배 이력도 다 초기화. 아예 새로운 결사니까"
--
-- 대상:
--   - distribution_history (분배 확정 이력)      → 아카이브 후 전체 삭제
--   - item_requests        (신청/지망 이력)      → 아카이브 후 전체 삭제
--   - distribution_period  (분배 회차 이력)      → 아카이브 후 전체 삭제
--   - inventory.unsold_period_count (유찰 카운트) → 0 리셋
-- 보전:
--   - inventory 재고 자체(실물 아이템 목록)는 유지 — 유찰 카운트만 새 출발
--   - 회원 계정, 규정(guild_regulations), 공금/참여 아카이브는 그대로
--
-- 아카이브 테이블이 이미 존재하면 실패한다(중복 실행 방지 겸용).

BEGIN;

-- ── 1. 아카이브 ──────────────────────────────────────────────
CREATE TABLE distribution_history_archive AS SELECT * FROM distribution_history;
CREATE TABLE item_requests_archive        AS SELECT * FROM item_requests;
CREATE TABLE distribution_period_archive  AS SELECT * FROM distribution_period;

ALTER TABLE distribution_history_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_requests_archive        ENABLE ROW LEVEL SECURITY;
ALTER TABLE distribution_period_archive  ENABLE ROW LEVEL SECURITY;

-- ── 2. 본 테이블 비우기 (자식 → 부모 순) ─────────────────────
DELETE FROM item_requests;
DELETE FROM distribution_period;
DELETE FROM distribution_history;

-- ── 3. 유찰 카운트 리셋 ──────────────────────────────────────
UPDATE inventory SET unsold_period_count = 0
  WHERE COALESCE(unsold_period_count, 0) <> 0;

COMMIT;

-- ── 검증 (실행 후 결과 확인용) ───────────────────────────────
SELECT 'distribution_history' AS t, (SELECT COUNT(*) FROM distribution_history_archive) AS 아카이브, (SELECT COUNT(*) FROM distribution_history) AS 본테이블
UNION ALL SELECT 'item_requests', (SELECT COUNT(*) FROM item_requests_archive), (SELECT COUNT(*) FROM item_requests)
UNION ALL SELECT 'distribution_period', (SELECT COUNT(*) FROM distribution_period_archive), (SELECT COUNT(*) FROM distribution_period)
UNION ALL SELECT 'inventory(유찰>0)', NULL, (SELECT COUNT(*) FROM inventory WHERE COALESCE(unsold_period_count, 0) <> 0)
UNION ALL SELECT 'inventory(재고 보전)', NULL, (SELECT COUNT(*) FROM inventory);
