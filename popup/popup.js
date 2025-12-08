const NEWS_REEL_URL = "https://gaeinjjeongbo.netlify.app/news-only"; // replace with your real news reel URL

const scanButton = document.getElementById("scan");
const statusEl = document.getElementById("status");
const tabButtons = Array.from(document.querySelectorAll("[data-target]"));
const panels = Array.from(document.querySelectorAll(".tab-panel"));
const newsFrame = document.getElementById("newsFrame");
const prePromptToggle = document.getElementById("prePromptToggle");
const clearCacheButton = document.getElementById("clearCache");
const cacheStatus = document.getElementById("cacheStatus");
const inlineResultEl = document.getElementById("inlineResult");
const PREF_KEY = "preAnalysisPromptEnabled";
let triedAutoCache = false;

if (newsFrame) {
  newsFrame.dataset.src = NEWS_REEL_URL;
}

if (prePromptToggle) {
  chrome.storage.local.get({ [PREF_KEY]: false }, (res) => {
    prePromptToggle.checked = Boolean(res[PREF_KEY]);
  });

  prePromptToggle.addEventListener("change", () => {
    chrome.storage.local.set({ [PREF_KEY]: prePromptToggle.checked });
  });
}

if (clearCacheButton && cacheStatus) {
  clearCacheButton.addEventListener("click", () => {
    cacheStatus.textContent = "Clearing cache...";
    chrome.storage.local.clear(() => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        cacheStatus.textContent = "Failed to clear cache.";
        return;
      }
      prePromptToggle.checked = false;
      chrome.storage.local.set({ [PREF_KEY]: false }, () => {
        cacheStatus.textContent = "Cache cleared.";
        setTimeout(() => {
          cacheStatus.textContent = "";
        }, 2000);
      });
    });
  });
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    if (targetId) activateTab(targetId);
  });
});

// Extension popup UI starts on the Score tab
activateTab("panel-score");
showCachedIfAvailable();

scanButton.addEventListener("click", async () => {
  if (inlineResultEl) inlineResultEl.innerHTML = "";
  statusEl.textContent = "Scanning...";
  scanButton.disabled = true;

  const active = await getActivePageTab();

  if (!active?.id) {
    statusEl.textContent = "No active tab available.";
    scanButton.disabled = false;
    return;
  }

  if (isBlockedScheme(active.url)) {
    statusEl.textContent = "Cannot run on this page (restricted by the browser).";
    scanButton.disabled = false;
    return;
  }

  const { text, error } = await fetchConsentText(active.id, active.url);
  if (error === "no_content") {
    statusEl.textContent = "Content script unavailable on this page.";
    scanButton.disabled = false;
    return;
  }

  if (!text) {
    statusEl.textContent = "No 개인정보 text found on this page.";
    scanButton.disabled = false;
    return;
  }

  chrome.runtime.sendMessage({ type: "GET_CACHED_RESULT", text }, (cacheRes) => {
    const lastErr = chrome.runtime.lastError;
    const cached = cacheRes?.result;
    if (!lastErr && cached) {
      statusEl.textContent = "Cached result shown below.";
      renderInlineResult(cached, true);
      hideScanButton();
      scanButton.disabled = false;
      return;
    }

    chrome.runtime.sendMessage(
      { type: "ANALYZE_TEXT_DIRECT", text, tabId: active.id },
      (analysisRes) => {
        const err = chrome.runtime.lastError || analysisRes?.error;
        if (err) {
          statusEl.textContent = "Analysis failed. Try again.";
          scanButton.disabled = false;
          return;
        }

        const result = analysisRes?.result;
        if (result) {
          statusEl.textContent = "Result ready below.";
          renderInlineResult(result, analysisRes.source === "cache");
          hideScanButton();
        } else {
          statusEl.textContent = "No result returned.";
        }
        scanButton.disabled = false;
      }
    );
  });
});

async function showCachedIfAvailable() {
  if (triedAutoCache) return;
  triedAutoCache = true;

  const active = await getActivePageTab();
  if (!active?.id || isBlockedScheme(active.url)) return;

  const { text } = await fetchConsentText(active.id, active.url);
  if (!text) return;

  chrome.runtime.sendMessage({ type: "GET_CACHED_RESULT", text }, (cacheRes) => {
    const lastErr = chrome.runtime.lastError;
    const cached = cacheRes?.result;
    if (!lastErr && cached) {
      statusEl.textContent = "Cached result shown below.";
      renderInlineResult(cached, true);
      hideScanButton();
    }
  });
}

