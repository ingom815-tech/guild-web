// 참여율 관리 화면: 시즌 설정/마감 + 출석 로그 파싱·매칭·저장 + 참여 현황 + 입력 이력
const Participation = (() => {
  const ACTIVITIES = ["본토", "시틈", "유니", "결던", "별봉", "긴급"];
  const ACTIVITY_COLS = { 본토: "bontu_score", 시틈: "siteum_score", 유니: "uni_score", 결던: "gyeoldun_score", 별봉: "byeolbong_score", 긴급: "saebyeok_score" };

  let status = null; // GET view=status 응답
  let logs = [];
  let parsedSessions = []; // 분석 결과 (매칭 포함)
  let confirmAction = null; // 확인 모달에서 실행할 콜백

  // !긴급 로그만 저장 시간으로 데이/나이트 분류 (표시용 — 실제 저장값은 서버가 동일 규칙으로 판정)
  function classifyShift(activity, logDatetime) {
    if (activity !== "긴급" || !logDatetime) return null;
    const hour = parseInt(String(logDatetime).slice(11, 13), 10);
    if (Number.isNaN(hour)) return null;
    return hour >= 9 && hour < 18 ? "day" : "night";
  }
  const SHIFT_BADGE = { day: "☀️ 데이", night: "🌙 나이트" };

  function toast(msg, isErr) {
    const t = document.getElementById("partToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  async function load() {
    try {
      const [st, lg] = await Promise.all([Api.getParticipationStatus(), Api.getParticipationLogs()]);
      status = st;
      logs = lg;
    } catch (e) {
      toast(e.message || "참여율 정보 조회 실패", true);
      return;
    }
    renderSeason();
    renderStatusTable();
    renderLogs();
  }

  function renderSeason() {
    document.getElementById("partSeasonLabel").textContent =
      `시즌 ${status.season} ${status.closed ? "🔒 (마감됨)" : "🟢 (진행중)"}`;
    document.getElementById("partSeasonInfo").textContent =
      `이번 시즌 세션 ${status.total_sessions}회 입력됨 · 1회 참여 = 100점 · 참여율 = 참석 세션/전체 세션`;
    document.getElementById("partSeasonInput").value = status.season;
    document.getElementById("partResetBtn").classList.toggle("hidden", (Auth.getUser() || {}).role !== "관리자");
  }

  // ── 매칭 사전: 닉네임 이력 → current_id → user_id (원본 우선순위, 먼저 등록된 값 우선) ──
  function buildMatchMap() {
    const map = new Map();
    for (const nh of status.nick_history || []) {
      const k = (nh.nickname || "").trim();
      if (k && !map.has(k)) map.set(k, nh.user_id);
    }
    for (const m of status.members || []) {
      const k = (m.current_id || "").trim();
      if (k && !map.has(k)) map.set(k, m.user_id);
    }
    for (const m of status.members || []) {
      const k = (m.user_id || "").trim();
      if (k && !map.has(k)) map.set(k, m.user_id);
    }
    return map;
  }

  // ── 출석 입력 ──
  function initAttendance() {
    document.getElementById("partParseBtn").addEventListener("click", () => {
      const text = document.getElementById("partLogText").value;
      if (!text.trim()) {
        toast("텍스트를 붙여넣어주세요.", true);
        return;
      }
      if (!status) {
        toast("시즌 정보를 아직 불러오지 못했습니다.", true);
        return;
      }
      const map = buildMatchMap();
      const existing = new Set(logs.map((l) => `${l.activity_type}|${String(l.log_datetime).replace("T", " ").slice(0, 19)}`));

      parsedSessions = ParticipationParser.parse(text).map((s) => {
        if (!s.ok) return s;
        const members = s.members.map((mm) => {
          const uid = map.get(mm.member_name.trim()) || null;
          return { ...mm, user_id: uid, matched: !!uid };
        });
        const dup = existing.has(`${s.activity_type}|${s.log_datetime}`);
        return { ...s, members, duplicate: dup };
      });
      renderPreview();
    });

    document.getElementById("partSaveBtn").addEventListener("click", async () => {
      const toSave = parsedSessions.filter((s) => s.ok && !s.duplicate);
      if (!toSave.length) {
        toast("저장할 세션이 없습니다.", true);
        return;
      }
      const btn = document.getElementById("partSaveBtn");
      btn.disabled = true;
      try {
        const res = await Api.saveParticipationLogs(
          toSave.map((s) => ({
            activity_type: s.activity_type,
            log_datetime: s.log_datetime,
            log_date: s.log_date,
            location: s.location,
            total_participants: s.total_participants || 0,
            commander: s.commander || "",
            members: s.members,
          })),
        );
        let msg = `✅ ${res.inserted}건 저장, 점수 재계산 완료 (시즌 총 ${res.total_sessions}세션)`;
        if (res.skipped_duplicates) msg += ` · 중복 ${res.skipped_duplicates}건 스킵`;
        if (res.errors && res.errors.length) msg += ` · 실패 ${res.errors.length}건`;
        toast(msg, !!(res.errors && res.errors.length));
        document.getElementById("partLogText").value = "";
        parsedSessions = [];
        renderPreview();
        await load();
      } catch (err) {
        toast(err.message || "저장 실패", true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function renderPreview() {
    const el = document.getElementById("partPreview");
    el.innerHTML = "";
    const saveBtn = document.getElementById("partSaveBtn");

    if (!parsedSessions.length) {
      saveBtn.classList.add("hidden");
      return;
    }

    let savable = 0;
    parsedSessions.forEach((s) => {
      const box = document.createElement("div");
      box.style.cssText = "border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px";
      if (!s.ok) {
        box.style.borderColor = "#F3B9B9";
        box.style.background = "var(--red-bg)";
        box.innerHTML = `<b style="color:var(--red-tx)">⚠️ 파싱 실패</b><div class="meta err-detail" style="margin-top:4px"></div>`;
        box.querySelector(".err-detail").textContent = s.error;
        el.appendChild(box);
        return;
      }
      const matched = s.members.filter((m) => m.matched);
      const unmatched = s.members.filter((m) => !m.matched);
      if (s.duplicate) {
        box.style.opacity = ".6";
      } else {
        savable++;
      }
      const shift = classifyShift(s.activity_type, s.log_datetime);
      box.innerHTML = `
        <div class="row" style="gap:8px;flex-wrap:wrap">
          <span class="badge b-green">!${s.activity_type}</span>
          ${shift ? `<span class="badge ${shift === "day" ? "b-myth" : "b-legend"}">${SHIFT_BADGE[shift]}</span>` : ""}
          <b class="dtv"></b>
          <span class="meta locv"></span>
          <span class="meta">참여 ${s.members.length}명 (매칭 ${matched.length} / 미매칭 ${unmatched.length})</span>
          ${s.duplicate ? `<span class="badge b-gray">이미 입력된 로그 — 저장 시 제외</span>` : ""}
        </div>
        ${unmatched.length ? `<div class="meta unm" style="color:#B8860B;margin-top:4px"></div>` : ""}`;
      box.querySelector(".dtv").textContent = s.log_datetime;
      box.querySelector(".locv").textContent = s.location || "-";
      if (unmatched.length) {
        box.querySelector(".unm").textContent = `⚠️ 미매칭(점수 미반영): ${unmatched.map((m) => m.member_name).join(", ")}`;
      }
      el.appendChild(box);
    });

    saveBtn.classList.toggle("hidden", savable === 0);
    saveBtn.textContent = `💾 ${savable}개 세션 저장`;
  }

  // ── 참여 현황 표 ──
  function renderStatusTable() {
    const q = (document.getElementById("qp").value || "").trim();
    const rows = (status.members || [])
      .filter((m) => !q || (m.current_id || "").includes(q))
      .slice()
      .sort((a, b) => (b.participation_score || 0) - (a.participation_score || 0));

    const table = document.getElementById("partStatusTable");
    let html = `<tr><th>닉네임</th>${ACTIVITIES.map((a) => `<th class="num">${a}</th>`).join("")}<th class="num">참여점수</th><th class="num">참여율</th><th class="num">기여점수</th></tr>`;
    html += rows
      .map((m) => {
        const rate = m.participation_rate != null ? `${m.participation_rate}%` : "—";
        const rateHtml = m.participation_rate != null && m.participation_rate < 50 ? `<span class="low">${rate}</span>` : rate;
        return `<tr>
          <td><b class="nm"></b></td>
          ${ACTIVITIES.map((a) => `<td class="num gtext">${m[ACTIVITY_COLS[a]] || 0}</td>`).join("")}
          <td class="num"><b>${(m.participation_score || 0).toLocaleString()}</b></td>
          <td class="num">${rateHtml}</td>
          <td class="num">${(m.contribution_score || 0).toLocaleString()}</td>
        </tr>`;
      })
      .join("");
    table.innerHTML = html;
    const trs = table.querySelectorAll("tr");
    rows.forEach((m, i) => (trs[i + 1].querySelector(".nm").textContent = m.current_id || m.user_id));
  }

  // ── 입력 이력 ──
  function renderLogs() {
    const listEl = document.getElementById("partLogList");
    document.querySelectorAll("#partLogList .irow[data-id]").forEach((el) => el.remove());
    document.getElementById("partLogEmpty").style.display = logs.length ? "none" : "flex";

    logs.forEach((l) => {
      const row = document.createElement("div");
      row.className = "irow";
      row.dataset.id = l.id;
      row.innerHTML = `
        <span class="badge b-green">!${l.activity_type}</span>
        ${l.shift ? `<span class="badge ${l.shift === "day" ? "b-myth" : "b-legend"}">${SHIFT_BADGE[l.shift]}</span>` : ""}
        <b class="dt" style="font-size:13px"></b>
        <span class="meta loc"></span>
        <span class="meta">매칭 ${l.matched_count}명${l.unmatched_count ? ` · 미매칭 ${l.unmatched_count}` : ""}</span>
        <button type="button" class="btn sm ghost" data-act="del" style="margin-left:auto;color:#A32D2D">삭제</button>`;
      row.querySelector(".dt").textContent = String(l.log_datetime).replace("T", " ").slice(0, 16);
      row.querySelector(".loc").textContent = l.location || "-";
      row.querySelector('[data-act="del"]').addEventListener("click", () => {
        openConfirm("로그 삭제", `[!${l.activity_type}] ${String(l.log_datetime).replace("T", " ").slice(0, 16)} 로그를 삭제할까요? 삭제 후 점수가 자동 재계산됩니다.`, async () => {
          await Api.deleteParticipationLog(l.id);
          toast("🗑️ 삭제 및 재계산 완료");
          await load();
        });
      });
      listEl.appendChild(row);
    });
  }

  // ── 시즌 설정 ──
  function initSeasonActions() {
    document.getElementById("partSetSeasonBtn").addEventListener("click", async () => {
      const season = parseInt(document.getElementById("partSeasonInput").value, 10);
      if (!season || season < 1) {
        toast("시즌 번호를 확인해주세요.", true);
        return;
      }
      try {
        await Api.participationSeasonOp("set_season", { season });
        toast(`✓ 현재 시즌이 ${season}으로 설정되었습니다.`);
        await load();
      } catch (err) {
        toast(err.message || "시즌 설정 실패", true);
      }
    });

    document.getElementById("partCloseSeasonBtn").addEventListener("click", () => {
      openConfirm("시즌 마감", `시즌 ${status ? status.season : "?"}을(를) 마감할까요? 최종 재계산 후 마감 플래그가 저장됩니다.`, async () => {
        const res = await Api.participationSeasonOp("close_season");
        toast(`🔒 시즌 ${res.season} 마감 완료`);
        await load();
      });
    });

    document.getElementById("partResetBtn").addEventListener("click", () => {
      openConfirm("참여점수 초기화", "전체 회원의 활동/참여/기여 점수를 모두 0으로 초기화합니다. 되돌릴 수 없습니다. 진행할까요?", async () => {
        await Api.participationSeasonOp("reset_scores");
        toast("참여점수가 초기화되었습니다.");
        await load();
      });
    });
  }

  // ── 공용 확인 모달 ──
  function openConfirm(title, msg, action) {
    confirmAction = action;
    document.getElementById("partConfirmTitle").textContent = title;
    document.getElementById("partConfirmMsg").textContent = msg;
    document.getElementById("partConfirmBackdrop").classList.add("on");
  }

  function initConfirmModal() {
    document.getElementById("partConfirmCancelBtn").addEventListener("click", () => {
      confirmAction = null;
      document.getElementById("partConfirmBackdrop").classList.remove("on");
    });
    document.getElementById("partConfirmYesBtn").addEventListener("click", async () => {
      const action = confirmAction;
      confirmAction = null;
      document.getElementById("partConfirmBackdrop").classList.remove("on");
      if (!action) return;
      try {
        await action();
      } catch (err) {
        toast(err.message || "처리 실패", true);
      }
    });
  }

  function filter() {
    renderStatusTable();
  }

  function init() {
    initAttendance();
    initSeasonActions();
    initConfirmModal();
    document.getElementById("qp").addEventListener("input", filter);
  }

  return { init, load, filter };
})();
