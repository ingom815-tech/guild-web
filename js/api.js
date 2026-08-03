// Supabase Edge Function 호출용 얇은 fetch 래퍼. supabase-js SDK 미사용(전부 자체 Edge Function 경유).
const Api = (() => {
  const BASE = `${window.APP_CONFIG.SUPABASE_URL}/functions/v1`;

  function sessionToken() {
    return localStorage.getItem("session_token");
  }

  // ── 분배 탭 캐시 동기화 버스 ──────────────────────────────────
  // 분배 하위 탭(창고/신청/현황/결과/이력)은 탭 전환 때 재조회하지 않고 캐시를 쓴다.
  // 데이터를 바꾸는 액션(신청/취소/확정/기간 설정 등)은 bump()로 버전을 올리고,
  // 각 화면은 자기 캐시 버전이 다르면 다음 진입 때 다시 조회한다.
  window.DistSync = {
    ver: 0,
    bump() {
      this.ver += 1;
    },
  };

  async function call(fnName, { method = "GET", body, query } = {}) {
    let url = `${BASE}/${fnName}`;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += `?${qs}`;
    }
    const headers = {
      apikey: window.APP_CONFIG.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    };
    const token = sessionToken();
    if (token) headers["X-Session-Token"] = token;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      throw new ApiError(0, "네트워크 오류가 발생했습니다. 연결을 확인해주세요.");
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* 본문 없는 응답 허용 */
    }

    if (res.status === 401) {
      // 세션 만료/무효 — 로그인 화면으로
      Auth.clearSession();
      if (window.App && window.App.showLogin) window.App.showLogin();
      throw new ApiError(401, (data && data.error) || "로그인이 만료되었습니다. 다시 로그인해주세요.");
    }

    if (!res.ok) {
      throw new ApiError(res.status, (data && data.error) || `요청 실패 (${res.status})`);
    }
    return data;
  }

  return {
    login: (user_id, password) => call("login", { method: "POST", body: { user_id, password } }),
    logout: () => call("logout", { method: "POST" }).catch(() => null),
    changePassword: (old_password, new_password) =>
      call("change-password", { method: "POST", body: { old_password, new_password } }),
    listInventory: () => call("inventory", { method: "GET" }),
    listItemMaster: () => call("item-master", { method: "GET" }),
    createInventoryItem: (item) => call("inventory", { method: "POST", body: item }),
    createInventoryItemsBatch: (items) => call("inventory", { method: "POST", body: { items } }),
    updateInventoryItem: (id, item) => call("inventory", { method: "PUT", query: { id }, body: item }),
    deleteInventoryItem: (id, confirmDelete) =>
      call("inventory", { method: "DELETE", query: { id, confirm: confirmDelete ? "true" : "false" } }),
    listMembers: () => call("members", { method: "GET" }),
    getMemberImages: (user_id) => call("members", { method: "GET", query: { view: "images", user_id } }),
    createMember: (member) => call("members", { method: "POST", body: member }),
    updateMember: (user_id, patch) => call("members", { method: "PUT", query: { user_id }, body: patch }),
    deleteMember: (user_id, confirmDelete) =>
      call("members", { method: "DELETE", query: { user_id, confirm: confirmDelete ? "true" : "false" } }),
    getDashboard: () => call("dashboard", { method: "GET" }),
    // 진단 로그 (무인증, 실패 무시) — 가입 화면 스샷 첨부 실패 원인 수집용
    sendDiag: (context, detail) =>
      call("register", { method: "POST", query: { action: "diag" }, body: { context, detail: JSON.stringify(detail) } }).catch(() => null),
    getDistributionItems: () => call("distribution", { method: "GET", query: { view: "items" } }),
    getDistributionPeriod: () => call("distribution", { method: "GET", query: { view: "period" } }),
    getMyRequests: () => call("distribution", { method: "GET", query: { view: "my" } }),
    createItemRequest: (reqBody) => call("distribution", { method: "POST", body: reqBody }),
    cancelItemRequest: (id) => call("distribution", { method: "DELETE", query: { id } }),
    setDistributionPeriod: (start_time, end_time) =>
      call("distribution", { method: "POST", query: { action: "period" }, body: { start_time, end_time } }),
    extendDistributionPeriod: (period_id, new_end) =>
      call("distribution", { method: "PUT", query: { action: "period" }, body: { period_id, new_end } }),
    closeDistributionPeriod: (period_id) =>
      call("distribution", { method: "POST", query: { action: "close" }, body: { period_id } }),
    getDistStatus: () => call("distribution", { method: "GET", query: { view: "status" } }),
    getConfirmedDistributions: () => call("distribution", { method: "GET", query: { view: "confirmed" } }),
    getDistHistory: () => call("distribution", { method: "GET", query: { view: "history" } }),
    confirmDistribution: (item_id, user_id) =>
      call("distribution", { method: "POST", query: { action: "confirm" }, body: { item_id, user_id } }),
    bulkCancelRequests: (request_ids) =>
      call("distribution", { method: "POST", query: { action: "bulk_cancel" }, body: { request_ids } }),
    dispatchRequests: (request_ids) =>
      call("distribution", { method: "POST", query: { action: "dispatch" }, body: { request_ids } }),
    undispatchRequests: (request_ids) =>
      call("distribution", { method: "POST", query: { action: "undispatch" }, body: { request_ids } }),
    revertConfirmed: (request_id) =>
      call("distribution", { method: "POST", query: { action: "revert" }, body: { request_id } }),
    declineConflict: (request_id) =>
      call("distribution", { method: "POST", query: { action: "decline_conflict" }, body: { request_id } }),
    finalizeDistributions: (entries) =>
      call("distribution", { method: "POST", query: { action: "finalize" }, body: { entries } }),
    cancelDistHistory: (history_id) =>
      call("distribution", { method: "POST", query: { action: "cancel_history" }, body: { history_id } }),
    deleteDistHistory: (history_id) =>
      call("distribution", { method: "POST", query: { action: "delete_history" }, body: { history_id } }),
    getProfile: () => call("profile", { method: "GET" }),
    updateProfile: (patch) => call("profile", { method: "PUT", body: patch }),
    uploadProfileImages: (kind, images) =>
      call("profile", { method: "POST", query: { action: "images" }, body: { kind, images } }),
    register: (payload) => call("register", { method: "POST", body: payload }),
    getPublicGuilds: () => call("register", { method: "GET" }),
    getGuilds: () => call("members", { method: "GET", query: { view: "guilds" } }),
    // 전력 분석 (운영진 — 역할 배치/짝지, 즉시 저장)
    getWarBoard: () => call("members", { method: "GET", query: { view: "war" } }),
    setWarRole: (user_id, role) => call("members", { method: "POST", query: { action: "war_role" }, body: { user_id, role } }),
    setWarPair: (a, b) => call("members", { method: "POST", query: { action: "war_pair" }, body: { a, b } }),
    clearWarPair: (user_id) => call("members", { method: "POST", query: { action: "war_unpair" }, body: { user_id } }),
    publishWar: (guild) => call("members", { method: "POST", query: { action: "war_publish" }, body: { guild: guild || null } }),
    setWarMain: (user_id, level) => call("members", { method: "POST", query: { action: "war_main" }, body: { user_id, level } }),
    // 결사원 공개용 전력 현황 (전 회원 조회 가능 — dashboard 함수 경유)
    getWarStatus: () => call("dashboard", { method: "GET", query: { view: "war_status" } }),
    updateGuild: (id, name) =>
      call("members", { method: "POST", query: { action: "guild_update" }, body: { id, name } }),
    addGuild: (name) => call("members", { method: "POST", query: { action: "guild_add" }, body: { name } }),
    deleteGuild: (id) => call("members", { method: "POST", query: { action: "guild_delete" }, body: { id } }),
    getRegistrations: () => call("members", { method: "GET", query: { view: "registrations" } }),
    approveRegistration: (request_id) =>
      call("members", { method: "POST", query: { action: "approve" }, body: { request_id } }),
    rejectRegistration: (request_id) =>
      call("members", { method: "POST", query: { action: "reject" }, body: { request_id } }),
    getParticipationStatus: () => call("participation", { method: "GET", query: { view: "status" } }),
    getParticipationLogs: () => call("participation", { method: "GET", query: { view: "logs" } }),
    getParticipationLogMembers: (id) => call("participation", { method: "GET", query: { view: "log_members", id } }),
    getSeasonScores: (season) =>
      call("participation", { method: "GET", query: season ? { view: "season_scores", season } : { view: "season_scores" } }),
    addLogMember: (log_id, user_id) =>
      call("participation", { method: "POST", query: { action: "add_member" }, body: { log_id, user_id } }),
    removeLogMember: (log_id, ident) =>
      call("participation", { method: "POST", query: { action: "remove_member" }, body: { log_id, ...ident } }),
    saveParticipationLogs: (sessions) => call("participation", { method: "POST", body: { sessions } }),
    deleteParticipationLog: (id) => call("participation", { method: "DELETE", query: { id } }),
    participationSeasonOp: (op, extra) =>
      call("participation", { method: "POST", query: { action: "season" }, body: { op, ...(extra || {}) } }),
    getTreasuryBalances: () => call("treasury", { method: "GET", query: { view: "balances" } }),
    getTreasuryHistory: (filters) => call("treasury", { method: "GET", query: { view: "history", ...filters } }),
    createTreasuryTransaction: (tx) => call("treasury", { method: "POST", body: tx }),
    deleteTreasuryTransaction: (id) => call("treasury", { method: "DELETE", query: { id } }),
  };
})();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
