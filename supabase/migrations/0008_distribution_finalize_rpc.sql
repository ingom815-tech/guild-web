-- 분배 후반부(확정/최종처리/취소)용 RPC 3개.
-- SECURITY DEFINER 이유는 0002/0004/0005와 동일 — RLS 정책 0개 상태에서 함수 소유자 권한으로 실행,
-- anon/authenticated에는 EXECUTE 미부여 (Edge Function이 service_role로만 호출).
-- 원본 database.py는 명시적 트랜잭션 없이 단계별 개별 커밋이었으나(부분 반영 위험),
-- 여기서는 다단계 로직을 함수 하나 = 트랜잭션 하나로 원자화한다. 로직 자체는 원본 그대로.

-- ── 1) 운영진 수동 확정 (원본 confirm_item_distribution, database.py:2399) ──
-- 재고 초과 방지: 기확정 수량 + 이번 신청 수량 > 재고면 거부.
-- 재고 소진 시 남은 대기 신청 전부 '반려'.
CREATE OR REPLACE FUNCTION public.confirm_item_distribution(
  p_item_id integer,
  p_winner_user_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_qty integer;
  v_confirmed integer;
  v_this_qty integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('confirm_item_' || p_item_id::text));

  SELECT quantity INTO v_current_qty FROM inventory WHERE id = p_item_id AND status = '재고';
  IF NOT FOUND THEN
    RETURN 'no_item';
  END IF;

  SELECT COALESCE(SUM(requested_quantity), 0) INTO v_confirmed
  FROM item_requests WHERE item_id = p_item_id AND status = '확정';

  SELECT requested_quantity INTO v_this_qty
  FROM item_requests
  WHERE item_id = p_item_id AND user_id = p_winner_user_id AND status = '대기'
  ORDER BY id LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'no_request';
  END IF;

  IF v_confirmed + v_this_qty > v_current_qty THEN
    RETURN 'exceeded';
  END IF;

  UPDATE item_requests SET status = '확정'
  WHERE item_id = p_item_id AND user_id = p_winner_user_id AND status = '대기';

  -- 재고 소진 → 남은 대기 전부 반려 (원본 동일)
  IF v_confirmed + v_this_qty >= v_current_qty THEN
    UPDATE item_requests SET status = '반려'
    WHERE item_id = p_item_id AND status = '대기';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_item_distribution(integer, text) FROM PUBLIC, anon, authenticated;

-- ── 2) 최종확인 (원본 finalize_distribution, database.py:2537-2591) ──
-- 이력 INSERT + 신청행 DELETE + 아퀴 특칙(동일 유저의 다른 아퀴 대기 신청 취소) + 재고 차감.
-- 원본과 동일하게 공금 입금은 이 함수 밖(Edge Function)에서 처리한다 — 원본 app.py 호출부 책임의 비대칭 유지.
-- 장비/아퀴 자동 갱신도 Edge Function(TS)에서 수행 (원본 _update_member_equipment_on_distribution 이식).
CREATE OR REPLACE FUNCTION public.finalize_distribution(
  p_item_id integer,
  p_receiver_name text,
  p_receiver_user_id text,
  p_request_id integer,
  p_diamond integer,
  p_cash integer
)
RETURNS TABLE (
  history_id integer,
  item_name text,
  category text,
  grade text,
  looter text,
  looter_user_id text,
  dist_qty integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_looter_name text;
  v_req_qty integer;
  v_hist_id integer;
  v_new_qty integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('finalize_item_' || p_item_id::text));

  SELECT i.*, m.current_id AS looter_current_id
  INTO v_inv
  FROM inventory i
  LEFT JOIN members m ON m.user_id = i.looter_user_id
  WHERE i.id = p_item_id AND i.status = '재고';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no_item';
  END IF;

  v_looter_name := COALESCE(v_inv.looter_current_id, v_inv.looter);

  SELECT requested_quantity INTO v_req_qty FROM item_requests WHERE id = p_request_id;
  IF v_req_qty IS NULL THEN
    v_req_qty := 1;
  END IF;

  INSERT INTO distribution_history
    (item_name, looter, looter_user_id, quantity, registered_at, category, receiver, grade,
     receiver_user_id, diamond_amount, cash_amount)
  VALUES
    (v_inv.item_name, v_looter_name, v_inv.looter_user_id, v_req_qty, v_inv.registered_at,
     v_inv.category, p_receiver_name, v_inv.grade, p_receiver_user_id,
     COALESCE(p_diamond, 0), COALESCE(p_cash, 0))
  RETURNING id INTO v_hist_id;

  IF p_request_id IS NOT NULL THEN
    DELETE FROM item_requests WHERE id = p_request_id;
  END IF;

  -- 아퀴 특칙: 아퀴를 받은 유저의 다른 아퀴 대기 신청 전부 '취소' (원본 2571-2578)
  IF v_inv.category = '아퀴' AND p_receiver_user_id IS NOT NULL THEN
    UPDATE item_requests ir SET status = '취소'
    FROM inventory i2
    WHERE ir.item_id = i2.id
      AND i2.category = '아퀴'
      AND ir.user_id = p_receiver_user_id
      AND ir.status = '대기';
  END IF;

  -- 재고 차감 (원본 2580-2591)
  v_new_qty := v_inv.quantity - v_req_qty;
  IF v_new_qty <= 0 THEN
    DELETE FROM item_requests WHERE item_id = p_item_id;
    DELETE FROM inventory WHERE id = p_item_id;
  ELSE
    UPDATE inventory SET quantity = v_new_qty, unsold_period_count = 0 WHERE id = p_item_id;
  END IF;

  RETURN QUERY SELECT v_hist_id, v_inv.item_name, v_inv.category, v_inv.grade,
    v_looter_name, v_inv.looter_user_id, v_req_qty;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_distribution(integer, text, text, integer, integer, integer) FROM PUBLIC, anon, authenticated;

