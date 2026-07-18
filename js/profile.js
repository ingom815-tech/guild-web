// 내 정보 화면: 긴급 참여조(데이/나이트) 선택 + 내 조 긴급 참여율 지표 (전 회원)
// 참여점수 계산과 무관한 별도 참고 지표 — 점수 로직은 서버에서도 건드리지 않는다.
const Profile = (() => {
  let data = null; // GET /profile 응답

  function toast(msg, isErr) {
    const t = document.getElementById("profileToast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    t.style.display = "block";
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.style.display = "none"), 5000);
  }

  async function load() {
    try {
      data = await Api.getProfile();
    } catch (e) {
      toast(e.message || "내 정보 조회 실패", true);
      return;
    }
    render();
  }

  const SHIFT_LABEL = { day: "데이조", night: "나이트조" };

  function render() {
    document.getElementById("profileNameLabel").textContent = `${data.user.current_id || data.user.user_id}님의 정보`;
    document.getElementById("profileMetaLine").textContent = `고정아이디 ${data.user.user_id} · ${data.user.role} · 시즌 ${data.season}`;

    // 조 토글 상태 (표시는 현재 선택값 preferred 기준)
    document.querySelectorAll("#shiftToggle span").forEach((s) => {
      s.classList.toggle("on", s.dataset.sh === data.preferred_shift);
    });

    // 변경 예약 안내
    const pendingNote = document.getElementById("shiftPendingNote");
    if (data.pending_change) {
      pendingNote.textContent = `⏳ ${SHIFT_LABEL[data.pending_change.shift]} 변경은 시즌 ${data.pending_change.effective_season}부터 반영됩니다. (이번 시즌 계산: ${data.effective_shift ? SHIFT_LABEL[data.effective_shift] : "미선택"})`;
    } else {
      pendingNote.textContent = "";
    }

    // 지표
    const box = document.getElementById("shiftMetricBox");
    if (!data.effective_shift) {
      box.innerHTML = `<span class="meta">참여조를 선택하면 내 조 긴급 참여율이 표시됩니다.</span>`;
      return;
    }
    const m = data.metrics;
    if (!m || m.rate === null) {
      box.innerHTML = "";
      const label = document.createElement("b");
      label.style.fontSize = "14px";
      label.textContent = `${SHIFT_LABEL[m ? m.shift : data.effective_shift]}`;
      const note = document.createElement("span");
      note.className = "meta";
      note.textContent = " · 이번 시즌 우리 조 긴급 소집이 아직 없습니다.";
      box.appendChild(label);
      box.appendChild(note);
      return;
    }
    box.innerHTML = `
      <b style="font-size:14px" class="sh-label"></b>
      <span style="margin-left:8px">내 조 긴급 참여율 <b class="rate-v" style="font-size:16px"></b> <span class="meta frac"></span></span>
      <span class="meta" style="margin-left:10px">· 타조 지원 <b class="sup-v"></b>회</span>`;
    box.querySelector(".sh-label").textContent = SHIFT_LABEL[m.shift];
    box.querySelector(".rate-v").textContent = `${m.rate}%`;
    box.querySelector(".frac").textContent = `(${m.attended}/${m.total})`;
    box.querySelector(".sup-v").textContent = m.other_support;
  }

  async function selectShift(el) {
    const shift = el.dataset.sh;
    if (data && data.preferred_shift === shift) return;
    try {
      const res = await Api.setProfileShift(shift);
      if (res.unchanged) return;
      if (res.immediate) {
        toast(`✓ ${SHIFT_LABEL[shift]} 선택 완료 — 이번 시즌부터 바로 반영됩니다.`);
      } else {
        toast(`✓ ${SHIFT_LABEL[shift]}(으)로 변경 — 시즌 ${res.effective_season}부터 계산에 반영됩니다.`);
      }
      await load();
    } catch (err) {
      toast(err.message || "조 선택 실패", true);
    }
  }

  function init() {}

  return { init, load, selectShift };
})();
