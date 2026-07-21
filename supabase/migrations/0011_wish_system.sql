-- 분배 신청 지망제 개편 (분배신청_지망제_시안.html).
-- 실행 전 안전장치: 아래 두 값이 모두 0일 때만 실행할 것 (회차 사이, 신청 데이터 없는 상태).
--   SELECT (SELECT COUNT(*) FROM distribution_period WHERE status='진행중') AS active_periods,
--          (SELECT COUNT(*) FROM item_requests WHERE status='대기') AS pending_requests;
-- 전체가 멱등(재실행 안전)하게 작성됨.

-- ── 1) 지망 순위 컬럼: 1/2/3, NULL = 자유 신청 ──
ALTER TABLE public.item_requests
  ADD COLUMN IF NOT EXISTS wish_rank smallint
  CHECK (wish_rank IS NULL OR wish_rank BETWEEN 1 AND 3);

-- ── 2) 회원×회차×순위 유일 ──
-- 대기 상태에서만 유일하면 회차당 유일과 동치 (회차 전이 = 상태 전이: 대기→확정/반려/취소).
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_requests_user_rank_pending
  ON public.item_requests (user_id, wish_rank)
  WHERE status = '대기' AND wish_rank IS NOT NULL;

-- ── 3) 대량 소모품 자유 신청 플래그 ──
ALTER TABLE public.inventory
  ADD COLUMN IF NOT EXISTS free_apply boolean NOT NULL DEFAULT false;

-- ── 4) inventory_with_counts 뷰 재생성 (뷰 컬럼은 생성 시점 고정 — free_apply 포함 목적) ──
DROP VIEW IF EXISTS public.inventory_with_counts;
CREATE VIEW public.inventory_with_counts AS
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

