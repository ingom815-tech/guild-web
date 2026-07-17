// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
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

// 실제 마이그레이션된 데이터 기준(guild_assets/guild_transactions 조회로 확인) — 전부 한글 표기.
const ASSET_TYPES = ["현금", "다이아"];
const DIRECTIONS = ["입금", "출금"];
const CASH_OWNER_ID = "guild_treasury";
const CASH_OWNER_NAME = "결사 금고";

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  const url = new URL(req.url);

  if (req.method === "GET") {
    const view = url.searchParams.get("view") || "balances";

    if (view === "history") {
      let query = supabase
        .from("guild_transactions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      const assetType = url.searchParams.get("asset_type");
      if (assetType) query = query.eq("asset_type", assetType);
      const direction = url.searchParams.get("direction");
      if (direction) query = query.eq("direction", direction);

      const { data, error } = await query;
      if (error) return jsonResponse({ error: "이력 조회에 실패했습니다." }, 500);
      return jsonResponse(data);
    }

    // view === "balances" (기본)
    const { data: assets, error } = await supabase.from("guild_assets").select("*");
    if (error) return jsonResponse({ error: "잔액 조회에 실패했습니다." }, 500);

    const cashRow = (assets || []).find((a) => a.asset_type === "현금");
    const diamondRows = (assets || []).filter((a) => a.asset_type === "다이아");
    const diamondTotal = diamondRows.reduce((sum, a) => sum + (a.balance || 0), 0);

    return jsonResponse({
      cash: cashRow || { asset_type: "현금", owner_user_id: CASH_OWNER_ID, owner_name: CASH_OWNER_NAME, balance: 0 },
      diamonds: diamondRows,
      diamond_total: diamondTotal,
    });
  }

  // 수동 입출금(POST)과 이력 삭제(DELETE)는 조회와 달리 운영진 이상만 접근 가능.
  if (!isStaff(user)) {
    return jsonResponse({ error: "운영진만 사용할 수 있는 기능입니다." }, 403);
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }

    const asset_type = typeof body.asset_type === "string" ? body.asset_type : "";
    if (!ASSET_TYPES.includes(asset_type)) {
      return jsonResponse({ error: `asset_type은 ${ASSET_TYPES.join(", ")} 중 하나여야 합니다.` }, 400);
    }
    const direction = typeof body.direction === "string" ? body.direction : "";
    if (!DIRECTIONS.includes(direction)) {
      return jsonResponse({ error: `direction은 ${DIRECTIONS.join(", ")} 중 하나여야 합니다.` }, 400);
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) {
      return jsonResponse({ error: "amount는 1 이상의 정수여야 합니다." }, 400);
    }
    const description = typeof body.description === "string" ? body.description.trim() : "";

    let owner_user_id: string;
    let owner_name: string;
    if (asset_type === "현금") {
      owner_user_id = CASH_OWNER_ID;
      owner_name = CASH_OWNER_NAME;
    } else {
      owner_user_id = typeof body.owner_user_id === "string" ? body.owner_user_id.trim() : "";
      owner_name = typeof body.owner_name === "string" ? body.owner_name.trim() : "";
      if (!owner_user_id) return jsonResponse({ error: "다이아 지급 대상(owner_user_id)이 필요합니다." }, 400);
    }

    const { data, error } = await supabase.rpc("apply_treasury_transaction", {
      p_asset_type: asset_type,
      p_direction: direction,
      p_amount: amount,
      p_owner_user_id: owner_user_id,
      p_owner_name: owner_name,
      p_description: description || null,
      p_ref_type: null,
      p_ref_id: null,
      p_created_by: user.current_id || user.user_id,
    });
    if (error) return jsonResponse({ error: "입출금 처리에 실패했습니다." }, 500);

    const row = Array.isArray(data) ? data[0] : data;
    return jsonResponse({ ok: true, transaction_id: row?.transaction_id, new_balance: row?.new_balance }, 201);
  }

  if (req.method === "DELETE") {
    // 이력 강제 삭제(+잔액 역전)는 관리자만 — 운영진은 입출금은 가능해도 이력 삭제는 불가.
    if (!isAdmin(user)) return jsonResponse({ error: "이력 삭제는 관리자만 가능합니다." }, 403);

    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);

    const { error } = await supabase.rpc("reverse_treasury_transaction", { p_transaction_id: Number(id) });
    if (error) return jsonResponse({ error: "이력 삭제에 실패했습니다." }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
