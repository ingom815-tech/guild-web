// 관리자 전용 로그 관리: 참여 로그 / 재고 로그 조회·삭제.
// 삭제 = 롤백 — 참여 로그는 서버가 출석 기록 제거 후 이번 시즌 점수를 재계산하고,
// 재고 로그는 delete_inventory_item RPC가 걸린 분배 신청까지 원자적으로 삭제한다 (기존 API 재사용, 신규 엔드포인트 없음).
const LogAdmin = (() => {
  let activeTab = "part";
  let pendingAction = null; // 확인 모달에서 실행할 비동기 작업

  function toast(msg, isErr) {
    const t = document.getElementById("logAdmToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  function load() {
    if (activeTab === "part") loadPart();
    else loadInv();
  }

  function setTab(el) {
    document.querySelectorAll(".stab[data-la]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeTab = el.dataset.la;
    document.getElementById("logAdmPart").classList.toggle("hidden", activeTab !== "part");
    document.getElementById("logAdmInv").classList.toggle("hidden", activeTab !== "inv");
    load();
  }

  // ── 참여 로그 ──
  const ACT_BADGE = { 긴급: "b-hero", 본토: "b-rare", 시틈: "b-rare", 유니: "b-rare", 결던: "b-rare", 별봉: "b-rare" };
  const SHIFT_LABEL = { day: "데이", night: "나이트" };

  async function loadPart() {
    let logs = [];
    try {
      logs = await Api.getParticipationLogs();
    } catch (e) {
      toast(e.message || "참여 로그 조회 실패", true);
      return;
    }
    document.getElementById("logAdmPartCnt").textContent = logs.length;
    const listEl = document.getElementById("logAdmPartList");
    listEl.querySelectorAll(".irow[data-id]").forEach((el) => el.remove());
    document.getElementById("logAdmPartEmpty").style.display = logs.length ? "none" : "flex";

    logs.forEach((l) => {
      const row = document.createElement("div");
      row.className = "irow two";
      row.dataset.id = l.id;
      row.style.cursor = "pointer";
      const when = l.log_datetime ? String(l.log_datetime).slice(5, 16).replace("T", " ") : l.log_date || "";
      const shift = l.activity_type === "긴급" && l.shift ? ` · ${SHIFT_LABEL[l.shift] || l.shift}조` : "";
      row.innerHTML = `
        <div class="r1">
          <span style="width:56px"><span class="badge ${ACT_BADGE[l.activity_type] || "b-gray"}"></span></span>
          <span class="nm"></span>
          <span style="width:64px" class="pcount">${l.total_participants ?? 0}명</span>
          <span class="chev" style="width:16px">▾</span>
        </div>
        <div class="r2">
          <span class="meta info" style="flex:1;min-width:0"></span>
          <button class="btn sm ghost" data-act="del" style="color:#A32D2D;margin-left:auto">삭제</button>
        </div>
        <div class="lad-detail"></div>`;
      row.querySelector(".badge").textContent = l.activity_type || "-";
      row.querySelector(".nm").textContent = l.location || "-";
      row.querySelector(".info").textContent =
        `${when}${shift}` +
        (l.commander ? ` · 지휘 ${l.commander}` : "") +
        (l.recorded_by ? ` · 기록 ${l.recorded_by}` : "");
      // 행 클릭 → 참석 명단 펼침 (최초 1회만 조회, 보정 후에는 재조회)
      row.addEventListener("click", async (e) => {
        if (e.target.closest("button") || e.target.closest("select")) return;
        const open = row.classList.toggle("open");
        if (!open || row.dataset.loaded) return;
        await loadLogDetail(row, l);
      });
      row.querySelector('[data-act="del"]').addEventListener("click", () => {
        openConfirm(
          "참여 로그 삭제",
          `[${l.activity_type}] ${l.location || "-"} (${when}, ${l.total_participants ?? 0}명) 로그를 삭제할까요?\n출석 기록이 제거되고 이번 시즌 참여점수가 재계산됩니다.`,
          async () => {
            await Api.deleteParticipationLog(l.id);
            toast("🗑️ 참여 로그 삭제 + 점수 재계산 완료");
            await loadPart();
          }
        );
      });
      listEl.appendChild(row);
    });
  }

  // 결사원 목록 캐시 (참석자 추가 select용)
  let membersCache = null;
  async function getMembersList() {
    if (!membersCache) membersCache = await Api.listMembers();
    return membersCache;
  }

  async function loadLogDetail(row, l) {
    const detail = row.querySelector(".lad-detail");
    detail.textContent = "명단 불러오는 중...";
    try {
      const members = await Api.getParticipationLogMembers(l.id);
      await renderLogMembers(detail, members, l, row);
      row.dataset.loaded = "1";
    } catch (err) {
      detail.textContent = `명단 조회 실패: ${err.message || ""} — participation 함수가 최신 버전인지 확인해주세요.`;
    }
  }

  // 참석 명단 렌더링 — 조별 그룹 + 관리자 보정(이름별 ✕ 제거 / 하단 참석자 추가)
  async function renderLogMembers(box, members, l, row) {
    box.innerHTML = "";
    const refresh = async (newTotal) => {
      if (newTotal != null) {
        l.total_participants = newTotal;
        row.querySelector(".pcount").textContent = `${newTotal}명`;
      }
      await loadLogDetail(row, l);
    };

    const squads = new Map();
    members.forEach((m) => {
      const no = m.squad_no || 0;
      if (!squads.has(no)) squads.set(no, []);
      squads.get(no).push(m);
    });
    [...squads.keys()].sort((a, b) => a - b).forEach((no) => {
      const line = document.createElement("div");
      line.className = "lad-squad";
      const label = document.createElement("b");
      label.textContent = no ? `${no}조 (${squads.get(no).length}명) ` : `조 미지정 (${squads.get(no).length}명) `;
      line.appendChild(label);
      squads.get(no).forEach((m) => {
        const chip = document.createElement("span");
        chip.className = "lad-chip" + (m.user_id ? "" : " lad-un");
        chip.title = m.user_id ? "" : "결사원 명부와 매칭되지 않은 닉네임 (점수 미반영)";
        const nameSpan = document.createElement("span");
        nameSpan.textContent = m.member_name || "?";
        chip.appendChild(nameSpan);
        const x = document.createElement("span");
        x.className = "lad-x";
        x.textContent = "✕";
        x.title = "이 세션에서 제거";
        x.addEventListener("click", () => {
          const scoreNote = m.user_id
            ? "참여 횟수 -1 · 참여점수 -100점이 즉시 재계산됩니다."
            : "미매칭 이름이라 점수 변화는 없습니다. (명단 정리)";
          openConfirm("참석자 제거", `"${m.member_name}"을(를) 이 세션 명단에서 제거할까요?\n${scoreNote}`, async () => {
            const res = await Api.removeLogMember(l.id, m.user_id ? { user_id: m.user_id } : { member_name: m.member_name });
            toast(`✓ 제거 완료 — 점수 재계산됨`);
            await refresh(res.total_participants);
          });
        });
        chip.appendChild(x);
        line.appendChild(chip);
      });
      box.appendChild(line);
    });
    if (!members.length) {
      const empty = document.createElement("div");
      empty.className = "meta";
      empty.textContent = "저장된 명단이 없습니다.";
      box.appendChild(empty);
    }
    const un = members.filter((m) => !m.user_id).length;
    if (un) {
      const note = document.createElement("div");
      note.className = "meta";
      note.style.marginTop = "4px";
      note.textContent = `※ 빨간 이름 ${un}명은 결사원 명부와 매칭되지 않아 점수에 반영되지 않았습니다.`;
      box.appendChild(note);
    }

    // 참석자 추가 (관리자 보정) — 이미 명단에 있는 결사원은 제외
    const addRow = document.createElement("div");
    addRow.className = "lad-add";
    const sel = document.createElement("select");
    const inIds = new Set(members.filter((m) => m.user_id).map((m) => m.user_id));
    try {
      const all = await getMembersList();
      sel.innerHTML =
        `<option value="">참석자 추가...</option>` +
        all
          .filter((m) => !inIds.has(m.user_id))
          .sort((a, b) => (a.current_id || "").localeCompare(b.current_id || "", "ko"))
          .map((m) => `<option value="${m.user_id}"></option>`)
          .join("");
      let i = 1;
      all
        .filter((m) => !inIds.has(m.user_id))
        .sort((a, b) => (a.current_id || "").localeCompare(b.current_id || "", "ko"))
        .forEach((m) => (sel.options[i++].textContent = m.current_id || m.user_id));
    } catch (e) {
      sel.innerHTML = `<option value="">결사원 목록 조회 실패</option>`;
    }
    const addBtn = document.createElement("button");
    addBtn.className = "btn sm ghost";
    addBtn.textContent = "+ 참석 추가";
    addBtn.addEventListener("click", () => {
      if (!sel.value) {
        toast("추가할 결사원을 먼저 선택해주세요.", true);
        return;
      }
      const name = sel.options[sel.selectedIndex].textContent;
      openConfirm("참석자 추가", `"${name}"을(를) 이 세션 참석자로 추가할까요?\n참여 횟수 +1 · 참여점수 +100점이 즉시 재계산됩니다.`, async () => {
        const res = await Api.addLogMember(l.id, sel.value);
        toast(`✓ ${name} 참석 추가 — 점수 재계산됨`);
        await refresh(res.total_participants);
      });
    });
    addRow.appendChild(sel);
    addRow.appendChild(addBtn);
    box.appendChild(addRow);
  }

  // ── 재고 로그 ──
  const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };

  async function loadInv() {
    let items = [];
    try {
      items = await Api.listInventory();
    } catch (e) {
      toast(e.message || "재고 로그 조회 실패", true);
      return;
    }
    document.getElementById("logAdmInvCnt").textContent = items.length;
    const listEl = document.getElementById("logAdmInvList");
    listEl.querySelectorAll(".irow[data-id]").forEach((el) => el.remove());
    document.getElementById("logAdmInvEmpty").style.display = items.length ? "none" : "flex";

    items.forEach((it) => {
      const row = document.createElement("div");
      row.className = "irow two";
      row.dataset.id = it.id;
      const regDate = it.registered_at ? String(it.registered_at).slice(0, 16).replace("T", " ") : "";
      row.innerHTML = `
        <div class="r1">
          <span style="width:56px">${it.grade ? `<span class="badge ${GRADE_BADGE[it.grade] || "b-gray"}">${it.grade}</span>` : ""}</span>
          <span class="nm"></span>
          <span style="width:60px">수량 ${it.quantity}</span>
        </div>
        <div class="r2">
          <span class="meta info" style="flex:1;min-width:0"></span>
          <button class="btn sm ghost" data-act="del" style="color:#A32D2D;margin-left:auto">삭제</button>
        </div>`;
      row.querySelector(".nm").textContent = it.item_name;
      row.querySelector(".info").textContent =
        `룻자 ${it.looter || "-"} · 신청 ${it.applicant_count || 0}명` + (regDate ? ` · 등록 ${regDate}` : "");
      row.querySelector('[data-act="del"]').addEventListener("click", () => deleteInvItem(it));
      listEl.appendChild(row);
    });
  }

  async function deleteInvItem(it) {
    // 1차 호출은 확인 요청 — 걸린 신청 수를 받아 경고에 포함 (재고 관리 삭제와 동일 경로)
    let applicants = 0;
    try {
      const res = await Api.deleteInventoryItem(it.id, false);
      if (res.requires_confirmation) applicants = res.applicant_count || 0;
      else {
        toast("🗑️ 재고 로그 삭제 완료");
        await loadInv();
        return;
      }
    } catch (e) {
      toast(e.message || "삭제 확인 실패", true);
      return;
    }
    openConfirm(
      "재고 로그 삭제",
      `"${it.item_name}" (수량 ${it.quantity})을 삭제할까요?` +
        (applicants ? `\n⚠️ 대기 중인 분배 신청 ${applicants}건도 함께 삭제(롤백)됩니다.` : ""),
      async () => {
        await Api.deleteInventoryItem(it.id, true);
        toast("🗑️ 재고 로그 삭제 완료" + (applicants ? ` (신청 ${applicants}건 롤백)` : ""));
        await loadInv();
      }
    );
  }

  // ── 확인 모달 ──
  function openConfirm(title, msg, action) {
    pendingAction = action;
    document.getElementById("logAdmConfirmTitle").textContent = title;
    document.getElementById("logAdmConfirmMsg").textContent = msg;
    document.getElementById("logAdmConfirmMsg").style.whiteSpace = "pre-line";
    document.getElementById("logAdmConfirmBackdrop").classList.add("on");
  }

  function init() {
    document.getElementById("logAdmCancelBtn").addEventListener("click", () => {
      pendingAction = null;
      document.getElementById("logAdmConfirmBackdrop").classList.remove("on");
    });
    document.getElementById("logAdmOkBtn").addEventListener("click", async () => {
      if (!pendingAction) return;
      const action = pendingAction;
      pendingAction = null;
      document.getElementById("logAdmConfirmBackdrop").classList.remove("on");
      try {
        await action();
      } catch (e) {
        toast(e.message || "삭제 실패", true);
      }
    });
  }

  return { init, load, setTab };
})();
