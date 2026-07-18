-- 다이아 계좌 통합 별칭: 특정 룻자의 다이아 정산을 다른 계좌로 합산 관리.
-- 현재 규칙: 곰형(크앙) → 관리자(admin). 나머지 운영진은 각자 계좌 유지.
-- Edge Function(finalize 입금)과 아래 분배취소(출금 역전)가 같은 별칭을 읽어 대칭을 보장한다.
INSERT INTO app_settings (key, value)
VALUES ('dia_account_alias', '{"크앙":"admin"}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 분배취소: 다이아 역전 대상에 별칭 적용 (0008 버전 대체 — 나머지 로직 동일)
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
  v_alias jsonb;
  v_dia_uid text;
  v_dia_name text;
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

  -- 다이아 역전: 실제 입금됐던 계좌를 거래 기록(ref_id=이력번호)에서 찾아 그 계좌에서 출금.
  -- (UI에서 룻자를 골라 입금한 경우까지 정확히 대칭) 기록이 없으면 룻자+별칭으로 폴백.
  IF COALESCE(v_h.diamond_amount, 0) > 0 THEN
    SELECT owner_user_id, owner_name INTO v_dia_uid, v_dia_name
    FROM guild_transactions
    WHERE ref_type = 'distribution' AND ref_id = p_history_id::text
      AND asset_type = '다이아' AND direction = '입금'
    ORDER BY id DESC LIMIT 1;

    IF v_dia_uid IS NULL AND v_h.looter_user_id IS NOT NULL THEN
      v_dia_uid := v_h.looter_user_id;
      BEGIN
        SELECT value::jsonb INTO v_alias FROM app_settings WHERE key = 'dia_account_alias';
        IF v_alias IS NOT NULL AND v_alias ? v_dia_uid THEN
          v_dia_uid := v_alias ->> v_dia_uid;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_dia_uid := v_h.looter_user_id; -- 별칭 파싱 실패 시 원래 대상 유지
      END;
      SELECT current_id INTO v_dia_name FROM members WHERE user_id = v_dia_uid;
    END IF;

    IF v_dia_uid IS NOT NULL THEN
      PERFORM public.apply_treasury_transaction(
        '다이아', '출금', v_h.diamond_amount,
        v_dia_uid, COALESCE(v_dia_name, v_h.looter, v_dia_uid),
        '분배취소: ' || v_h.item_name || ' (이력#' || p_history_id || ')',
        'distribution_cancel', p_history_id::text, p_created_by);
    END IF;
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
