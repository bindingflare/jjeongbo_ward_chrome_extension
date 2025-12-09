const NEWS_REEL_URL = "https://gaeinjjeongbo.netlify.app/news-only"; // free version news
const NEWS_REEL_URL_FULL = "https://gaeinjjeongbo.netlify.app/news-only-full"; // premium version news
const NEWS_JSON_URL = "https://gaeinjjeongbo.netlify.app/news-only.json";
const NEWS_JSON_URL_FULL = "https://gaeinjjeongbo.netlify.app/news-only-full.json";
const NEWS_BASE_URL = "https://gaeinjjeongbo.netlify.app/";

const scanButton = document.getElementById("scan");
const statusEl = document.getElementById("status");
const tabButtons = Array.from(document.querySelectorAll("[data-target]"));
const panels = Array.from(document.querySelectorAll(".tab-panel"));
const newsFrame = document.getElementById("newsFrame");
const newsLinks = document.getElementById("newsLinks");
const newsLinkPrimary = document.getElementById("newsLinkPrimary");
const newsHintFull = document.getElementById("newsHintFull");
const newsHintFree = document.getElementById("newsHintFree");
const newsBadge = document.getElementById("newsBadge");
const newsListEl = document.getElementById("newsList");
const newsModePill = document.getElementById("newsModePill");
const newsSubtitle = document.getElementById("newsSubtitle");
const prePromptToggle = document.getElementById("prePromptToggle");
const freeModeToggle = document.getElementById("freeModeToggle");
const clearCacheButton = document.getElementById("clearCache");
const cacheStatus = document.getElementById("cacheStatus");
const inlineResultEl = document.getElementById("inlineResult");
const PREF_KEY = "preAnalysisPromptEnabled";
const FREE_MODE_KEY = "freeVersionEnabled";
const NEWS_READ_FREE = "newsReadFree";
const NEWS_READ_FULL = "newsReadFull";
const settingsButton = document.getElementById("settingsButton");
const settingsPanel = document.getElementById("settingsPanel");
let triedAutoCache = false;
let freeModeEnabled = false;
const prefsReady = new Promise((resolve) => {
  chrome.storage.local.get({ [PREF_KEY]: false, [FREE_MODE_KEY]: false }, (res) => {
    if (prePromptToggle) {
      prePromptToggle.checked = Boolean(res[PREF_KEY]);
    }
    freeModeEnabled = Boolean(res[FREE_MODE_KEY]);
    if (freeModeToggle) {
      freeModeToggle.checked = freeModeEnabled;
    }
    renderNewsView();
    resolve();
  });
});

if (prePromptToggle) {
  prePromptToggle.addEventListener("change", () => {
    chrome.storage.local.set({ [PREF_KEY]: prePromptToggle.checked });
  });
}

