(() => {
  const STORAGE_KEY = "geminiFolders";
  const ROOT_ID = "gfo-folders-root";
  const CHAT_LINK_SELECTOR = 'a[data-test-id="conversation"]';
  const MOVE_MENU_ID = "gfo-move-menu";
  const collapsedFolderIds = new Set();
  let activeFoldersRoot = null;
  let activeFoldersList = null;
  let activeFolderFilterId = null;
  let nativeChatObserver = null;
  let moveMenuOutsideHandler = null;

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

  function normalizeMappings(value) {
    return isPlainObject(value) ? { ...value } : {};
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
        chatToFolderMap: normalizeMappings(rawState.chatToFolderMap ?? rawState.chatFolderMappings)
      };
    }

    return {
      folders: [],
      chatToFolderMap: {}
    };
  }

  function mappingsNeedMigration(rawState) {
    if (!isPlainObject(rawState)) {
      return false;
    }

    if (rawState.chatToFolderMap !== undefined && !isPlainObject(rawState.chatToFolderMap)) {
      return true;
    }

    return !("chatToFolderMap" in rawState) && Object.keys(normalizeMappings(rawState.chatFolderMappings)).length > 0;
  }

  async function getFolders() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const state = normalizeState(result[STORAGE_KEY]);
    return state.folders;
  }

  async function loadFolderState() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const rawState = result[STORAGE_KEY];
    const state = normalizeState(rawState);

    if (folderTreeNeedsMigration(rawState?.folders ?? rawState) || mappingsNeedMigration(rawState)) {
      await saveFolderState(state);
    }

    return state;
  }

  async function saveFolderState(state) {
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
  }

  function collectFolderIds(folder) {
    const folderIds = [folder.id];

    (folder.children || []).forEach((child) => {
      folderIds.push(...collectFolderIds(child));
    });

    return folderIds;
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

    Object.entries(mappings || {}).forEach(([chatId, folderId]) => {
      if (!folderIdSet.has(folderId)) {
        nextMappings[chatId] = folderId;
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

    await saveFolderState({
      ...state,
      folders: nextFolders
    });

    return true;
  }

  async function deleteFolder(folderId) {
    const state = await loadFolderState();
    const removal = removeFolderFromTree(state.folders, folderId);

    if (!removal.removed) {
      return false;
    }

    removal.removedIds.forEach((id) => collapsedFolderIds.delete(id));

    await saveFolderState({
      ...state,
      folders: removal.folders,
      chatToFolderMap: clearMappingsForFolderIds(state.chatToFolderMap, removal.removedIds)
    });

    return true;
  }

  function extractChatIdFromLink(link) {
    try {
      const url = new URL(link.href, window.location.origin);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts.pop() || null;
    } catch {
      return null;
    }
  }

  function getNativeChatItem(link) {
    return link.closest("side-nav-entry-button") || link.parentElement || link;
  }

  async function setChatFolderMapping(chatId, folderId) {
    if (!chatId) {
      return;
    }

    const state = await loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };

    if (!folderId) {
      delete nextMap[chatId];
    } else {
      nextMap[chatId] = folderId;
    }

    await saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
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

  function closeMoveMenu() {
    const existing = document.getElementById(MOVE_MENU_ID);
    if (existing) {
      existing.remove();
    }

    if (moveMenuOutsideHandler) {
      document.removeEventListener("pointerdown", moveMenuOutsideHandler, true);
      moveMenuOutsideHandler = null;
    }
  }

  async function openMoveMenu(triggerButton, chatId) {
    closeMoveMenu();

    const state = await loadFolderState();
    const rows = flattenFolderTree(state.folders);
    const currentFolderId = state.chatToFolderMap?.[chatId] || null;

    const menu = document.createElement("div");
    menu.id = MOVE_MENU_ID;
    menu.className = "gfo-move-menu";

    const removeItem = document.createElement("button");
    removeItem.type = "button";
    removeItem.className = "gfo-move-menu-item";
    removeItem.textContent = "Remove from folder";
    removeItem.classList.toggle("is-active", !currentFolderId);
    removeItem.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await setChatFolderMapping(chatId, null);
      await applyCurrentFolderFilter();
      closeMoveMenu();
    });
    menu.appendChild(removeItem);

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "gfo-move-menu-empty";
      empty.textContent = "No folders available";
      menu.appendChild(empty);
    } else {
      rows.forEach((row) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "gfo-move-menu-item";
        item.style.paddingLeft = `${12 + row.depth * 14}px`;
        item.textContent = row.name;
        item.classList.toggle("is-active", currentFolderId === row.id);
        item.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          await setChatFolderMapping(chatId, row.id);
          await applyCurrentFolderFilter();
          closeMoveMenu();
        });
        menu.appendChild(item);
      });
    }

    document.body.appendChild(menu);

    const rect = triggerButton.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const top = Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + 6);
    const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rect.right - menuRect.width));
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${left}px`;

    moveMenuOutsideHandler = (event) => {
      if (menu.contains(event.target) || triggerButton.contains(event.target)) {
        return;
      }

      closeMoveMenu();
    };

    document.addEventListener("pointerdown", moveMenuOutsideHandler, true);
  }

  function ensureMoveButtonForChat(link) {
    const row = getNativeChatItem(link);
    if (!row) {
      return;
    }

    row.classList.add("gfo-native-chat-item");

    if (row.querySelector(".gfo-chat-move-button")) {
      return;
    }

    const moveButton = document.createElement("button");
    moveButton.type = "button";
    moveButton.className = "gfo-chat-move-button";
    moveButton.setAttribute("aria-label", "Move chat to folder");
    moveButton.textContent = "\ud83d\udcc1";

    moveButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const chatId = extractChatIdFromLink(link);
      if (!chatId) {
        return;
      }

      openMoveMenu(moveButton, chatId);
    });

    row.appendChild(moveButton);
  }

  function injectMoveButtons(sidebar) {
    sidebar.querySelectorAll(CHAT_LINK_SELECTOR).forEach((link) => {
      ensureMoveButtonForChat(link);
    });
  }

  async function applyCurrentFolderFilter() {
    const sidebar = findSidebar();
    if (!sidebar) {
      return;
    }

    const state = await loadFolderState();
    const map = state.chatToFolderMap || {};

    sidebar.querySelectorAll(CHAT_LINK_SELECTOR).forEach((link) => {
      const row = getNativeChatItem(link);
      if (!row) {
        return;
      }

      const chatId = extractChatIdFromLink(link);
      if (!activeFolderFilterId || !chatId) {
        row.classList.remove("gfo-hidden");
        return;
      }

      row.classList.toggle("gfo-hidden", map[chatId] !== activeFolderFilterId);
    });
  }

  function observeNativeChatList(sidebar) {
    if (nativeChatObserver) {
      nativeChatObserver.disconnect();
      nativeChatObserver = null;
    }

    injectMoveButtons(sidebar);
    applyCurrentFolderFilter();

    nativeChatObserver = new MutationObserver(() => {
      injectMoveButtons(sidebar);
      applyCurrentFolderFilter();
    });

    nativeChatObserver.observe(sidebar, {
      childList: true,
      subtree: true
    });
  }

  async function setActiveFolderFilter(folderId) {
    activeFolderFilterId = folderId;

    if (activeFoldersList) {
      activeFoldersList.querySelectorAll(".gfo-folder-item").forEach((row) => {
        row.classList.toggle("gfo-folder-item--active", row.dataset.folderId === activeFolderFilterId);
      });
    }

    await applyCurrentFolderFilter();
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

  function createDot(className) {
    const dot = document.createElement("span");
    dot.className = className;
    dot.setAttribute("aria-hidden", "true");
    return dot;
  }

  function isFolderCollapsed(folderId) {
    return collapsedFolderIds.has(folderId);
  }

  function setFolderCollapsed(folderId, collapsed) {
    if (collapsed) {
      collapsedFolderIds.add(folderId);
      return;
    }

    collapsedFolderIds.delete(folderId);
  }

  async function refreshFolderUI() {
    if (!activeFoldersRoot || !activeFoldersList) {
      return;
    }

    const state = await loadFolderState();
    renderFolders(activeFoldersList, state.folders);
    syncState(activeFoldersRoot, findHistoryContainer(findSidebar()));
    await applyCurrentFolderFilter();
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

  function renderFolderNode(folder, depth = 0) {
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

    row.classList.toggle("gfo-folder-item--active", folder.id === activeFolderFilterId);

    const hasChildren = Array.isArray(folder.children) && folder.children.length > 0;
    const isCollapsed = isFolderCollapsed(folder.id);

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "gfo-toggle-folder";
    toggleButton.textContent = isCollapsed ? ">" : "v";
    toggleButton.setAttribute("aria-label", isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`);
    toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
    toggleButton.classList.toggle("is-open", !isCollapsed);

    const icon = createDot("gfo-folder-dot");

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

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "gfo-folder-action gfo-folder-action-delete";
    deleteButton.textContent = "×";
    deleteButton.setAttribute("aria-label", `Delete ${folder.name}`);

    actions.append(addSubFolderButton, deleteButton);

    row.append(toggleButton, icon, label, actions);

    const childrenContainer = document.createElement("div");
    childrenContainer.className = "gfo-folder-children";
    childrenContainer.style.display = isCollapsed ? "none" : "flex";

    if (hasChildren) {
      folder.children.forEach((childFolder) => {
        childrenContainer.appendChild(renderFolderNode(childFolder, depth + 1));
      });
    }

    toggleButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextCollapsed = childrenContainer.style.display !== "none";
      setFolderCollapsed(folder.id, nextCollapsed);
      childrenContainer.style.display = nextCollapsed ? "none" : "flex";
      toggleButton.classList.toggle("is-open", !nextCollapsed);
      toggleButton.setAttribute("aria-expanded", String(!nextCollapsed));
      toggleButton.setAttribute("aria-label", nextCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`);
      toggleButton.textContent = nextCollapsed ? ">" : "v";
    });

    addSubFolderButton.addEventListener("click", (event) => {
      event.stopPropagation();
      handleCreateFolder(folder.id);
    });

    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      handleDeleteFolder(folder.id, folder.name);
    });

    row.addEventListener("click", () => {
      setActiveFolderFilter(folder.id);
    });

    node.append(row, childrenContainer);
    return node;
  }

  function renderFolders(listEl, folders) {
    listEl.innerHTML = "";

    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "gfo-empty-state";
      empty.textContent = "No folders yet";
      listEl.appendChild(empty);
      return;
    }

    folders.forEach((folder) => {
      listEl.appendChild(renderFolderNode(folder));
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

        const clearFilterButton = existing.querySelector(".gfo-clear-filter");
        if (clearFilterButton && clearFilterButton.dataset.gfoBound !== "true") {
          clearFilterButton.dataset.gfoBound = "true";
          clearFilterButton.addEventListener("click", async () => {
            await setActiveFolderFilter(null);
          });
        }

        observeNativeChatList(sidebar);
        await refreshFolderUI();
        return;
      }

      const root = document.createElement("section");
      root.id = ROOT_ID;
      root.className = "gfo-root";
      root.setAttribute("aria-label", "Folders");

      const header = document.createElement("div");
      header.className = "gfo-header";

      const titleIcon = createDot("gfo-title-dot");

      const title = document.createElement("h3");
      title.className = "gfo-title";
      title.textContent = "Folders";

      const newFolderButton = document.createElement("button");
      newFolderButton.type = "button";
      newFolderButton.className = "gfo-new-folder";
      newFolderButton.setAttribute("aria-label", "New Folder");

      const clearFilterButton = document.createElement("button");
      clearFilterButton.type = "button";
      clearFilterButton.className = "gfo-clear-filter";
      clearFilterButton.textContent = "Show All";
      clearFilterButton.setAttribute("aria-label", "Show all chats");

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

      header.append(titleIcon, title, clearFilterButton, newFolderButton);
      root.append(header, list);

      const mounted = mountRoot(sidebar, root);
      if (!mounted) {
        return;
      }

      activeFoldersRoot = root;
      activeFoldersList = list;
      syncState(root, historyContainer);
      watchState(root, historyContainer);
      observeNativeChatList(sidebar);

      const state = await loadFolderState();
      renderFolders(list, state.folders);
      await applyCurrentFolderFilter();

      newFolderButton.addEventListener("click", async () => {
        await handleCreateFolder();
      });

      clearFilterButton.addEventListener("click", async () => {
        await setActiveFolderFilter(null);
      });
    } catch (error) {
      console.warn("Gemini Folders: safe inject skipped due to runtime error", error);
    }
  }

  function observeGeminiSidebar() {
    let observer;

    const tryInject = () => {
      const sidebar = findSidebar();
      if (sidebar) {
        injectFoldersUI(sidebar);
      }
    };

    tryInject();

    observer = new MutationObserver(() => {
      observer.disconnect();
      tryInject();
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function startWhenReady() {
    const init = () => {
      setTimeout(() => {
        observeGeminiSidebar();
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
