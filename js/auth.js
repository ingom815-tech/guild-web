// 로그인/로그아웃/세션유지(localStorage)/비밀번호 변경/역할별 UI 노출
const Auth = (() => {
  const TOKEN_KEY = "session_token";
  const USER_KEY = "current_user";

  function getUser() {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
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

  return { getUser, setSession, clearSession, isLoggedIn, isStaff, login, logout, changePassword, applyRoleUI };
})();
