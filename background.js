const ANALYZE_ENDPOINT = "https://swai-backend.onrender.com/api/check";
const ANALYZE_SUMMARY_ENDPOINT = "https://swai-backend.onrender.com/api/checkSummary";
const FRONTEND_FALLBACK = "https://gaeinjjeongbo.netlify.app/analysis-result";
const SUMMARY_TEXT_LIMIT = 200;
const PREF_KEY = "preAnalysisPromptEnabled";
const FREE_MODE_KEY = "freeVersionEnabled";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FOUND_CONSENT" && typeof msg.text === "string") {
    // Auto/content-script path → page overlay
    handleConsent(msg.text, sender.tab?.id, { useSummary: msg.useSummary })
      .then(sendResponse)
      .catch((error) => {
        console.error("Consent handling failed", error);
        sendResponse({ error: "processing_failed" });
    });
    return true; // keep the message channel open for async response
  }

  if (msg?.type === "PROMPT_ANALYZE" && typeof msg.text === "string") {
    // Overlay prompt “Send analysis” action
    handleConsent(msg.text, sender.tab?.id, { skipPrompt: true, useSummary: msg.useSummary })
      .then(sendResponse)
      .catch((error) => {
        console.error("Prompt analysis failed", error);
        sendResponse({ error: "processing_failed" });
      });
    return true;
  }

  if (msg?.type === "ANALYZE_TEXT_DIRECT" && typeof msg.text === "string") {
    // Extension popup (inline result) path: no overlay, no prompt
    directAnalyzeFromPopup(msg.text, msg.tabId, msg.useSummary)
      .then(sendResponse)
      .catch((error) => {
        console.error("Direct analysis failed", error);
        sendResponse({ error: "processing_failed" });
      });
    return true;
  }

  if (msg?.type === "GET_CACHED_RESULT" && typeof msg.text === "string") {
    getCachedResult(msg.text, msg.useSummary)
      .then((cachedResult) => sendResponse({ result: cachedResult }))
      .catch((error) => {
        console.error("Cache lookup failed", error);
        sendResponse({ result: null });
      });
    return true;
  }

  if (msg?.type === "OPEN_FULL_RESULT" && typeof msg.url === "string") {
    openResultTab(msg.url, msg.payload)
      .then((ok) => sendResponse({ ok }))
      .catch((error) => {
        console.error("Full result open failed", error);
        sendResponse({ ok: false });
      });
    return true;
  }

  return undefined;
});

async function handleConsent(text, tabId, options = {}) {
  const skipPrompt = Boolean(options.skipPrompt);
  const suppressOverlay = Boolean(options.suppressOverlay);
  const explicitUseSummary = options.useSummary;

  // Always clear any stale overlay before proceeding
  if (tabId) {
    await removeOverlay(tabId);
  }

  if (!tabId) {
    console.warn("No tabId provided for consent result");
    return { error: "no_tab" };
  }

  const prefs = await chrome.storage.local.get({
    [PREF_KEY]: false,
    [FREE_MODE_KEY]: false
  });
  const useSummary = typeof explicitUseSummary === "boolean" ? explicitUseSummary : Boolean(prefs[FREE_MODE_KEY]);
  const desiredMode = useSummary ? "free" : "full";

  const cacheKey = await makeCacheKey(text);
  const cache = await chrome.storage.local.get(cacheKey);
  const cachedResultRaw = cache[cacheKey];
  const cachedResult =
    cachedResultRaw && (cachedResultRaw.mode || desiredMode) === desiredMode
      ? {
          mode: cachedResultRaw.mode || desiredMode,
          summary: "",
          fullLink: sanitizeLink(cachedResultRaw.fullLink, desiredMode === "free"),
          ...cachedResultRaw
        }
      : null;

  // Inline/popup-direct path: return cached immediately, bypass prompt/overlay
  if (suppressOverlay) {
    if (cachedResult) {
      return { source: "cache", result: cachedResult };
    }
  } else {
    // Overlay path: honor prompt setting
    if (prefs[PREF_KEY] && !skipPrompt) {
      await showOverlay(
        tabId,
        { prompt: true, text, cacheAvailable: Boolean(cachedResult), mode: useSummary ? "free" : "full" },
        false
      );
      return { source: "prompt" };
    }

    if (cachedResult) {
      if (Number(cachedResult.score) !== 0) {
        const safeCached = {
          ...cachedResult,
          fullLink: sanitizeLink(cachedResult.fullLink, desiredMode === "free"),
          cacheAvailable: true
        };
        await showOverlay(tabId, safeCached, true);
      }
      return { source: "cache", result: cachedResult };
    }
  }

  let result;
  try {
    result = await callRemoteAnalyzer(text, useSummary);
  } catch (error) {
    console.error("API call failed", error);
    const detail = formatError(error);
    if (!suppressOverlay) {
      await showOverlay(tabId, { error: "분석을 실패했습니다.", detail }, false);
    }
    return { error: "api_error", detail };
  }

  await chrome.storage.local.set({ [cacheKey]: result });
  if (!suppressOverlay) {
    if (Number(result.score) === 0) {
      await removeOverlay(tabId);
    } else {
      await showOverlay(tabId, result, false);
    }
  }
  return { source: "api", result };
}