if (freeModeToggle) {
  freeModeToggle.addEventListener("change", () => {
    freeModeEnabled = freeModeToggle.checked;
    chrome.storage.local.set({ [FREE_MODE_KEY]: freeModeEnabled }, () => {
      renderNewsView();
      if (inlineResultEl) {
        inlineResultEl.innerHTML = "";
      }
      renderPlaceholderResult();
      if (statusEl) {
        statusEl.textContent = "";
      }
      updateNewsBadge();
    });
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
      if (prePromptToggle) {
        prePromptToggle.checked = false;
      }
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

  if (settingsButton && settingsPanel) {
    settingsButton.addEventListener("click", () => {
      const isOpen = settingsPanel.hidden === false;
      if (isOpen) {
        closeSettingsPanel();
      } else {
        openSettingsPanel();
      }
    });

    document.addEventListener("click", (e) => {
      if (!settingsPanel || !settingsButton) return;
      if (settingsPanel.hidden) return;
      if (settingsPanel.contains(e.target) || settingsButton.contains(e.target)) return;
      closeSettingsPanel();
    });
  }

  // Extension popup UI starts on the Score tab
  activateTab("panel-score");
  showCachedIfAvailable();
  updateNewsBadge();
  renderPlaceholderResult();

  scanButton.addEventListener("click", async () => {
    await prefsReady;
    renderPlaceholderResult("분석을 시작합니다…");
  statusEl.textContent = "Scanning...";
  scanButton.disabled = true;
  const summaryMode = freeModeEnabled;

  const active = await getActivePageTab();

  if (!active?.id) {
    statusEl.textContent = "No active tab available.";
    scanButton.disabled = false;
    return;
  }

    if (isBlockedScheme(active.url)) {
      statusEl.textContent = "Cannot run on this page (restricted by the browser).";
      renderPlaceholderResult();
      scanButton.disabled = false;
      return;
    }

  const { text, error, fromFallback } = await fetchConsentText(active.id, active.url);
    if (error === "no_content") {
      statusEl.textContent = "Content script unavailable on this page.";
      renderPlaceholderResult();
      scanButton.disabled = false;
      return;
    }

    if (!text) {
      statusEl.textContent = "No 개인정보 text found on this page.";
      renderPlaceholderResult();
      scanButton.disabled = false;
      return;
    }

  if (fromFallback) {
    statusEl.textContent = "Detector failed — analyzing full page text.";
  }

  chrome.runtime.sendMessage({ type: "GET_CACHED_RESULT", text, useSummary: summaryMode }, (cacheRes) => {
    const lastErr = chrome.runtime.lastError;
    const cached = cacheRes?.result;
      if (!lastErr && cached) {
        statusEl.textContent = "Cached result shown!";
        renderInlineResult(cached, true);
        hideScanButton();
        scanButton.disabled = false;
      return;
    }

    chrome.runtime.sendMessage(
      { type: "ANALYZE_TEXT_DIRECT", text, tabId: active.id, useSummary: summaryMode },
      (analysisRes) => {
        const err = chrome.runtime.lastError || analysisRes?.error;
        if (err) {
          statusEl.textContent = "Analysis failed. Try again.";
          renderPlaceholderResult();
          scanButton.disabled = false;
          return;
        }

        const result = analysisRes?.result;
        if (result) {
          statusEl.textContent = "Result ready!";
          renderInlineResult(result, analysisRes.source === "cache");
          hideScanButton();
        } else {
          statusEl.textContent = "No result returned.";
          renderPlaceholderResult();
        }
        scanButton.disabled = false;
      }
    );
  });
});

async function showCachedIfAvailable() {
  if (triedAutoCache) return;
  triedAutoCache = true;

  await prefsReady;
  const summaryMode = freeModeEnabled;

  const active = await getActivePageTab();
  if (!active?.id || isBlockedScheme(active.url)) return;

  const { text } = await fetchConsentText(active.id, active.url);
  if (!text) return;

  chrome.runtime.sendMessage({ type: "GET_CACHED_RESULT", text, useSummary: summaryMode }, (cacheRes) => {
    const lastErr = chrome.runtime.lastError;
    const cached = cacheRes?.result;
    if (!lastErr && cached) {
      statusEl.textContent = "Cached result shown!";
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
    prefsReady.then(() => {
      renderNewsView();
      renderNewsList();
    });
  }
}

function renderNewsView() {
  const panelNews = document.getElementById("panel-news");
  const active = panelNews?.classList.contains("active");

  if (newsModePill) {
    newsModePill.textContent = freeModeEnabled ? "FREE" : "PRO";
    newsModePill.style.background = freeModeEnabled ? "rgba(52, 211, 153, 0.16)" : "rgba(88, 166, 255, 0.16)";
    newsModePill.style.color = freeModeEnabled ? "#0d704f" : "#0b5cab";
  }

  if (newsSubtitle) {
    newsSubtitle.textContent = "최신 소식을 불러오는 중입니다…";
  }

  if (active) {
    renderNewsList();
  }
}

function getNewsJsonUrl() {
  return freeModeEnabled ? NEWS_JSON_URL : NEWS_JSON_URL_FULL;
}

async function renderNewsList() {
  if (!newsListEl) return;
  newsListEl.innerHTML = `<div class="news-placeholder">뉴스를 불러오는 중입니다…</div>`;

  const feed = await fetchNewsFeed(getNewsJsonUrl());
  if (!feed || !Array.isArray(feed.items)) {
    newsListEl.innerHTML = `<div class="news-placeholder">뉴스를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</div>`;
    if (newsSubtitle) newsSubtitle.textContent = "불러오기 실패";
    return;
  }

  const items = feed.items;
  const readIds = await loadReadSet();
  const unreadCount = items.filter((it) => it?.id && !readIds.has(it.id)).length;
  if (newsSubtitle) {
    newsSubtitle.textContent =
      unreadCount > 0 ? `${items.length}개의 기사 · ${unreadCount}개 새 글` : `${items.length}개의 기사`;
  }
  if (newsModePill) {
    newsModePill.textContent = freeModeEnabled ? "FREE" : "PRO";
  }

  newsListEl.innerHTML = "";

  if (!items.length) {
    newsListEl.innerHTML = `<div class="news-placeholder">표시할 뉴스가 없습니다.</div>`;
    return;
  }

  items.forEach((item) => {
    const id = item.id || item.url || item.title || "";
    const isRead = id ? readIds.has(id) : false;
    const card = document.createElement("article");
    card.className = "news-card" + (isRead ? " news-card--read" : "");
    card.tabIndex = 0;

    const thumb = document.createElement("div");
    thumb.className = "news-thumb-inline";

    if (item.image) {
      const imgWrap = document.createElement("div");
      imgWrap.className = "news-image-wrap";
      const img = document.createElement("img");
      img.src = resolveNewsUrl(item.image);
      img.alt = item.title || "news image";
      img.className = "news-image";
      imgWrap.appendChild(img);

      const badgeStack = document.createElement("div");
      badgeStack.className = "news-badge-stack";
      if (item.category) {
        const cat = document.createElement("span");
        cat.className = "news-category";
        cat.textContent = item.category;
        badgeStack.appendChild(cat);
      }

      const isPremium = Boolean(item.premium) || (Array.isArray(item.badges) && item.badges.includes("PRO"));
      if (isPremium) {
        const pro = document.createElement("span");
        pro.className = "news-category news-category-pro";
        pro.textContent = "PRO";
        badgeStack.appendChild(pro);
      }

      if (item.featured || (feed.featuredId && feed.featuredId === item.id)) {
        const feat = document.createElement("span");
        feat.className = "news-category news-category-featured";
        feat.textContent = "추천";
        badgeStack.appendChild(feat);
      }

      imgWrap.appendChild(badgeStack);
      thumb.appendChild(imgWrap);
    }

    const body = document.createElement("div");
    body.className = "news-body";

    const title = document.createElement("h5");
    title.className = "news-title-inline";
    title.textContent = item.title || "(제목 없음)";
    body.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "news-meta";
    if (item.displayDate || item.date) {
      const date = document.createElement("span");
      date.textContent = item.displayDate || item.date;
      meta.appendChild(date);
    }
    body.appendChild(meta);

    const tags = document.createElement("div");
    tags.className = "news-tags";
    const isPremiumFlag = Boolean(item.premium) || (Array.isArray(item.badges) && item.badges.includes("PRO"));
    if (Array.isArray(item.badges)) {
      item.badges.forEach((b) => {
        if (b === "PRO" && isPremiumFlag) return; // avoid duplicate premium badge
        const t = document.createElement("span");
        t.className = "news-tag";
        t.textContent = b;
        tags.appendChild(t);
      });
    }
    if (item.category && !item.image) {
      const cat = document.createElement("span");
      cat.className = "news-tag";
      cat.textContent = item.category;
      tags.appendChild(cat);
    }
    if (isPremiumFlag) {
      const p = document.createElement("span");
      p.className = "news-tag news-tag--premium";
      p.textContent = "PRO";
      tags.appendChild(p);
    }
    if (item.featured || (feed.featuredId && feed.featuredId === item.id)) {
      const feat = document.createElement("span");
      feat.className = "news-tag news-tag--featured";
      feat.textContent = "추천";
      tags.appendChild(feat);
    }

    body.appendChild(tags);
    thumb.appendChild(body);
    card.appendChild(thumb);

    card.addEventListener("click", () => {
      openNewsItem(item, readIds);
    });
    card.addEventListener("keypress", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openNewsItem(item, readIds);
      }
    });

    newsListEl.appendChild(card);
  });
}

  async function updateNewsBadge() {
    await prefsReady;
    const feed = await fetchNewsFeed(getNewsJsonUrl());
    if (!feed || !Array.isArray(feed.items)) {
      hideBadge();
      return;
    }
    const items = feed.items;
    const readIds = await loadReadSet();
    const unread = items.filter((item) => item?.id && !readIds.has(item.id)).length;
    setBadge(unread);
  }

  function getReadKey() {
    return freeModeEnabled ? NEWS_READ_FREE : NEWS_READ_FULL;
  }

  function resolveNewsUrl(path) {
    try {
      return new URL(path || "", NEWS_BASE_URL).toString();
    } catch (err) {
      return path || "";
    }
  }

  async function loadReadSet() {
    const key = getReadKey();
    return new Promise((resolve) => {
      chrome.storage.local.get({ [key]: [] }, (res) => {
        const arr = Array.isArray(res[key]) ? res[key] : [];
        resolve(new Set(arr.filter(Boolean)));
      });
    });
  }

  async function saveReadSet(set) {
    const key = getReadKey();
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: Array.from(set) }, resolve);
    });
  }

  async function openNewsItem(item, readIds) {
    const targetUrl = resolveNewsUrl(item?.url || "");
    if (targetUrl) {
      chrome.tabs.create({ url: targetUrl });
    }
    const id = item?.id || item?.url || item?.title;
    if (id && readIds) {
      readIds.add(id);
      await saveReadSet(readIds);
      await updateNewsBadge();
      renderNewsList();
    }
  }

