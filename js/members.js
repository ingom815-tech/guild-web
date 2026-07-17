// 결사원 관리 화면: 목록 렌더/필터/등록/수정/비밀번호 재설정/탈퇴(2단계 확인)
const Members = (() => {
  let members = [];
  let activeRoleFilter = "전체";
  let pendingDeleteId = null;

  function toast(msg, isErr) {
    const t = document.getElementById("membersToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 4000);
  }

  async function load() {
    try {
      members = await Api.listMembers();
    } catch (e) {
      toast(e.message || "결사원 목록 조회 실패", true);
      return;
    }
    render();
  }

  function render() {
    const container = document.getElementById("membersTable");
    const q = (document.getElementById("qm").value || "").trim();
    const rows = members.filter((m) => {
      const roleHit = activeRoleFilter === "전체" || m.role === activeRoleFilter;
      const qHit =
        !q ||
        (m.current_id || "").includes(q) ||
        (m.guild_name || "").includes(q) ||
        (m.class || "").includes(q);
      return roleHit && qHit;
    });

    document.querySelectorAll("#membersTable .irow[data-id]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("membersEmpty");
    emptyRow.style.display = rows.length ? "none" : "flex";

    const isAdmin = (Auth.getUser() || {}).role === "관리자";
    rows.forEach((m) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = m.user_id;
      row.innerHTML = `
        <span class="nm"></span>
        <span style="width:90px" class="meta guild"></span>
        <span style="width:80px" class="meta cls"></span>
        <span style="width:50px">${m.level ?? 0}</span>
        <span style="width:80px">${(m.power ?? 0).toLocaleString()}</span>
        <span style="width:56px"><span class="role-badge"></span></span>
        <span style="width:70px">${m.contribution_score ?? 0}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="btn sm ghost" data-act="edit">수정</button>
          <button class="btn sm ghost" data-act="delete" style="color:#A32D2D">탈퇴</button>
        </span>`;
      row.querySelector(".nm").textContent = m.current_id || m.user_id;
      row.querySelector(".guild").textContent = m.guild_name || "-";
      row.querySelector(".cls").textContent = m.class || "-";
      const badge = row.querySelector(".role-badge");
      badge.textContent = m.role || "";
      badge.className = "role-badge " + (m.role || "");
      row.querySelector('[data-act="edit"]').addEventListener("click", () => openEdit(m));
      const delBtn = row.querySelector('[data-act="delete"]');
      if (isAdmin) {
        delBtn.addEventListener("click", () => requestDelete(m));
      } else {
        delBtn.disabled = true;
        delBtn.title = "탈퇴 처리는 관리자만 가능합니다.";
        delBtn.style.opacity = ".4";
      }
      container.appendChild(row);
    });
  }

  function filter() {
    render();
  }

  function setRole(el) {
    document.querySelectorAll(".fchip[data-ri]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeRoleFilter = el.dataset.ri;
    render();
  }

  // ── 등록/수정 모달 (하나의 폼을 두 모드로 재사용) ──
  function openCreate() {
    document.getElementById("memberForm").reset();
    document.getElementById("memberForm").dataset.mode = "create";
    document.getElementById("memberForm").dataset.userId = "";
    document.getElementById("memberModalTitle").textContent = "결사원 등록";
    document.getElementById("memberIdRow").classList.remove("hidden");
    document.getElementById("memberUserId").disabled = false;
    document.getElementById("memberPwResetBox").classList.add("hidden");
    document.getElementById("memberLevel").value = 0;
    document.getElementById("memberPower").value = 0;
    document.getElementById("memberModalBackdrop").classList.add("on");
  }

  function openEdit(m) {
    document.getElementById("memberForm").reset();
    document.getElementById("memberForm").dataset.mode = "edit";
    document.getElementById("memberForm").dataset.userId = m.user_id;
    document.getElementById("memberModalTitle").textContent = `결사원 수정 — ${m.current_id || m.user_id}`;
    // 아이디/비밀번호는 등록 전용 필드라 수정 모드에서는 숨김(아이디는 PK라 변경 불가, 비번은 아래 별도 재설정 박스 사용).
    document.getElementById("memberIdRow").classList.add("hidden");
    document.getElementById("memberCurrentId").value = m.current_id || "";
    document.getElementById("memberGuild").value = m.guild_name || "";
    document.getElementById("memberClass").value = m.class || "";
    document.getElementById("memberLevel").value = m.level ?? 0;
    document.getElementById("memberPower").value = m.power ?? 0;
    document.getElementById("memberRole").value = m.role || "결사원";
    document.getElementById("memberSubjRank").value = m.subjugation_rank || "";
    document.getElementById("memberAbyss").value = m.abyss_level || "";

    const isAdmin = (Auth.getUser() || {}).role === "관리자";
    document.getElementById("memberPwResetBox").classList.toggle("hidden", !isAdmin);
    document.getElementById("memberNewPw").value = "";

    document.getElementById("memberModalBackdrop").classList.add("on");
  }

  function closeModal() {
    document.getElementById("memberModalBackdrop").classList.remove("on");
  }

  function initMemberModal() {
    document.getElementById("memberAddBtn").addEventListener("click", openCreate);
    document.getElementById("memberCancelBtn").addEventListener("click", closeModal);

    document.getElementById("memberForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = document.getElementById("memberForm");
      const mode = form.dataset.mode;
      const btn = document.getElementById("memberSaveBtn");
      btn.disabled = true;
      try {
        if (mode === "create") {
          const payload = {
            user_id: document.getElementById("memberUserId").value.trim(),
            password: document.getElementById("memberPassword").value,
            current_id: document.getElementById("memberCurrentId").value.trim(),
            guild_name: document.getElementById("memberGuild").value.trim(),
            class: document.getElementById("memberClass").value.trim(),
            level: parseInt(document.getElementById("memberLevel").value, 10) || 0,
            power: parseInt(document.getElementById("memberPower").value, 10) || 0,
            role: document.getElementById("memberRole").value,
            subjugation_rank: document.getElementById("memberSubjRank").value.trim(),
            abyss_level: document.getElementById("memberAbyss").value.trim(),
          };
          await Api.createMember(payload);
          toast(`✓ ${payload.current_id} 등록 완료`);
        } else {
          const payload = {
            current_id: document.getElementById("memberCurrentId").value.trim(),
            guild_name: document.getElementById("memberGuild").value.trim(),
            class: document.getElementById("memberClass").value.trim(),
            level: parseInt(document.getElementById("memberLevel").value, 10) || 0,
            power: parseInt(document.getElementById("memberPower").value, 10) || 0,
            role: document.getElementById("memberRole").value,
            subjugation_rank: document.getElementById("memberSubjRank").value.trim(),
            abyss_level: document.getElementById("memberAbyss").value.trim(),
          };
          await Api.updateMember(form.dataset.userId, payload);
          toast("✓ 수정 완료");
        }
        closeModal();
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("memberPwResetBtn").addEventListener("click", async () => {
      const form = document.getElementById("memberForm");
      const newPw = document.getElementById("memberNewPw").value;
      if (!newPw || newPw.length < 4) {
        toast("비밀번호는 4자 이상이어야 합니다.", true);
        return;
      }
      const btn = document.getElementById("memberPwResetBtn");
      btn.disabled = true;
      try {
        await Api.updateMember(form.dataset.userId, { new_password: newPw });
        document.getElementById("memberNewPw").value = "";
        toast("✓ 비밀번호가 재설정되었습니다");
      } catch (err) {
        toast(err.message || "비밀번호 재설정 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 탈퇴 (2단계 확인) ──
  async function requestDelete(m) {
    try {
      await Api.deleteMember(m.user_id, false);
      pendingDeleteId = m.user_id;
      document.getElementById("memberDeleteModalMsg").textContent =
        `"${m.current_id || m.user_id}"님을 탈퇴 처리할까요? 이 작업은 되돌릴 수 없습니다.`;
      document.getElementById("memberDeleteModalBackdrop").classList.add("on");
    } catch (err) {
      toast(err.message || "탈퇴 확인 실패", true);
    }
  }

  function initDeleteModal() {
    document.getElementById("memberDeleteCancelBtn").addEventListener("click", () => {
      pendingDeleteId = null;
      document.getElementById("memberDeleteModalBackdrop").classList.remove("on");
    });
    document.getElementById("memberDeleteConfirmBtn").addEventListener("click", async () => {
      if (!pendingDeleteId) return;
      try {
        await Api.deleteMember(pendingDeleteId, true);
        document.getElementById("memberDeleteModalBackdrop").classList.remove("on");
        toast("🗑️ 탈퇴 처리되었습니다");
        pendingDeleteId = null;
        await load();
      } catch (err) {
        toast(err.message || "탈퇴 처리 실패", true);
      }
    });
  }

  function init() {
    initMemberModal();
    initDeleteModal();
  }

  return { init, load, filter, setRole };
})();