async function directAnalyzeFromPopup(text, tabId, useSummary) {
  if (!tabId) {
    return { error: "no_tab" };
  }

  const cacheKey = await makeCacheKey(text);
  const cache = await chrome.storage.local.get(cacheKey);
  const cachedResult = cache[cacheKey];
  const desiredMode = useSummary ? "free" : "full";

  if (cachedResult && (cachedResult.mode || desiredMode) === desiredMode) {
    const normalized = {
      mode: cachedResult.mode || desiredMode,
      summary: "",
      fullLink: sanitizeLink(cachedResult.fullLink, desiredMode === "free"),
      originalText: "",
      meta: {},
      ...cachedResult
    };
    return { source: "cache", result: normalized };
  }

  return handleConsent(text, tabId, { skipPrompt: true, suppressOverlay: true, useSummary });
}

async function getCachedResult(text, useSummary) {
  const cacheKey = await makeCacheKey(text);
  const cache = await chrome.storage.local.get(cacheKey);
  const cachedResult = cache[cacheKey];
  const desiredMode = useSummary ? "free" : "full";
  return cachedResult
    ? (cachedResult.mode || desiredMode) === desiredMode
      ? {
          mode: cachedResult.mode || desiredMode,
          summary: "",
          fullLink: sanitizeLink(cachedResult.fullLink, desiredMode === "free"),
          originalText: "",
          originalTextFull: cachedResult.originalTextFull || cachedResult.originalText || "",
          meta: {},
          ...cachedResult
        }
      : null
    : null;
}

