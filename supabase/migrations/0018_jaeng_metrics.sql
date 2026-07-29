-- 0018: !긴급 → !쟁 개편 1단계 (추가만 — 먼저 실행, 이후 함수 3개 재배포, 그 다음 0019)
--
-- 규정 변경(사용자 승인): 쟁(구 긴급) 출석은 참여점수·참여율 계산에서 제외하고
-- 별도 지표(쟁 참여횟수/쟁 참여율 + 오전/오후/새벽 시간대별 횟수)로 관리한다.
--   오전 09:00~17:00 / 오후 17:01~23:00 / 새벽 23:01~08:59 (로그의 log_datetime 기준)
-- 데이/나이트 조 선택 기능은 폐지(0019에서 테이블/컬럼 삭제).
--
-- ※ 참여점수 공식 변경점: 기존에는 긴급이 saebyeok 컬럼으로 6종 합산에 포함됐다.
--    이번 개편으로 5종(본토/시틈/유니/결던/별봉) × 100으로 바뀌고, 참여율 분모에서도
--    쟁 로그가 빠진다. 합병 초기화 직후(시즌 1 로그 0건)라 소급 영향 없음.

-- ── 쟁 지표 컬럼 ──
ALTER TABLE members
  ADD COLUMN IF NOT EXISTS jaeng_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jaeng_rate numeric,
  ADD COLUMN IF NOT EXISTS jaeng_morning integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jaeng_evening integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jaeng_dawn integer NOT NULL DEFAULT 0;

ALTER TABLE season_participation
  ADD COLUMN IF NOT EXISTS jaeng_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jaeng_rate numeric,
  ADD COLUMN IF NOT EXISTS jaeng_morning integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jaeng_evening integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jaeng_dawn integer NOT NULL DEFAULT 0;

