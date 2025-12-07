const ANALYZE_ENDPOINT = "https://swai-backend.onrender.com/api/check";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "FOUND_CONSENT" && typeof msg.text === "string") {
    handleConsent(msg.text, sender.tab?.id)
      .then(sendResponse)
      .catch((error) => {
        console.error("Consent handling failed", error);
        sendResponse({ error: "processing_failed" });
      });
    return true; // keep the message channel open for async response
  }

  return undefined;
});

async function handleConsent(text, tabId) {
  if (!tabId) {
    console.warn("No tabId provided for consent result");
    return { error: "no_tab" };
  }

  const cacheKey = await hashText(text);
  const cache = await chrome.storage.local.get(cacheKey);
  const cachedResult = cache[cacheKey];

  if (cachedResult) {
    await showOverlay(tabId, cachedResult, true);
    return { source: "cache", result: cachedResult };
  }

  let result;
  try {
    result = await callRemoteAnalyzer(text);
  } catch (error) {
    console.error("API call failed", error);
    const detail = formatError(error);
    await showOverlay(tabId, { error: "분석을 실패했습니다.", detail }, false);
    return { error: "api_error", detail };
  }

  await chrome.storage.local.set({ [cacheKey]: result });
  await showOverlay(tabId, result, false);
  return { source: "api", result };
}

async function callRemoteAnalyzer(text) {
  if (!ANALYZE_ENDPOINT) throw new Error("Analyzer endpoint missing");

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let res;
  try {
    res = await fetch(ANALYZE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ text }),
      signal: controller.signal
    });
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
  const s = data && (data.score ?? data.riskScore ?? (data.result ? data.result.score : undefined));
  const l = data && (data.label ?? (data.result ? data.result.label : undefined));
  const b = (data && (data.bullets ?? data.issues ?? (data.result ? data.result.bullets : undefined))) || [];

  let score = typeof s === "number" ? s : 0;
  score = Math.max(0, Math.min(100, score));
  const label = l || "(레이블 정보 없음)";
  const bullets = Array.isArray(b) ? b : [];

  return { score, label, bullets };
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

async function hashText(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text.slice(0, 5000)); // prevent huge payloads in the hash
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function showOverlay(tabId, payload, fromCache) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: injectOverlay,
    args: [payload, fromCache]
  });
}

function injectOverlay(payload, fromCache) {
  const existing = document.getElementById("privacy-consent-overlay");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.id = "privacy-consent-overlay";
  container.style.cssText = `
    position: fixed;
    top: 12px;
    left: 12px;
    max-width: 400px;
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
  title.appendChild(pill);

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
      setTimeout(() => container.remove(), 5000);
      return;
    }

    container.append(title, body);
    document.body.appendChild(container);
    setTimeout(() => container.remove(), 5000);
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
  meterEl.dataset.prev = "0";
  meterEl.style.cssText = `
    position: relative;
    width: 46px;
    height: 82px;
    border-radius: 12px;
    background: #0b1623;
    border: 1px solid rgba(255, 255, 255, 0.12);
    overflow: hidden;
    --fill: 0%;
    --water: hsl(200 85% 52%);
    --waterLight: hsl(200 90% 70%);
  `;
  const meterWater = document.createElement("div");
  meterWater.style.cssText = `
    position: absolute;
    left: 0;
    bottom: 0;
    width: 100%;
    height: var(--fill);
    background: linear-gradient(180deg, var(--waterLight) 0%, var(--water) 60%, var(--water) 100%);
    transition: height 0.2s ease-out;
  `;
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

  resultCard.append(row, list);
  container.append(title, resultCard);
  document.body.appendChild(container);

  const normalized = payload && typeof payload === "object" ? payload : {};
  normalized.bullets = Array.isArray(normalized.bullets) ? normalized.bullets : [];
  updateAnalysisUI(normalized);

  setTimeout(() => container.remove(), 6000);

  function updateAnalysisUI(result) {
    const resultCardEl = document.getElementById("analysisResult");
    const scoreElInner = document.getElementById("riskScore");
    const labelElInner = document.getElementById("riskLabel");
    const ul = document.getElementById("riskBullets");
    const meter = document.getElementById("riskMeter");
    if (!resultCardEl || !scoreElInner || !labelElInner || !ul || !meter) return;

    resultCardEl.classList.remove("d-none");
    scoreElInner.textContent = `${result.score}`;
    labelElInner.textContent = `위험도: ${result.label}`;

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
