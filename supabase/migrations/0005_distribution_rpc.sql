-- 분배 신청 단계용 RPC 2개.
-- SECURITY DEFINER 이유는 0002/0004와 동일(RLS 정책 0개 상태에서 함수 소유자 권한으로 실행,
-- anon/authenticated에는 EXECUTE 미부여 — Edge Function이 service_role로만 호출).

-- ── 1) 신청 등록 ──
-- 원본 add_item_request(database.py:2071)의 중복 판정을 그대로 재현하되,
-- SELECT-then-INSERT 레이스를 트랜잭션+어드바이저리 락으로 제거.
-- 중복 판정은 item_id 단위가 아니라 "같은 item_name의 재고 전체" 단위(원본 규칙).
CREATE OR REPLACE FUNCTION public.add_item_request_safe(
  p_user_id text,
  p_item_id integer,
  p_score integer,
  p_qty integer,
  p_pref1 text,
  p_pref2 text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_dup_status text;
BEGIN
  SELECT item_name INTO v_name FROM inventory WHERE id = p_item_id AND status = '재고';
  IF NOT FOUND THEN
    RETURN 'no_item';
  END IF;

  -- 같은 유저의 같은 아이템명 동시 신청을 직렬화
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id || '|' || v_name));

  SELECT ir.status INTO v_dup_status
  FROM item_requests ir
  JOIN inventory inv ON inv.id = ir.item_id
  WHERE inv.item_name = v_name
    AND inv.status = '재고'
    AND ir.user_id = p_user_id
    AND ir.status IN ('대기', '확정')
  ORDER BY CASE ir.status WHEN '확정' THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_dup_status = '확정' THEN
    RETURN 'dup_confirmed';
  ELSIF v_dup_status = '대기' THEN
    RETURN 'dup_pending';
  END IF;

  INSERT INTO item_requests (user_id, item_id, current_contribution_score, requested_quantity, preference_1, preference_2)
  VALUES (p_user_id, p_item_id, p_score, p_qty, NULLIF(p_pref1, ''), NULLIF(p_pref2, ''));

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.add_item_request_safe(text, integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;

-- ── 2) 기간 종료 + 자동 확정 ──
-- 원본 auto_confirm_distributions(database.py:3506) + end_distribution_period(3478)를
-- 하나의 트랜잭션으로 묶은 것. FOR UPDATE 잠금으로 동시 호출(여러 사용자가 동시에
-- 마감 경과된 신청 화면을 여는 경우)에도 한 번만 실행되도록 함(이미 '종료'면 no-op).
-- 확정 순서: 기여점수 스냅샷 DESC, 신청시각 ASC. 재고 잔여를 못 채우는 신청은 '반려'.
-- 카테고리 아이템(is_category_item)은 자동확정 제외(운영진 수동 배정 대상 — 원본 동일).
-- 종료 시 전설 아퀴 재고의 유찰 카운트 +1 (원본 end_distribution_period 동일).
CREATE OR REPLACE FUNCTION public.close_distribution_period(p_period_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_name text;
  v_total integer;
  v_confirmed integer;
  v_remaining integer;
  v_req RECORD;
  v_count integer := 0;
BEGIN
  SELECT status INTO v_status FROM distribution_period WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND OR v_status <> '진행중' THEN
    RETURN 0;
  END IF;

  FOR v_name IN
    SELECT DISTINCT inv.item_name
    FROM item_requests ir
    JOIN inventory inv ON inv.id = ir.item_id
    WHERE ir.status = '대기'
      AND inv.status = '재고'
      AND COALESCE(inv.is_category_item, FALSE) = FALSE
  LOOP
    SELECT COALESCE(SUM(quantity), 0) INTO v_total
    FROM inventory WHERE item_name = v_name AND status = '재고';

    SELECT COALESCE(SUM(ir.requested_quantity), 0) INTO v_confirmed
    FROM item_requests ir
    JOIN inventory inv ON inv.id = ir.item_id
    WHERE inv.item_name = v_name AND inv.status = '재고' AND ir.status = '확정';

    v_remaining := v_total - v_confirmed;

    IF v_remaining <= 0 THEN
      UPDATE item_requests ir SET status = '반려'
      FROM inventory inv
      WHERE inv.id = ir.item_id AND inv.item_name = v_name AND inv.status = '재고' AND ir.status = '대기';
      CONTINUE;
    END IF;

    FOR v_req IN
      SELECT ir.id, ir.requested_quantity
      FROM item_requests ir
      JOIN inventory inv ON inv.id = ir.item_id
      WHERE inv.item_name = v_name AND inv.status = '재고' AND ir.status = '대기'
      ORDER BY ir.current_contribution_score DESC, ir.request_date ASC
    LOOP
      IF v_req.requested_quantity <= v_remaining THEN
        UPDATE item_requests SET status = '확정' WHERE id = v_req.id;
        v_remaining := v_remaining - v_req.requested_quantity;
        v_count := v_count + 1;
      ELSE
        UPDATE item_requests SET status = '반려' WHERE id = v_req.id;
      END IF;
    END LOOP;
  END LOOP;

  UPDATE distribution_period SET status = '종료' WHERE id = p_period_id;

  UPDATE inventory
  SET unsold_period_count = COALESCE(unsold_period_count, 0) + 1
  WHERE category = '아퀴' AND grade = '전설' AND status = '재고';

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.close_distribution_period(integer) FROM PUBLIC, anon, authenticated;
