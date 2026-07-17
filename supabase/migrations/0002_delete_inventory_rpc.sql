-- item_requests(대기중 신청 포함) 삭제 + inventory 삭제를 하나의 트랜잭션으로 묶는다.
-- item_requests.item_id 에는 FK 제약이 없어서(직접 확인함), 두 supabase-js 호출을
-- 순서대로 날리면 중간에 실패 시 고아 행이 남을 수 있다 — 이걸 막기 위한 RPC.
-- security definer: RLS가 전체 테이블에 걸려 있어도(정책 0개) 이 함수 소유자 권한으로
-- 실행되어 정상 동작한다. anon/authenticated 에는 EXECUTE 권한을 주지 않는다
-- (Edge Function은 service_role 키로 호출하므로 별도 GRANT 불필요).

CREATE OR REPLACE FUNCTION public.delete_inventory_item(p_item_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM item_requests WHERE item_id = p_item_id;
  DELETE FROM inventory WHERE id = p_item_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_inventory_item(integer) FROM PUBLIC, anon, authenticated;
