-- 0016: 결사 합병 초기화 4탄 — 닉네임 이력 + 가입 신청 이력 + 세션 정리
-- (기록용 — 사용자가 2026-07-28 SQL Editor에서 이미 실행 완료한 스크립트)
--
-- 사용자 결정: 기존 결사원은 합병 결사로 그대로 이동 → members의 스샷/장비/아퀴는 보전.
--
-- 대상:
--   - member_nick_history    (옛 닉네임 사전)   → 아카이브 후 삭제
--     참여 로그 닉 매칭용 사전. 옛 닉이 남으면 합병 신규 인원 닉과 겹칠 때 오매칭 위험.
--   - registration_requests  (가입 신청 이력)   → 아카이브 후 삭제
--     base64 스샷 포함이라 DB 용량도 회수됨.
--   - user_sessions          (로그인 세션)      → 삭제만 (일회성 토큰이라 아카이브 불필요.
--     실행 즉시 전원 로그아웃 → 재로그인)
--
-- 아카이브 테이블이 이미 존재하면 실패한다(중복 실행 방지 겸용).

BEGIN;

CREATE TABLE member_nick_history_archive   AS SELECT * FROM member_nick_history;
CREATE TABLE registration_requests_archive AS SELECT * FROM registration_requests;

ALTER TABLE member_nick_history_archive   ENABLE ROW LEVEL SECURITY;
ALTER TABLE registration_requests_archive ENABLE ROW LEVEL SECURITY;

DELETE FROM member_nick_history;
DELETE FROM registration_requests;
DELETE FROM user_sessions;

COMMIT;

-- ── 검증 ─────────────────────────────────────────────────────
SELECT 'member_nick_history' AS t, (SELECT COUNT(*) FROM member_nick_history_archive) AS 아카이브, (SELECT COUNT(*) FROM member_nick_history) AS 본테이블
UNION ALL SELECT 'registration_requests', (SELECT COUNT(*) FROM registration_requests_archive), (SELECT COUNT(*) FROM registration_requests)
UNION ALL SELECT 'user_sessions', NULL, (SELECT COUNT(*) FROM user_sessions);
