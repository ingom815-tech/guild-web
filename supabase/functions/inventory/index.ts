// 대시보드 웹 에디터에 배포 가능하도록 의도적으로 단일 파일(자체 완결) 구성.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session-token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

// 기존 Streamlit 앱의 app.py EQUIPMENT_GRADES / ITEM_CATEGORIES 상수와 동일한 값.
const GRADES = ["희귀", "영웅", "전설", "신화", "절대자"];
const CATEGORIES = [
  "아퀴", "심연석", "기타", "주무기", "특화무기", "머리", "상의", "바지",
  "장갑", "신발", "망토", "허리", "반지", "귀걸이", "팔찌", "목걸이",
];

interface InventoryPayload {
  item_name: string;
  grade: string;
  category: string;
  quantity: number;
  looter?: string;
}

function validateInventoryPayload(
  body: Record<string, unknown>,
): { valid: boolean; errors: string[]; value?: InventoryPayload } {
  const errors: string[] = [];

  const item_name = typeof body.item_name === "string" ? body.item_name.trim() : "";
  if (!item_name) errors.push("item_name은 필수입니다.");

  const grade = typeof body.grade === "string" ? body.grade : "";
  if (grade && !GRADES.includes(grade)) errors.push(`grade는 ${GRADES.join(", ")} 중 하나여야 합니다.`);

  const category = typeof body.category === "string" ? body.category : "";
  if (category && !CATEGORIES.includes(category)) {
    errors.push(`category는 ${CATEGORIES.join(", ")} 중 하나여야 합니다.`);
  }

  const quantity = Number(body.quantity);
  if (!Number.isFinite(quantity) || quantity < 0 || !Number.isInteger(quantity)) {
    errors.push("quantity는 0 이상의 정수여야 합니다.");
  }

  const looter = typeof body.looter === "string" ? body.looter.trim() : "";

  if (errors.length) return { valid: false, errors };
  return { valid: true, errors: [], value: { item_name, grade, category, quantity, looter } };
}

interface InventoryExtra {
  drop_date: string | null;
  boss_name: string | null;
  raid_type: string;
}

// 게임 로그에서 뽑힌 날짜는 "2026.03.23" 형식 — Postgres date 컬럼용으로 "2026-03-23"로 정규화.
function normalizeDropDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return raw;
}

/**
 * 동일 item_name + status='재고' 행이 있으면 수량만 합산(UPDATE), 없으면 새로 등록(INSERT).
 * 기존 앱의 dedup 규칙을 그대로 재현. 단일 등록·배치 등록(텍스트 로그 파싱) 양쪽에서 재사용.
 */
async function upsertInventoryItem(
  item: InventoryPayload,
  extra: InventoryExtra,
): Promise<{ data?: unknown; error?: boolean; wasUpdate?: boolean }> {
  const { data: existing, error: findErr } = await supabase
    .from("inventory")
    .select("id, quantity")
    .eq("item_name", item.item_name)
    .eq("status", "재고")
    .maybeSingle();
  if (findErr) return { error: true };

  if (existing) {
    const { data, error } = await supabase
      .from("inventory")
      .update({ quantity: existing.quantity + item.quantity })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) return { error: true };
    return { data, wasUpdate: true };
  }

  const { data, error } = await supabase
    .from("inventory")
    .insert({
      item_name: item.item_name,
      grade: item.grade,
      category: item.category,
      quantity: item.quantity,
      looter: item.looter || null,
      status: "재고",
      drop_date: normalizeDropDate(extra.drop_date),
      boss_name: extra.boss_name,
      raid_type: extra.raid_type,
    })
    .select()
    .single();
  if (error) return { error: true };
  return { data, wasUpdate: false };
}

