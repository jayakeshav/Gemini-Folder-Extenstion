(() => {
  // Utility functions for the Gemini Folders extension

  window.GeminiFolders = window.GeminiFolders || {};
  const GF = window.GeminiFolders;

  GF.isExtensionContextInvalidated = function(error) {
    const message = String(error && error.message ? error.message : error || "");
    return message.includes("Extension context invalidated");
  };

  GF.hasRuntimeContext = function() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
    } catch {
      return false;
    }
  };

  GF.fireAndForget = function(promise, scope) {
    promise.catch((error) => {
      if (GF.isExtensionContextInvalidated(error)) {
        if (GF.shutdownOnContextInvalidation) {
          GF.shutdownOnContextInvalidation();
        }
        return;
      }

      if (!GF.isExtensionContextInvalidated(error)) {
        console.warn(`Gemini Folders: ${scope}`, error);
      }
    });
  };

  GF.hashStringToId = function(value) {
    let hash = 2166136261;
    const input = String(value || "");

    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return `h${(hash >>> 0).toString(16)}`;
  };

  GF.getProfilePictureUrl = function() {
    const selectors = [
      'img[alt*="profile" i]',
      'img[aria-label*="profile" i]',
      'img[alt*="account" i]',
      'button[aria-label*="profile" i] img',
      'button[aria-label*="account" i] img',
      'a[aria-label*="profile" i] img',
      'a[aria-label*="account" i] img',
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
  };

  GF.isSignInPromptVisible = function() {
    const nodes = Array.from(document.querySelectorAll("a, button"));

    return nodes.some((node) => {
      const text = String(node.textContent || "").trim();
      const label = String(node.getAttribute("aria-label") || "").trim();
      const title = String(node.getAttribute("title") || "").trim();
      const href = String(node.getAttribute("href") || "").trim();

      const hasSignInText = /\bsign\s*in\b/i.test(text) || /\bsign\s*in\b/i.test(label) || /\bsign\s*in\b/i.test(title);
      if (!hasSignInText) {
        return false;
      }

      // Prefer likely auth/navigation CTAs over unrelated text nodes.
      return !href || /signin|accounts\.google\.com|login/i.test(href);
    });
  };

  GF.extractEmailLikeValue = function(value) {
    const text = String(value || "").trim();
    return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ? text : "";
  };

  GF.searchWizGlobalData = function(node, seen = new Set(), depth = 0) {
    if (!node || depth > 5) {
      return "";
    }

    if (typeof node === "string") {
      return GF.extractEmailLikeValue(node);
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
        const emailCandidate = GF.extractEmailLikeValue(value);
        if (emailCandidate) {
          return emailCandidate.toLowerCase();
        }

        if ((keyLower.includes("email") || keyLower.includes("userid") || keyLower === "id") && value.trim()) {
          return value.trim();
        }
      }

      if (value && typeof value === "object") {
        const nested = GF.searchWizGlobalData(value, seen, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }

    return "";
  };

  GF.getUserIdFromWizGlobalData = function() {
    try {
      const wizData = window.WIZ_global_data;
      if (!wizData) {
        return "";
      }

      return GF.searchWizGlobalData(wizData);
    } catch {
      return "";
    }
  };

  GF.getUserIdFromDom = function() {
    const selectors = [
      'button[aria-label*="profile" i]',
      'button[aria-label*="account" i]',
      'button[aria-label*="settings" i]',
      '[data-test-id*="profile" i]',
      '[data-test-id*="account" i]',
      '[data-test-id*="settings" i]'
    ];

    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node) {
        continue;
      }

      const candidate = [node.getAttribute("aria-label"), node.title, node.textContent]
        .map((item) => String(item || "").trim())
        .find(Boolean);

      const emailCandidate = GF.extractEmailLikeValue(candidate);
      if (emailCandidate) {
        return emailCandidate.toLowerCase();
      }

      if (candidate && !/\s/.test(candidate) && /^(?=.*[0-9]|.*[_@.-])[A-Za-z0-9._-]{8,}$/.test(candidate)) {
        return candidate;
      }
    }

    return "";
  };

  GF.getUserIdFromProfilePicture = function() {
    const profilePictureUrl = GF.getProfilePictureUrl();
    if (!profilePictureUrl) {
      return "";
    }

    return `profile_${GF.hashStringToId(profilePictureUrl)}`;
  };

  GF.getUserId = function() {
    const domUserId = GF.getUserIdFromDom();
    if (domUserId) {
      return domUserId;
    }

    if (GF.isSignInPromptVisible()) {
      return null;
    }

    const wizUserId = GF.getUserIdFromWizGlobalData();
    if (typeof wizUserId === "string") {
      const normalized = wizUserId.trim();
      const invalidWizValue = !normalized || normalized === "[object Object]" || /^undefined|null$/i.test(normalized);
      const looksLikeEmail = Boolean(GF.extractEmailLikeValue(normalized));
      const looksLikeAccountHandle = /@/.test(normalized) || /^profile_/i.test(normalized);
      if (!invalidWizValue && (looksLikeEmail || looksLikeAccountHandle)) {
        return normalized;
      }
    }

    const profileUserId = GF.getUserIdFromProfilePicture();
    if (profileUserId) {
      return profileUserId;
    }

    return null;
  };

  GF.extractChatIdFromLink = function(link) {
    try {
      const href = link.getAttribute("href") || link.href;
      if (!href) {
        return null;
      }

      const url = new URL(href, window.location.origin);
      const parts = url.pathname.split("/").filter(Boolean);

      const candidate = parts.pop() || null;
      if (!candidate || candidate === "app") {
        return null;
      }

      return candidate;
    } catch {
      return null;
    }
  };

  GF.getChatDisplayTitleFromLink = function(link) {
    const text = (link.textContent || link.getAttribute("aria-label") || link.title || "").trim();
    return text || "Untitled Chat";
  };

  GF.normalizeDisplayTitle = function(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  };

  GF.isUnhelpfulChatTitle = function(title) {
    const normalized = GF.normalizeDisplayTitle(title).toLowerCase();
    if (!normalized) {
      return true;
    }

    return (
      normalized === "chat" ||
      normalized === "chats" ||
      normalized === "new chat" ||
      normalized === "new chats" ||
      normalized === "all chats" ||
      normalized === "conversation" ||
      normalized === "conversations" ||
      normalized === "history" ||
      normalized === "gemini"
    );
  };

  GF.getMeaningfulTitleFromElement = function(element) {
    if (!element) {
      return "";
    }

    const candidate = GF.normalizeDisplayTitle(element.textContent || element.getAttribute("aria-label") || element.title || "");
    return candidate && !GF.isUnhelpfulChatTitle(candidate) ? candidate : "";
  };

})();
