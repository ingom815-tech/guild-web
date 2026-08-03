-- 0023: 전력 분석 역할 6종 개편 — 딜러(dealer)를 마딜러(mdealer)/물딜러(pdealer)로 분리
-- 기존 '딜러' 지정자는 클래스 기준으로 이관: 태양감시자/주문각인사 → 마딜러, 그 외 → 물딜러.
-- (이관은 시작값일 뿐 — 분석 탭에서 자유롭게 재지정 가능)
ALTER TABLE war_roles DROP CONSTRAINT war_roles_role_check;
UPDATE war_roles wr
SET role = CASE WHEN m.class IN ('태양감시자', '주문각인사') THEN 'mdealer' ELSE 'pdealer' END
FROM members m
WHERE m.user_id = wr.member_id AND wr.role = 'dealer';
ALTER TABLE war_roles ADD CONSTRAINT war_roles_role_check
  CHECK (role IN ('tank', 'bruiser', 'mdealer', 'pdealer', 'healer', 'support'));
