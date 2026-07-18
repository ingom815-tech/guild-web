// 분배 신청 화면: 기간 상태/관리(운영진) + 5탭 아이템 그룹 + 신청 모달 + 내 신청 목록
const Distribution = (() => {
  const GRADE_BADGE = { 신화: "b-myth", 전설: "b-legend", 영웅: "b-hero", 희귀: "b-rare" };
  let data = null; // GET view=items 응답
  let myRequests = [];
  let activeTab = "브로치";
  let applyTarget = null; // 신청 모달 대상 그룹

  function toast(msg, isErr) {
    const t = document.getElementById("applyToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  // DB의 기간 시각은 KST 벽시계값(타임존 없음) — 문자열을 그대로 표시하고,
  // 비교할 때만 서버와 같은 방식(문자열을 UTC로 해석 vs 현재+9h)을 쓴다.
  function fmtNaive(ts) {
    if (!ts) return "-";
    return String(ts).replace("T", " ").slice(0, 16);
  }
  function naiveEpoch(ts) {
    const s = String(ts).replace(" ", "T");
    return new Date(s.endsWith("Z") ? s : s + "Z").getTime();
  }
  function kstNowEpoch() {
    return Date.now() + 9 * 3600 * 1000;
  }

  async function load() {
    try {
      const [items, my] = await Promise.all([Api.getDistributionItems(), Api.getMyRequests()]);
      data = items;
      myRequests = my;
    } catch (e) {
      toast(e.message || "분배 정보 조회 실패", true);
      return;
    }
    if (data.auto_confirmed > 0) {
      toast(`⏰ 신청 기간이 마감되어 ${data.auto_confirmed}건이 자동 확정되었습니다.`);
    }
    renderPeriod();
    renderGrid();
    renderMyRequests();
  }

  function renderPeriod() {
    const p = data.period;
    const label = document.getElementById("periodStatusLabel");
    const info = document.getElementById("periodTimeInfo");
    const myInfo = document.getElementById("myApplyInfo");
    const staff = Auth.isStaff();

    if (p && p.status === "진행중") {
      label.textContent = "🟢 분배 신청 접수중";
      const remainMs = naiveEpoch(p.end_time) - kstNowEpoch();
      const remainH = Math.max(0, Math.floor(remainMs / 3600000));
      const remainM = Math.max(0, Math.floor((remainMs % 3600000) / 60000));
      info.textContent = `${fmtNaive(p.start_time)} ~ ${fmtNaive(p.end_time)} (남은 시간 ${remainH}시간 ${remainM}분)`;
    } else {
      label.textContent = "⚪ 신청 기간이 아닙니다";
      info.textContent = p ? `최근 기간: ${fmtNaive(p.start_time)} ~ ${fmtNaive(p.end_time)} (종료)` : "설정된 기간이 없습니다.";
    }

    const my = data.my || {};
    myInfo.innerHTML = "";
    const chip = (txt, ok) => {
      const s = document.createElement("span");
      s.className = "badge " + (ok ? "b-green" : "b-gray");
      s.textContent = txt;
      return s;
    };
    myInfo.appendChild(chip(`참여율 ${my.participation_rate != null ? my.participation_rate + "%" : "-"}`, true));
    myInfo.appendChild(chip(`기여점수 ${(my.contribution_score || 0).toLocaleString()}`, true));
    myInfo.appendChild(chip(my.has_power_ss ? "전투력 스샷 ✓" : "전투력 스샷 ✗", my.has_power_ss));
    myInfo.appendChild(chip(my.has_aqui_ss ? "아퀴룬 스샷 ✓" : "아퀴룬 스샷 ✗", my.has_aqui_ss));

    // 운영진 기간 관리 폼
    const box = document.getElementById("periodStaffBox");
    box.classList.toggle("hidden", !staff);
    if (staff) {
      const active = !!(p && p.status === "진행중");
      document.getElementById("periodSetForm").style.display = active ? "none" : "flex";
      document.getElementById("periodActiveForm").style.display = active ? "flex" : "none";
      if (active) document.getElementById("periodNewEnd").value = String(p.end_time).replace(" ", "T").slice(0, 16);
    }
  }

  function setTab(el) {
    document.querySelectorAll(".fchip[data-ai]").forEach((c) => c.classList.remove("on"));
    el.classList.add("on");
    activeTab = el.dataset.ai;
    renderGrid();
  }

  function renderGrid() {
    const grid = document.getElementById("applyGrid");
    const groups = (data.groups || []).filter((g) => g.tab === activeTab);
    document.getElementById("applyEmpty").style.display = groups.length ? "none" : "block";
    grid.innerHTML = "";

    groups.forEach((g) => {
      const card = document.createElement("div");
      card.className = "mcard";
      const badgeCls = GRADE_BADGE[g.grade] || "b-gray";
      const unsoldBadge = (g.unsold_period_count || 0) >= 2 ? `<span class="badge b-green">🔓 2회 유찰 — 전원 신청 가능</span>` : "";
      const raidBadge = g.raid_type === "연합" ? `<span class="badge b-gray">연합</span>` : `<span class="badge b-green">결사</span>`;
      const elig = g.eligibility || { eligible: true, failed: [], rule: "" };
      let eligHtml = "";
      if (elig.rule && !((g.unsold_period_count || 0) >= 2)) {
        if (elig.eligible) {
          eligHtml = `<div class="meta" style="color:var(--green-dk);margin-top:4px">✓ ${elig.rule} 자격 충족</div>`;
        } else {
          const reasons = elig.failed.map((f) => `${f.label} ${f.current} / 기준 ${f.required}`).join(", ");
          eligHtml = `<div class="meta" style="color:#A32D2D;margin-top:4px">✗ ${elig.rule} — ${reasons}</div>`;
        }
      }
      card.innerHTML = `
        <div class="hd">
          <span class="badge ${badgeCls}">${g.grade || "-"}</span>
          ${raidBadge}
          <span class="nm"></span>
        </div>
        <div class="meta-line"></div>
        ${unsoldBadge}
        ${eligHtml}
        <div style="margin-top:8px" class="act"></div>`;
      card.querySelector(".nm").textContent = g.item_name;
      card.querySelector(".meta-line").textContent =
        `수량 ${g.quantity} · 룻자 ${g.looters && g.looters.length ? g.looters.join(", ") : "-"}` +
        (g.drop_date ? ` · ${String(g.drop_date).slice(0, 10)}` : "");

      const act = card.querySelector(".act");
      if (g.can_apply) {
        const btn = document.createElement("button");
        btn.className = "btn sm";
        btn.textContent = "신청하기";
        btn.addEventListener("click", () => openApply(g));
        act.appendChild(btn);
      } else {
        const s = document.createElement("span");
        s.className = "badge " + (g.applied ? "b-green" : "b-gray");
        s.textContent = g.blocked_reason || "신청 불가";
        act.appendChild(s);
      }
      grid.appendChild(card);
    });
  }

  // ── 신청 모달 ──
  function openApply(g) {
    applyTarget = g;
    document.getElementById("applyModalTitle").textContent = `${g.item_name} 신청`;
    document.getElementById("applyModalMeta").textContent = `등급 ${g.grade || "-"} · 재고 ${g.quantity}개`;

    const isCat = !!g.is_category_item;
    document.getElementById("applyQtyField").classList.toggle("hidden", isCat);
    document.getElementById("applyPrefFields").classList.toggle("hidden", !isCat);
    document.getElementById("applyPref1").value = "";
    document.getElementById("applyPref2").value = "";

    const note = document.getElementById("applyModalNote");
    if (!isCat) {
      const cap = g.item_name.replace(/ /g, "").includes("찬란한") ? Math.min(g.quantity, 3) : g.quantity;
      const qtyInput = document.getElementById("applyQty");
      qtyInput.value = 1;
      qtyInput.max = cap;
      note.style.display = cap < g.quantity ? "block" : "none";
      note.className = "toast";
      note.textContent = cap < g.quantity ? `이 아이템은 1인 최대 ${cap}개까지 신청할 수 있습니다.` : "";
    } else {
      note.style.display = "block";
      note.className = "toast";
      note.textContent = "카테고리 아이템입니다. 원하는 옵션을 1순위(필수)/2순위(선택)로 적어주세요. 수량은 1개 고정입니다.";
    }
    document.getElementById("applyModalBackdrop").classList.add("on");
  }

  function initApplyModal() {
    document.getElementById("applyCancelBtn").addEventListener("click", () => {
      document.getElementById("applyModalBackdrop").classList.remove("on");
    });
    document.getElementById("applyForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!applyTarget) return;
      const btn = document.getElementById("applySubmitBtn");
      btn.disabled = true;
      try {
        const body = { item_id: applyTarget.first_item_id };
        if (applyTarget.is_category_item) {
          body.preference_1 = document.getElementById("applyPref1").value.trim();
          body.preference_2 = document.getElementById("applyPref2").value.trim();
          if (!body.preference_1) {
            toast("1순위 선호를 입력해주세요.", true);
            return;
          }
        } else {
          body.quantity = parseInt(document.getElementById("applyQty").value, 10) || 1;
        }
        await Api.createItemRequest(body);
        document.getElementById("applyModalBackdrop").classList.remove("on");
        toast(`✅ ${applyTarget.item_name} 신청 완료!`);
        applyTarget = null;
        await load();
      } catch (err) {
        toast(err.message || "신청 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── 내 신청 목록 ──
  function renderMyRequests() {
    const listEl = document.getElementById("myRequestList");
    document.querySelectorAll("#myRequestList .irow[data-id]").forEach((el) => el.remove());
    const emptyRow = document.getElementById("myRequestEmpty");
    emptyRow.style.display = myRequests.length ? "none" : "flex";

    myRequests.forEach((r) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = r.id;
      const prefTxt = r.preference_1 ? ` · 1순위 ${r.preference_1}${r.preference_2 ? " / 2순위 " + r.preference_2 : ""}` : "";
      row.innerHTML = `
        <span style="width:56px">${r.grade ? `<span class="badge ${GRADE_BADGE[r.grade] || "b-gray"}">${r.grade}</span>` : ""}</span>
        <span class="nm"></span>
        <span class="meta detail"></span>
        <button type="button" class="btn sm ghost" data-act="cancel" style="margin-left:auto;color:#A32D2D">취소</button>`;
      row.querySelector(".nm").textContent = r.item_name;
      row.querySelector(".detail").textContent = `수량 ${r.requested_quantity} · 기여점수 ${r.current_contribution_score}${prefTxt}`;
      row.querySelector('[data-act="cancel"]').addEventListener("click", async () => {
        try {
          await Api.cancelItemRequest(r.id);
          toast("신청이 취소되었습니다.");
          await load();
        } catch (err) {
          toast(err.message || "취소 실패", true);
        }
      });
      listEl.appendChild(row);
    });
  }

  // ── 운영진 기간 관리 ──
  function initPeriodForms() {
    document.getElementById("periodSetBtn").addEventListener("click", async () => {
      const start = document.getElementById("periodStart").value;
      const end = document.getElementById("periodEnd").value;
      if (!start || !end) {
        toast("시작/마감 시각을 입력해주세요.", true);
        return;
      }
      try {
        await Api.setDistributionPeriod(start, end);
        toast("📅 분배 신청 기간이 설정되었습니다.");
        await load();
      } catch (err) {
        toast(err.message || "기간 설정 실패", true);
      }
    });

    document.getElementById("periodExtendBtn").addEventListener("click", async () => {
      const newEnd = document.getElementById("periodNewEnd").value;
      if (!newEnd || !data.period) return;
      try {
        await Api.extendDistributionPeriod(data.period.id, newEnd);
        toast("마감 시각이 변경되었습니다.");
        await load();
      } catch (err) {
        toast(err.message || "연장 실패", true);
      }
    });

    document.getElementById("periodCloseBtn").addEventListener("click", async () => {
      if (!data.period) return;
      if (!confirm("기간을 종료하고 자동확정을 실행할까요? 되돌릴 수 없습니다.")) return;
      try {
        const res = await Api.closeDistributionPeriod(data.period.id);
        toast(`기간 종료 — ${res.confirmed_count || 0}건 자동 확정되었습니다.`);
        await load();
      } catch (err) {
        toast(err.message || "종료 실패", true);
      }
    });
  }

  function init() {
    initApplyModal();
    initPeriodForms();
  }

  return { init, load, setTab };
})();