Deno.serve(async (req: Request) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  const token = req.headers.get("x-session-token");
  const user = await validateSession(token);
  if (!user) return jsonResponse({ error: "로그인이 필요합니다." }, 401);

  const url = new URL(req.url);

  if (req.method === "GET") {
    // 0003_inventory_view.sql 로 생성한 뷰: item_name 기준 신청 인원(applicant_count) 포함
    const { data, error } = await supabase
      .from("inventory_with_counts")
      .select("*")
      .order("id", { ascending: false });
    if (error) return jsonResponse({ error: "재고 조회에 실패했습니다." }, 500);
    return jsonResponse(data);
  }

  // 아래 쓰기 작업(POST/PUT/DELETE)은 관리자·운영진만 가능
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

    // 배치 모드: {items: [...]} — 텍스트 로그 파싱 결과 일괄 등록용
    if (Array.isArray(body.items)) {
      const rawItems = body.items as Record<string, unknown>[];
      if (!rawItems.length) return jsonResponse({ error: "등록할 항목이 없습니다." }, 400);

      let inserted = 0;
      const errors: string[] = [];
      for (const raw of rawItems) {
        const check = validateInventoryPayload(raw);
        if (!check.valid) {
          errors.push(`${raw.item_name ?? "?"}: ${check.errors.join(" ")}`);
          continue;
        }
        const result = await upsertInventoryItem(check.value!, {
          drop_date: typeof raw.drop_date === "string" ? raw.drop_date : null,
          boss_name: typeof raw.boss_name === "string" ? raw.boss_name : null,
          raid_type: typeof raw.raid_type === "string" ? raw.raid_type : "결사",
        });
        if (result.error) {
          errors.push(`${check.value!.item_name}: 저장 실패`);
        } else {
          inserted++;
        }
      }
      return jsonResponse({ inserted, failed: errors.length, errors });
    }

    // 단일 등록
    const check = validateInventoryPayload(body);
    if (!check.valid) return jsonResponse({ error: check.errors.join(" ") }, 400);
    const result = await upsertInventoryItem(check.value!, {
      drop_date: typeof body.drop_date === "string" ? body.drop_date : null,
      boss_name: typeof body.boss_name === "string" ? body.boss_name : null,
      raid_type: typeof body.raid_type === "string" ? body.raid_type : "결사",
    });
    if (result.error) return jsonResponse({ error: "등록에 실패했습니다." }, 500);
    return jsonResponse(result.data, result.wasUpdate ? 200 : 201);
  }

  if (req.method === "PUT") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "잘못된 요청 본문입니다." }, 400);
    }
    // 기존 앱의 수정 폼 규칙: item_name/category/grade/looter/quantity 만 수정 가능.
    // 다른 필드가 와도 무시한다(status/drop_date 등은 이 폼으로 바꾸지 않음).
    const check = validateInventoryPayload(body);
    if (!check.valid) return jsonResponse({ error: check.errors.join(" ") }, 400);
    const item = check.value!;

    const { data, error } = await supabase
      .from("inventory")
      .update({
        item_name: item.item_name,
        grade: item.grade,
        category: item.category,
        quantity: item.quantity,
        looter: item.looter || null,
      })
      .eq("id", id)
      .eq("status", "재고")
      .select()
      .maybeSingle();
    if (error) return jsonResponse({ error: "수정에 실패했습니다." }, 500);
    if (!data) return jsonResponse({ error: "해당 재고를 찾을 수 없습니다." }, 404);
    return jsonResponse(data);
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return jsonResponse({ error: "id가 필요합니다." }, 400);
    const confirm = url.searchParams.get("confirm") === "true";

    const { data: item, error: findErr } = await supabase
      .from("inventory")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (findErr) return jsonResponse({ error: "삭제 확인 중 오류가 발생했습니다." }, 500);
    if (!item) return jsonResponse({ error: "해당 재고를 찾을 수 없습니다." }, 404);

    if (!confirm) {
      const { count, error: cntErr } = await supabase
        .from("item_requests")
        .select("user_id", { count: "exact", head: true })
        .eq("item_id", id)
        .eq("status", "대기");
      if (cntErr) return jsonResponse({ error: "신청 인원 조회에 실패했습니다." }, 500);
      return jsonResponse({ requires_confirmation: true, applicant_count: count ?? 0 });
    }

    // item_requests 삭제 + inventory 삭제를 하나의 트랜잭션으로 처리하는 RPC
    // (item_requests.item_id 에 FK가 없어 순서가 어긋나면 고아 행이 남을 수 있음)
    const { error: rpcErr } = await supabase.rpc("delete_inventory_item", { p_item_id: Number(id) });
    if (rpcErr) return jsonResponse({ error: "삭제에 실패했습니다." }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "지원하지 않는 메서드입니다." }, 405);
});
