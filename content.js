(() => {
  const STORAGE_KEY = "geminiFolders";
  const ROOT_ID = "gfo-folders-root";
  const QUICK_ADD_BUTTON_ID = "gfo-quick-add";
  const QUICK_ADD_MENU_ID = "gfo-quick-add-menu";
  const expandedFolderIds = new Set();
  let activeFoldersRoot = null;
  let activeFoldersList = null;
  let sidebarObserver = null;
  let mainHeaderObserver = null;
  let activeChatContext = null;
  let folderContextMenu = null;
  let folderContextMenuOutsideHandler = null;
  let folderContextMenuBound = false;
  let quickAddMenu = null;
  let quickAddMenuOutsideHandler = null;
  let quickAddEnsureScheduled = false;
  let isContextAlive = true;

  function isExtensionContextInvalidated(error) {
    const message = String(error && error.message ? error.message : error || "");
    return message.includes("Extension context invalidated");
  }

  function hasRuntimeContext() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local);
    } catch {
      return false;
    }
  }

  function shutdownOnContextInvalidation() {
    if (!isContextAlive) {
      return;
    }

    isContextAlive = false;

    if (sidebarObserver) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }

    if (mainHeaderObserver) {
      mainHeaderObserver.disconnect();
      mainHeaderObserver = null;
    }

    closeFolderContextMenu();
    closeQuickAddMenu();
  }

  function warnIfUnexpected(error, scope) {
    if (isExtensionContextInvalidated(error)) {
      shutdownOnContextInvalidation();
      return;
    }

    if (!isExtensionContextInvalidated(error)) {
      console.warn(`Gemini Folders: ${scope}`, error);
    }
  }

  function fireAndForget(promise, scope) {
    promise.catch((error) => {
      warnIfUnexpected(error, scope);
    });
  }

  function createFolderId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }

    return `folder_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeFolderNode(node) {
    if (typeof node === "string") {
      return {
        id: createFolderId(),
        name: node.trim() || "Untitled Folder",
        children: []
      };
    }

    if (!isPlainObject(node)) {
      return null;
    }

    const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : "Untitled Folder";
    const children = Array.isArray(node.children) ? node.children.map(normalizeFolderNode).filter(Boolean) : [];

    return {
      id: typeof node.id === "string" && node.id ? node.id : createFolderId(),
      name,
      children
    };
  }

  function normalizeFolderTree(value) {
    return Array.isArray(value) ? value.map(normalizeFolderNode).filter(Boolean) : [];
  }

  function folderTreeNeedsMigration(value) {
    if (!Array.isArray(value)) {
      return Boolean(value);
    }

    return value.some((node) => {
      if (typeof node === "string") {
        return true;
      }

      if (!isPlainObject(node)) {
        return true;
      }

      if (typeof node.id !== "string" || !node.id) {
        return true;
      }

      return folderTreeNeedsMigration(node.children);
    });
  }

  function normalizeChatMappingEntry(value) {
    if (typeof value === "string") {
      return {
        folderIDs: [value],
        title: ""
      };
    }

    if (!isPlainObject(value)) {
      return null;
    }

    const folderIDs = Array.isArray(value.folderIDs)
      ? value.folderIDs.filter((folderID) => typeof folderID === "string" && folderID)
      : typeof value.folderID === "string" && value.folderID
        ? [value.folderID]
        : typeof value.folderId === "string" && value.folderId
          ? [value.folderId]
          : [];

    if (!folderIDs.length) {
      return null;
    }

    return {
      folderIDs: Array.from(new Set(folderIDs)),
      title: typeof value.title === "string" ? value.title.trim() : ""
    };
  }

  function normalizeChatToFolderMap(value) {
    if (!isPlainObject(value)) {
      return {};
    }

    const nextMap = {};

    Object.entries(value).forEach(([chatId, entry]) => {
      const normalizedEntry = normalizeChatMappingEntry(entry);
      if (normalizedEntry) {
        nextMap[chatId] = normalizedEntry;
      }
    });

    return nextMap;
  }

  function normalizeState(rawState) {
    if (Array.isArray(rawState)) {
      return {
        folders: normalizeFolderTree(rawState),
        chatToFolderMap: {}
      };
    }

    if (isPlainObject(rawState)) {
      return {
        folders: normalizeFolderTree(rawState.folders),
        chatToFolderMap: normalizeChatToFolderMap(rawState.chatToFolderMap ?? rawState.chatFolderMappings)
      };
    }

    return {
      folders: [],
      chatToFolderMap: {}
    };
  }

  function chatMappingsNeedMigration(rawState) {
    if (!isPlainObject(rawState)) {
      return false;
    }

    const sourceMap = rawState.chatToFolderMap ?? rawState.chatFolderMappings;

    if (sourceMap !== undefined && !isPlainObject(sourceMap)) {
      return true;
    }

    return Object.values(sourceMap || {}).some((entry) => {
      return (
        !isPlainObject(entry) ||
        !Array.isArray(entry.folderIDs) ||
        typeof entry.title !== "string"
      );
    });
  }

  async function getFolders() {
    if (!isContextAlive) {
      return [];
    }

    const state = await loadFolderState();
    return state.folders;
  }

  async function loadFolderState() {
    if (!isContextAlive) {
      return normalizeState(undefined);
    }

    if (!hasRuntimeContext()) {
      shutdownOnContextInvalidation();
      return normalizeState(undefined);
    }

    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const rawState = result[STORAGE_KEY];
      const state = normalizeState(rawState);

      if (folderTreeNeedsMigration(rawState?.folders ?? rawState) || chatMappingsNeedMigration(rawState)) {
        await saveFolderState(state);
      }

      return state;
    } catch (error) {
      warnIfUnexpected(error, "loadFolderState failed");
      return normalizeState(undefined);
    }
  }

  async function saveFolderState(state) {
    if (!isContextAlive) {
      return false;
    }

    if (!hasRuntimeContext()) {
      shutdownOnContextInvalidation();
      return false;
    }

    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: state });
      return true;
    } catch (error) {
      warnIfUnexpected(error, "saveFolderState failed");
      return false;
    }
  }

  function collectFolderIds(folder) {
    const folderIds = [folder.id];

    (folder.children || []).forEach((child) => {
      folderIds.push(...collectFolderIds(child));
    });

    return folderIds;
  }

  function flattenFolderTree(folders, depth = 0) {
    const rows = [];

    folders.forEach((folder) => {
      rows.push({
        id: folder.id,
        name: folder.name,
        depth
      });

      if (Array.isArray(folder.children) && folder.children.length) {
        rows.push(...flattenFolderTree(folder.children, depth + 1));
      }
    });

    return rows;
  }

  function getChatsForFolder(folderId, chatToFolderMap) {
    return Object.entries(chatToFolderMap || {})
      .filter(([, entry]) => Array.isArray(entry?.folderIDs) && entry.folderIDs.includes(folderId))
      .map(([chatId, entry]) => ({
        chatId,
        title: entry.title || "Untitled Chat"
      }))
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  function extractChatIdFromLink(link) {
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
  }

  function getChatDisplayTitleFromLink(link) {
    const text = (link.textContent || link.getAttribute("aria-label") || link.title || "").trim();
    return text || "Untitled Chat";
  }

  function normalizeDisplayTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isUnhelpfulChatTitle(title) {
    const normalized = normalizeDisplayTitle(title).toLowerCase();
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
  }

  function getMeaningfulTitleFromElement(element) {
    if (!element) {
      return "";
    }

    const candidate = normalizeDisplayTitle(element.textContent || element.getAttribute("aria-label") || element.title || "");
    return candidate && !isUnhelpfulChatTitle(candidate) ? candidate : "";
  }

  function getMainChatTitleCandidate() {
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
      const title = getMeaningfulTitleFromElement(document.querySelector(selector));
      if (title) {
        return title;
      }
    }

    return "";
  }

  function getDocumentTitleCandidate() {
    const raw = normalizeDisplayTitle(document.title || "");
    if (!raw) {
      return "";
    }

    return normalizeDisplayTitle(raw.replace(/\s*[-|]\s*gemini.*$/i, ""));
  }

  function getChatUrl(chatId) {
    return `/app/${chatId}`;
  }

  function getCurrentChatIdFromPath() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const chatId = parts.pop() || "";

    if (!chatId || chatId === "app") {
      return null;
    }

    return chatId;
  }

  function getSelectedSidebarChatTitle() {
    const selectedLink =
      document.querySelector('a[data-test-id="conversation"][aria-current="page"]') ||
      document.querySelector("side-nav-entry-button.selected a[data-test-id=\"conversation\"]") ||
      document.querySelector("a[data-test-id=\"conversation\"].selected");

    if (!selectedLink) {
      return "";
    }

    return getChatDisplayTitleFromLink(selectedLink);
  }

  function getCurrentChatTitle() {
    const mainTitle = getMainChatTitleCandidate();
    if (mainTitle) {
      return mainTitle;
    }

    const sidebarTitle = normalizeDisplayTitle(getSelectedSidebarChatTitle());
    if (sidebarTitle && !isUnhelpfulChatTitle(sidebarTitle)) {
      return sidebarTitle;
    }

    const documentTitle = getDocumentTitleCandidate();
    if (documentTitle && !isUnhelpfulChatTitle(documentTitle)) {
      return documentTitle;
    }

    return "Untitled Chat";
  }

  function getNativeChatLinkById(chatId) {
    const nativeLink = document.querySelector(`a[data-test-id="conversation"][href*="${chatId}"]`);
    if (nativeLink) {
      return nativeLink;
    }

    const links = Array.from(document.querySelectorAll(`a[href*="${chatId}"]`));
    return links.find((link) => !link.closest(`#${ROOT_ID}`)) || null;
  }

  function markCustomChatItemSelected(chatId) {
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
  }

  function syncSelectedCustomChatFromCurrentPath() {
    const chatId = getCurrentChatIdFromPath();
    if (!chatId) {
      markCustomChatItemSelected("");
      return;
    }

    markCustomChatItemSelected(chatId);
  }

  function handleCustomChatItemClick(event, chatId) {
    const nativeLink = getNativeChatLinkById(chatId);

    // Soft navigation when Gemini already has this chat link in the sidebar DOM.
    if (nativeLink) {
      event.preventDefault();
      nativeLink.click();
      markCustomChatItemSelected(chatId);
      return;
    }

    // Hard navigation fallback for chats not currently materialized by Gemini.
    window.location.href = getChatUrl(chatId);
  }

  function closeFolderContextMenu() {
    if (folderContextMenu) {
      folderContextMenu.remove();
      folderContextMenu = null;
    }

    if (folderContextMenuOutsideHandler) {
      document.removeEventListener("pointerdown", folderContextMenuOutsideHandler, true);
      folderContextMenuOutsideHandler = null;
    }

    activeChatContext = null;
  }

  function closeQuickAddMenu() {
    if (quickAddMenu) {
      quickAddMenu.remove();
      quickAddMenu = null;
    }

    if (quickAddMenuOutsideHandler) {
      document.removeEventListener("pointerdown", quickAddMenuOutsideHandler, true);
      quickAddMenuOutsideHandler = null;
    }
  }

  function removeQuickAddButton() {
    const existingButton = document.getElementById(QUICK_ADD_BUTTON_ID);
    if (existingButton) {
      existingButton.remove();
    }
  }

  function getFolderIDsForChatEntry(entry) {
    if (!entry) {
      return [];
    }

    if (Array.isArray(entry.folderIDs)) {
      return entry.folderIDs.filter((folderID) => typeof folderID === "string" && folderID);
    }

    if (typeof entry.folderID === "string" && entry.folderID) {
      return [entry.folderID];
    }

    if (typeof entry.folderId === "string" && entry.folderId) {
      return [entry.folderId];
    }

    return [];
  }

  function getChatFolderState(chatToFolderMap, chatId) {
    const entry = normalizeChatMappingEntry(chatToFolderMap?.[chatId]);
    return {
      entry,
      folderIDs: getFolderIDsForChatEntry(entry)
    };
  }

  async function assignChatToFolder(chatContext, folderId) {
    if (!chatContext || !chatContext.chatId || !folderId) {
      return false;
    }

    const state = await loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };
    const currentFolderIDs = getFolderIDsForChatEntry(nextMap[chatContext.chatId]);

    nextMap[chatContext.chatId] = {
      folderIDs: Array.from(new Set([...currentFolderIDs, folderId])),
      title: chatContext.title || "Untitled Chat"
    };

    return saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
  }

  async function removeChatFromFolder(chatId, folderId = null) {
    if (!chatId) {
      return false;
    }

    const state = await loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };
    const currentEntry = normalizeChatMappingEntry(nextMap[chatId]);

    if (!currentEntry) {
      return true;
    }

    const nextFolderIDs = folderId
      ? currentEntry.folderIDs.filter((existingFolderId) => existingFolderId !== folderId)
      : [];

    if (!nextFolderIDs.length) {
      delete nextMap[chatId];
    } else {
      nextMap[chatId] = {
        folderIDs: nextFolderIDs,
        title: currentEntry.title || "Untitled Chat"
      };
    }

    return saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
  }

  async function saveCurrentChatToFolder(folderId) {
    const chatId = getCurrentChatIdFromPath();
    if (!chatId || !folderId) {
      return false;
    }

    const state = await loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };
    const currentFolderIDs = getFolderIDsForChatEntry(nextMap[chatId]);

    nextMap[chatId] = {
      folderIDs: Array.from(new Set([...currentFolderIDs, folderId])),
      title: getCurrentChatTitle()
    };

    return saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
  }

  function findHeaderActionGroup() {
    const candidates = [
      'main [role="toolbar"]',
      'main [aria-label*="actions" i]',
      'main .actions',
      'main .header-actions',
      'main .top-right-actions'
    ];

    for (const selector of candidates) {
      const node = document.querySelector(selector);
      if (node && !node.closest(`#${ROOT_ID}`)) {
        return node;
      }
    }

    const shareLikeButton = document.querySelector(
      'main button[aria-label*="Share" i], main button[aria-label*="Spark" i], main button[aria-label*="Copy" i]'
    );

    if (shareLikeButton?.parentElement && !shareLikeButton.parentElement.closest(`#${ROOT_ID}`)) {
      return shareLikeButton.parentElement;
    }

    return null;
  }

  async function openQuickAddMenu(anchorButton) {
    closeQuickAddMenu();

    const state = await loadFolderState();
    const folders = flattenFolderTree(state.folders);
    const chatId = getCurrentChatIdFromPath();
    const chatState = getChatFolderState(state.chatToFolderMap, chatId);
    const folderIDSet = new Set(chatState.folderIDs);

    const menu = document.createElement("div");
    menu.id = QUICK_ADD_MENU_ID;
    menu.className = "gfo-quick-add-menu";

    const header = document.createElement("div");
    header.className = "gfo-quick-add-menu-header";
    header.textContent = "Add current chat to folder";
    menu.appendChild(header);

    if (!chatId) {
      const empty = document.createElement("div");
      empty.className = "gfo-quick-add-menu-empty";
      empty.textContent = "Open a chat first";
      menu.appendChild(empty);
    } else if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "gfo-quick-add-menu-empty";
      empty.textContent = "No folders available";
      menu.appendChild(empty);
    } else {
      folders.forEach((folder) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "gfo-quick-add-menu-item";
        item.classList.toggle("is-selected", folderIDSet.has(folder.id));
        item.dataset.folderId = folder.id;
        item.style.paddingLeft = `${12 + folder.depth * 14}px`;

        const checkmark = document.createElement("span");
        checkmark.className = "gfo-quick-add-menu-check";
        checkmark.textContent = folderIDSet.has(folder.id) ? "✓" : "";
        checkmark.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "gfo-quick-add-menu-label";
        label.textContent = folder.name;

        item.append(checkmark, label);

        item.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();

          fireAndForget(
            (async () => {
              const saved = folderIDSet.has(folder.id)
                ? await removeChatFromFolder(chatId, folder.id)
                : await saveCurrentChatToFolder(folder.id);
              if (saved) {
                await refreshFolderUI();
                openQuickAddMenu(anchorButton);
              }
            })(),
            "toggle quick add folder failed"
          );
        });

        menu.appendChild(item);
      });
    }

    document.body.appendChild(menu);

    const rect = anchorButton.getBoundingClientRect();
    const left = Math.min(window.innerWidth - menu.offsetWidth - 8, Math.max(8, rect.left));
    const top = Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 6);

    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;

    quickAddMenu = menu;

    quickAddMenuOutsideHandler = (event) => {
      if (quickAddMenu && quickAddMenu.contains(event.target)) {
        return;
      }

      if (anchorButton.contains(event.target)) {
        return;
      }

      closeQuickAddMenu();
    };

    document.addEventListener("pointerdown", quickAddMenuOutsideHandler, true);
  }

  function ensureQuickAddButton() {
    if (!isContextAlive) {
      return;
    }

    // Only show quick-add when a concrete chat route is open.
    if (!getCurrentChatIdFromPath()) {
      closeQuickAddMenu();
      removeQuickAddButton();
      return;
    }

    const actionGroup = findHeaderActionGroup();
    if (!actionGroup) {
      return;
    }

    let button = document.getElementById(QUICK_ADD_BUTTON_ID);

    if (!button) {
      button = document.createElement("button");
      button.id = QUICK_ADD_BUTTON_ID;
      button.type = "button";
      button.className = "gfo-quick-add";
      button.setAttribute("aria-label", "Add current chat to folder");
      button.innerHTML = getQuickAddFolderIconMarkup();

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        fireAndForget(openQuickAddMenu(button), "openQuickAddMenu failed");
      });
    }

    if (button.parentElement !== actionGroup) {
      actionGroup.appendChild(button);
    }
  }

  function scheduleEnsureQuickAddButton() {
    if (quickAddEnsureScheduled) {
      return;
    }

    quickAddEnsureScheduled = true;

    requestAnimationFrame(() => {
      quickAddEnsureScheduled = false;
      ensureQuickAddButton();
    });
  }

  function observeMainHeaderArea() {
    if (!isContextAlive) {
      return;
    }

    const target = document.querySelector("main") || document.body;
    if (!target) {
      return;
    }

    if (mainHeaderObserver) {
      mainHeaderObserver.disconnect();
      mainHeaderObserver = null;
    }

    ensureQuickAddButton();

    mainHeaderObserver = new MutationObserver(() => {
      if (!isContextAlive || !mainHeaderObserver) {
        return;
      }

      scheduleEnsureQuickAddButton();
    });

    mainHeaderObserver.observe(target, {
      childList: true,
      subtree: true
    });
  }

  async function openFolderContextMenu(event, chatContext) {
    if (!isContextAlive || !chatContext) {
      return;
    }

    closeFolderContextMenu();

    const state = await loadFolderState();
    const folders = flattenFolderTree(state.folders);
    const chatState = getChatFolderState(state.chatToFolderMap, chatContext.chatId);
    const mappedEntry = chatState.entry;
    const folderIDSet = new Set(chatState.folderIDs);

    const menu = document.createElement("div");
    menu.id = "gfo-folder-context-menu";
    menu.className = "gfo-folder-context-menu";

    const header = document.createElement("div");
    header.className = "gfo-folder-context-menu-header";
    header.textContent = `Add \"${chatContext.title}\" to:`;
    menu.appendChild(header);

    const removeItem = document.createElement("button");
    removeItem.type = "button";
    removeItem.className = "gfo-folder-context-menu-item gfo-folder-context-menu-item-remove";
    removeItem.textContent = "Remove from folder";
    removeItem.disabled = !mappedEntry || !chatContext.folderId;
    removeItem.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      fireAndForget(
        (async () => {
          const saved = await removeChatFromFolder(chatContext.chatId, chatContext.folderId);
          if (saved) {
            await refreshFolderUI();
            closeFolderContextMenu();
          }
        })(),
        "removeChatFromFolder failed"
      );
    });
    menu.appendChild(removeItem);

    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "gfo-folder-context-menu-empty";
      empty.textContent = "No folders yet";
      menu.appendChild(empty);
    } else {
      folders.forEach((folder) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "gfo-folder-context-menu-item";
        item.classList.toggle("is-selected", folderIDSet.has(folder.id));
        item.dataset.folderId = folder.id;
        item.style.paddingLeft = `${12 + folder.depth * 14}px`;

        const checkmark = document.createElement("span");
        checkmark.className = "gfo-folder-context-menu-check";
        checkmark.textContent = folderIDSet.has(folder.id) ? "✓" : "";
        checkmark.setAttribute("aria-hidden", "true");

        const label = document.createElement("span");
        label.className = "gfo-folder-context-menu-label";
        label.textContent = folder.name;

        item.append(checkmark, label);

        item.addEventListener("click", (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
          fireAndForget(
            (async () => {
              const saved = folderIDSet.has(folder.id)
                ? await removeChatFromFolder(chatContext.chatId, folder.id)
                : await assignChatToFolder(chatContext, folder.id);
              if (saved) {
                await refreshFolderUI();
                openFolderContextMenu(event, chatContext);
              }
            })(),
            "toggle folder context action failed"
          );
        });

        menu.appendChild(item);
      });
    }

    document.body.appendChild(menu);

    const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8;
    const maxTop = window.scrollY + document.documentElement.clientHeight - menu.offsetHeight - 8;
    const left = Math.max(window.scrollX + 8, Math.min(event.pageX, maxLeft));
    const top = Math.max(window.scrollY + 8, Math.min(event.pageY, maxTop));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    folderContextMenu = menu;

    folderContextMenuOutsideHandler = (pointerEvent) => {
      if (folderContextMenu && folderContextMenu.contains(pointerEvent.target)) {
        return;
      }

      closeFolderContextMenu();
    };

    document.addEventListener("pointerdown", folderContextMenuOutsideHandler, true);
  }

  function bindFolderContextMenuListener() {
    if (folderContextMenuBound) {
      return;
    }

    folderContextMenuBound = true;

    document.addEventListener(
      "contextmenu",
      (event) => {
        if (!isContextAlive) {
          return;
        }

        const link = event.target.closest("a[data-test-id=\"conversation\"]");
        const customChat = event.target.closest(".gfo-folder-chat-item");

        if (!link && !customChat) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const chatId = link ? extractChatIdFromLink(link) : customChat.dataset.chatId || null;
        if (!chatId) {
          return;
        }

        activeChatContext = {
          chatId,
          folderId: customChat?.dataset.folderId || null,
          title: link ? getChatDisplayTitleFromLink(link) : (customChat.dataset.chatTitle || customChat.textContent || "Untitled Chat").trim()
        };

        fireAndForget(openFolderContextMenu(event, activeChatContext), "openFolderContextMenu failed");
      },
      true
    );
  }

  function insertFolderIntoTree(folders, parentId, newFolder) {
    if (!parentId) {
      return {
        folders: [...folders, newFolder],
        inserted: true
      };
    }

    let inserted = false;

    const nextFolders = folders.map((folder) => {
      if (folder.id === parentId) {
        inserted = true;
        return {
          ...folder,
          children: [...(folder.children || []), newFolder]
        };
      }

      if (Array.isArray(folder.children) && folder.children.length) {
        const childResult = insertFolderIntoTree(folder.children, parentId, newFolder);
        if (childResult.inserted) {
          inserted = true;
          return {
            ...folder,
            children: childResult.folders
          };
        }
      }

      return folder;
    });

    return {
      folders: inserted ? nextFolders : folders,
      inserted
    };
  }

  function removeFolderFromTree(folders, targetId) {
    let removed = false;
    const removedIds = [];

    const nextFolders = folders.flatMap((folder) => {
      if (folder.id === targetId) {
        removed = true;
        removedIds.push(...collectFolderIds(folder));
        return [];
      }

      if (Array.isArray(folder.children) && folder.children.length) {
        const childResult = removeFolderFromTree(folder.children, targetId);
        if (childResult.removed) {
          removed = true;
          removedIds.push(...childResult.removedIds);
          return [
            {
              ...folder,
              children: childResult.folders
            }
          ];
        }
      }

      return [folder];
    });

    return {
      folders: nextFolders,
      removed,
      removedIds
    };
  }

  function clearMappingsForFolderIds(mappings, folderIds) {
    const folderIdSet = new Set(folderIds);
    const nextMappings = {};

    Object.entries(mappings || {}).forEach(([chatId, entry]) => {
      const normalizedEntry = normalizeChatMappingEntry(entry);
      if (!normalizedEntry) {
        return;
      }

      const remainingFolderIDs = normalizedEntry.folderIDs.filter((folderID) => !folderIdSet.has(folderID));
      if (remainingFolderIDs.length) {
        nextMappings[chatId] = {
          folderIDs: remainingFolderIDs,
          title: normalizedEntry.title
        };
      }
    });

    return nextMappings;
  }

  async function createFolder(name, parentId = null) {
    const folderName = name.trim();
    if (!folderName) {
      return false;
    }

    const state = await loadFolderState();
    const newFolder = {
      id: createFolderId(),
      name: folderName,
      children: []
    };

    let nextFolders = state.folders;

    if (parentId) {
      const insertion = insertFolderIntoTree(state.folders, parentId, newFolder);
      if (!insertion.inserted) {
        return false;
      }

      nextFolders = insertion.folders;
    } else {
      nextFolders = [...state.folders, newFolder];
    }

    const saved = await saveFolderState({
      ...state,
      folders: nextFolders
    });

    return saved;
  }

  async function deleteFolder(folderId) {
    const state = await loadFolderState();
    const removal = removeFolderFromTree(state.folders, folderId);

    if (!removal.removed) {
      return false;
    }

    removal.removedIds.forEach((id) => expandedFolderIds.delete(id));

    const saved = await saveFolderState({
      ...state,
      folders: removal.folders,
      chatToFolderMap: clearMappingsForFolderIds(state.chatToFolderMap, removal.removedIds)
    });

    return saved;
  }

  function findSidebar() {
    return document.querySelector("bard-sidenav[role='navigation']") || document.querySelector("bard-sidenav");
  }

  function findHistoryContainer(sidebar) {
    if (!sidebar) {
      return null;
    }

    return sidebar.querySelector(".sidenav-with-history-container");
  }

  function findSidebarWrapper(sidebar) {
    if (!sidebar) {
      return null;
    }

    return sidebar;
  }

  function isExpanded(historyContainer) {
    if (!historyContainer) {
      return true;
    }

    if (historyContainer.classList.contains("expanded")) {
      return true;
    }

    if (historyContainer.classList.contains("collapsed")) {
      return false;
    }

    return historyContainer.getBoundingClientRect().width >= 180;
  }

  function syncState(root, historyContainer) {
    const expanded = isExpanded(historyContainer);
    root.classList.toggle("gfo-expanded", expanded);
    root.classList.toggle("gfo-collapsed", !expanded);
  }

  function watchState(root, historyContainer) {
    if (!historyContainer || historyContainer.dataset.gfoStateObserverAttached === "true") {
      return;
    }

    historyContainer.dataset.gfoStateObserverAttached = "true";

    const observer = new MutationObserver(() => {
      syncState(root, historyContainer);
    });

    observer.observe(historyContainer, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  function createFolderIcon() {
    const icon = document.createElement("span");
    icon.className = "gfo-title-dot gfo-title-folder-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M3 7.5C3 6.12 4.12 5 5.5 5h4.38c.53 0 1.04.21 1.41.59L12.7 7H18.5C19.88 7 21 8.12 21 9.5v7c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 19 3 17.88 3 16.5v-9Z"></path>
      </svg>
    `;
    return icon;
  }

  function getFolderStateIconMarkup(isOpen) {
    if (isOpen) {
      return `
        <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path d="M3 9.25C3 7.73 4.23 6.5 5.75 6.5h3.98c.4 0 .78-.16 1.06-.44l.38-.38c.38-.38.88-.59 1.41-.59h5.67C19.77 5.09 21 6.32 21 7.84v1.41H3Z"></path>
          <path d="M3.12 10.75h17.76c.8 0 1.38.76 1.16 1.53l-1.14 4.06c-.33 1.2-1.43 2.03-2.68 2.03H5.78c-1.25 0-2.35-.83-2.68-2.03L1.96 12.28c-.22-.77.36-1.53 1.16-1.53Z"></path>
        </svg>
      `;
    }

    return `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M3 7.5C3 6.12 4.12 5 5.5 5h4.38c.53 0 1.04.21 1.41.59L12.7 7H18.5C19.88 7 21 8.12 21 9.5v7c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 19 3 17.88 3 16.5v-9Z"></path>
      </svg>
    `;
  }

  function getQuickAddFolderIconMarkup() {
    return `
      <svg class="gfo-quick-add-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v-2H4V8h16v3h2V8c0-1.1-.9-2-2-2Z"></path>
        <path d="M16 12c-.55 0-1 .45-1 1v2h-2c-.55 0-1 .45-1 1s.45 1 1 1h2v2c0 .55.45 1 1 1s1-.45 1-1v-2h2c.55 0 1-.45 1-1s-.45-1-1-1h-2v-2c0-.55-.45-1-1-1Z"></path>
      </svg>
    `;
  }

  function isFolderCollapsed(folderId) {
    return !expandedFolderIds.has(folderId);
  }

  function setFolderCollapsed(folderId, collapsed) {
    if (collapsed) {
      expandedFolderIds.delete(folderId);
      return;
    }

    expandedFolderIds.add(folderId);
  }

  async function refreshFolderUI() {
    if (!activeFoldersRoot || !activeFoldersList) {
      return;
    }

    const state = await loadFolderState();
    renderFolders(activeFoldersList, state.folders, state.chatToFolderMap);
    syncState(activeFoldersRoot, findHistoryContainer(findSidebar()));
    syncSelectedCustomChatFromCurrentPath();
  }

  async function handleCreateFolder(parentId = null) {
    const folderLabel = parentId ? "Sub-folder name:" : "Folder name:";
    const folderName = prompt(folderLabel);
    if (!folderName || !folderName.trim()) {
      return;
    }

    const created = await createFolder(folderName, parentId);
    if (created) {
      await refreshFolderUI();
    }
  }

  async function handleDeleteFolder(folderId, folderName) {
    const confirmed = confirm(`Delete folder \"${folderName}\" and all nested folders?`);
    if (!confirmed) {
      return;
    }

    const deleted = await deleteFolder(folderId);
    if (deleted) {
      await refreshFolderUI();
    }
  }

  function renderFolderNode(folder, depth = 0, chatToFolderMap = {}) {
    const node = document.createElement("div");
    node.className = "gfo-folder-node";
    node.dataset.folderId = folder.id;
    node.style.setProperty("--gfo-folder-indent", `${depth * 16}px`);

    const row = document.createElement("div");
    row.className = "gfo-folder-item";
    row.dataset.folderId = folder.id;

    if (depth > 0) {
      row.classList.add("gfo-folder-item--child");
    }

    const assignedChats = getChatsForFolder(folder.id, chatToFolderMap);
    const hasChildren = Array.isArray(folder.children) && folder.children.length > 0;
    const hasNestedContent = hasChildren || assignedChats.length > 0;
    const isCollapsed = isFolderCollapsed(folder.id);
    node.classList.toggle("gfo-folder-node--collapsed", isCollapsed);

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "gfo-toggle-folder";
    toggleButton.innerHTML = getFolderStateIconMarkup(!isCollapsed);
    toggleButton.setAttribute("aria-label", isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`);
    toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
    toggleButton.classList.toggle("is-open", !isCollapsed);
    toggleButton.disabled = !hasNestedContent;

    const label = document.createElement("span");
    label.className = "gfo-folder-name";
    label.textContent = folder.name;

    const actions = document.createElement("div");
    actions.className = "gfo-folder-actions";

    const addSubFolderButton = document.createElement("button");
    addSubFolderButton.type = "button";
    addSubFolderButton.className = "gfo-folder-action gfo-folder-action-add";
    addSubFolderButton.textContent = "+";
    addSubFolderButton.setAttribute("aria-label", `Add sub-folder to ${folder.name}`);
    addSubFolderButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "gfo-folder-action gfo-folder-action-delete";
    deleteButton.textContent = "×";
    deleteButton.setAttribute("aria-label", `Delete ${folder.name}`);
    deleteButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    actions.append(addSubFolderButton, deleteButton);

    row.append(toggleButton, label, actions);

    const childrenContainer = document.createElement("div");
    childrenContainer.className = "gfo-folder-children";
    childrenContainer.hidden = isCollapsed;
    childrenContainer.style.setProperty("display", isCollapsed ? "none" : "flex", "important");

    if (hasChildren) {
      folder.children.forEach((childFolder) => {
        childrenContainer.appendChild(renderFolderNode(childFolder, depth + 1, chatToFolderMap));
      });
    }

    if (assignedChats.length) {
      const chatList = document.createElement("div");
      chatList.className = "gfo-folder-chat-list";

      assignedChats.forEach((chat) => {
        const chatButton = document.createElement("a");
        chatButton.className = "gfo-folder-chat-item";
        chatButton.dataset.chatId = chat.chatId;
        chatButton.dataset.folderId = folder.id;
        chatButton.dataset.chatTitle = chat.title;
        chatButton.textContent = chat.title;
        chatButton.href = getChatUrl(chat.chatId);
        chatButton.setAttribute("aria-label", `Open ${chat.title}`);
        chatButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          handleCustomChatItemClick(event, chat.chatId);
        });

        chatList.appendChild(chatButton);
      });

      childrenContainer.appendChild(chatList);
    }

    toggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!hasNestedContent) {
        return;
      }

      const nextCollapsed = !node.classList.contains("gfo-folder-node--collapsed");
      setFolderCollapsed(folder.id, nextCollapsed);
      node.classList.toggle("gfo-folder-node--collapsed", nextCollapsed);
      childrenContainer.hidden = nextCollapsed;
      childrenContainer.style.setProperty("display", nextCollapsed ? "none" : "flex", "important");
      toggleButton.classList.toggle("is-open", !nextCollapsed);
      toggleButton.setAttribute("aria-expanded", String(!nextCollapsed));
      toggleButton.setAttribute("aria-label", nextCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`);
      toggleButton.innerHTML = getFolderStateIconMarkup(!nextCollapsed);
    });

    addSubFolderButton.addEventListener("click", (event) => {
      event.stopPropagation();
      fireAndForget(handleCreateFolder(folder.id), "handleCreateFolder failed");
    });

    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      fireAndForget(handleDeleteFolder(folder.id, folder.name), "handleDeleteFolder failed");
    });

    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        return;
      }

      if (!hasNestedContent) {
        return;
      }

      toggleButton.click();
    });

    node.append(row, childrenContainer);
    return node;
  }

  function renderFolders(listEl, folders, chatToFolderMap) {
    listEl.innerHTML = "";

    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "gfo-empty-state";
      empty.textContent = "No folders yet";
      listEl.appendChild(empty);
      return;
    }

    folders.forEach((folder) => {
      listEl.appendChild(renderFolderNode(folder, 0, chatToFolderMap || {}));
    });
  }

  function mountRoot(sidebar, root) {
    const wrapper = findSidebarWrapper(sidebar);
    if (!wrapper) {
      return false;
    }

    const anchor = wrapper.querySelector(
      'side-nav-entry-button[data-test-id="my-stuff-side-nav-entry-button"]'
    );

    if (!anchor) {
      return false;
    }

    if (root.parentElement !== anchor.parentElement || root.previousElementSibling !== anchor) {
      anchor.insertAdjacentElement("afterend", root);
    }

    return true;
  }

  async function injectFoldersUI(sidebar) {
    try {
      if (!sidebar) {
        return;
      }

      const historyContainer = findHistoryContainer(sidebar);
      if (!historyContainer) {
        return;
      }

      const existing = document.getElementById(ROOT_ID);
      if (existing) {
        const mounted = mountRoot(sidebar, existing);
        if (!mounted) {
          return;
        }

        activeFoldersRoot = existing;
        activeFoldersList = existing.querySelector(".gfo-list");
        syncState(existing, historyContainer);
        watchState(existing, historyContainer);
        bindFolderContextMenuListener();
        await refreshFolderUI();
        return;
      }

      const root = document.createElement("section");
      root.id = ROOT_ID;
      root.className = "gfo-root";
      root.setAttribute("aria-label", "Folders");

      const header = document.createElement("div");
      header.className = "gfo-header";

      const titleIcon = createFolderIcon();

      const title = document.createElement("h3");
      title.className = "gfo-title";
      title.textContent = "Folders";

      const newFolderButton = document.createElement("button");
      newFolderButton.type = "button";
      newFolderButton.className = "gfo-new-folder";
      newFolderButton.setAttribute("aria-label", "New Folder");

      const newFolderButtonIcon = document.createElement("span");
      newFolderButtonIcon.className = "gfo-button-icon";
      newFolderButtonIcon.textContent = "+";
      newFolderButtonIcon.setAttribute("aria-hidden", "true");

      const newFolderButtonLabel = document.createElement("span");
      newFolderButtonLabel.className = "gfo-button-label";
      newFolderButtonLabel.textContent = "New Folder";

      newFolderButton.append(newFolderButtonIcon, newFolderButtonLabel);

      const list = document.createElement("div");
      list.className = "gfo-list";

      header.append(titleIcon, title, newFolderButton);
      root.append(header, list);

      const mounted = mountRoot(sidebar, root);
      if (!mounted) {
        return;
      }

      activeFoldersRoot = root;
      activeFoldersList = list;
      syncState(root, historyContainer);
      watchState(root, historyContainer);
      bindFolderContextMenuListener();

      const state = await loadFolderState();
      renderFolders(list, state.folders, state.chatToFolderMap);
      syncSelectedCustomChatFromCurrentPath();

      newFolderButton.addEventListener("click", () => {
        fireAndForget(handleCreateFolder(), "handleCreateFolder failed");
      });
    } catch (error) {
      warnIfUnexpected(error, "safe inject skipped due to runtime error");
    }
  }

  function observeGeminiSidebar() {
    if (!isContextAlive) {
      return;
    }

    const tryInject = () => {
      if (!isContextAlive) {
        return;
      }

      if (document.getElementById(ROOT_ID)) {
        return;
      }

      const sidebar = findSidebar();
      if (sidebar) {
        fireAndForget(injectFoldersUI(sidebar), "injectFoldersUI failed");
      }
    };

    tryInject();

    if (sidebarObserver) {
      sidebarObserver.disconnect();
      sidebarObserver = null;
    }

    sidebarObserver = new MutationObserver(() => {
      if (!isContextAlive || !sidebarObserver) {
        return;
      }

      bindFolderContextMenuListener();
      scheduleEnsureQuickAddButton();
      syncSelectedCustomChatFromCurrentPath();
      tryInject();
    });

    if (!sidebarObserver || !isContextAlive || !document.documentElement) {
      return;
    }

    sidebarObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function startWhenReady() {
    function handleUnhandledRejection(event) {
      try {
        if (isExtensionContextInvalidated(event.reason)) {
          event.preventDefault();
          shutdownOnContextInvalidation();
        }
      } catch {
        shutdownOnContextInvalidation();
      }
    }

    function handleGlobalError(event) {
      try {
        const candidate = event.error || event.message;
        if (isExtensionContextInvalidated(candidate)) {
          event.preventDefault();
          shutdownOnContextInvalidation();
        }
      } catch {
        shutdownOnContextInvalidation();
      }
    }

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleGlobalError);
    window.addEventListener("popstate", () => {
      syncSelectedCustomChatFromCurrentPath();
    });

    const init = () => {
      setTimeout(() => {
        observeGeminiSidebar();
        observeMainHeaderArea();
        ensureQuickAddButton();
        syncSelectedCustomChatFromCurrentPath();
      }, 1000);
    };

    if (document.readyState === "complete") {
      init();
      return;
    }

    window.addEventListener("load", init, { once: true });
  }

  startWhenReady();
})();