-- ── 5) 지망 신청 RPC ──
-- p_rank 1~3 = 지망 (수량 1 고정), NULL = 자유 신청 (기존 수량 규칙).
-- 같은 순위의 다른 아이템은 자동 해제(교체), 같은 아이템 재등록은 순위 이동 — 시안 동작.
-- 해제된 지망은 '취소' 상태로 남긴다(이력 보존).
CREATE OR REPLACE FUNCTION public.add_item_wish_safe(
  p_user_id text,
  p_item_id integer,
  p_rank integer,
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

  -- 유저 단위 직렬화 (지망 교체/이동이 여러 행을 만지므로 유저의 지망 조작 전체를 잠금)
  PERFORM pg_advisory_xact_lock(hashtext(p_user_id || '|wish'));

  IF p_rank IS NOT NULL THEN
    -- R3: 이번 회차에 이미 지망 확정을 보유하면 재지망 불가 (회차당 1개)
    IF EXISTS (
      SELECT 1 FROM item_requests
      WHERE user_id = p_user_id AND status = '확정' AND wish_rank IS NOT NULL
    ) THEN
      RETURN 'already_confirmed';
    END IF;

    -- 같은 아이템(같은 이름 재고군)의 기존 대기 지망 해제 → 순위 이동
    UPDATE item_requests ir SET status = '취소'
    FROM inventory inv
    WHERE inv.id = ir.item_id AND inv.item_name = v_name AND inv.status = '재고'
      AND ir.user_id = p_user_id AND ir.status = '대기' AND ir.wish_rank IS NOT NULL;

    -- 같은 순위에 걸려 있던 다른 아이템 해제 → 교체
    UPDATE item_requests SET status = '취소'
    WHERE user_id = p_user_id AND status = '대기' AND wish_rank = p_rank;

    INSERT INTO item_requests
      (user_id, item_id, current_contribution_score, requested_quantity, preference_1, preference_2, wish_rank)
    VALUES
      (p_user_id, p_item_id, p_score, 1, NULLIF(p_pref1, ''), NULLIF(p_pref2, ''), p_rank);
    RETURN 'ok';
  END IF;

  -- 자유 신청: 기존 add_item_request_safe와 동일한 중복 판정 (자유 신청끼리, 같은 이름 단위)
  SELECT ir.status INTO v_dup_status
  FROM item_requests ir
  JOIN inventory inv ON inv.id = ir.item_id
  WHERE inv.item_name = v_name AND inv.status = '재고'
    AND ir.user_id = p_user_id AND ir.status IN ('대기', '확정') AND ir.wish_rank IS NULL
  ORDER BY CASE ir.status WHEN '확정' THEN 0 ELSE 1 END
  LIMIT 1;

  IF v_dup_status = '확정' THEN
    RETURN 'dup_confirmed';
  ELSIF v_dup_status = '대기' THEN
    RETURN 'dup_pending';
  END IF;

  INSERT INTO item_requests
    (user_id, item_id, current_contribution_score, requested_quantity, preference_1, preference_2, wish_rank)
  VALUES
    (p_user_id, p_item_id, p_score, GREATEST(COALESCE(p_qty, 1), 1), NULLIF(p_pref1, ''), NULLIF(p_pref2, ''), NULL);
  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.add_item_wish_safe(text, integer, integer, integer, integer, text, text) FROM PUBLIC, anon, authenticated;

-- ── 6) 기간 종료 + 자동확정: 지망제 3패스 알고리즘으로 교체 ──
-- 패스1→2→3: 아이템별 해당 순위 풀에서 기여점수 DESC·신청일 ASC로 재고 수량만큼 확정(지망 1건 = 수량 1).
-- 확정 즉시 그 유저의 잔여 지망 전부 '취소'(R3) — 다음 풀에서 자연 제외.
-- 자유 신청(wish_rank NULL)은 기존 방식(기여점수순, 수량 검증, R3 미적용)으로 별도 확정.
-- 순위 밖 지망은 '반려'. 카테고리 아이템은 자동확정 제외(운영진 수동 배정 — 기존 동일).
-- 유찰: 이번 회차 확정이 하나도 없는 전설 아퀴 재고만 +1 (구분 표준화 후 '아퀴룬', 구 값 '아퀴' 호환).
CREATE OR REPLACE FUNCTION public.close_distribution_period(p_period_id integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_name text;
  v_rank integer;
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

  -- ── 지망 3패스 선정 ──
  FOR v_rank IN 1..3 LOOP
    FOR v_name IN
      SELECT DISTINCT inv.item_name
      FROM item_requests ir
      JOIN inventory inv ON inv.id = ir.item_id
      WHERE ir.status = '대기' AND ir.wish_rank = v_rank
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
      CONTINUE WHEN v_remaining <= 0;

      FOR v_req IN
        SELECT ir.id, ir.user_id
        FROM item_requests ir
        JOIN inventory inv ON inv.id = ir.item_id
        WHERE inv.item_name = v_name AND inv.status = '재고'
          AND ir.status = '대기' AND ir.wish_rank = v_rank
        ORDER BY ir.current_contribution_score DESC, ir.request_date ASC
      LOOP
        EXIT WHEN v_remaining <= 0;
        UPDATE item_requests SET status = '확정' WHERE id = v_req.id;
        v_remaining := v_remaining - 1;
        v_count := v_count + 1;
        -- R3: 확정자의 잔여 지망 전부 자동 취소 (회차당 1개)
        UPDATE item_requests SET status = '취소'
        WHERE user_id = v_req.user_id AND status = '대기' AND wish_rank IS NOT NULL;
      END LOOP;
    END LOOP;
  END LOOP;

  -- 순위 밖 잔여 지망 → 반려 (카테고리 아이템 지망은 대기 유지 — 운영진 수동 배정)
  UPDATE item_requests ir SET status = '반려'
  FROM inventory inv
  WHERE inv.id = ir.item_id AND inv.status = '재고'
    AND COALESCE(inv.is_category_item, FALSE) = FALSE
    AND ir.status = '대기' AND ir.wish_rank IS NOT NULL;

  -- ── 자유 신청: 기존 방식 (기여점수 DESC·신청일 ASC, 수량 검증, R3 미적용) ──
  FOR v_name IN
    SELECT DISTINCT inv.item_name
    FROM item_requests ir
    JOIN inventory inv ON inv.id = ir.item_id
    WHERE ir.status = '대기' AND ir.wish_rank IS NULL
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
      WHERE inv.id = ir.item_id AND inv.item_name = v_name AND inv.status = '재고'
        AND ir.status = '대기' AND ir.wish_rank IS NULL;
      CONTINUE;
    END IF;

    FOR v_req IN
      SELECT ir.id, ir.requested_quantity
      FROM item_requests ir
      JOIN inventory inv ON inv.id = ir.item_id
      WHERE inv.item_name = v_name AND inv.status = '재고'
        AND ir.status = '대기' AND ir.wish_rank IS NULL
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

  -- 유찰: 이번 회차 확정이 하나도 붙지 않은 전설 아퀴 재고만 +1 (R2)
  UPDATE inventory inv
  SET unsold_period_count = COALESCE(unsold_period_count, 0) + 1
  WHERE inv.category IN ('아퀴', '아퀴룬') AND inv.grade = '전설' AND inv.status = '재고'
    AND NOT EXISTS (
      SELECT 1 FROM item_requests ir
      JOIN inventory i2 ON i2.id = ir.item_id
      WHERE i2.item_name = inv.item_name AND i2.status = '재고' AND ir.status = '확정'
    );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.close_distribution_period(integer) FROM PUBLIC, anon, authenticated;

-- ── 7) 운영진 수동 확정: R3 적용 (지망 신청을 확정하면 그 유저의 잔여 지망 자동 취소) ──
-- 재고 초과 방지/소진 시 잔여 반려 등 기존 로직은 그대로.
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
  v_this_rank integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('confirm_item_' || p_item_id::text));

  SELECT quantity INTO v_current_qty FROM inventory WHERE id = p_item_id AND status = '재고';
  IF NOT FOUND THEN
    RETURN 'no_item';
  END IF;

  SELECT COALESCE(SUM(requested_quantity), 0) INTO v_confirmed
  FROM item_requests WHERE item_id = p_item_id AND status = '확정';

  SELECT requested_quantity, wish_rank INTO v_this_qty, v_this_rank
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

  -- R3: 지망 신청을 확정한 경우 잔여 지망 자동 취소 (자유 신청 확정 시엔 지망 유지)
  IF v_this_rank IS NOT NULL THEN
    UPDATE item_requests SET status = '취소'
    WHERE user_id = p_winner_user_id AND status = '대기' AND wish_rank IS NOT NULL;
  END IF;

  -- 재고 소진 → 남은 대기 전부 반려 (원본 동일)
  IF v_confirmed + v_this_qty >= v_current_qty THEN
    UPDATE item_requests SET status = '반려'
    WHERE item_id = p_item_id AND status = '대기';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_item_distribution(integer, text) FROM PUBLIC, anon, authenticated;