-- ── 3) 분배취소 (원본 cancel_finalized_distribution, database.py:1896-1983, 관리자 전용) ──
-- 재고 복원(동일 아이템 있으면 수량 합산, 없으면 신규 행) + 확정 신청 복원 + 공금 역전 + 이력 DELETE.
-- 공금 역전은 0004의 apply_treasury_transaction을 재사용해 잔액/거래로그 일관성 유지.
CREATE OR REPLACE FUNCTION public.cancel_finalized_distribution(
  p_history_id integer,
  p_created_by text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_h record;
  v_inv_id integer;
  v_score integer;
BEGIN
  SELECT * INTO v_h FROM distribution_history WHERE id = p_history_id;
  IF NOT FOUND THEN
    RETURN 'no_history';
  END IF;

  -- 재고 복원: 동일 아이템(이름+구분+등급+룻자) 재고행이 있으면 합산, 없으면 신규 INSERT
  SELECT id INTO v_inv_id
  FROM inventory
  WHERE item_name = v_h.item_name
    AND COALESCE(category, '') = COALESCE(v_h.category, '')
    AND COALESCE(grade, '') = COALESCE(v_h.grade, '')
    AND COALESCE(looter_user_id, '') = COALESCE(v_h.looter_user_id, '')
    AND status = '재고'
  ORDER BY id LIMIT 1;

  IF v_inv_id IS NOT NULL THEN
    UPDATE inventory SET quantity = quantity + COALESCE(v_h.quantity, 1) WHERE id = v_inv_id;
  ELSE
    INSERT INTO inventory (item_name, looter, looter_user_id, quantity, category, grade, registered_at, status)
    VALUES (v_h.item_name, v_h.looter, v_h.looter_user_id, COALESCE(v_h.quantity, 1),
            v_h.category, v_h.grade, COALESCE(v_h.registered_at, NOW() AT TIME ZONE 'Asia/Seoul'), '재고')
    RETURNING id INTO v_inv_id;
  END IF;

  -- 확정 신청 복원 (수령자 uid가 있을 때만 — 원본 동일)
  IF v_inv_id IS NOT NULL AND v_h.receiver_user_id IS NOT NULL THEN
    SELECT COALESCE(contribution_score, 0) INTO v_score FROM members WHERE user_id = v_h.receiver_user_id;
    IF FOUND THEN
      INSERT INTO item_requests (user_id, item_id, status, requested_quantity, current_contribution_score)
      VALUES (v_h.receiver_user_id, v_inv_id, '확정', COALESCE(v_h.quantity, 1), COALESCE(v_score, 0));
    END IF;
  END IF;

  -- 다이아 역전 (룻자 계좌 출금)
  IF COALESCE(v_h.diamond_amount, 0) > 0 AND v_h.looter_user_id IS NOT NULL THEN
    PERFORM public.apply_treasury_transaction(
      '다이아', '출금', v_h.diamond_amount,
      v_h.looter_user_id, COALESCE(v_h.looter, v_h.looter_user_id),
      '분배취소: ' || v_h.item_name || ' (이력#' || p_history_id || ')',
      'distribution_cancel', p_history_id::text, p_created_by);
  END IF;

  -- 현금 역전 (결사 금고 출금)
  IF COALESCE(v_h.cash_amount, 0) > 0 THEN
    PERFORM public.apply_treasury_transaction(
      '현금', '출금', v_h.cash_amount,
      'guild_treasury', '결사 금고',
      '분배취소: ' || v_h.item_name || ' (이력#' || p_history_id || ')',
      'distribution_cancel', p_history_id::text, p_created_by);
  END IF;

  DELETE FROM distribution_history WHERE id = p_history_id;
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_finalized_distribution(integer, text) FROM PUBLIC, anon, authenticated;
