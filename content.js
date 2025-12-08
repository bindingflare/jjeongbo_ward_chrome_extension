const KEYWORDS = [
  "개인정보 수집",
  "개인정보 활용",
  "개인정보 동의",
  "민감정보",
  "제3자 제공"
];

const skipAuto = Boolean(window.__privacy_manual_injection);
let autoSent = false;

function extractConsentText() {
  const bodyText = document.body?.innerText || "";
  if (!bodyText.trim()) return null;

  const hasMatch = KEYWORDS.some((keyword) => bodyText.includes(keyword));
  if (!hasMatch) return null;

  // Limit length to avoid oversized payloads
  return bodyText.trim().slice(0, 15000);
}

function sendConsent(trigger) {
  const text = extractConsentText();
  if (!text) return;
  if (trigger === "auto" && autoSent) return;

  autoSent = true;
  chrome.runtime.sendMessage({
    type: "FOUND_CONSENT",
    text
  });
}

// Auto run once on page load (unless injected manually for popup scan)
if (!skipAuto) {
  sendConsent("auto");
}

// Allow manual re-scan and text retrieval from the popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "MANUAL_SCAN") {
    sendConsent("manual");
    return;
  }

  if (msg?.type === "GET_CONSENT_TEXT") {
    const text = extractConsentText();
    sendResponse({ text });
    return true;
  }

  return undefined;
});
