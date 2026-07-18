// 부트스트랩: 로그인 폼, 화면 전환, 탭 네비게이션, 로그아웃/비밀번호 변경 모달 배선
const Tabs = (() => {
  function go(id, el) {
    document.querySelectorAll(".screen").forEach((s) => s.classList.remove("on"));
    document.getElementById("s-" + id).classList.add("on");
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("on"));
    if (el) el.classList.add("on");
    if (id === "inv") {
      Inventory.load();
      Inventory.loadItemMaster();
    }
    if (id === "drop") Inventory.loadItemMaster();
    if (id === "members") Members.load();
    if (id === "treasury") Treasury.load();
    if (id === "dashboard") Dashboard.load();
    if (id === "apply") Distribution.load();
  }
  return { go };
})();

const App = (() => {
  function showLogin() {
    document.getElementById("loginScreen").classList.remove("hidden");
    document.getElementById("appScreen").classList.add("hidden");
  }

  function showApp(user) {
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("appScreen").classList.remove("hidden");
    Auth.applyRoleUI(user);
    Tabs.go("dashboard", document.querySelector('.tab[data-s="dashboard"]'));
  }

  function initLoginForm() {
    const form = document.getElementById("loginForm");
    const errBox = document.getElementById("loginErr");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.style.display = "none";
      const btn = document.getElementById("loginBtn");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>로그인 중...';
      try {
        const user = await Auth.login(
          document.getElementById("loginId").value.trim(),
          document.getElementById("loginPw").value
        );
        form.reset();
        showApp(user);
      } catch (err) {
        errBox.textContent = err.message || "로그인에 실패했습니다.";
        errBox.style.display = "block";
      } finally {
        btn.disabled = false;
        btn.textContent = "로그인";
      }
    });
  }

  function initLogout() {
    document.getElementById("logoutBtn").addEventListener("click", async () => {
      await Auth.logout();
      showLogin();
    });
  }

  function initChangePassword() {
    const backdrop = document.getElementById("pwModalBackdrop");
    document.getElementById("changePwBtn").addEventListener("click", () => {
      document.getElementById("pwForm").reset();
      document.getElementById("pwErr").style.display = "none";
      backdrop.classList.add("on");
    });
    document.getElementById("pwCancelBtn").addEventListener("click", () => backdrop.classList.remove("on"));
    document.getElementById("pwForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = document.getElementById("pwErr");
      errBox.style.display = "none";
      try {
        await Auth.changePassword(document.getElementById("oldPw").value, document.getElementById("newPw").value);
        backdrop.classList.remove("on");
        alert("비밀번호가 변경되었습니다.");
      } catch (err) {
        errBox.textContent = err.message || "변경 실패";
        errBox.style.display = "block";
      }
    });
  }

  function boot() {
    initLoginForm();
    initLogout();
    initChangePassword();
    Inventory.init();
    Members.init();
    Treasury.init();
    Dashboard.init();
    Distribution.init();
    if (Auth.isLoggedIn()) {
      showApp(Auth.getUser());
    } else {
      showLogin();
    }

    // 브라우저가 저장된 로그인 아이디를 검색창에 자동완성으로 잘못 채우는 문제 방지.
    // autocomplete="off"를 무시하고 늦게 채우는 경우가 있어, 부팅 직후 한 번 비워준다
    // (이 시점엔 사용자가 아직 아무것도 입력하지 않았으므로 안전).
    setTimeout(() => {
      document.querySelectorAll('input[type="search"]').forEach((el) => {
        if (el.value) {
          el.value = "";
          el.dispatchEvent(new Event("input"));
        }
      });
    }, 400);
  }

  return { showLogin, showApp, boot };
})();

document.addEventListener("DOMContentLoaded", App.boot);
