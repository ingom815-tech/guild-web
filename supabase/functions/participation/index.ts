// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
// 참여율 관리: 출석 로그 저장/이력/삭제 + 시즌 설정/마감 + 멱등 점수 재계산(RPC 호출).
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function handlePreflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return null;
}

function getServiceRoleKey(): string {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const parsed = JSON.parse(secretKeysRaw);
      if (parsed && typeof parsed.default === "string" && parsed.default) return parsed.default;
    } catch {
      // 폴백
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("서비스 롤 키를 찾을 수 없습니다.");
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getServiceRoleKey());

interface SessionUser {
  user_id: string;
  current_id: string | null;
  role: string;
}

async function validateSession(token: string | null): Promise<SessionUser | null> {
  if (!token) return null;
  const { data: session, error: sessionErr } = await supabase
    .from("user_sessions")
    .select("user_id, expires_at")
    .eq("session_token", token)
    .maybeSingle();
  if (sessionErr || !session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) return null;

  const { data: member, error: memberErr } = await supabase
    .from("members")
    .select("user_id, current_id, role")
    .eq("user_id", session.user_id)
    .maybeSingle();
  if (memberErr || !member) return null;

  return { user_id: member.user_id, current_id: member.current_id, role: member.role };
}

function isStaff(user: SessionUser | null): boolean {
  return !!user && (user.role === "관리자" || user.role === "운영진");
}

function isAdmin(user: SessionUser | null): boolean {
  return !!user && user.role === "관리자";
}

// 쟁(구 긴급)은 참여점수 계산에서 제외되는 별도 지표 — RPC가 시간대(오전/오후/새벽)별로 집계한다.
// '긴급'은 레거시 태그 호환용(파서가 쟁으로 매핑하지만 방어적으로 수용).
const ACTIVITY_TYPES = ["본토", "시틈", "유니", "결던", "별봉", "쟁", "긴급"];
const JAENG_TYPES = ["쟁", "긴급"];

async function getCurrentSeason(): Promise<number> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
  if (data && data.value != null && !Number.isNaN(parseInt(data.value, 10))) return parseInt(data.value, 10);
  return 1;
}

// 점수 재계산 호출 — 간헐적 타임아웃 대비 1회 자동 재시도. err가 null이면 성공.
async function recalcScores(season: number): Promise<{ err: string | null; total: number }> {
  let lastErr = "재계산 실패";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, error } = await supabase.rpc("recalc_participation_scores", { p_season: season });
    if (!error) return { err: null, total: (data as number) ?? 0 };
    lastErr = error.message || lastErr;
  }
  return { err: lastErr, total: 0 };
}

