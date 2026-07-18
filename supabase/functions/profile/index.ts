// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
// 내 정보(셀프서비스): 긴급 참여조(데이/나이트) 선택 + 내 조 긴급 참여율 지표.
// 중요: 참여점수 계산과 무관한 별도 참고 지표 — 점수 로직은 건드리지 않는다.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function getCurrentSeason(): Promise<number> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
  if (data && data.value != null && !Number.isNaN(parseInt(data.value, 10))) return parseInt(data.value, 10);
  return 1;
}

// 현재 시즌 계산에 적용되는 조: effective_season <= 현재 시즌인 가장 최근 이력
async function getEffectiveShift(userId: string, season: number): Promise<string | null> {
  const { data } = await supabase
    .from("member_shift_history")
    .select("shift, effective_season")
    .eq("user_id", userId)
    .lte("effective_season", season)
    .order("id", { ascending: false })
    .limit(1);
  return data && data.length ? data[0].shift : null;
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  const season = await getCurrentSeason();

  if (req.method === "GET") {
    const { data: me } = await supabase
      .from("members")
      .select("preferred_shift")
      .eq("user_id", user.user_id)
      .maybeSingle();
    const preferred = me?.preferred_shift || null;
    const effective = await getEffectiveShift(user.user_id, season);

    // 다음 시즌부터 반영 예정인 변경이 있는지
    const { data: pendingRows } = await supabase
      .from("member_shift_history")
      .select("shift, effective_season")
      .eq("user_id", user.user_id)
      .gt("effective_season", season)
      .order("id", { ascending: false })
      .limit(1);
    const pending = pendingRows && pendingRows.length ? pendingRows[0] : null;

    // 지표: 계산용 조(effective)가 있을 때만
    let metrics: Record<string, unknown> | null = null;
    if (effective) {
      const { data: emLogs } = await supabase
        .from("participation_logs")
        .select("id, shift")
        .eq("season", season)
        .eq("activity_type", "긴급")
        .not("shift", "is", null);
      const myShiftLogIds = (emLogs || []).filter((l) => l.shift === effective).map((l) => l.id);
      const otherShiftLogIds = (emLogs || []).filter((l) => l.shift !== effective).map((l) => l.id);

      let attended = 0;
      let otherSupport = 0;
      const allIds = [...myShiftLogIds, ...otherShiftLogIds];
      if (allIds.length) {
        const { data: myRows } = await supabase
          .from("participation_log_members")
          .select("log_id")
          .eq("user_id", user.user_id)
          .in("log_id", allIds);
        const attendedIds = new Set((myRows || []).map((r) => r.log_id));
        attended = myShiftLogIds.filter((id) => attendedIds.has(id)).length;
        otherSupport = otherShiftLogIds.filter((id) => attendedIds.has(id)).length;
      }
      metrics = {
        shift: effective,
        attended,
        total: myShiftLogIds.length,
        rate: myShiftLogIds.length ? Math.round((attended / myShiftLogIds.length) * 100) : null,
        other_support: otherSupport,
      };
    }

    return jsonResponse({
      season,
      user: { user_id: user.user_id, current_id: user.current_id, role: user.role },
      preferred_shift: preferred,
      effective_shift: effective,
      pending_change: pending, // {shift, effective_season} | null
      metrics,
    });
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    const shift = typeof body.shift === "string" ? body.shift : "";
    if (!["day", "night"].includes(shift)) return jsonResponse({ error: "shift는 day 또는 night여야 합니다." }, 400);

    const { data: me } = await supabase
      .from("members")
      .select("preferred_shift")
      .eq("user_id", user.user_id)
      .maybeSingle();
    if (me?.preferred_shift === shift) {
      return jsonResponse({ ok: true, unchanged: true, effective_season: null });
    }

    // 최초 선택 = 현재 시즌 즉시 반영, 변경 = 다음 시즌부터 (사용자 승인된 규칙)
    const { count: historyCount } = await supabase
      .from("member_shift_history")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.user_id);
    const effectiveSeason = (historyCount ?? 0) === 0 ? season : season + 1;

    const { error: histErr } = await supabase
      .from("member_shift_history")
      .insert({ user_id: user.user_id, shift, effective_season: effectiveSeason });
    if (histErr) return jsonResponse({ error: "조 변경 이력 저장에 실패했습니다." }, 500);

    const { error: updErr } = await supabase
      .from("members")
      .update({ preferred_shift: shift })
      .eq("user_id", user.user_id);
    if (updErr) return jsonResponse({ error: "조 선택 저장에 실패했습니다." }, 500);

    return jsonResponse({ ok: true, shift, effective_season: effectiveSeason, immediate: effectiveSeason === season });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
