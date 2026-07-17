// Send to ProBuild - MV3 service worker.
//
// Right-click -> "Send selection/page to ProBuild" posts the text to the
// ProBuild clip inbox (/api/studio-library/clip). Auth rides on the user's
// existing ProBuild session cookie (host_permissions exempt extension fetches
// from SameSite blocking). 401/redirect -> open the login page.

const PROBUILD = "https://probuild.goldentouchremodeling.com";
const MAX_TEXT = 200000;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "send-selection",
    title: "Send selection to ProBuild",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "send-page",
    title: "Send page to ProBuild catalog",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    let text = info.selectionText || "";
    if (info.menuItemId === "send-page" || text.length < 40) {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.body ? document.body.innerText : "",
      });
      text = (result && result.result) || text;
    }
    text = (text || "").slice(0, MAX_TEXT);
    if (text.trim().length < 40) {
      notify("Nothing to send", "Select the product details on the page first.");
      return;
    }

    const res = await fetch(`${PROBUILD}/api/studio-library/clip`, {
      method: "POST",
      credentials: "include",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        sourceUrl: info.pageUrl || (tab && tab.url) || null,
        title: (tab && tab.title) || null,
      }),
    });

    if (res.status === 401 || res.redirected) {
      notify("Sign in to ProBuild", "Opening ProBuild so you can sign in, then try again.");
      chrome.tabs.create({ url: `${PROBUILD}/login` });
      return;
    }
    if (res.status === 403) {
      notify("No permission", "Your ProBuild account can't manage the catalog (admin/manager only).");
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      notify("ProBuild rejected the clip", body.error || `Error ${res.status}`);
      return;
    }
    notify("Sent to ProBuild", "Review it under Settings > Design Catalog.");
  } catch (e) {
    notify("Couldn't reach ProBuild", String(e && e.message ? e.message : e));
  }
});

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    title,
    message,
  });
}
