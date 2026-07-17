-- 공금관리(다이아/현금) 수동 입출금용 RPC 2개.
-- 원본 Streamlit 앱은 guild_assets.balance UPDATE/INSERT와 guild_transactions INSERT를
-- 별도의 두 쿼리로 날려서(트랜잭션 미결합) 동시 입출금 시 레이스 컨디션 위험이 있었다.
-- 여기서는 하나의 Postgres 함수로 원자화한다. SECURITY DEFINER 이유는 0002와 동일
-- (RLS 정책 0개라도 함수 소유자 권한으로 통과, anon/authenticated에는 EXECUTE 미부여).
--
-- 잔액 값 표기는 실제 마이그레이션된 데이터 기준: asset_type은 '현금'/'다이아',
-- direction은 '입금'/'출금' (전부 한글). 현금은 owner_user_id='guild_treasury'
-- 단일 행, 다이아는 owner_user_id=운영진 user_id별로 여러 행.
--
-- 출금 시 잔액 부족 검사 없음(원본과 동일 — 사용자 확인 후 그대로 포팅한 결함성 동작).

CREATE OR REPLACE FUNCTION public.apply_treasury_transaction(
  p_asset_type text,
  p_direction text,
  p_amount integer,
  p_owner_user_id text,
  p_owner_name text,
  p_description text,
  p_ref_type text,
  p_ref_id text,
  p_created_by text
)
RETURNS TABLE (transaction_id integer, new_balance integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delta integer;
  v_balance integer;
  v_tx_id integer;
BEGIN
  IF p_direction = '입금' THEN
    v_delta := p_amount;
  ELSIF p_direction = '출금' THEN
    v_delta := -p_amount;
  ELSE
    RAISE EXCEPTION 'direction은 입금 또는 출금이어야 합니다: %', p_direction;
  END IF;

  -- guild_assets에 (asset_type, owner_user_id) UNIQUE 제약이 없어 ON CONFLICT를 못 쓴다
  -- (기존 마이그레이션 데이터에 중복이 있는지 검증되지 않아 이번에 제약을 새로 추가하지도 않음).
  -- FOR UPDATE로 기존 행을 잠가 동시 갱신 레이스를 막는다(원본은 이 락조차 없었음).
  PERFORM 1 FROM guild_assets
    WHERE asset_type = p_asset_type AND owner_user_id = p_owner_user_id
    FOR UPDATE;
  IF FOUND THEN
    UPDATE guild_assets
      SET balance = balance + v_delta, updated_at = (now() AT TIME ZONE 'Asia/Seoul')
      WHERE asset_type = p_asset_type AND owner_user_id = p_owner_user_id
      RETURNING balance INTO v_balance;
  ELSE
    INSERT INTO guild_assets (asset_type, owner_user_id, owner_name, balance)
      VALUES (p_asset_type, p_owner_user_id, p_owner_name, v_delta)
      RETURNING balance INTO v_balance;
  END IF;

  INSERT INTO guild_transactions (asset_type, direction, amount, owner_user_id, owner_name, description, ref_type, ref_id, created_by)
  VALUES (p_asset_type, p_direction, p_amount, p_owner_user_id, p_owner_name, p_description, p_ref_type, p_ref_id, p_created_by)
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_tx_id, v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_treasury_transaction(text, text, integer, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- 이력 삭제(원본의 delete_transaction) — 역방향으로 잔액을 되돌리되 0 밑으로는 안 내려가게
-- GREATEST로 클램프(원본에도 있던 동작). 수동 출금 자체는 클램프 없음과 별개 — 이력 삭제
-- 시 과다 차감으로 잔액이 더 이상해지는 것만 방지하는 용도.
CREATE OR REPLACE FUNCTION public.reverse_treasury_transaction(p_transaction_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx guild_transactions%ROWTYPE;
  v_delta integer;
BEGIN
  SELECT * INTO v_tx FROM guild_transactions WHERE id = p_transaction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '해당 거래를 찾을 수 없습니다: %', p_transaction_id;
  END IF;

  -- 입금 이력을 지우면 잔액에서 빼고, 출금 이력을 지우면 잔액에 되돌려준다.
  IF v_tx.direction = '입금' THEN
    v_delta := -v_tx.amount;
  ELSE
    v_delta := v_tx.amount;
  END IF;

  UPDATE guild_assets
  SET balance = GREATEST(balance + v_delta, 0), updated_at = (now() AT TIME ZONE 'Asia/Seoul')
  WHERE asset_type = v_tx.asset_type AND owner_user_id = v_tx.owner_user_id;

  DELETE FROM guild_transactions WHERE id = p_transaction_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_treasury_transaction(integer) FROM PUBLIC, anon, authenticated;