async function callRemoteAnalyzer(text, useSummary) {
  const summaryMode = Boolean(useSummary);
  const endpoint = summaryMode ? ANALYZE_SUMMARY_ENDPOINT : ANALYZE_ENDPOINT;
  if (!endpoint) throw new Error("Analyzer endpoint missing");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let url = endpoint;
  const headers = {
    Accept: "application/json"
  };
  const fetchOptions = {
    method: "POST",
    headers,
    signal: controller.signal
  };

  const originalProvidedText = text || "";
  headers["Content-Type"] = "application/json";
  fetchOptions.body = JSON.stringify({ text: originalProvidedText });

  let res;
  try {
    res = await fetch(url, fetchOptions);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const message = `Analyzer HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.body = bodyText.slice(0, 300);
    throw error;
  }

  const data = await res.json().catch(() => ({}));
  const meta = data && typeof data === "object" ? data.meta || {} : {};
  const s = data && (data.score ?? data.riskScore ?? (data.result ? data.result.score : undefined));
  const l = data && (data.label ?? (data.result ? data.result.label : undefined));
  const b = (data && (data.bullets ?? data.issues ?? (data.result ? data.result.bullets : undefined))) || [];
  const previewText = typeof meta.preview === "string" ? meta.preview : "";
  const summaryText =
    (data &&
      (data.summary ??
        data.shortSummary ??
        data.short ??
        (meta ? meta.summary || meta.shortSummary : undefined) ??
        (data.result ? data.result.summary : undefined))) ||
    previewText ||
    "";
  const originalText =
    (meta && typeof meta.originalText === "string" && meta.originalText) || originalProvidedText;
  const baseLink =
    (meta &&
      (meta.fullLink || meta.fullUrl || meta.url || meta.link)) ||
    (data &&
      (data.fullLink ?? data.fullUrl ?? data.url ?? data.link ??
        (data.result ? data.result.fullLink || data.result.url || data.result.link : undefined))) ||
    "";
  const fullLink = sanitizeLink(baseLink, summaryMode);

  let score = typeof s === "number" ? s : NaN;
  if (Number.isNaN(score) && previewText) {
    const m = previewText.match(/score:\s*([0-9]+)/i);
    if (m) score = Number(m[1]);
  }
  score = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;

  let label = l;
  if (!label && previewText) {
    const lm = previewText.match(/label:\s*([^\n]+)/i);
    if (lm) label = lm[1].trim();
  }
  label = label || "(레이블 정보 없음)";
  const bullets = Array.isArray(b) ? b : [];

  return {
    ...data,
    score,
    label,
    bullets,
    summary: summaryText,
    fullLink: summaryMode ? fullLink : "",
    originalText,
    originalTextFull: originalProvidedText,
    meta,
    mode: summaryMode ? "free" : "full"
  };
}

function formatError(err) {
  if (!err) return "unknown error";
  const parts = [];
  if (typeof err === "string") return err;
  if (err.message) parts.push(err.message);
  if (err.status) parts.push(`status ${err.status}`);
  if (err.body) parts.push(`body: ${String(err.body).slice(0, 200)}`);
  return parts.join(" | ") || "unknown error";
}

function sanitizeLink(link, summaryMode) {
  if (!link) return summaryMode ? FRONTEND_FALLBACK : "";
  let out = link;
  try {
    const u = new URL(link);
    // strip legacy text param
    u.searchParams.delete("text");
    if (summaryMode) {
      u.search = "";
      if (/\/api\/check/i.test(u.pathname)) {
        u.pathname = "/analysis-result";
      }
    }
    out = u.toString();
  } catch (err) {
    out = link;
  }
  if (
    summaryMode &&
    (out.includes("swai-backend.onrender.com") || out.includes("/api/check") || out.includes("/api/checkSummary"))
  ) {
    out = FRONTEND_FALLBACK;
  }
  return out;
}

async function makeCacheKey(text) {
  const hash = await hashText(text);
  return `analysis:${hash}`;
}

async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text.slice(0, 5000)); // prevent huge payloads in the hash
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function showOverlay(tabId, payload, fromCache) {
  if (payload && !payload.prompt && !payload.error && Number(payload.score) === 0) {
    await removeOverlay(tabId);
    return;
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectOverlay,
    args: [payload, fromCache]
  });
}

function injectOverlay(payload, fromCache) {
  // Do not show overlay for empty/zero-score results
  if (payload && !payload.prompt && !payload.error && Number(payload.score) === 0) {
    return;
  }

  const existing = document.getElementById("privacy-consent-overlay");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.id = "privacy-consent-overlay";
  container.style.cssText = `
    position: fixed;
    top: 12px;
    left: 12px;
    width: min(260px, 90vw);
    background: #0d1117;
    color: #f0f6fc;
    padding: 14px 16px;
    border-radius: 12px;
    font-size: 12px;
    z-index: 2147483647;
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
    line-height: 1.4;
  `;

  const title = document.createElement("div");
  title.style.fontWeight = "600";
  title.style.display = "flex";
  title.style.alignItems = "center";
  title.style.gap = "8px";
  title.textContent = "분석 결과";

  const modePill = document.createElement("span");
  modePill.id = "resultModePill";
  const isFreeMode = payload && payload.mode === "free";
  modePill.textContent = isFreeMode ? "무료" : "전체";
  modePill.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: ${isFreeMode ? "rgba(240, 246, 252, 0.12)" : "rgba(88, 166, 255, 0.14)"};
    color: ${isFreeMode ? "#f0f6fc" : "#58a6ff"};
    font-size: 11px;
    font-weight: 600;
  `;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.style.cssText = `
    margin-left: auto;
    padding: 2px 6px;
    background: transparent;
    color: inherit;
    border: none;
    border-radius: 6px;
    font-weight: 700;
    cursor: pointer;
    line-height: 1;
  `;
  closeBtn.addEventListener("click", () => container.remove());

  const pill = document.createElement("span");
  pill.textContent = fromCache ? "캐시" : "실시간";
  pill.style.cssText = `
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px 8px;
    border-radius: 999px;
    background: ${fromCache ? "rgba(88, 166, 255, 0.14)" : "rgba(52, 211, 153, 0.14)"};
    color: ${fromCache ? "#58a6ff" : "#34d399"};
    font-size: 11px;
    font-weight: 600;
  `;
  title.appendChild(modePill);
  title.appendChild(pill);
  title.appendChild(closeBtn);

  // Scoped styles for water meter (matches site)
  const meterStyle = document.createElement("style");
  meterStyle.textContent = `
    #privacy-consent-overlay .water-meter {
      --fill: 0%;
      --water: hsl(240 85% 52%);
      --waterLight: hsl(240 90% 70%);
      width: 84px;
      height: 84px;
      border-radius: 50%;
      position: relative;
      overflow: hidden;
      background: #f5f5f5;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #privacy-consent-overlay .water-meter > #riskScore {
      position: relative;
      z-index: 2;
      font-size: 1.25rem;
      font-weight: 700;
    }
    #privacy-consent-overlay .water-meter .water {
      position: absolute;
      left: 0;
      bottom: 0;
      width: 100%;
      height: var(--fill);
      background: linear-gradient(to top, var(--water) 0%, var(--waterLight) 100%);
      transition: height 600ms ease, background-color 300ms ease;
    }
    #privacy-consent-overlay .water-meter .water::after {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: -8px;
      height: 16px;
      background: radial-gradient(circle at 10% 50%, rgba(255,255,255,.35) 20%, transparent 22%) 0 0/18px 16px repeat-x,
                  radial-gradient(circle at 50% 40%, rgba(255,255,255,.2) 20%, transparent 22%) 0 0/22px 16px repeat-x;
      animation: waveSlide 3.5s linear infinite;
    }
    @keyframes waveSlide {
      from { background-position: 0 0, 0 0; }
      to { background-position: 100% 0, -100% 0; }
    }
  `;

  if (payload && payload.prompt) {
    container.appendChild(meterStyle);
    const body = document.createElement("div");
    body.style.marginTop = "8px";
    body.style.lineHeight = "1.5";
    // body.textContent = "개인정보 관련 텍스트가 발견되었습니다!";

    const snippetText = (payload.preview || payload.text || "").slice(0, 200);
    if (snippetText) {
      const snippet = document.createElement("div");
      snippet.style.cssText = "margin-top: 8px; padding: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; font-size: 11px; line-height: 1.4;";
      snippet.textContent = snippetText + (payload.text && payload.text.length > snippetText.length ? "…" : "");
      body.appendChild(snippet);
    }

    const actions = document.createElement("div");
    actions.style.cssText = "margin-top: 10px; display: flex; justify-content: flex-end;";

    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.textContent = payload.cacheAvailable ? "결과보기" : "분석하기";
    sendBtn.style.cssText = `
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.06);
      color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
    `;

    // const cancelBtn = document.createElement("button");
    // cancelBtn.type = "button";
    // cancelBtn.textContent = "Dismiss";
    // cancelBtn.style.cssText = `
    //   padding: 8px 10px;
    //   background: rgba(255, 255, 255, 0.06);
    //   color: inherit;
    //   border: 1px solid rgba(255, 255, 255, 0.12);
    //   border-radius: 8px;
    //   font-weight: 600;
    //   cursor: pointer;
    // `;

    // cancelBtn.addEventListener("click", () => container.remove());

    sendBtn.addEventListener("click", () => {
      sendBtn.disabled = true;
      sendBtn.textContent = payload.cacheAvailable ? "Loading..." : "Sending...";
      chrome.runtime.sendMessage(
        { type: "PROMPT_ANALYZE", text: payload.text || "", useSummary: payload.mode === "free" },
        (res) => {
          const lastError = chrome.runtime.lastError;
          if (lastError || res?.error) {
            sendBtn.disabled = false;
            sendBtn.textContent = payload.cacheAvailable ? "Retry" : "Retry send";
            body.appendChild(document.createTextNode(" 전송에 실패했습니다. 다시 시도해주세요."));
          }
        }
      );
    });

    actions.append(sendBtn);//, cancelBtn);
    container.append(title, body, actions);
    document.body.appendChild(container);
    return;
  }

  if (payload && payload.error) {
    const body = document.createElement("div");
    body.style.marginTop = "6px";
    body.textContent = payload.error;

    if (payload.detail) {
      const detail = document.createElement("div");
      detail.style.cssText = "margin-top: 4px; opacity: 0.8; font-size: 11px;";
      detail.textContent = payload.detail;
      container.append(title, body, detail);
      document.body.appendChild(container);
      return;
    }

    container.append(title, body);
    document.body.appendChild(container);
    return;
  }

  const resultCard = document.createElement("div");
  resultCard.id = "analysisResult";
  resultCard.style.cssText = `
    margin-top: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    padding: 10px 12px;
  `;

  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 12px; align-items: center;";

  const meterEl = document.createElement("div");
  meterEl.id = "riskMeter";
  meterEl.className = "water-meter";
  meterEl.dataset.prev = "0";
  meterEl.style.setProperty("--fill", "0%");
  meterEl.style.setProperty("--water", "hsl(200 85% 52%)");
  meterEl.style.setProperty("--waterLight", "hsl(200 90% 70%)");
  const meterWater = document.createElement("div");
  meterWater.className = "water";
  meterEl.appendChild(meterWater);

  const scoreWrap = document.createElement("div");
  scoreWrap.style.cssText = "display: flex; flex-direction: column; gap: 4px; min-width: 0;";

  const scoreEl = document.createElement("div");
  scoreEl.id = "riskScore";
  scoreEl.style.cssText = "font-size: 22px; font-weight: 700;";
  scoreEl.textContent = "0";

  const labelEl = document.createElement("div");
  labelEl.id = "riskLabel";
  labelEl.style.cssText = "font-size: 12px; opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
  labelEl.textContent = "위험도: -";

  scoreWrap.append(scoreEl, labelEl);
  row.append(meterEl, scoreWrap);

  const list = document.createElement("ul");
  list.id = "riskBullets";
  list.style.cssText = "margin: 10px 0 0 18px; padding: 0; max-height: 120px; overflow: hidden;";

  const summaryBox = document.createElement("div");
  summaryBox.id = "analysisSummary";
  summaryBox.style.cssText =
    "margin-top: 10px; padding: 10px; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; display: none; white-space: pre-wrap; line-height: 1.5;";

  const linkWrap = document.createElement("div");
  linkWrap.id = "analysisLinkWrap";
  linkWrap.style.cssText = "margin-top: 8px; display: none;";
  const linkEl = document.createElement("a");
  linkEl.id = "analysisFullLink";
  linkEl.href = "#";
  linkEl.target = "_blank";
  linkEl.rel = "noreferrer noopener";
  linkEl.textContent = "전체 결과 보기";
  linkEl.style.cssText = "color: #58a6ff; text-decoration: underline; font-weight: 600;";
  linkWrap.appendChild(linkEl);

  resultCard.append(row, list, summaryBox, linkWrap);
  container.append(title, meterStyle, resultCard);
  document.body.appendChild(container);

  const normalized =
    payload && typeof payload === "object"
      ? { mode: payload.mode || "full", summary: "", fullLink: "", originalText: "", meta: {}, ...payload }
      : { mode: "full", summary: "", fullLink: "", originalText: "", meta: {}, bullets: [] };
  normalized.bullets = Array.isArray(normalized.bullets) ? normalized.bullets : [];
  normalized.summary = typeof normalized.summary === "string" ? normalized.summary : "";
  normalized.fullLink = typeof normalized.fullLink === "string" ? normalized.fullLink : "";
  normalized.originalText = typeof normalized.originalText === "string" ? normalized.originalText : "";
  normalized.meta = normalized.meta && typeof normalized.meta === "object" ? normalized.meta : {};
  updateAnalysisUI(normalized);

  function updateAnalysisUI(result) {
    const resultCardEl = document.getElementById("analysisResult");
    const scoreElInner = document.getElementById("riskScore");
    const labelElInner = document.getElementById("riskLabel");
    const ul = document.getElementById("riskBullets");
    const meter = document.getElementById("riskMeter");
    const summaryBoxEl = document.getElementById("analysisSummary");
    const linkWrapEl = document.getElementById("analysisLinkWrap");
    const linkEl = document.getElementById("analysisFullLink");
    const modePillEl = document.getElementById("resultModePill");
    if (!resultCardEl || !scoreElInner || !labelElInner || !ul || !meter) return;

  resultCardEl.classList.remove("d-none");
  scoreElInner.textContent = `${result.score}`;
  labelElInner.textContent = `위험도: ${result.label}`;

    if (modePillEl) {
      const free = result.mode === "free";
      modePillEl.textContent = free ? "무료" : "PRO";
      modePillEl.style.background = free ? "rgba(240, 246, 252, 0.12)" : "rgba(88, 166, 255, 0.14)";
      modePillEl.style.color = free ? "#f0f6fc" : "#58a6ff";
    }

  if (summaryBoxEl) {
    let summaryText = "";
    if (typeof result.summary === "string" && result.summary) {
      summaryText = result.summary;
    } else if (result.meta && typeof result.meta.preview === "string") {
      summaryText = result.meta.preview;
    }

    if (summaryText) {
      summaryText = summaryText
        .split("\n")
        .filter((line) => {
          const lower = line.trim().toLowerCase();
          return !(lower.startsWith("score:") || lower.startsWith("label:"));
        })
        .join("\n")
        .trim();
    }
    if (summaryText) {
      summaryBoxEl.textContent = summaryText;
      summaryBoxEl.style.display = "block";
    } else {
      summaryBoxEl.style.display = "none";
    }
  }

    if (linkWrapEl && linkEl) {
      if (result.mode === "free" && result.fullLink) {
        linkEl.href = result.fullLink;
        linkEl.onclick = (e) => {
          e.preventDefault();
          chrome.runtime.sendMessage({ type: "OPEN_FULL_RESULT", url: result.fullLink, payload: result });
        };
        linkWrapEl.style.display = "block";
      } else {
        linkWrapEl.style.display = "none";
      }
    }

    if (meter) {
      const target = Math.max(0, Math.min(100, Number(result.score) || 0));

      function scoreToHue(s) {
        let hue;
        if (s <= 30) {
          hue = 200; // ocean blue
        } else if (s <= 50) {
          const t1 = (s - 30) / 20; // 0..1
          hue = 200 - t1 * (200 - 120); // 200→120
        } else if (s <= 80) {
          const t2 = (s - 50) / 30; // 0..1
          hue = 120 - t2 * (120 - 50); // 120→50
        } else {
          const t3 = (s - 80) / 20; // 0..1
          hue = 30 - t3 * (30 - 0); // 30→0
        }
        return Math.max(0, Math.min(360, Math.round(hue)));
      }

      if (meter.__rafId) cancelAnimationFrame(meter.__rafId);

      let from = parseFloat(meter.dataset.prev);
      if (Number.isNaN(from)) from = target;

      let start;
      const duration = 1000;
      const ease = (t) => 1 - Math.pow(1 - t, 3);

      function step(ts) {
        if (start == null) start = ts;
        const p = Math.min(1, (ts - start) / duration);
        const e = ease(p);
        const cur = from + (target - from) * e;
        const hue = scoreToHue(cur);
        const water = `hsl(${hue} 85% 52%)`;
        const waterLight = `hsl(${hue} 90% 70%)`;
        meter.style.setProperty("--fill", `${cur}%`);
        meter.style.setProperty("--water", water);
        meter.style.setProperty("--waterLight", waterLight);
        meter.setAttribute("aria-valuenow", String(Math.round(cur)));
        scoreElInner.textContent = String(Math.round(cur));
        if (p < 1) {
          meter.__rafId = requestAnimationFrame(step);
        } else {
          delete meter.__rafId;
          meter.dataset.prev = String(target);
        }
      }

      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.setAttribute("role", "meter");
      meter.__rafId = requestAnimationFrame(step);
    }

    ul.innerHTML = "";
    (result.bullets || []).forEach((b) => {
      const li = document.createElement("li");
      li.textContent = b;
      ul.appendChild(li);
    });
  }
}

async function removeOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.getElementById("privacy-consent-overlay");
        if (el) el.remove();
      }
    });
  } catch (e) {
    // ignore
  }
}

function openResultTab(url, payload) {
  return new Promise((resolve) => {
    if (!url) {
      resolve(false);
      return;
    }

    chrome.tabs.create({ url }, (tab) => {
      if (!tab?.id) {
        resolve(false);
        return;
      }

      const applyPayload = () => {
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            func: (data) => {
              try {
                sessionStorage.setItem("analysisPayload", JSON.stringify(data || {}));
              } catch (err) {
                // ignore storage errors
              }
            },
            args: [payload]
          })
          .catch(() => {});
      };

      applyPayload();

      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          applyPayload();
          chrome.tabs.onUpdated.removeListener(listener);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
      resolve(true);
    });
  });
}
