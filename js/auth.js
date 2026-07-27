// 로그인/로그아웃/세션유지(localStorage)/비밀번호 변경/역할별 UI 노출
const Auth = (() => {
  const TOKEN_KEY = "session_token";
  const USER_KEY = "current_user";
  const LAST_ACTIVE_KEY = "last_active_at";
  // 웹을 닫은(또는 방치한) 뒤 이 시간이 지나 다시 열면 자동 로그아웃.
  const AUTO_LOGOUT_MS = 30 * 60 * 1000; // 30분

  let trackingStarted = false;

  // 페이지가 살아있는 동안 주기적으로 "마지막 활동 시각"을 남긴다.
  // 창을 닫으면 갱신이 멈추므로, 다음 접속 때 이 시각과의 차이가 곧 "꺼져 있던 시간"이 된다.
  function touchActivity() {
    if (localStorage.getItem(TOKEN_KEY)) localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
  }

  function isExpiredByInactivity() {
    if (!localStorage.getItem(TOKEN_KEY)) return false;
    const last = Number(localStorage.getItem(LAST_ACTIVE_KEY) || 0);
    if (!last) return false; // 기능 도입 전 세션 — 이번 접속부터 기록 시작
    return Date.now() - last > AUTO_LOGOUT_MS;
  }

  function startActivityTracking() {
    if (trackingStarted) return;
    trackingStarted = true;
    touchActivity();
    setInterval(touchActivity, 30 * 1000);
    document.addEventListener("visibilitychange", touchActivity);
    window.addEventListener("pagehide", touchActivity);
  }

  // 만료 처리: 서버 세션 무효화(베스트에포트) 후 로컬 즉시 정리
  function expireSession() {
    Api.logout(); // 실패해도 무시 (api.js에서 catch) — 서버 expires_at이 최종 안전망
    clearSession();
  }

  function getUser() {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now()));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(LAST_ACTIVE_KEY);
  }

  function isLoggedIn() {
    return !!localStorage.getItem(TOKEN_KEY) && !!getUser();
  }

  function isStaff(user) {
    const u = user || getUser();
    return !!u && (u.role === "관리자" || u.role === "운영진");
  }

  async function login(userId, password) {
    const data = await Api.login(userId, password);
    setSession(data.token, data.user);
    return data.user;
  }

  async function logout() {
    await Api.logout();
    clearSession();
  }

  async function changePassword(oldPw, newPw) {
    return Api.changePassword(oldPw, newPw);
  }

  function applyRoleUI(user) {
    document.body.classList.toggle("staff", isStaff(user));
    document.body.classList.toggle("admin", user.role === "관리자");
    const badge = document.getElementById("userRoleBadge");
    const greet = document.getElementById("userGreeting");
    if (badge) {
      badge.textContent = user.role;
      badge.className = "role-badge " + user.role;
    }
    if (greet) greet.textContent = `안녕하세요, ${user.current_id || user.user_id}님`;
  }

  return {
    getUser, setSession, clearSession, isLoggedIn, isStaff, login, logout, changePassword, applyRoleUI,
    isExpiredByInactivity, expireSession, startActivityTracking,
  };
})();
