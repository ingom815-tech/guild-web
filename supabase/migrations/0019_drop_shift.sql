-- 0019: !긴급 → !쟁 개편 2단계 — 데이/나이트 조 선택 기능 폐지 (파괴적)
--
-- ⚠️ 반드시 0018 실행 + participation/dashboard/profile 함수 3개 재배포가 끝난 뒤 실행할 것.
--    (구버전 함수들이 이 테이블/컬럼을 조회하므로 먼저 지우면 화면이 500으로 깨진다)
--
-- 사용자 결정: 조 선택 기록은 보존 없이 삭제해도 됨 (합병 초기화로 사실상 빈 상태).

DROP TABLE IF EXISTS member_shift_history;
ALTER TABLE members DROP COLUMN IF EXISTS preferred_shift;
ALTER TABLE participation_logs DROP COLUMN IF EXISTS shift;

-- 검증: 세 개 모두 0행이면 정리 완료
SELECT
  (SELECT COUNT(*) FROM information_schema.tables  WHERE table_name = 'member_shift_history') AS 남은_테이블,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'members' AND column_name = 'preferred_shift') AS 남은_조컬럼,
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'participation_logs' AND column_name = 'shift') AS 남은_시프트컬럼;
