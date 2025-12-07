const scanButton = document.getElementById("scan");
const statusEl = document.getElementById("status");

scanButton.addEventListener("click", () => {
  statusEl.textContent = "Scanning...";
  scanButton.disabled = true;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;

    if (!tabId) {
      statusEl.textContent = "No active tab available.";
      scanButton.disabled = false;
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: "MANUAL_SCAN" }, () => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        statusEl.textContent = "Content script unavailable on this page.";
      } else {
        statusEl.textContent = "Scan requested. Overlay will show results.";
      }
      scanButton.disabled = false;
    });
  });
});