function activateTab(targetId) {
  tabButtons.forEach((btn) => {
    const isActive = btn.dataset.target === targetId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
    btn.tabIndex = isActive ? "0" : "-1";
  });

  panels.forEach((panel) => {
    const isActive = panel.id === targetId;
    panel.classList.toggle("active", isActive);
    panel.hidden = !isActive;
  });

  if (targetId === "panel-news") {
    ensureNewsFrame();
  }
}

function ensureNewsFrame() {
  if (!newsFrame || newsFrame.dataset.loaded === "true") return;

  const src = newsFrame.dataset.src || NEWS_REEL_URL;
  if (src) {
    newsFrame.src = src;
    newsFrame.dataset.loaded = "true";
  }
}

function getActivePageTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" }, (tabs) => {
      if (tabs && tabs[0]) {
        resolve({ id: tabs[0].id, url: tabs[0].url || "" });
        return;
      }
      chrome.tabs.query({ active: true, windowType: "normal" }, (fallbackTabs) => {
        if (fallbackTabs && fallbackTabs[0]) {
          resolve({ id: fallbackTabs[0].id, url: fallbackTabs[0].url || "" });
        } else {
          resolve(null);
        }
      });
    });
  });
}

function isBlockedScheme(url) {
  if (!url) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("view-source:")
  );
}

function fetchConsentText(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_CONSENT_TEXT" }, (res) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        ensureContentScript(tabId, url)
          .then((ok) => {
            if (!ok) {
              resolve({ error: "no_content" });
              return;
            }
            chrome.tabs.sendMessage(tabId, { type: "GET_CONSENT_TEXT" }, (res2) => {
              const err2 = chrome.runtime.lastError;
              if (err2) {
                resolve({ error: "no_content" });
                return;
              }
              resolve({ text: res2?.text });
            });
          })
          .catch(() => resolve({ error: "no_content" }));
      } else {
        resolve({ text: res?.text });
      }
    });
  });
}

function ensureContentScript(tabId, url) {
  return new Promise((resolve) => {
    if (isBlockedScheme(url)) {
      resolve(false);
      return;
    }
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          window.__privacy_manual_injection = true;
        }
      },
      () => {
        chrome.scripting.executeScript(
          {
            target: { tabId },
            files: ["content.js"]
          },
          () => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve(false);
            } else {
              resolve(true);
            }
          }
        );
      }
    );
  });
}

function renderInlineResult(result, fromCache) {
  if (!inlineResultEl) return;
  inlineResultEl.innerHTML = "";

  const card = document.createElement("div");
  card.className = "inline-card";

  const header = document.createElement("div");
  header.className = "inline-header";

  const title = document.createElement("div");
  title.className = "inline-title";
  title.textContent = "분석 결과";

  const pill = document.createElement("span");
  pill.className = "inline-pill";
  pill.textContent = fromCache ? "캐시" : "실시간";
  if (!fromCache) {
    pill.style.background = "rgba(52, 211, 153, 0.14)";
    pill.style.color = "#34d399";
  }

  header.append(title, pill);

  const row = document.createElement("div");
  row.className = "inline-row";

  const meter = document.createElement("div");
  meter.className = "inline-meter";
  const fill = document.createElement("div");
  fill.className = "inline-meter-fill";
  meter.appendChild(fill);

  const scoreWrap = document.createElement("div");
  const scoreEl = document.createElement("div");
  scoreEl.className = "inline-score";
  scoreEl.textContent = Math.round(result.score ?? 0);

  const labelEl = document.createElement("div");
  labelEl.className = "inline-label";
  labelEl.textContent = `위험도: ${result.label || "-"}`;

  scoreWrap.append(scoreEl, labelEl);
  row.append(meter, scoreWrap);

  const list = document.createElement("ul");
  list.className = "inline-list";
  (result.bullets || []).forEach((b) => {
    const li = document.createElement("li");
    li.textContent = b;
    list.appendChild(li);
  });

  card.append(header, row, list);
  inlineResultEl.appendChild(card);

  const target = Math.max(0, Math.min(100, Number(result.score) || 0));
  fill.style.height = `${target}%`;
}

function hideScanButton() {
  if (scanButton) {
    scanButton.style.display = "none";
  }
}
