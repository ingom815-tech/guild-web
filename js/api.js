// Supabase Edge Function 호출용 얇은 fetch 래퍼. supabase-js SDK 미사용(전부 자체 Edge Function 경유).
const Api = (() => {
  const BASE = `${window.APP_CONFIG.SUPABASE_URL}/functions/v1`;

  function sessionToken() {
    return localStorage.getItem("session_token");
  }

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
    createMember: (member) => call("members", { method: "POST", body: member }),
    updateMember: (user_id, patch) => call("members", { method: "PUT", query: { user_id }, body: patch }),
    deleteMember: (user_id, confirmDelete) =>
      call("members", { method: "DELETE", query: { user_id, confirm: confirmDelete ? "true" : "false" } }),
    getDashboard: () => call("dashboard", { method: "GET" }),
    getDistributionItems: () => call("distribution", { method: "GET", query: { view: "items" } }),
    getMyRequests: () => call("distribution", { method: "GET", query: { view: "my" } }),
    createItemRequest: (reqBody) => call("distribution", { method: "POST", body: reqBody }),
    cancelItemRequest: (id) => call("distribution", { method: "DELETE", query: { id } }),
    setDistributionPeriod: (start_time, end_time) =>
      call("distribution", { method: "POST", query: { action: "period" }, body: { start_time, end_time } }),
    extendDistributionPeriod: (period_id, new_end) =>
      call("distribution", { method: "PUT", query: { action: "period" }, body: { period_id, new_end } }),
    closeDistributionPeriod: (period_id) =>
      call("distribution", { method: "POST", query: { action: "close" }, body: { period_id } }),
    getProfile: () => call("profile", { method: "GET" }),
    setProfileShift: (shift) => call("profile", { method: "POST", body: { shift } }),
    updateProfile: (patch) => call("profile", { method: "PUT", body: patch }),
    uploadProfileImages: (kind, images) =>
      call("profile", { method: "POST", query: { action: "images" }, body: { kind, images } }),
    register: (payload) => call("register", { method: "POST", body: payload }),
    getRegistrations: () => call("members", { method: "GET", query: { view: "registrations" } }),
    approveRegistration: (request_id) =>
      call("members", { method: "POST", query: { action: "approve" }, body: { request_id } }),
    rejectRegistration: (request_id) =>
      call("members", { method: "POST", query: { action: "reject" }, body: { request_id } }),
    getParticipationStatus: () => call("participation", { method: "GET", query: { view: "status" } }),
    getParticipationLogs: () => call("participation", { method: "GET", query: { view: "logs" } }),
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
