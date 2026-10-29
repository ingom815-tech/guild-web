-- 0031: 이벤트 시즌 쟁참여율 = 통합 참여율 (2026-10-24 사용자 요청 — "참여율 다 합쳐달라")
--
-- 0030은 이벤트 시즌의 참여점수·참여율만 쟁 포함으로 통합하고 쟁참여율은 별도 기준(쟁 ÷ 쟁 세션)으로 남겼음.
-- 이벤트 시즌에서는 쟁참여율(jaeng_rate)도 통합 참여율(참석 세션 ÷ 전체 세션, 쟁 포함)과 같은 값으로 저장
-- → 참여 현황·시즌 기록·대시보드·전력 분석·브로치 탭이 모두 한 숫자로 보임.
-- 쟁 횟수(jaeng_count)·시간대 분해는 그대로. 정규 시즌(1~999)은 0027/0030과 완전히 동일.
-- 함수 본문 외 변경 없음 — Edge Function 재배포 불필요.
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
  v_event boolean := p_season > 1000;  -- 이벤트 시즌(1001~): 쟁·긴급까지 6종 통합 집계
BEGIN
  -- 점수/참여율 분모: 정규 = 쟁 제외 5종 / 이벤트 = 쟁·긴급 포함 전 세션
  SELECT COUNT(*) INTO v_total_sessions
  FROM participation_logs
  WHERE season = p_season AND (v_event OR activity_type NOT IN ('쟁', '긴급'));

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
    COALESCE(s.jaeng_score, 0) AS jaeng_score,
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
      -- 쟁·긴급 참석 (이벤트 시즌에만 집계됨 — 정규는 아래 WHERE에서 제외되어 항상 0)
      SUM(CASE WHEN pl.activity_type IN ('쟁', '긴급') THEN 1 ELSE 0 END)::int AS jaeng_score,
      COUNT(DISTINCT plm.log_id)::int AS attended
    FROM participation_log_members plm
    JOIN participation_logs pl ON pl.id = plm.log_id
    WHERE pl.season = p_season AND plm.user_id IS NOT NULL
      AND (v_event OR pl.activity_type NOT IN ('쟁', '긴급'))
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
    participation_score = (a.bontu + a.siteum + a.uni + a.gyeoldun + a.byeolbong + a.jaeng_score) * 100,
    jaeng_count = a.jaeng,
    jaeng_rate = CASE WHEN v_event THEN  -- 이벤트 시즌: 쟁참여율 = 통합 참여율 (모든 화면 같은 숫자)
           CASE WHEN v_total_sessions > 0
                THEN ROUND((a.attended::numeric / v_total_sessions) * 100, 1)
                ELSE NULL END
         WHEN a.jaeng_denom > 0
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
    (a.bontu + a.siteum + a.uni + a.gyeoldun + a.byeolbong + a.jaeng_score) * 100,
    CASE WHEN v_total_sessions > 0
         THEN ROUND((a.attended::numeric / v_total_sessions) * 100, 1)
         ELSE 0 END,
    a.bontu, a.siteum, a.uni, a.gyeoldun, a.byeolbong, 0,
    a.jaeng,
    CASE WHEN v_event THEN  -- 이벤트 시즌: 쟁참여율 = 통합 참여율 (모든 화면 같은 숫자)
           CASE WHEN v_total_sessions > 0
                THEN ROUND((a.attended::numeric / v_total_sessions) * 100, 1)
                ELSE NULL END
         WHEN a.jaeng_denom > 0
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
