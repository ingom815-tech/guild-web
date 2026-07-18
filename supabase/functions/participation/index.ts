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

const ACTIVITY_TYPES = ["본토", "시틈", "유니", "결던", "별봉", "긴급"];

// !긴급 로그만 저장 시간으로 데이/나이트 분류 (참여점수 계산과 무관한 참고 지표).
// 데이 09:00:00~17:59:59 / 나이트 18:00:00~익일 08:59:59 (18:00 정각=night, 09:00 정각=day)
function classifyShift(activity: string, logDatetime: string): string | null {
  if (activity !== "긴급") return null;
  const hour = parseInt(logDatetime.slice(11, 13), 10);
  if (Number.isNaN(hour)) return null;
  return hour >= 9 && hour < 18 ? "day" : "night";
}

async function getCurrentSeason(): Promise<number> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
  if (data && data.value != null && !Number.isNaN(parseInt(data.value, 10))) return parseInt(data.value, 10);
  return 1;
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
      const { error: rpcErr } = await supabase.rpc("recalc_participation_scores", { p_season: season });
      if (rpcErr) return jsonResponse({ error: "마감 전 재계산에 실패했습니다." }, 500);
      if (!(await setSetting(`season_${season}_closed`, "true"))) {
        return jsonResponse({ error: "마감 플래그 저장에 실패했습니다." }, 500);
      }
      return jsonResponse({ ok: true, season });
    }

    return jsonResponse({ error: "알 수 없는 시즌 작업입니다." }, 400);
  }

  // ── 조회 ──
  if (req.method === "GET") {
    const view = url.searchParams.get("view") || "status";
    const season = await getCurrentSeason();

    if (view === "logs") {
      const { data: logs, error } = await supabase
        .from("participation_logs")
        .select("id, activity_type, log_datetime, log_date, location, total_participants, commander, recorded_by, shift")
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

    // view === "status"
    const { data: closedFlag } = await supabase
      .from("app_settings").select("value").eq("key", `season_${season}_closed`).maybeSingle();
    const { count: totalSessions } = await supabase
      .from("participation_logs")
      .select("id", { count: "exact", head: true })
      .eq("season", season);

    const { data: members, error: memErr } = await supabase
      .from("members")
      .select("user_id, current_id, class, role, power, participation_score, contribution_score, bontu_score, siteum_score, uni_score, gyeoldun_score, byeolbong_score, saebyeok_score")
      .neq("role", "관리자")
      .order("current_id", { ascending: true });
    if (memErr) return jsonResponse({ error: "회원 조회에 실패했습니다." }, 500);

    const { data: rates } = await supabase
      .from("season_participation")
      .select("user_id, participation_rate")
      .eq("season", season);
    const rateMap = new Map<string, number | null>();
    for (const r of rates || []) rateMap.set(r.user_id, r.participation_rate);

    // 매칭 사전: 닉네임 이력 → current_id → user_id (원본 _member_map 우선순위)
    const { data: nickHistory } = await supabase
      .from("member_nick_history")
      .select("user_id, nickname");

    return jsonResponse({
      season,
      closed: !!(closedFlag && closedFlag.value === "true"),
      total_sessions: totalSessions ?? 0,
      members: (members || []).map((m) => ({ ...m, participation_rate: rateMap.get(m.user_id) ?? null })),
      nick_history: nickHistory || [],
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
          shift: classifyShift(activity, logDatetime),
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
      const { data: rpcData, error: rpcErr } = await supabase.rpc("recalc_participation_scores", { p_season: season });
      if (rpcErr) return jsonResponse({ error: "점수 재계산에 실패했습니다. (로그는 저장됨)" }, 500);
      totalSessions = rpcData ?? 0;
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
    await supabase.rpc("recalc_participation_scores", { p_season: season });
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
