// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

// 원본 render_dashboard의 주력 결사원 판정 기준 (app.py: _MAIN_THRESHOLD/_OTHER_THRESHOLD).
const MAIN_CLASSES = new Set(["주문각인사", "집행관"]);
const MAIN_THRESHOLD = 40000;
const OTHER_THRESHOLD = 44000;

// 원본 _aqui_targets 하드코딩 그대로 (app.py:2280-2285).
const AQUI_TARGETS = [
  { id: "A3", label: "신의 방패", classes: ["집행관"], color: "#c8a84e" },
  { id: "A5", label: "사슬 속박", classes: ["집행관"], color: "#ef4444" },
  { id: "B3", label: "고양의 영역", classes: ["주문각인사"], color: "#3b82f6" },
  { id: "B2", label: "보호의 축복", classes: ["주문각인사"], color: "#22c55e" },
];

// status_check 문자열("T:3|A3:m,B2:l,...")에서 보유 아퀴 스킬 id set 추출 (원본 _parse_aqui_ids 그대로).
function parseAquiIds(sc: string | null): Set<string> {
  const owned = new Set<string>();
  if (sc && sc.includes("|")) {
    const right = sc.split("|").slice(1).join("|");
    for (let e of right.split(",")) {
      e = e.trim();
      if (e) owned.add(e.includes(":") ? e.split(":")[0] : e);
    }
  }
  return owned;
}

