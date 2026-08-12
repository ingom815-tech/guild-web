// 기존 Streamlit 앱(app.py _render_drop_item_reg, "텍스트 로그로 등록")의 파싱/매칭 로직을
// 그대로 이식한 것. 서버 없이 이미 불러온 item_master 목록만으로 클라이언트에서 동작한다.
//
// 지원 형식:
//   1) 레이드 로그 형식 — "처치 시간 ... 결사부대장 ... 보스" 헤더가 있는 블록들
//   2) 단순 형식 — "아이템명 수량" 한 줄씩 (수량 생략 시 1)
const LogParser = (() => {
  // 아이템 별칭 → 정식 item_master 이름 (기존 ITEM_ALIASES/ITEM_ALIAS_CONTAINS 그대로)
  // Object.create(null): 로그에서 뽑힌 문자열이 우연히 "constructor" 등과 같아져도
  // Object.prototype 상속 멤버를 잘못 매칭 결과로 반환하지 않도록 방지.
  const ITEM_ALIASES = Object.assign(Object.create(null), {
    설계자의계율전승서조각: "신화 전승서 조각",
    // 장비 부위 약칭 → 실제 재고 품목명 (2026-08 사용자 지정 매핑 — 키는 공백 제거 기준 정확 일치)
    전승서: "계율서",
    상의: "지배자 셔츠",
    신발: "혁신의 판금장화",
    장갑: "지배의 천장갑",
    벨트: "자유의 장식띠",
    망토: "지배의 케이프",
    목걸이: "구원의 목걸이",
    귀걸이: "구원의 귀걸이",
    반지: "구원의 반지",
    하의: "지배자 천바지",
    투구: "지배의 머리띠",
  });
  const ITEM_ALIAS_CONTAINS = [["계율조각", "신화 전승서 조각"]];

  const ROMAN_MAP = { I: "1", II: "2", III: "3", IV: "4", V: "5", VI: "6" };
  const UNICODE_ROMAN_MAP = { Ⅰ: "I", Ⅱ: "II", Ⅲ: "III", Ⅳ: "IV", Ⅴ: "V", Ⅵ: "VI" };

  function resolveItemAlias(name) {
    const nameNoSpace = name.replace(/ /g, "");
    if (ITEM_ALIASES[nameNoSpace]) return ITEM_ALIASES[nameNoSpace];
    for (const [keyword, canonical] of ITEM_ALIAS_CONTAINS) {
      if (nameNoSpace.includes(keyword)) return canonical;
    }
    return name;
  }

  // item_master 목록에서 로마자 등급 표기(끝이 " I"/" II" 등) → 아라비아 숫자 별칭 테이블을 만든다.
  // 예: "PVP조각 II" → 별칭 "PVP조각2", "PVP조각 2" 모두 해당 아이템으로 매칭.
  function buildNumeralAlias(itemMaster) {
    const alias = Object.create(null);
    for (const item of itemMaster) {
      const ibase = item.item_name.replace(/\s+$/, "");
      for (const [rom, ara] of Object.entries(ROMAN_MAP)) {
        if (ibase.endsWith(" " + rom)) {
          const stem = ibase.slice(0, -(rom.length + 1));
          alias[(stem + ara).replace(/ /g, "")] = item;
          alias[stem + ara] = item;
          for (const [uc, lc] of Object.entries(UNICODE_ROMAN_MAP)) {
            if (lc === rom) {
              alias[(stem + " " + uc).replace(/ /g, "")] = item;
              alias[stem + " " + uc] = item;
            }
          }
        }
      }
    }
    return alias;
  }

  function hpVariants(s) {
    const vs = [];
    const sNo = s.replace(/ /g, "");
    const sl = sNo.toLowerCase();
    if (sNo.includes("물약") && !sNo.toUpperCase().includes("HP")) {
      vs.push(sNo.replaceAll("물약", "HP물약강화"));
      vs.push(sNo.replaceAll("물약", "HP 물약 강화").replace(/ /g, ""));
    }
    if (sl.includes("hp") && !sNo.includes("물약")) {
      vs.push(sNo.replace(/hp/gi, "HP물약강화"));
    }
    if (sl.includes("hp물약")) {
      vs.push(sNo.replace(/hp물약/gi, "HP물약강화"));
    }
    return vs;
  }

  function jaccard(setA, setB) {
    if (!setA.size || !setB.size) return 0;
    let inter = 0;
    for (const t of setA) if (setB.has(t)) inter++;
    const union = setA.size + setB.size - inter;
    return union ? inter / union : 0;
  }

  /**
   * 로그에서 뽑아낸 이름 하나를 item_master와 매칭한다.
   * 반환: 매칭된 item_master 행({item_name, grade, category}) 또는 null
   */
  function tryMatchItem(rawName, ctx) {
    const { itemMaster, itemLookup, itemLookupNoSpace, numeralAlias } = ctx;
    let name = resolveItemAlias(rawName);

    // "- 등급 [로마자] 아퀴룬" 접미사 → 아퀴 카테고리 등급 덮어씀 (영웅은 등록 대상 아님)
    const suffixMatch = name.match(/-\s*(전설|영웅|희귀|신화|절대자)\s*(?:I{1,3}|IV|V|VI)?\s*아퀴룬/);
    const suffixGrade = suffixMatch ? suffixMatch[1] : null;
    if (suffixGrade === "영웅") return null;

    const stripped = name.replace(/\s*-\s*(전설|영웅|희귀|신화|절대자)\s*\S*.*$/, "").trim();

    function applyGrade(item) {
      if (!item) return item;
      if (suffixGrade && item.category === "아퀴") return { ...item, grade: suffixGrade };
      return item;
    }

    // "별빛 심연석 조각 (녹색)-다이아" (게임 로그) → "별빛 심연석 (녹색)-다이아" (DB 등록명) 정규화
    const norm = name.replaceAll("조각 (", "(");
    const normStr = stripped.replaceAll("조각 (", "(");
    const hpExtra = hpVariants(stripped);

    const candidates = [
      name, stripped, norm, normStr,
      name.replace(/ /g, ""), stripped.replace(/ /g, ""),
      norm.replace(/ /g, ""), normStr.replace(/ /g, ""),
      ...hpExtra,
    ];
    for (const c of candidates) {
      if (itemLookup[c]) return applyGrade(itemLookup[c]);
      if (itemLookupNoSpace[c]) return applyGrade(itemLookupNoSpace[c]);
      if (numeralAlias[c]) return applyGrade(numeralAlias[c]);
    }

    // 퍼지 매칭: 토큰 자카드 유사도 + 부분 문자열 포함 매칭
    const tokens = new Set(stripped.split(/\s+/).filter(Boolean));
    const tokensNorm = new Set(normStr.split(/\s+/).filter(Boolean));
    const strippedNo = normStr.replace(/ /g, "").toLowerCase();
    let best = null;
    let bscore = 0;
    for (const dbItem of itemMaster) {
      const dbName = dbItem.item_name;
      const dbTokens = new Set(dbName.split(/\s+/).filter(Boolean));
      const dbNo = dbName.replace(/ /g, "").toLowerCase();
      for (const tok of [tokens, tokensNorm]) {
        const sc = jaccard(dbTokens, tok);
        if (sc > bscore) {
          bscore = sc;
          best = dbItem;
        }
      }
      if (strippedNo && dbNo) {
        if (strippedNo === dbNo) {
          bscore = 1.0;
          best = dbItem;
        } else if (dbNo.includes(strippedNo)) {
          const subSc = strippedNo.length / dbNo.length;
          if (subSc > bscore && subSc >= 0.7) {
            bscore = subSc;
            best = dbItem;
          }
        } else if (strippedNo.includes(dbNo)) {
          const subSc = dbNo.length / strippedNo.length;
          if (subSc > bscore && subSc >= 0.7) {
            bscore = subSc;
            best = dbItem;
          }
        }
      }
    }
    return bscore >= 0.5 ? applyGrade(best) : null;
  }

  function buildContext(itemMaster) {
    const itemLookup = Object.create(null);
    const itemLookupNoSpace = Object.create(null);
    for (const item of itemMaster) {
      itemLookup[item.item_name] = item;
      itemLookupNoSpace[item.item_name.replace(/ /g, "")] = item;
    }
    return {
      itemMaster,
      itemLookup,
      itemLookupNoSpace,
      numeralAlias: buildNumeralAlias(itemMaster),
    };
  }

  // ── 단순 형식: "아이템명 수량" 한 줄씩, 수량 없으면 1개 ──
  function parseSimpleFormat(lines, ctx, defaultLooter) {
    const simpleLineRe = /^(.+?)[\t\s]+(\d+)개?\s*$/;
    const matched = [];
    const unmatched = [];
    let found = false;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(simpleLineRe);
      if (m) {
        found = true;
        const sname = m[1].trim();
        let sqty = parseInt(m[2], 10);
        // 숫자가 수량이 아니라 로마자 등급 표기일 수 있음 ("특화 5" = "특화 V")
        const combined = (sname + String(sqty)).replace(/ /g, "");
        const tierMatch = ctx.numeralAlias[combined] || ctx.itemLookupNoSpace[combined];
        let mr;
        if (tierMatch) {
          mr = tierMatch;
          sqty = 1;
        } else {
          mr = tryMatchItem(sname, ctx);
        }
        if (mr) {
          matched.push(toMatchedEntry(mr, sqty, sname, defaultLooter, null, null, false));
        } else {
          unmatched.push({ name: sname, qty: sqty, boss: "-" });
        }
      } else {
        found = true;
        const sname = line;
        let mr = tryMatchItem(sname, ctx);
        let qty = 1;
        let outName = sname;
        // 약식: 수량이 공백 없이 붙은 경우 ("별심조각5") — 전체 라인 매칭 실패 시 끝 숫자를 수량으로 분리 재시도.
        // "특화5" 같은 로마자 등급 별칭은 위 tryMatchItem(numeralAlias)이 먼저 잡으므로 안전.
        const tail = !mr ? line.match(/^(.+?)(\d+)개?$/) : null;
        if (tail) {
          const stem = tail[1].trim();
          const mr2 = tryMatchItem(stem, ctx);
          qty = parseInt(tail[2], 10) || 1;
          outName = stem;
          if (mr2) mr = mr2;
        }
        if (mr) {
          matched.push(toMatchedEntry(mr, qty, outName, defaultLooter, null, null, false));
        } else {
          unmatched.push({ name: outName, qty, boss: "-" });
        }
      }
    }
    return { found, matched, unmatched };
  }

  // strictFuzzy: 레이드 로그 형식은 원본 app.py에서 대소문자/공백 무시 없는 엄격 비교(!=)를 쓰고,
  // 단순 형식은 공백 제거 + 대소문자 무시 비교를 쓴다 (두 분기의 원본 규칙이 서로 다름 — 그대로 재현).
  function toMatchedEntry(mr, qty, logName, looter, dropDate, bossName, strictFuzzy) {
    const fuzzy = strictFuzzy
      ? mr.item_name !== logName
      : mr.item_name.replace(/ /g, "").toLowerCase() !== logName.replace(/ /g, "").toLowerCase();
    return {
      item_name: mr.item_name,
      grade: mr.grade,
      category: mr.category || "기타",
      quantity: qty,
      log_name: logName,
      fuzzy,
      drop_date: dropDate,
      boss_name: bossName,
      looter,
    };
  }

  // ── 레이드 로그 형식: "결사...부대장" + "보스" 헤더가 있는 블록 단위 파싱 ──
  function parseRaidLogFormat(lines, ctx, defaultLooter) {
    const headerRe = /결사.{0,3}부대장/;
    const blockStarts = []; // {lineIdx, looterCol, bossCol}
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (headerRe.test(l) && l.includes("보스")) {
        const parts = l.split(/\t|\s{2,}/);
        const looterCol = parts.findIndex((p) => p.includes("결사") && p.includes("부대장"));
        const bossCol = parts.findIndex((p) => p === "보스");
        if (looterCol !== -1 && bossCol !== -1) {
          blockStarts.push({ lineIdx: i, looterCol, bossCol });
        }
      }
    }
    if (!blockStarts.length) return null; // 레이드 로그 형식 아님 → 호출자가 단순 형식으로 폴백

    const matched = [];
    const unmatched = [];

    blockStarts.forEach((bs, bi) => {
      const nextIdx = bi + 1 < blockStarts.length ? blockStarts[bi + 1].lineIdx : lines.length;
      const blockLines = lines.slice(bs.lineIdx, nextIdx);

      let blkDate = null, blkBoss = null, blkLooter = null;
      for (const bl of blockLines.slice(1)) {
        if (bl) {
          const dp = bl.split(/\t|\s{2,}/);
          if (bs.looterCol < dp.length) blkLooter = dp[bs.looterCol].trim();
          if (bs.bossCol < dp.length) blkBoss = dp[bs.bossCol].trim();
          if (dp.length > 0) {
            const dm = dp[0].match(/^(\d{4}\.\d{2}\.\d{2})/);
            if (dm) blkDate = dm[1];
          }
          break;
        }
      }

      let inItems = false;
      for (const bl of blockLines) {
        if (bl.includes("전리품") && bl.includes("개수")) {
          inItems = true;
          continue;
        }
        if (!inItems) continue;
        let im = bl.match(/^(.+?)\t(\d+)개\s*$/);
        if (!im) im = bl.match(/^(.+?)\s{2,}(\d+)개\s*$/);
        if (im) {
          const iname = im[1].trim();
          const iqty = parseInt(im[2], 10);
          const mr = tryMatchItem(iname, ctx);
          if (mr) {
            matched.push(toMatchedEntry(mr, iqty, iname, blkLooter || defaultLooter, blkDate, blkBoss, true));
          } else {
            unmatched.push({ name: iname, qty: iqty, boss: blkBoss || "-" });
          }
        }
      }
    });

    return { matched, unmatched, blockCount: blockStarts.length };
  }

  /**
   * 로그 텍스트 전체를 파싱한다.
   * @param {string} text - 붙여넣은 원본 텍스트
   * @param {Array} itemMaster - [{item_name, grade, category}, ...]
   * @param {string} defaultLooter - 블록에 룻자 정보가 없을 때 쓸 기본 룻자
   * @returns {{matched: Array, unmatched: Array, isBlockFormat: boolean, blockCount: number}}
   */
  function parse(text, itemMaster, defaultLooter) {
    const ctx = buildContext(itemMaster);
    const lines = text.trim().split("\n").map((l) => l.trim());

    const raidResult = parseRaidLogFormat(lines, ctx, defaultLooter);
    if (raidResult) {
      return {
        matched: raidResult.matched,
        unmatched: raidResult.unmatched,
        isBlockFormat: true,
        blockCount: raidResult.blockCount,
        found: true,
      };
    }
    const simpleResult = parseSimpleFormat(lines, ctx, defaultLooter);
    return {
      matched: simpleResult.matched,
      unmatched: simpleResult.unmatched,
      isBlockFormat: false,
      blockCount: 0,
      found: simpleResult.found,
    };
  }

  return { parse };
})();
