const KEYWORDS = [
  "개인정보 수집",
  "개인정보 활용",
  "개인정보 동의",
  "민감정보",
  "제3자 제공"
];

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

// Auto run once on page load
sendConsent("auto");

// Allow manual re-scan from the popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MANUAL_SCAN") {
    sendConsent("manual");
  }
});