async function fetchNewsFeed(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch (err) {
    return null;
  }
}

function setBadge(count) {
  if (!newsBadge) return;
  if (!count || count < 0) {
    hideBadge();
    return;
  }
  newsBadge.textContent = String(count);
  newsBadge.hidden = count === 0;
}

  function hideBadge() {
    if (newsBadge) {
      newsBadge.hidden = true;
    }
  }

  function renderPlaceholderResult(message) {
    if (!inlineResultEl) return;
    inlineResultEl.innerHTML = "";

    const card = document.createElement("div");
    card.className = "inline-card inline-card--placeholder";

    const header = document.createElement("div");
    header.className = "inline-header";

    const title = document.createElement("div");
    title.className = "inline-title";
    title.textContent = "분석 결과";

    const pill = document.createElement("span");
    pill.className = "inline-pill";
    pill.textContent = "대기 중";
    pill.style.background = "rgba(88, 166, 255, 0.14)";
    pill.style.color = "#0b5cab";

    header.append(title, pill);

    const row = document.createElement("div");
    row.className = "inline-row";

    const meter = document.createElement("div");
    meter.className = "inline-meter";
    const fill = document.createElement("div");
    fill.className = "inline-meter-fill placeholder-fill";
    meter.appendChild(fill);

    const scoreWrap = document.createElement("div");
    const scoreEl = document.createElement("div");
    scoreEl.className = "inline-score placeholder-text";
    scoreEl.textContent = "??";

    const labelEl = document.createElement("div");
    labelEl.className = "inline-label placeholder-text";
    labelEl.textContent = "위험도: -";

    scoreWrap.append(scoreEl, labelEl);
    row.append(meter, scoreWrap);

    const list = document.createElement("ul");
    list.className = "inline-list";
    ["요약", "세부정보"].forEach((txt) => {
      const li = document.createElement("li");
      li.className = "placeholder-line";
      li.textContent = `${txt} 준비 중`;
      list.appendChild(li);
    });

    if (message) {
      const msg = document.createElement("div");
      msg.className = "inline-placeholder-message";
      msg.textContent = message;
      card.append(header, row, list, msg);
    } else {
      card.append(header, row, list);
    }

    inlineResultEl.appendChild(card);
  }

  function openSettingsPanel() {
    if (!settingsPanel || !settingsButton) return;
    settingsPanel.hidden = false;
    settingsButton.setAttribute("aria-expanded", "true");
  }

  function closeSettingsPanel() {
    if (!settingsPanel || !settingsButton) return;
    settingsPanel.hidden = true;
    settingsButton.setAttribute("aria-expanded", "false");
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
    const tryFallback = () => {
      fallbackGetPageText(tabId).then((fallbackText) => {
        if (fallbackText) {
          resolve({ text: fallbackText, fromFallback: true });
        } else {
          resolve({ error: "no_content" });
        }
      });
    };

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
                tryFallback();
                return;
              }
              if (res2?.text) {
                resolve({ text: res2.text });
              } else {
                tryFallback();
              }
            });
          })
          .catch(() => tryFallback());
      } else {
        if (res?.text) {
          resolve({ text: res.text });
        } else {
          tryFallback();
        }
      }
    });
  });
}