function classCounts(rows: { class: string | null }[]): { class: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.class) continue;
    counts.set(r.class, (counts.get(r.class) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort(([a], [b]) => a.localeCompare(b, "ko"))
    .map(([cls, count]) => ({ class: cls, count }));
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  if (req.method !== "GET") return jsonResponse({ error: "GET만 지원합니다." }, 405);

  const staff = isStaff(user);

  // 현재 시즌 (app_settings 키-값, 없으면 1 — 원본 get_members_dashboard와 동일 폴백)
  let season = 1;
  {
    const { data } = await supabase.from("app_settings").select("value").eq("key", "current_season").maybeSingle();
    if (data && data.value != null && !Number.isNaN(parseInt(data.value, 10))) season = parseInt(data.value, 10);
  }

  const { data: allMembers, error: membersErr } = await supabase
    .from("members")
    .select("user_id, guild_name, current_id, level, class, power, role, participation_score, contribution_score, subjugation_rank, abyss_level, status_check, equipment_info");
  if (membersErr) return jsonResponse({ error: "회원 조회에 실패했습니다." }, 500);

  const { data: spRows, error: spErr } = await supabase
    .from("season_participation")
    .select("user_id, participation_rate")
    .eq("season", season);
  if (spErr) return jsonResponse({ error: "참여율 조회에 실패했습니다." }, 500);
  const rateMap = new Map<string, number | null>();
  for (const sp of spRows || []) rateMap.set(sp.user_id, sp.participation_rate);

  // 관리자 계정은 원본과 동일하게 목록/집계 전부에서 제외.
  const members = (allMembers || [])
    .filter((m) => m.role !== "관리자")
    .map((m) => ({ ...m, participation_rate: rateMap.get(m.user_id) ?? null }));

  // ── KPI ──
  const totalMembers = members.length;
  const guildCount = new Set(members.map((m) => m.guild_name).filter((g) => g != null && g !== "")).size;
  const powers = members.map((m) => m.power).filter((p): p is number => p != null);
  const avgPower = powers.length ? Math.floor(powers.reduce((s, p) => s + p, 0) / powers.length) : 0;
  const rates = members.map((m) => m.participation_rate).filter((r): r is number => r != null);
  const avgRate = rates.length ? Math.round((rates.reduce((s, r) => s + r, 0) / rates.length) * 10) / 10 : null;
  const contribs = members.map((m) => m.contribution_score).filter((c): c is number => c != null);
  const avgContribution = contribs.length ? Math.floor(contribs.reduce((s, c) => s + c, 0) / contribs.length) : 0;

  let pendingRequests: number | undefined;
  if (staff) {
    const { count } = await supabase
      .from("item_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "대기");
    pendingRequests = count ?? 0;
  }

  // ── 직업 분포 (전체 / 주력) ──
  const mainMembers = members.filter((m) => {
    const p = m.power || 0;
    return m.class && (MAIN_CLASSES.has(m.class) ? p >= MAIN_THRESHOLD : p >= OTHER_THRESHOLD);
  });
  const classDistribution = { all: classCounts(members), main: classCounts(mainMembers) };

  // ── 주요 아퀴 보유 현황 ──
  const ownedIds = new Map<string, Set<string>>();
  for (const m of members) ownedIds.set(m.user_id, parseAquiIds(m.status_check));
  const keyAqui = AQUI_TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    classes: t.classes,
    color: t.color,
    owners: members
      .filter((m) => t.classes.includes(m.class || "") && ownedIds.get(m.user_id)!.has(t.id))
      .map((m) => m.current_id || m.user_id),
  }));

  // ── 회원 목록 (역할별 필드 스트립 — 전투력은 운영진 이상 응답에만 포함) ──
  const memberRows = members.map((m) => {
    const row: Record<string, unknown> = {
      user_id: m.user_id,
      current_id: m.current_id,
      guild_name: m.guild_name,
      class: m.class,
      level: m.level,
      role: m.role,
      subjugation_rank: m.subjugation_rank,
      abyss_level: m.abyss_level,
      participation_score: m.participation_score,
      participation_rate: m.participation_rate,
      contribution_score: m.contribution_score,
      equipment_info: m.equipment_info,
      status_check: m.status_check,
    };
    if (staff) row.power = m.power;
    return row;
  });

  const kpi: Record<string, unknown> = {
    total_members: totalMembers,
    guild_count: guildCount,
    avg_participation_rate: avgRate,
    avg_contribution: avgContribution,
  };
  if (staff) {
    kpi.avg_power = avgPower;
    kpi.pending_requests = pendingRequests;
  }

  // ── 긴급 데이/나이트 지표 (참여점수 계산과 무관한 별도 참고 데이터) ──
  // 계산용 조 = member_shift_history에서 effective_season <= 현재 시즌인 가장 최근 행.
  const { data: shiftRows } = await supabase
    .from("member_shift_history")
    .select("user_id, shift, effective_season, id")
    .lte("effective_season", season)
    .order("id", { ascending: true });
  const effectiveShift = new Map<string, string>();
  for (const r of shiftRows || []) effectiveShift.set(r.user_id, r.shift); // id 오름차순 → 마지막이 최신

  const memberIds = new Set(members.map((m) => m.user_id));
  let dayMemberIds: string[] = [];
  let nightMemberIds: string[] = [];
  for (const [uid, sh] of effectiveShift) {
    if (!memberIds.has(uid)) continue;
    if (sh === "day") dayMemberIds.push(uid);
    else if (sh === "night") nightMemberIds.push(uid);
  }
  const unselected = totalMembers - dayMemberIds.length - nightMemberIds.length;

  const { data: emLogs } = await supabase
    .from("participation_logs")
    .select("id, shift")
    .eq("season", season)
    .eq("activity_type", "긴급")
    .not("shift", "is", null);
  const dayLogIds = (emLogs || []).filter((l) => l.shift === "day").map((l) => l.id);
  const nightLogIds = (emLogs || []).filter((l) => l.shift === "night").map((l) => l.id);

  const attendance = new Map<number, Set<string>>(); // log_id -> user set
  const allEmIds = [...dayLogIds, ...nightLogIds];
  if (allEmIds.length) {
    const { data: att } = await supabase
      .from("participation_log_members")
      .select("log_id, user_id")
      .in("log_id", allEmIds)
      .not("user_id", "is", null);
    for (const r of att || []) {
      if (!attendance.has(r.log_id)) attendance.set(r.log_id, new Set());
      attendance.get(r.log_id)!.add(r.user_id);
    }
  }

  // KPI 데이/나이트 = 해당 조 선택자들의 "자기 조 긴급 참여율" 평균 (조원 0명 또는 로그 0건이면 null → "—")
  function avgShiftRate(memberList: string[], logIds: number[]): number | null {
    if (!memberList.length || !logIds.length) return null;
    let sum = 0;
    for (const uid of memberList) {
      let attended = 0;
      for (const lid of logIds) if (attendance.get(lid)?.has(uid)) attended++;
      sum += attended / logIds.length;
    }
    return Math.round((sum / memberList.length) * 1000) / 10;
  }
  // 응집률 = 로그별 (해당 조 선택자 중 참석자 수 ÷ 해당 조 선택 인원)의 평균
  function avgCohesion(memberList: string[], logIds: number[]): number | null {
    if (!memberList.length || !logIds.length) return null;
    const memberSet = new Set(memberList);
    let sum = 0;
    for (const lid of logIds) {
      const attendees = attendance.get(lid) || new Set();
      let cnt = 0;
      for (const uid of attendees) if (memberSet.has(uid)) cnt++;
      sum += cnt / memberList.length;
    }
    return Math.round((sum / logIds.length) * 1000) / 10;
  }

  const shiftMetrics: Record<string, unknown> = {
    kpi_day_rate: avgShiftRate(dayMemberIds, dayLogIds),
    kpi_night_rate: avgShiftRate(nightMemberIds, nightLogIds),
  };
  if (staff) {
    shiftMetrics.day_members = dayMemberIds.length;
    shiftMetrics.night_members = nightMemberIds.length;
    shiftMetrics.unselected = unselected;
    shiftMetrics.day_logs = dayLogIds.length;
    shiftMetrics.night_logs = nightLogIds.length;
    shiftMetrics.day_cohesion = avgCohesion(dayMemberIds, dayLogIds);
    shiftMetrics.night_cohesion = avgCohesion(nightMemberIds, nightLogIds);
  }

  return jsonResponse({
    kpi,
    class_distribution: classDistribution,
    key_aqui: keyAqui,
    members: memberRows,
    shift_metrics: shiftMetrics,
  });
});
