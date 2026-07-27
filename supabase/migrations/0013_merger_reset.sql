-- 0013: 결사 합병 초기화 — 참여 데이터 + 공금 데이터 아카이브 후 리셋
--
-- ⚠️ 실행 시점: 합병 직전에 1회만. 사용자 승인 완료된 결정 사항:
--   - 공금 잔액: 전부 0으로 리셋 (합병 후 실물 보유액을 "합병 이월금"으로 첫 입금 처리)
--   - 기여점수(contribution_score): 그대로 유지 (시즌 1 첫 참여 로그 등록 시 자연 갱신)
--   - 회원 계정(members의 user_id/current_id/password)·분배 이력·재고: 건드리지 않음 (보전)
--
-- 방식: DELETE가 아니라 아카이브 테이블로 전체 복사 후 본 테이블을 비운다.
-- 아카이브 테이블도 RLS를 켜서(정책 0개 = 전체 차단) anon 키로 못 읽게 한다.
-- 재실행 불가: 아카이브 테이블이 이미 존재하면 실패한다(중복 실행 방지 겸용).

BEGIN;

-- ── 1. 참여 데이터 아카이브 ──────────────────────────────────
CREATE TABLE participation_logs_archive        AS SELECT * FROM participation_logs;
CREATE TABLE participation_log_members_archive AS SELECT * FROM participation_log_members;
CREATE TABLE season_participation_archive      AS SELECT * FROM season_participation;
CREATE TABLE member_shift_history_archive      AS SELECT * FROM member_shift_history;

ALTER TABLE participation_logs_archive        ENABLE ROW LEVEL SECURITY;
ALTER TABLE participation_log_members_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_participation_archive      ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_shift_history_archive      ENABLE ROW LEVEL SECURITY;

-- ── 2. 참여 데이터 본 테이블 비우기 ──────────────────────────
DELETE FROM participation_log_members;
DELETE FROM participation_logs;
DELETE FROM season_participation;
DELETE FROM member_shift_history;

-- ── 3. members 참여 컬럼 리셋 (계정·기여점수는 유지) ─────────
UPDATE members SET
  participation_score = 0,
  bontu_score    = 0,
  siteum_score   = 0,
  uni_score      = 0,
  gyeoldun_score = 0,
  byeolbong_score = 0,
  saebyeok_score = 0,
  preferred_shift = NULL;

-- ── 4. 시즌 설정: 시즌 1 재시작 ──────────────────────────────
INSERT INTO app_settings (key, value) VALUES ('current_season', '1')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
DELETE FROM app_settings WHERE key LIKE 'season\_%\_closed';

-- ── 5. 공금 아카이브 ─────────────────────────────────────────
CREATE TABLE guild_transactions_archive AS SELECT * FROM guild_transactions;
CREATE TABLE guild_assets_archive       AS SELECT * FROM guild_assets;

ALTER TABLE guild_transactions_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_assets_archive       ENABLE ROW LEVEL SECURITY;

-- ── 6. 공금 리셋: 이력 전체 삭제 + 잔액 0 ────────────────────
-- 계좌 행(결사 금고 + 운영진별 다이아 계좌)은 남기고 잔액만 0으로.
-- 곰형의 음수 잔액(-13,576)도 이 시점에 0으로 정리된다.
DELETE FROM guild_transactions;
UPDATE guild_assets SET balance = 0, updated_at = (now() AT TIME ZONE 'Asia/Seoul');

COMMIT;

-- ── 검증 (실행 후 결과 확인용) ───────────────────────────────
SELECT 'participation_logs' AS t, (SELECT COUNT(*) FROM participation_logs_archive) AS 아카이브, (SELECT COUNT(*) FROM participation_logs) AS 본테이블
UNION ALL SELECT 'participation_log_members', (SELECT COUNT(*) FROM participation_log_members_archive), (SELECT COUNT(*) FROM participation_log_members)
UNION ALL SELECT 'season_participation', (SELECT COUNT(*) FROM season_participation_archive), (SELECT COUNT(*) FROM season_participation)
UNION ALL SELECT 'member_shift_history', (SELECT COUNT(*) FROM member_shift_history_archive), (SELECT COUNT(*) FROM member_shift_history)
UNION ALL SELECT 'guild_transactions', (SELECT COUNT(*) FROM guild_transactions_archive), (SELECT COUNT(*) FROM guild_transactions)
UNION ALL SELECT 'members(참여점수>0)', NULL, (SELECT COUNT(*) FROM members WHERE participation_score > 0)
UNION ALL SELECT 'guild_assets(잔액≠0)', (SELECT COUNT(*) FROM guild_assets_archive WHERE balance <> 0), (SELECT COUNT(*) FROM guild_assets WHERE balance <> 0)
UNION ALL SELECT 'current_season', NULL, (SELECT value::int FROM app_settings WHERE key = 'current_season');
