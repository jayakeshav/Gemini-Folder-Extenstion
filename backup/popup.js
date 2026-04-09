(() => {
  // Browser popup for Gemini Folders extension export/import functionality

  const STORAGE_KEY = "geminiFolders";

  // DOM Elements
  const exportButton = document.getElementById("export-button");
  const importButton = document.getElementById("import-button");
  const importInput = document.getElementById("import-input");
  const statusEl = document.getElementById("status");

  // Utility: Set status message with optional styling
  function setStatus(message, kind = "") {
    statusEl.textContent = message;
    statusEl.classList.remove("error", "success");
    if (kind) {
      statusEl.classList.add(kind);
    }
  }

  // Utility: Hash string to ID (mirrors content script logic)
  function hashStringToId(value) {
    let hash = 2166136261;
    const input = String(value || "");

    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return `h${(hash >>> 0).toString(16)}`;
  }

  // Utility: Extract email-like values
  function extractEmailLikeValue(value) {
    const text = String(value || "").trim();
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ? text : "";
  }

  // Utility: Recursively search object for user identifier
  function searchWizGlobalData(node, seen = new Set(), depth = 0) {
    if (!node || depth > 5) {
      return "";
    }

    if (typeof node === "string") {
      return extractEmailLikeValue(node);
    }

    if (typeof node !== "object") {
      return "";
    }

    if (seen.has(node)) {
      return "";
    }

    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      const keyLower = key.toLowerCase();

      if (typeof value === "string") {
        const emailCandidate = extractEmailLikeValue(value);
        if (emailCandidate) {
          return emailCandidate.toLowerCase();
        }

        if ((keyLower.includes("email") || keyLower.includes("userid") || keyLower === "id") && value.trim()) {
          return value.trim();
        }
      }

      if (value && typeof value === "object") {
        const nested = searchWizGlobalData(value, seen, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }

    return "";
  }

  // Utility: Extract profile picture URL
  function getProfilePictureUrl() {
    const selectors = [
      'img[alt*="profile" i]',
      'img[aria-label*="profile" i]',
      'img[alt*="account" i]',
      'img[src*="googleusercontent" i]',
      'img[src*="gstatic" i]',
      'button[aria-label*="profile" i] img',
      'button[aria-label*="account" i] img',
      '[data-test-id*="profile" i] img',
      '[data-test-id*="account" i] img'
    ];

    for (const selector of selectors) {
      const image = document.querySelector(selector);
      const candidate = image?.currentSrc || image?.src || image?.getAttribute("src") || "";
      if (candidate) {
        return candidate;
      }
    }

    const avatarNodes = Array.from(document.querySelectorAll("button, a, div, span")).filter((node) => {
      const label = `${node.getAttribute("aria-label") || ""} ${node.title || ""}`.toLowerCase();
      return label.includes("profile") || label.includes("account");
    });

    for (const node of avatarNodes) {
      const style = node.getAttribute("style") || "";
      const match = style.match(/url\((['\"]?)(.*?)\1\)/i);
      if (match?.[2]) {
        return match[2];
      }
    }

    return "";
  }

  // Create user ID detection code as string for executeScript
  function createUserIdDetectionCode() {
    return `(() => {
      function hashStringToId(value) {
        let hash = 2166136261;
        const input = String(value || "");
        for (let index = 0; index < input.length; index += 1) {
          hash ^= input.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        return \`h\${(hash >>> 0).toString(16)}\`;
      }

      function extractEmailLikeValue(value) {
        const text = String(value || "").trim();
        return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ? text : "";
      }

      function searchWizGlobalData(node, seen = new Set(), depth = 0) {
        if (!node || depth > 5) return "";
        if (typeof node === "string") return extractEmailLikeValue(node);
        if (typeof node !== "object") return "";
        if (seen.has(node)) return "";
        seen.add(node);

        for (const [key, value] of Object.entries(node)) {
          const keyLower = key.toLowerCase();
          if (typeof value === "string") {
            const emailCandidate = extractEmailLikeValue(value);
            if (emailCandidate) return emailCandidate.toLowerCase();
            if ((keyLower.includes("email") || keyLower.includes("userid") || keyLower === "id") && value.trim()) {
              return value.trim();
            }
          }
          if (value && typeof value === "object") {
            const nested = searchWizGlobalData(value, seen, depth + 1);
            if (nested) return nested;
          }
        }
        return "";
      }

      function getProfilePictureUrl() {
        const selectors = ['img[alt*="profile" i]', 'img[aria-label*="profile" i]', 'img[alt*="account" i]',
          'img[src*="googleusercontent" i]', 'img[src*="gstatic" i]', 'button[aria-label*="profile" i] img',
          'button[aria-label*="account" i] img', '[data-test-id*="profile" i] img', '[data-test-id*="account" i] img'];
        for (const selector of selectors) {
          const image = document.querySelector(selector);
          const candidate = image?.currentSrc || image?.src || image?.getAttribute("src") || "";
          if (candidate) return candidate;
        }
        return "";
      }

      function getUserIdFromDom() {
        const selectors = ['button[aria-label*="profile" i]', 'button[aria-label*="account" i]',
          'button[aria-label*="settings" i]', '[data-test-id*="profile" i]', '[data-test-id*="account" i]',
          '[data-test-id*="settings" i]'];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          if (!node) continue;
          const candidate = [node.getAttribute("aria-label"), node.title, node.textContent]
            .map((item) => String(item || "").trim()).find(Boolean);
          const emailCandidate = extractEmailLikeValue(candidate);
          if (emailCandidate) return emailCandidate.toLowerCase();
          if (candidate && !/\\s/.test(candidate) && /^(?=.*[0-9]|.*[_@.-])[A-Za-z0-9._-]{8,}$/.test(candidate)) {
            return candidate;
          }
        }
        return "";
      }

      function getUserIdFromWizGlobalData() {
        try {
          const wizData = window.WIZ_global_data;
          return wizData ? searchWizGlobalData(wizData) : "";
        } catch {
          return "";
        }
      }

      function getUserIdFromProfilePicture() {
        const url = getProfilePictureUrl();
        return url ? \`profile_\${hashStringToId(url)}\` : "";
      }

      return getUserIdFromDom() || getUserIdFromWizGlobalData() || getUserIdFromProfilePicture() || "";
    })()`;
  }

  // Chrome API: Get currently active tab
  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve(tabs && tabs.length ? tabs[0] : null);
      });
    });
  }

  // Chrome API: Execute function in a tab's context
  function executeInTab(tabId, code) {
    return new Promise((resolve) => {
      chrome.scripting.executeScript({ target: { tabId }, func: () => eval(code) }, (results) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(results && results.length ? results[0].result : null);
      });
    });
  }

  // Get storage key for current user in active tab
  async function getCurrentStorageKey() {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
      return STORAGE_KEY;
    }

    const code = createUserIdDetectionCode();
    const userId = await executeInTab(activeTab.id, code);
    return userId ? `${STORAGE_KEY}_${encodeURIComponent(String(userId))}` : STORAGE_KEY;
  }

  // Export backup to JSON file
  async function exportBackup() {
    const storageKey = await getCurrentStorageKey();
    const result = await new Promise((resolve) => {
      chrome.storage.local.get(storageKey, resolve);
    });

    const payload = result[storageKey] || { folders: [], chatToFolderMap: {} };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "gemini_folders_backup.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setStatus("Export successful.", "success");
  }

  // Validate backup JSON structure
  function validateBackupData(data) {
    return Boolean(data) && 
           Array.isArray(data.folders) && 
           data.chatToFolderMap && 
           typeof data.chatToFolderMap === "object" && 
           !Array.isArray(data.chatToFolderMap);
  }

  // Refresh sidebar in active tab after import
  async function refreshActiveTabUi() {
    const activeTab = await getActiveTab();
    if (!activeTab?.id) {
      return;
    }

    await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, { action: "refreshUI" }, () => {
        resolve();
      });
    });
  }

  // Import backup from JSON file
  async function importBackupFile(file) {
    const contents = await file.text();
    let data;

    try {
      data = JSON.parse(contents);
    } catch {
      throw new Error("Invalid JSON file.");
    }

    if (!validateBackupData(data)) {
      throw new Error("Backup must include folders (array) and chatToFolderMap (object).");
    }

    const storageKey = await getCurrentStorageKey();
    await new Promise((resolve) => {
      chrome.storage.local.set({ [storageKey]: data }, resolve);
    });

    await refreshActiveTabUi();
    setStatus("Import complete.", "success");
  }

  // Event listeners
  exportButton.addEventListener("click", async () => {
    try {
      setStatus("Exporting...");
      await exportBackup();
    } catch (error) {
      setStatus(error?.message || "Export failed.", "error");
    }
  });

  importButton.addEventListener("click", () => {
    importInput.value = "";
    importInput.click();
  });

  importInput.addEventListener("change", async () => {
    const file = importInput.files && importInput.files[0];
    if (!file) {
      return;
    }

    try {
      setStatus("Importing...");
      await importBackupFile(file);
    } catch (error) {
      setStatus(error?.message || "Import failed.", "error");
    }
  });

  // Initialize
  setStatus("Ready.");
})();