function fallbackGetPageText(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          try {
            const raw = document.body ? document.body.innerText || document.body.textContent || "" : "";
            // Limit size to avoid oversized payloads
            return raw.slice(0, 15000);
          } catch (e) {
            return "";
          }
        }
      },
      (results) => {
        const lastError = chrome.runtime.lastError;
        if (lastError || !Array.isArray(results) || !results[0]) {
          resolve("");
          return;
        }
        resolve(typeof results[0].result === "string" ? results[0].result.trim() : "");
      }
    );
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

  const safeResult = result || {};
  let summaryText = typeof safeResult.summary === "string" ? safeResult.summary : "";
  const fullLink = typeof safeResult.fullLink === "string" ? safeResult.fullLink : "";
  const isFreeMode = safeResult.mode === "free";
  const bulletList = Array.isArray(safeResult.bullets) ? safeResult.bullets : [];
  if (!safeResult.meta || typeof safeResult.meta !== "object") {
    safeResult.meta = {};
  }

  const card = document.createElement("div");
  card.className = "inline-card";

  const header = document.createElement("div");
  header.className = "inline-header";

  const title = document.createElement("div");
  title.className = "inline-title";
  title.textContent = "분석 결과";

  const modePill = document.createElement("span");
  modePill.className = "inline-pill inline-pill-mode";
  modePill.textContent = isFreeMode ? "무료" : "전체";
  if (isFreeMode) {
    modePill.style.background = "rgba(15, 23, 42, 0.08)";
    modePill.style.color = "#111827";
  } else {
    modePill.style.background = "rgba(88, 166, 255, 0.14)";
    modePill.style.color = "#0b5cab";
  }

  const pill = document.createElement("span");
  pill.className = "inline-pill";
  pill.textContent = fromCache ? "캐시" : "실시간";
  if (!fromCache) {
    pill.style.background = "rgba(52, 211, 153, 0.14)";
    pill.style.color = "#34d399";
  }

  header.append(title, modePill, pill);

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
  scoreEl.textContent = Math.round(safeResult.score ?? 0);

  const labelEl = document.createElement("div");
  labelEl.className = "inline-label";
  labelEl.textContent = `위험도: ${safeResult.label || "-"}`;

  scoreWrap.append(scoreEl, labelEl);
  row.append(meter, scoreWrap);

  const list = document.createElement("ul");
  list.className = "inline-list";
  bulletList.forEach((b) => {
    const li = document.createElement("li");
    li.textContent = b;
    list.appendChild(li);
  });

  card.append(header, row, list);

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
    const summaryEl = document.createElement("div");
    summaryEl.className = "inline-summary";
    summaryEl.textContent = summaryText;
    card.appendChild(summaryEl);
  }

  if (isFreeMode && fullLink) {
    const link = document.createElement("a");
    link.className = "inline-link";
    link.href = fullLink;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "전체 결과 보기";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "OPEN_FULL_RESULT", url: fullLink, payload: safeResult });
    });
  card.appendChild(link);
  }

  inlineResultEl.appendChild(card);

  const target = Math.max(0, Math.min(100, Number(safeResult.score) || 0));

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

  if (meter) {
    if (meter.__rafId) cancelAnimationFrame(meter.__rafId);
    let from = parseFloat(meter.dataset.prev);
    if (Number.isNaN(from)) from = target;

    let start;
    const duration = 1000;
    const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic

    function step(ts) {
      if (start == null) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const e = ease(p);
      const cur = from + (target - from) * e;
      const hue = scoreToHue(cur);
      const water = `hsl(${hue} 85% 52%)`;
      const waterLight = `hsl(${hue} 90% 70%)`;
      fill.style.background = `linear-gradient(to top, ${water} 0%, ${waterLight} 100%)`;
      fill.style.height = `${cur}%`;
      scoreEl.textContent = String(Math.round(cur));
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
  } else {
    fill.style.height = `${target}%`;
  }
}

function hideScanButton() {
  if (scanButton) {
    scanButton.style.display = "none";
  }
}
