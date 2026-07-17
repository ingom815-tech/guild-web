-- 재고 목록 + 아이템명 기준 신청 인원(applicant_count) 집계 뷰.
-- 기존 Streamlit 앱의 확립된 규칙을 그대로 재현: 신청 인원은 inventory.id가 아니라
-- item_name 기준으로 집계된다(같은 이름의 재고 행이 여러 개면 신청자 풀을 공유).
-- status='재고'인 행만 대상으로 한다(분배완료/정산완료 행은 1단계 관리 대상 아님).

CREATE OR REPLACE VIEW public.inventory_with_counts AS
SELECT
  inv.*,
  COALESCE(rc.applicant_count, 0) AS applicant_count
FROM public.inventory inv
LEFT JOIN (
  SELECT inv2.item_name, COUNT(DISTINCT ir.user_id) AS applicant_count
  FROM public.item_requests ir
  JOIN public.inventory inv2 ON ir.item_id = inv2.id
  WHERE ir.status = '대기' AND inv2.status = '재고'
  GROUP BY inv2.item_name
) rc ON rc.item_name = inv.item_name
WHERE inv.status = '재고';