-- ── 재계산 함수 교체 ──
-- 점수 세션 = 쟁/긴급 제외 5종. 쟁 세션('쟁' + 레거시 '긴급')은 별도 집계.
CREATE OR REPLACE FUNCTION public.recalc_participation_scores(p_season integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_sessions integer;  -- 점수/참여율 분모 (쟁 제외)
  v_total_jaeng integer;     -- 쟁 참여율 분모
BEGIN
  SELECT COUNT(*) INTO v_total_sessions
  FROM participation_logs
  WHERE season = p_season AND activity_type NOT IN ('쟁', '긴급');

  SELECT COUNT(*) INTO v_total_jaeng
  FROM participation_logs
  WHERE season = p_season AND activity_type IN ('쟁', '긴급');

  -- 회원별 점수 집계 (쟁 제외 5종 — 로그 없는 회원 = 전부 0 → 멱등 재계산)
  CREATE TEMP TABLE _agg ON COMMIT DROP AS
  SELECT
    m.user_id,
    COALESCE(s.bontu, 0) AS bontu,
    COALESCE(s.siteum, 0) AS siteum,
    COALESCE(s.uni, 0) AS uni,
    COALESCE(s.gyeoldun, 0) AS gyeoldun,
    COALESCE(s.byeolbong, 0) AS byeolbong,
    COALESCE(s.attended, 0) AS attended,
    COALESCE(j.jaeng, 0) AS jaeng,
    COALESCE(j.morning, 0) AS morning,
    COALESCE(j.evening, 0) AS evening,
    COALESCE(j.dawn, 0) AS dawn
  FROM members m
  LEFT JOIN (
    SELECT
      plm.user_id,
      SUM(CASE WHEN pl.activity_type = '본토' THEN 1 ELSE 0 END)::int AS bontu,
      SUM(CASE WHEN pl.activity_type = '시틈' THEN 1 ELSE 0 END)::int AS siteum,
      SUM(CASE WHEN pl.activity_type = '유니' THEN 1 ELSE 0 END)::int AS uni,
      SUM(CASE WHEN pl.activity_type = '결던' THEN 1 ELSE 0 END)::int AS gyeoldun,
      SUM(CASE WHEN pl.activity_type = '별봉' THEN 1 ELSE 0 END)::int AS byeolbong,
      COUNT(DISTINCT plm.log_id)::int AS attended
    FROM participation_log_members plm
    JOIN participation_logs pl ON pl.id = plm.log_id
    WHERE pl.season = p_season AND plm.user_id IS NOT NULL
      AND pl.activity_type NOT IN ('쟁', '긴급')
    GROUP BY plm.user_id
  ) s ON s.user_id = m.user_id
  LEFT JOIN (
    -- 쟁 집계: 총 횟수 + 시간대별 (오전 0900~1700 / 오후 1701~2300 / 새벽 그 외)
    SELECT
      plm.user_id,
      COUNT(DISTINCT plm.log_id)::int AS jaeng,
      SUM(CASE WHEN (EXTRACT(HOUR FROM pl.log_datetime)::int * 100 + EXTRACT(MINUTE FROM pl.log_datetime)::int)
                    BETWEEN 900 AND 1700 THEN 1 ELSE 0 END)::int AS morning,
      SUM(CASE WHEN (EXTRACT(HOUR FROM pl.log_datetime)::int * 100 + EXTRACT(MINUTE FROM pl.log_datetime)::int)
                    BETWEEN 1701 AND 2300 THEN 1 ELSE 0 END)::int AS evening,
      SUM(CASE WHEN (EXTRACT(HOUR FROM pl.log_datetime)::int * 100 + EXTRACT(MINUTE FROM pl.log_datetime)::int)
                    NOT BETWEEN 900 AND 2300 THEN 1 ELSE 0 END)::int AS dawn
    FROM participation_log_members plm
    JOIN participation_logs pl ON pl.id = plm.log_id
    WHERE pl.season = p_season AND plm.user_id IS NOT NULL
      AND pl.activity_type IN ('쟁', '긴급')
    GROUP BY plm.user_id
  ) j ON j.user_id = m.user_id;

  -- members 반영 (saebyeok_score는 개편 후 미사용 — 0 고정)
  UPDATE members m SET
    bontu_score = a.bontu,
    siteum_score = a.siteum,
    uni_score = a.uni,
    gyeoldun_score = a.gyeoldun,
    byeolbong_score = a.byeolbong,
    saebyeok_score = 0,
    participation_score = (a.bontu + a.siteum + a.uni + a.gyeoldun + a.byeolbong) * 100,
    jaeng_count = a.jaeng,
    jaeng_rate = CASE WHEN v_total_jaeng > 0
                      THEN ROUND((a.jaeng::numeric / v_total_jaeng) * 100, 1)
                      ELSE NULL END,
    jaeng_morning = a.morning,
    jaeng_evening = a.evening,
    jaeng_dawn = a.dawn
  FROM _agg a
  WHERE a.user_id = m.user_id;

  -- season_participation UPSERT (rate + 쟁 지표 포함)
  INSERT INTO season_participation
    (user_id, season, participation_score, participation_rate,
     bontu_score, siteum_score, uni_score, gyeoldun_score, byeolbong_score, saebyeok_score,
     jaeng_count, jaeng_rate, jaeng_morning, jaeng_evening, jaeng_dawn)
  SELECT
    a.user_id, p_season,
    (a.bontu + a.siteum + a.uni + a.gyeoldun + a.byeolbong) * 100,
    CASE WHEN v_total_sessions > 0
         THEN ROUND((a.attended::numeric / v_total_sessions) * 100, 1)
         ELSE 0 END,
    a.bontu, a.siteum, a.uni, a.gyeoldun, a.byeolbong, 0,
    a.jaeng,
    CASE WHEN v_total_jaeng > 0
         THEN ROUND((a.jaeng::numeric / v_total_jaeng) * 100, 1)
         ELSE NULL END,
    a.morning, a.evening, a.dawn
  FROM _agg a
  ON CONFLICT (user_id, season) DO UPDATE SET
    participation_score = EXCLUDED.participation_score,
    participation_rate = EXCLUDED.participation_rate,
    bontu_score = EXCLUDED.bontu_score,
    siteum_score = EXCLUDED.siteum_score,
    uni_score = EXCLUDED.uni_score,
    gyeoldun_score = EXCLUDED.gyeoldun_score,
    byeolbong_score = EXCLUDED.byeolbong_score,
    saebyeok_score = EXCLUDED.saebyeok_score,
    jaeng_count = EXCLUDED.jaeng_count,
    jaeng_rate = EXCLUDED.jaeng_rate,
    jaeng_morning = EXCLUDED.jaeng_morning,
    jaeng_evening = EXCLUDED.jaeng_evening,
    jaeng_dawn = EXCLUDED.jaeng_dawn;

  -- 기여점수 재계산 (공식 불변: 참여점수×0.7 + 전투력×0.3)
  UPDATE members SET
    contribution_score = ROUND(COALESCE(participation_score, 0) * 0.7 + COALESCE(power, 0) * 0.3);

  RETURN v_total_sessions;
END;
$$;

REVOKE ALL ON FUNCTION public.recalc_participation_scores(integer) FROM PUBLIC, anon, authenticated;
