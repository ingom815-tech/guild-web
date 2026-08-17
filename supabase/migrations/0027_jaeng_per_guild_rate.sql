-- 0027: 쟁참여율을 결사별 분모로 개편 (2026-08-13 사용자 승인)
--
-- 결사별 쟁 분모 = (그 결사 소속 매칭 회원이 1명 이상 참석한 쟁/긴급 세션 수)
--                + (유니/결던 세션 전체 수 — 전 결사 공통)
-- 개인 쟁참여율 = 본인 참석 횟수(쟁지표 4종) ÷ 본인 "현재 소속 결사"의 분모.
-- 소속 미지정 회원은 기존처럼 전체 쟁지표 세션 수로 폴백.
-- 소속 변경 시 다음 재계산부터 누적 참석 전체가 새 결사 분모 기준으로 계산됨(소급).
-- (0026의 safeupdate 대응 WHERE 유지. 함수 본문 외 변경 없음 — 함수 재배포 불필요)
CREATE OR REPLACE FUNCTION public.recalc_participation_scores(p_season integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_sessions integer;  -- 점수/일정참여율 분모 (쟁 제외 5종)
  v_total_jaeng integer;     -- 쟁지표 세션 전체 (쟁/긴급+유니/결던 — 소속 미지정 회원 폴백 분모)
  v_uni_gyeoldun integer;    -- 유니/결던 세션 수 (전 결사 공통으로 분모에 가산)
BEGIN
  SELECT COUNT(*) INTO v_total_sessions
  FROM participation_logs
  WHERE season = p_season AND activity_type NOT IN ('쟁', '긴급');

  SELECT COUNT(*) INTO v_total_jaeng
  FROM participation_logs
  WHERE season = p_season AND activity_type IN ('쟁', '긴급', '유니', '결던');

  SELECT COUNT(*) INTO v_uni_gyeoldun
  FROM participation_logs
  WHERE season = p_season AND activity_type IN ('유니', '결던');

  -- 결사별 쟁/긴급 참여 세션 수 (매칭 회원의 현재 소속 기준, 1명 이상 참석 = 참여)
  CREATE TEMP TABLE _guild_jaeng ON COMMIT DROP AS
  SELECT gm.guild_name, COUNT(DISTINCT pl.id)::int AS jaeng_sessions
  FROM participation_logs pl
  JOIN participation_log_members plm ON plm.log_id = pl.id AND plm.user_id IS NOT NULL
  JOIN members gm ON gm.user_id = plm.user_id
  WHERE pl.season = p_season AND pl.activity_type IN ('쟁', '긴급')
    AND COALESCE(gm.guild_name, '') <> ''
  GROUP BY gm.guild_name;

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
    COALESCE(j.dawn, 0) AS dawn,
    -- 쟁참여율 분모: 소속 결사의 쟁 세션 수 + 유니/결던 전체 (소속 미지정은 전체 폴백)
    CASE WHEN COALESCE(m.guild_name, '') = '' THEN v_total_jaeng
         ELSE COALESCE(gj.jaeng_sessions, 0) + v_uni_gyeoldun END AS jaeng_denom
  FROM members m
  LEFT JOIN _guild_jaeng gj ON gj.guild_name = m.guild_name
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
    -- 쟁 집계 (쟁/긴급 + 유니 + 결던): 총 횟수 + 시간대별 (오전 0900~1700 / 오후 1701~2300 / 새벽 그 외)
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
      AND pl.activity_type IN ('쟁', '긴급', '유니', '결던')
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
    jaeng_rate = CASE WHEN a.jaeng_denom > 0
                      THEN ROUND((a.jaeng::numeric / a.jaeng_denom) * 100, 1)
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
    CASE WHEN a.jaeng_denom > 0
         THEN ROUND((a.jaeng::numeric / a.jaeng_denom) * 100, 1)
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
    contribution_score = ROUND(COALESCE(participation_score, 0) * 0.7 + COALESCE(power, 0) * 0.3)
  WHERE user_id IS NOT NULL;  -- safeupdate(WHERE 필수) 대응 — 사실상 전체 행

  RETURN v_total_sessions;
END;
$$;

REVOKE ALL ON FUNCTION public.recalc_participation_scores(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalc_participation_scores(integer) TO service_role;

-- 교체 직후 현재 시즌 재계산까지 한 번에
SELECT public.recalc_participation_scores((SELECT value::int FROM app_settings WHERE key = 'current_season'));
