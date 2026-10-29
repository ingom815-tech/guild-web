-- 0032: 쟁참여율 분모를 4개 결사 공통으로 되돌림 (2026-10-29 사용자 승인)
--
-- 0027의 결사별 분모(그 결사원이 1명 이상 참석한 쟁 세션 + 유니/결던) 폐지.
-- 현재 4개 결사가 같은 조건의 쟁을 함께 진행하므로 모든 회원의 분모를 동일하게:
--   쟁참여율 = 본인 참석(쟁/긴급+유니+결던) ÷ 시즌 전체 쟁/긴급+유니/결던 세션 수
-- (0027 이전 0025 규칙과 같음 — 소속 미지정 회원이 쓰던 폴백 분모를 전원에게 적용)
-- 그 외(참여점수·일정참여율, 이벤트 시즌 통합 집계 0030·0031)는 변경 없음.
-- 함수 본문 외 변경 없음.
CREATE OR REPLACE FUNCTION public.recalc_participation_scores(p_season integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_sessions integer;  -- 점수/일정참여율 분모 (쟁 제외 5종)
  v_total_jaeng integer;     -- 쟁참여율 분모 (쟁/긴급+유니/결던 세션 전체 — 4개 결사 공통, 0032)
  v_event boolean := p_season > 1000;  -- 이벤트 시즌(1001~): 쟁·긴급까지 6종 통합 집계
BEGIN
  -- 점수/참여율 분모: 정규 = 쟁 제외 5종 / 이벤트 = 쟁·긴급 포함 전 세션
  SELECT COUNT(*) INTO v_total_sessions
  FROM participation_logs
  WHERE season = p_season AND (v_event OR activity_type NOT IN ('쟁', '긴급'));

  SELECT COUNT(*) INTO v_total_jaeng
  FROM participation_logs
  WHERE season = p_season AND activity_type IN ('쟁', '긴급', '유니', '결던');

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
    -- 쟁참여율 분모: 4개 결사 공통 = 시즌 전체 쟁/긴급+유니/결던 세션 수 (0032 — 결사별 분모 폐지)
    v_total_jaeng AS jaeng_denom
  FROM members m
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
