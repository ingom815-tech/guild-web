-- 참여율 관리용 RPC. SECURITY DEFINER 이유는 0002/0004/0005와 동일.
-- 원본 recalc_scores_from_logs(database.py:4001) + participation_rate 계산(4037-4074)
-- + recalc_contribution_scores(2946)를 하나의 트랜잭션으로 묶은 멱등 재계산 함수.
--
-- 점수 규칙(원본 그대로):
--   활동별 컬럼값 = 해당 시즌 로그에서 (user_id, activity_type)별 참여 로그 수
--   participation_score = 활동 합계 × 100
--   participation_rate  = 참석 DISTINCT 로그 수 / 시즌 전체 로그 수 × 100 (소수 1자리)
--   contribution_score  = round(participation_score × 0.7 + power × 0.3)
-- 활동 태그 → 컬럼: 본토→bontu, 시틈→siteum, 유니→uni, 결던→gyeoldun, 별봉→byeolbong, 긴급→saebyeok

CREATE OR REPLACE FUNCTION public.recalc_participation_scores(p_season integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_sessions integer;
BEGIN
  SELECT COUNT(*) INTO v_total_sessions
  FROM participation_logs WHERE season = p_season;

  -- 회원별 시즌 집계 (로그 없는 회원 = 전부 0 → 멱등 재계산)
  CREATE TEMP TABLE _agg ON COMMIT DROP AS
  SELECT
    m.user_id,
    COALESCE(s.bontu, 0) AS bontu,
    COALESCE(s.siteum, 0) AS siteum,
    COALESCE(s.uni, 0) AS uni,
    COALESCE(s.gyeoldun, 0) AS gyeoldun,
    COALESCE(s.byeolbong, 0) AS byeolbong,
    COALESCE(s.saebyeok, 0) AS saebyeok,
    COALESCE(s.attended, 0) AS attended
  FROM members m
  LEFT JOIN (
    SELECT
      plm.user_id,
      SUM(CASE WHEN pl.activity_type = '본토' THEN 1 ELSE 0 END)::int AS bontu,
      SUM(CASE WHEN pl.activity_type = '시틈' THEN 1 ELSE 0 END)::int AS siteum,
      SUM(CASE WHEN pl.activity_type = '유니' THEN 1 ELSE 0 END)::int AS uni,
      SUM(CASE WHEN pl.activity_type = '결던' THEN 1 ELSE 0 END)::int AS gyeoldun,
      SUM(CASE WHEN pl.activity_type = '별봉' THEN 1 ELSE 0 END)::int AS byeolbong,
      SUM(CASE WHEN pl.activity_type = '긴급' THEN 1 ELSE 0 END)::int AS saebyeok,
      COUNT(DISTINCT plm.log_id)::int AS attended
    FROM participation_log_members plm
    JOIN participation_logs pl ON pl.id = plm.log_id
    WHERE pl.season = p_season AND plm.user_id IS NOT NULL
    GROUP BY plm.user_id
  ) s ON s.user_id = m.user_id;

  -- members 반영
  UPDATE members m SET
    bontu_score = a.bontu,
    siteum_score = a.siteum,
    uni_score = a.uni,
    gyeoldun_score = a.gyeoldun,
    byeolbong_score = a.byeolbong,
    saebyeok_score = a.saebyeok,
    participation_score = (a.bontu + a.siteum + a.uni + a.gyeoldun + a.byeolbong + a.saebyeok) * 100
  FROM _agg a
  WHERE a.user_id = m.user_id;

  -- season_participation UPSERT (rate 포함)
  INSERT INTO season_participation
    (user_id, season, participation_score, participation_rate,
     bontu_score, siteum_score, uni_score, gyeoldun_score, byeolbong_score, saebyeok_score)
  SELECT
    a.user_id, p_season,
    (a.bontu + a.siteum + a.uni + a.gyeoldun + a.byeolbong + a.saebyeok) * 100,
    CASE WHEN v_total_sessions > 0
         THEN ROUND((a.attended::numeric / v_total_sessions) * 100, 1)
         ELSE 0 END,
    a.bontu, a.siteum, a.uni, a.gyeoldun, a.byeolbong, a.saebyeok
  FROM _agg a
  ON CONFLICT (user_id, season) DO UPDATE SET
    participation_score = EXCLUDED.participation_score,
    participation_rate = EXCLUDED.participation_rate,
    bontu_score = EXCLUDED.bontu_score,
    siteum_score = EXCLUDED.siteum_score,
    uni_score = EXCLUDED.uni_score,
    gyeoldun_score = EXCLUDED.gyeoldun_score,
    byeolbong_score = EXCLUDED.byeolbong_score,
    saebyeok_score = EXCLUDED.saebyeok_score;

  -- 기여점수 재계산 (원본 공식 그대로)
  UPDATE members SET
    contribution_score = ROUND(COALESCE(participation_score, 0) * 0.7 + COALESCE(power, 0) * 0.3);

  RETURN v_total_sessions;
END;
$$;

REVOKE ALL ON FUNCTION public.recalc_participation_scores(integer) FROM PUBLIC, anon, authenticated;