async function setSetting(key: string, value: string): Promise<boolean> {
  const { error } = await supabase.from("app_settings").upsert({ key, value }, { onConflict: "key" });
  return !error;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  // 참여율 관리 전체가 운영진 이상 전용 (원본과 동일)
  if (!isStaff(user)) return jsonResponse({ error: "운영진만 사용할 수 있는 기능입니다." }, 403);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ── 시즌 설정 ──
  if (action === "season" && req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const op = typeof body.op === "string" ? body.op : "";

    if (op === "set_season") {
      const season = Number(body.season);
      if (!Number.isInteger(season) || season < 1) return jsonResponse({ error: "시즌 번호는 1 이상의 정수여야 합니다." }, 400);
      if (!(await setSetting("current_season", String(season)))) {
        return jsonResponse({ error: "시즌 설정에 실패했습니다." }, 500);
      }
      return jsonResponse({ ok: true, season });
    }

    if (op === "reset_scores") {
      // 파괴적 작업 — 관리자 전용 (활동6 + 참여 + 기여 점수를 전부 0으로)
      if (!isAdmin(user)) return jsonResponse({ error: "참여점수 초기화는 관리자만 가능합니다." }, 403);
      const { error } = await supabase
        .from("members")
        .update({
          bontu_score: 0, siteum_score: 0, uni_score: 0,
          gyeoldun_score: 0, byeolbong_score: 0, saebyeok_score: 0,
          participation_score: 0, contribution_score: 0,
        })
        .neq("user_id", "");
      if (error) return jsonResponse({ error: "초기화에 실패했습니다." }, 500);
      return jsonResponse({ ok: true });
    }

    if (op === "close_season") {
      const season = await getCurrentSeason();
      // 마감 직전 최종 재계산으로 season_participation 스냅샷 확정
      const { err: rpcErr } = await recalcScores(season);
      if (rpcErr) return jsonResponse({ error: "마감 전 재계산에 실패했습니다." }, 500);
      if (!(await setSetting(`season_${season}_closed`, "true"))) {
        return jsonResponse({ error: "마감 플래그 저장에 실패했습니다." }, 500);
      }
      return jsonResponse({ ok: true, season });
    }

    return jsonResponse({ error: "알 수 없는 시즌 작업입니다." }, 400);
  }

  // ── 참석 명단 보정 (관리자 전용 — 로그 관리 탭 숨김 기능) ──
  // 점수·참여율 무결성을 위해 "기존 세션의 참석 여부"만 조정한다: 추가 = 횟수 +1/점수 +100, 제거 = 반대.
  // 가짜 세션을 만들지 않으므로 전체 세션 수(참여율 분모)는 변하지 않는다. 처리 후 즉시 재계산.
  if ((action === "add_member" || action === "remove_member") && req.method === "POST") {
    if (!isAdmin(user)) return jsonResponse({ error: "참석 보정은 관리자만 가능합니다." }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const logId = Number(body.log_id);
    if (!logId) return jsonResponse({ error: "log_id가 필요합니다." }, 400);

    const season = await getCurrentSeason();
    const { data: log } = await supabase
      .from("participation_logs")
      .select("id, season")
      .eq("id", logId)
      .maybeSingle();
    if (!log) return jsonResponse({ error: "해당 로그를 찾을 수 없습니다." }, 404);
    if (log.season !== season) {
      return jsonResponse({ error: "현재 시즌 로그만 보정할 수 있습니다. (지난 시즌은 마감 스냅샷 보존)" }, 400);
    }

    if (action === "add_member") {
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      if (!userId) return jsonResponse({ error: "user_id가 필요합니다." }, 400);
      const { data: member } = await supabase
        .from("members")
        .select("user_id, current_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (!member) return jsonResponse({ error: "해당 결사원을 찾을 수 없습니다." }, 404);
      const { data: dup } = await supabase
        .from("participation_log_members")
        .select("id")
        .eq("log_id", logId)
        .eq("user_id", userId)
        .maybeSingle();
      if (dup) return jsonResponse({ error: "이미 이 세션의 참석자입니다." }, 400);
      const { error: insErr } = await supabase.from("participation_log_members").insert({
        log_id: logId,
        user_id: userId,
        member_name: member.current_id || userId,
        squad_no: 0,
        matched: true,
      });
      if (insErr) return jsonResponse({ error: "참석자 추가에 실패했습니다." }, 500);
    } else {
      // remove_member: 매칭 행은 user_id로, 미매칭 행은 member_name으로 제거
      const userId = typeof body.user_id === "string" ? body.user_id : "";
      const memberName = typeof body.member_name === "string" ? body.member_name : "";
      let q = supabase.from("participation_log_members").delete().eq("log_id", logId);
      if (userId) q = q.eq("user_id", userId);
      else if (memberName) q = q.eq("member_name", memberName).is("user_id", null);
      else return jsonResponse({ error: "user_id 또는 member_name이 필요합니다." }, 400);
      const { data: removed, error: delErr } = await q.select("id");
      if (delErr) return jsonResponse({ error: "참석자 제거에 실패했습니다." }, 500);
      if (!removed || !removed.length) return jsonResponse({ error: "해당 참석 기록을 찾을 수 없습니다." }, 404);
    }

    // 표시용 인원수를 실제 명단 수와 일치시킴
    const { count: newCount } = await supabase
      .from("participation_log_members")
      .select("id", { count: "exact", head: true })
      .eq("log_id", logId);
    await supabase.from("participation_logs").update({ total_participants: newCount ?? 0 }).eq("id", logId);

    // 재계산 (1회 재시도) — 실패해도 참석 변경 자체는 저장됨을 프론트에 알림
    const { err: recalcErr } = await recalcScores(season);
    return jsonResponse({ ok: true, total_participants: newCount ?? 0, recalc_failed: !!recalcErr });
  }

  // ── 조회 ──
  if (req.method === "GET") {
    const view = url.searchParams.get("view") || "status";
    const season = await getCurrentSeason();

    if (view === "logs") {
      const { data: logs, error } = await supabase
        .from("participation_logs")
        .select("id, activity_type, log_datetime, log_date, location, total_participants, commander, recorded_by")
        .eq("season", season)
        .order("log_datetime", { ascending: false })
        .limit(200);
      if (error) return jsonResponse({ error: "이력 조회에 실패했습니다." }, 500);

      const ids = (logs || []).map((l) => l.id);
      const counts = new Map<number, { matched: number; unmatched: number }>();
      if (ids.length) {
        const { data: lm } = await supabase
          .from("participation_log_members")
          .select("log_id, user_id")
          .in("log_id", ids);
        for (const r of lm || []) {
          const c = counts.get(r.log_id) || { matched: 0, unmatched: 0 };
          if (r.user_id) c.matched++;
          else c.unmatched++;
          counts.set(r.log_id, c);
        }
      }
      return jsonResponse(
        (logs || []).map((l) => ({
          ...l,
          matched_count: counts.get(l.id)?.matched || 0,
          unmatched_count: counts.get(l.id)?.unmatched || 0,
        })),
      );
    }

    // 시즌별 참여 기록 (season_participation 스냅샷 — 시즌 선택 조회)
    if (view === "season_scores") {
      const target = Number(url.searchParams.get("season")) || season;
      const { data: seasonRows } = await supabase.from("season_participation").select("season");
      const seasons = [...new Set((seasonRows || []).map((r) => r.season))].sort((a, b) => b - a);
      const { data: rows, error } = await supabase
        .from("season_participation")
        .select("user_id, participation_score, participation_rate, bontu_score, siteum_score, uni_score, gyeoldun_score, byeolbong_score, jaeng_count, jaeng_rate, jaeng_morning, jaeng_evening, jaeng_dawn")
        .eq("season", target)
        .order("participation_score", { ascending: false });
      if (error) return jsonResponse({ error: "시즌 기록 조회에 실패했습니다." }, 500);
      const { data: mem } = await supabase.from("members").select("user_id, current_id, class");
      const memMap = new Map((mem || []).map((m) => [m.user_id, m]));
      return jsonResponse({
        season: target,
        current_season: season,
        seasons,
        rows: (rows || []).map((r) => ({
          ...r,
          current_id: memMap.get(r.user_id)?.current_id || r.user_id,
          class: memMap.get(r.user_id)?.class || "",
        })),
      });
    }

    // 로그 1건의 참석 명단 (로그 관리 상세 펼침용)
    if (view === "log_members") {
      const id = Number(url.searchParams.get("id"));
      if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);
      const { data, error } = await supabase
        .from("participation_log_members")
        .select("member_name, squad_no, matched, user_id")
        .eq("log_id", id)
        .order("squad_no", { ascending: true })
        .order("member_name", { ascending: true });
      if (error) return jsonResponse({ error: "명단 조회에 실패했습니다." }, 500);
      return jsonResponse(data || []);
    }

    // view === "status"
    // 세션 수는 점수용(쟁 제외)과 쟁을 구분해 반환 (쟁 참여율 분모 = total_jaeng)
    const [closedRes, scoreCntRes, jaengCntRes, memRes, ratesRes, nickRes] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", `season_${season}_closed`).maybeSingle(),
      supabase
        .from("participation_logs")
        .select("id", { count: "exact", head: true })
        .eq("season", season)
        .not("activity_type", "in", `("${JAENG_TYPES.join('","')}")`),
      supabase
        .from("participation_logs")
        .select("id", { count: "exact", head: true })
        .eq("season", season)
        .in("activity_type", JAENG_TYPES),
      supabase
        .from("members")
        .select("user_id, current_id, class, role, power, participation_score, contribution_score, bontu_score, siteum_score, uni_score, gyeoldun_score, byeolbong_score, jaeng_count, jaeng_rate, jaeng_morning, jaeng_evening, jaeng_dawn")
        .neq("role", "관리자")
        .order("current_id", { ascending: true }),
      supabase.from("season_participation").select("user_id, participation_rate").eq("season", season),
      // 매칭 사전: 닉네임 이력 → current_id → user_id (원본 _member_map 우선순위)
      supabase.from("member_nick_history").select("user_id, nickname"),
    ]);
    const closedFlag = closedRes.data;
    const { data: members, error: memErr } = memRes;
    if (memErr) return jsonResponse({ error: "회원 조회에 실패했습니다." }, 500);
    const rateMap = new Map<string, number | null>();
    for (const r of ratesRes.data || []) rateMap.set(r.user_id, r.participation_rate);

    return jsonResponse({
      season,
      closed: !!(closedFlag && closedFlag.value === "true"),
      total_sessions: scoreCntRes.count ?? 0,
      total_jaeng: jaengCntRes.count ?? 0,
      members: (members || []).map((m) => ({ ...m, participation_rate: rateMap.get(m.user_id) ?? null })),
      nick_history: nickRes.data || [],
    });
  }

  // ── 출석 로그 저장 (파싱·매칭은 클라이언트, 서버는 저장+중복차단+재계산) ──
  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    if (!Array.isArray(body.sessions) || !body.sessions.length) {
      return jsonResponse({ error: "저장할 세션이 없습니다." }, 400);
    }

    const season = await getCurrentSeason();
    const { data: closedFlag } = await supabase
      .from("app_settings").select("value").eq("key", `season_${season}_closed`).maybeSingle();
    if (closedFlag && closedFlag.value === "true") {
      return jsonResponse({ error: `시즌 ${season}은(는) 이미 마감되었습니다. 시즌 번호를 먼저 변경해주세요.` }, 400);
    }

    let inserted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const raw of body.sessions as Record<string, unknown>[]) {
      const activity = typeof raw.activity_type === "string" ? raw.activity_type : "";
      const logDatetime = typeof raw.log_datetime === "string" ? raw.log_datetime : "";
      if (!ACTIVITY_TYPES.includes(activity) || !logDatetime) {
        errors.push(`잘못된 세션: ${activity || "?"} / ${logDatetime || "?"}`);
        continue;
      }
      const membersArr = Array.isArray(raw.members) ? (raw.members as Record<string, unknown>[]) : [];
      if (!membersArr.length) {
        errors.push(`참여자 없는 세션: ${activity} ${logDatetime}`);
        continue;
      }

      // UNIQUE(activity_type, log_datetime) — 중복이면 스킵 (원본 ON CONFLICT DO NOTHING과 동일 효과)
      const { data: log, error: insErr } = await supabase
        .from("participation_logs")
        .insert({
          season,
          activity_type: activity,
          log_datetime: logDatetime,
          log_date: typeof raw.log_date === "string" ? raw.log_date : null,
          location: typeof raw.location === "string" ? raw.location : null,
          total_participants: Number(raw.total_participants) || 0,
          commander: typeof raw.commander === "string" ? raw.commander : null,
          recorded_by: user.current_id || user.user_id,
        })
        .select("id")
        .single();
      if (insErr) {
        if ((insErr as { code?: string }).code === "23505") {
          skipped++;
        } else {
          errors.push(`저장 실패: ${activity} ${logDatetime}`);
        }
        continue;
      }

      const rows = membersArr.map((mm) => ({
        log_id: log.id,
        user_id: typeof mm.user_id === "string" && mm.user_id ? mm.user_id : null,
        member_name: typeof mm.member_name === "string" ? mm.member_name : "",
        squad_no: Number(mm.squad_no) || 0,
        matched: !!mm.matched,
      }));
      const { error: lmErr } = await supabase.from("participation_log_members").insert(rows);
      if (lmErr) {
        // 멤버 저장 실패 시 고아 로그 방지를 위해 로그 롤백
        await supabase.from("participation_log_members").delete().eq("log_id", log.id);
        await supabase.from("participation_logs").delete().eq("id", log.id);
        errors.push(`참여자 저장 실패: ${activity} ${logDatetime}`);
        continue;
      }
      inserted++;
    }

    let totalSessions = 0;
    if (inserted > 0) {
      const { err: rpcErr, total } = await recalcScores(season);
      if (rpcErr) return jsonResponse({ error: "점수 재계산에 실패했습니다. (로그는 저장됨 — 다음 등록/보정 때 자동 반영)" }, 500);
      totalSessions = total;
    }

    return jsonResponse({ inserted, skipped_duplicates: skipped, errors, total_sessions: totalSessions }, 201);
  }

  // ── 로그 삭제 (+재계산) ──
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);

    // FK CASCADE 유무와 무관하게 안전하도록 멤버 행 먼저 삭제
    await supabase.from("participation_log_members").delete().eq("log_id", Number(id));
    const { data, error } = await supabase
      .from("participation_logs")
      .delete()
      .eq("id", Number(id))
      .select("id")
      .maybeSingle();
    if (error) return jsonResponse({ error: "삭제에 실패했습니다." }, 500);
    if (!data) return jsonResponse({ error: "해당 로그를 찾을 수 없습니다." }, 404);

    const season = await getCurrentSeason();
    const { err: recalcErr } = await recalcScores(season);
    return jsonResponse({ ok: true, recalc_failed: !!recalcErr });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
