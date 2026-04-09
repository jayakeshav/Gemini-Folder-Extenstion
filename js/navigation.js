(() => {
  // Navigation and chat selection logic for the Gemini Folders extension

  const GF = window.GeminiFolders;

  GF.getMainChatTitleCandidate = function() {
    const selectors = [
      'main [data-test-id="conversation-title"]',
      'main [data-testid="conversation-title"]',
      'main [data-test-id*="conversation-title" i]',
      'main [data-testid*="conversation-title" i]',
      'main [data-test-id*="title" i]',
      'main [data-testid*="title" i]',
      'main [aria-label*="title" i]',
      'main [role="heading"]',
      "main h1",
      "main h2",
      "main h3"
    ];

    for (const selector of selectors) {
      const title = GF.getMeaningfulTitleFromElement(document.querySelector(selector));
      if (title) {
        return title;
      }
    }

    return "";
  };

  GF.getDocumentTitleCandidate = function() {
    const raw = GF.normalizeDisplayTitle(document.title || "");
    if (!raw) {
      return "";
    }

    return GF.normalizeDisplayTitle(raw.replace(/\s*[-|]\s*gemini.*$/i, ""));
  };

  GF.getSelectedSidebarChatTitle = function() {
    const selectedLink =
      document.querySelector('a[data-test-id="conversation"][aria-current="page"]') ||
      document.querySelector("side-nav-entry-button.selected a[data-test-id=\"conversation\"]") ||
      document.querySelector("a[data-test-id=\"conversation\"].selected");

    if (!selectedLink) {
      return "";
    }

    return GF.getChatDisplayTitleFromLink(selectedLink);
  };

  GF.getCurrentChatTitle = function() {
    const mainTitle = GF.getMainChatTitleCandidate();
    if (mainTitle) {
      return mainTitle;
    }

    const sidebarTitle = GF.normalizeDisplayTitle(GF.getSelectedSidebarChatTitle());
    if (sidebarTitle && !GF.isUnhelpfulChatTitle(sidebarTitle)) {
      return sidebarTitle;
    }

    const documentTitle = GF.getDocumentTitleCandidate();
    if (documentTitle && !GF.isUnhelpfulChatTitle(documentTitle)) {
      return documentTitle;
    }

    return "Untitled Chat";
  };

  GF.getChatUrl = function(chatId) {
    return `/app/${chatId}`;
  };

  GF.getCurrentChatIdFromPath = function() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const chatId = parts.pop() || "";

    if (!chatId || chatId === "app") {
      return null;
    }

    return chatId;
  };

  GF.getNativeChatLinkById = function(chatId) {
    const nativeLink = document.querySelector(`a[data-test-id="conversation"][href*="${chatId}"]`);
    if (nativeLink) {
      return nativeLink;
    }

    const ROOT_ID = "gfo-folders-root";
    const links = Array.from(document.querySelectorAll(`a[href*="${chatId}"]`));
    return links.find((link) => !link.closest(`#${ROOT_ID}`)) || null;
  };

  GF.markCustomChatItemSelected = function(chatId) {
    const ROOT_ID = "gfo-folders-root";
    const activeFoldersRoot = document.getElementById(ROOT_ID);

    if (!activeFoldersRoot) {
      return;
    }

    activeFoldersRoot.querySelectorAll(".gfo-folder-chat-item.selected").forEach((item) => {
      item.classList.remove("selected");
    });

    const selected = activeFoldersRoot.querySelector(`.gfo-folder-chat-item[data-chat-id="${chatId}"]`);
    if (selected) {
      selected.classList.add("selected");
    }
  };

  GF.syncSelectedCustomChatFromCurrentPath = function() {
    const chatId = GF.getCurrentChatIdFromPath();
    if (!chatId) {
      GF.markCustomChatItemSelected("");
      return;
    }

    GF.markCustomChatItemSelected(chatId);
  };

  GF.handleCustomChatItemClick = function(event, chatId) {
    const nativeLink = GF.getNativeChatLinkById(chatId);

    if (nativeLink) {
      event.preventDefault();
      nativeLink.click();
      GF.markCustomChatItemSelected(chatId);
      return;
    }

    window.location.href = GF.getChatUrl(chatId);
  };

})();
