(() => {
  // Main entry point for the Gemini Folders extension

  const GF = window.GeminiFolders;

  const ROOT_ID = "gfo-folders-root";
  const QUICK_ADD_BUTTON_ID = "gfo-quick-add";
  const QUICK_ADD_MENU_ID = "gfo-quick-add-menu";

  // Global state
  GF.expandedFolderIds = new Set();
  GF.activeFoldersRoot = null;
  GF.activeFoldersList = null;
  GF.sidebarObserver = null;
  GF.mainHeaderObserver = null;
  GF.activeChatContext = null;
  GF.folderContextMenu = null;
  GF.folderContextMenuOutsideHandler = null;
  GF.folderContextMenuBound = false;
  GF.quickAddMenu = null;
  GF.quickAddMenuOutsideHandler = null;
  GF.quickAddEnsureScheduled = false;
  GF.isContextAlive = true;
  let userContextRefreshScheduled = false;

  GF.shutdownOnContextInvalidation = function() {
    if (!GF.isContextAlive) {
      return;
    }

    GF.isContextAlive = false;
    userContextRefreshScheduled = false;

    if (GF.sidebarObserver) {
      GF.sidebarObserver.disconnect();
      GF.sidebarObserver = null;
    }

    if (GF.mainHeaderObserver) {
      GF.mainHeaderObserver.disconnect();
      GF.mainHeaderObserver = null;
    }

    GF.closeFolderContextMenu();
    GF.closeQuickAddMenu();

    GF.activeFoldersRoot = null;
    GF.activeFoldersList = null;
    GF.activeChatContext = null;
    GF.quickAddEnsureScheduled = false;
    GF.folderContextMenuBound = false;
  };

  GF.warnIfUnexpected = function(error, scope) {
    if (GF.isExtensionContextInvalidated(error)) {
      GF.shutdownOnContextInvalidation();
      return;
    }

    if (!GF.isExtensionContextInvalidated(error)) {
      console.warn(`Gemini Folders: ${scope}`, error);
    }
  };

  GF.scheduleUserContextRefresh = function() {
    if (userContextRefreshScheduled || !GF.activeFoldersRoot || !GF.activeFoldersList) {
      return;
    }

    userContextRefreshScheduled = true;

    GF.fireAndForget(
      (async () => {
        try {
          if (!GF.isContextAlive) {
            return;
          }

          await GF.refreshFolderUI();
        } finally {
          userContextRefreshScheduled = false;
        }
      })(),
      "refreshFolderUI after user switch failed"
    );
  };

  GF.syncUserContextWrapper = function() {
    const changed = GF.syncUserContext();
    if (!changed) {
      return false;
    }

    GF.closeFolderContextMenu();
    GF.closeQuickAddMenu();

    if (GF.activeFoldersList) {
      GF.activeFoldersList.innerHTML = "";
    }

    GF.scheduleUserContextRefresh();
    return true;
  };

  GF.getFolderIDsForChatEntry = function(entry) {
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
  };

  GF.getChatFolderState = function(chatToFolderMap, chatId) {
    const entry = GF.normalizeChatMappingEntry(chatToFolderMap?.[chatId]);
    return {
      entry,
      folderIDs: GF.getFolderIDsForChatEntry(entry)
    };
  };

  GF.assignChatToFolder = async function(chatContext, folderId) {
    if (!chatContext || !chatContext.chatId || !folderId) {
      return false;
    }

    const state = await GF.loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };
    const currentFolderIDs = GF.getFolderIDsForChatEntry(nextMap[chatContext.chatId]);

    nextMap[chatContext.chatId] = {
      folderIDs: Array.from(new Set([...currentFolderIDs, folderId])),
      title: chatContext.title || "Untitled Chat"
    };

    return GF.saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
  };

  GF.removeChatFromFolder = async function(chatId, folderId = null) {
    if (!chatId) {
      return false;
    }

    const state = await GF.loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };
    const currentEntry = GF.normalizeChatMappingEntry(nextMap[chatId]);

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

    return GF.saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
  };

  GF.saveCurrentChatToFolder = async function(folderId) {
    const chatId = GF.getCurrentChatIdFromPath();
    if (!chatId || !folderId) {
      return false;
    }

    const state = await GF.loadFolderState();
    const nextMap = { ...(state.chatToFolderMap || {}) };
    const currentFolderIDs = GF.getFolderIDsForChatEntry(nextMap[chatId]);

    nextMap[chatId] = {
      folderIDs: Array.from(new Set([...currentFolderIDs, folderId])),
      title: GF.getCurrentChatTitle()
    };

    return GF.saveFolderState({
      ...state,
      chatToFolderMap: nextMap
    });
  };

  GF.closeFolderContextMenu = function() {
    if (GF.folderContextMenu) {
      GF.folderContextMenu.remove();
      GF.folderContextMenu = null;
    }

    if (GF.folderContextMenuOutsideHandler) {
      document.removeEventListener("pointerdown", GF.folderContextMenuOutsideHandler, true);
      GF.folderContextMenuOutsideHandler = null;
    }

    GF.activeChatContext = null;
  };

  GF.closeQuickAddMenu = function() {
    if (GF.quickAddMenu) {
      GF.quickAddMenu.remove();
      GF.quickAddMenu = null;
    }

    if (GF.quickAddMenuOutsideHandler) {
      document.removeEventListener("pointerdown", GF.quickAddMenuOutsideHandler, true);
      GF.quickAddMenuOutsideHandler = null;
    }
  };

  GF.removeQuickAddButton = function() {
    const existingSlot = document.getElementById("gfo-quick-add-slot");
    if (existingSlot) {
      existingSlot.remove();
      return;
    }

    const existingButton = document.getElementById(QUICK_ADD_BUTTON_ID);
    if (existingButton) {
      existingButton.remove();
    }
  };

  GF.refreshFolderUI = async function() {
    if (!GF.activeFoldersRoot || !GF.activeFoldersList) {
      return;
    }

    const state = await GF.loadFolderState();
    GF.renderFolders(GF.activeFoldersList, state.folders, state.chatToFolderMap);
    GF.syncState(GF.activeFoldersRoot, GF.findHistoryContainer(GF.findSidebar()));
    GF.syncSelectedCustomChatFromCurrentPath();
  };

  GF.handleCreateFolder = async function(parentId = null) {
    const folderLabel = parentId ? "Sub-folder name:" : "Folder name:";
    const folderName = prompt(folderLabel);
    if (!folderName || !folderName.trim()) {
      return;
    }

    const created = await GF.createFolder(folderName, parentId);
    if (created) {
      await GF.refreshFolderUI();
    }
  };

  GF.handleDeleteFolder = async function(folderId, folderName) {
    const confirmed = confirm(`Delete folder "${folderName}" and all nested folders?`);
    if (!confirmed) {
      return;
    }

    const deleted = await GF.deleteFolder(folderId);
    if (deleted) {
      await GF.refreshFolderUI();
    }
  };

  GF.insertFolderIntoTree = function(folders, parentId, newFolder) {
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
        const childResult = GF.insertFolderIntoTree(folder.children, parentId, newFolder);
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
  };

  GF.removeFolderFromTree = function(folders, targetId) {
    let removed = false;
    const removedIds = [];

    const nextFolders = folders.flatMap((folder) => {
      if (folder.id === targetId) {
        removed = true;
        removedIds.push(...GF.collectFolderIds(folder));
        return [];
      }

      if (Array.isArray(folder.children) && folder.children.length) {
        const childResult = GF.removeFolderFromTree(folder.children, targetId);
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
  };

  GF.clearMappingsForFolderIds = function(mappings, folderIds) {
    const folderIdSet = new Set(folderIds);
    const nextMappings = {};

    Object.entries(mappings || {}).forEach(([chatId, entry]) => {
      const normalizedEntry = GF.normalizeChatMappingEntry(entry);
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
  };

  GF.createFolder = async function(name, parentId = null) {
    const folderName = name.trim();
    if (!folderName) {
      return false;
    }

    const state = await GF.loadFolderState();
    const newFolder = {
      id: GF.createFolderId(),
      name: folderName,
      children: []
    };

    let nextFolders = state.folders;

    if (parentId) {
      const insertion = GF.insertFolderIntoTree(state.folders, parentId, newFolder);
      if (!insertion.inserted) {
        return false;
      }

      nextFolders = insertion.folders;
    } else {
      nextFolders = [...state.folders, newFolder];
    }

    const saved = await GF.saveFolderState({
      ...state,
      folders: nextFolders
    });

    return saved;
  };

  GF.deleteFolder = async function(folderId) {
    const state = await GF.loadFolderState();
    const removal = GF.removeFolderFromTree(state.folders, folderId);

    if (!removal.removed) {
      return false;
    }

    removal.removedIds.forEach((id) => GF.expandedFolderIds.delete(id));

    const saved = await GF.saveFolderState({
      ...state,
      folders: removal.folders,
      chatToFolderMap: GF.clearMappingsForFolderIds(state.chatToFolderMap, removal.removedIds)
    });

    return saved;
  };

  GF.findHeaderActionGroup = function() {
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
  };

  GF.openQuickAddMenu = async function(anchorButton) {
    GF.closeQuickAddMenu();

    const state = await GF.loadFolderState();
    const folders = GF.flattenFolderTree(state.folders);
    const chatId = GF.getCurrentChatIdFromPath();
    const chatState = GF.getChatFolderState(state.chatToFolderMap, chatId);
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

          GF.fireAndForget(
            (async () => {
              const saved = folderIDSet.has(folder.id)
                ? await GF.removeChatFromFolder(chatId, folder.id)
                : await GF.saveCurrentChatToFolder(folder.id);
              if (saved) {
                await GF.refreshFolderUI();
                GF.openQuickAddMenu(anchorButton);
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

    GF.quickAddMenu = menu;

    GF.quickAddMenuOutsideHandler = (event) => {
      if (GF.quickAddMenu && GF.quickAddMenu.contains(event.target)) {
        return;
      }

      if (anchorButton.contains(event.target)) {
        return;
      }

      GF.closeQuickAddMenu();
    };

    document.addEventListener("pointerdown", GF.quickAddMenuOutsideHandler, true);
  };

  GF.ensureQuickAddButton = function() {
    if (!GF.isContextAlive) {
      return;
    }

    if (!GF.getCurrentChatIdFromPath()) {
      GF.closeQuickAddMenu();
      GF.removeQuickAddButton();
      return;
    }

    const actionGroup = GF.findHeaderActionGroup();
    if (!actionGroup) {
      return;
    }

    const actionHost = actionGroup.closest?.("conversation-actions-icon") || actionGroup.querySelector?.("conversation-actions-icon") || null;
    const actionsMenuButton = actionHost?.querySelector?.('button[aria-label*="Open menu for conversation actions" i]') || null;

    let slot = document.getElementById("gfo-quick-add-slot");

    let button = document.getElementById(QUICK_ADD_BUTTON_ID);

    if (!button) {
      button = document.createElement("button");
      button.id = QUICK_ADD_BUTTON_ID;
      button.type = "button";
      button.className = "gfo-quick-add";
      button.setAttribute("aria-label", "Add current chat to folder");
      button.innerHTML = GF.getQuickAddFolderIconMarkup();

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (GF.quickAddMenu) {
          GF.closeQuickAddMenu();
          return;
        }

        GF.fireAndForget(GF.openQuickAddMenu(button), "openQuickAddMenu failed");
      });
    }

    if (!slot) {
      slot = document.createElement("span");
      slot.id = "gfo-quick-add-slot";
      slot.className = "gfo-quick-add-slot";
    }

    if (button.parentElement !== slot) {
      slot.appendChild(button);
    }

    if (actionHost?.parentElement && actionsMenuButton) {
      if (slot.parentElement !== actionHost || slot.previousElementSibling !== actionsMenuButton) {
        actionsMenuButton.insertAdjacentElement("afterend", slot);
      }
      return;
    }

    if (slot.parentElement !== actionGroup) {
      actionGroup.appendChild(slot);
    }
  };

  GF.scheduleEnsureQuickAddButton = function() {
    if (GF.quickAddEnsureScheduled) {
      return;
    }

    GF.quickAddEnsureScheduled = true;

    requestAnimationFrame(() => {
      GF.quickAddEnsureScheduled = false;
      GF.ensureQuickAddButton();
    });
  };

  GF.openFolderContextMenu = async function(event, chatContext) {
    if (!GF.isContextAlive || !chatContext) {
      return;
    }

    GF.closeFolderContextMenu();

    const state = await GF.loadFolderState();
    const folders = GF.flattenFolderTree(state.folders);
    const chatState = GF.getChatFolderState(state.chatToFolderMap, chatContext.chatId);
    const mappedEntry = chatState.entry;
    const folderIDSet = new Set(chatState.folderIDs);

    const menu = document.createElement("div");
    menu.id = "gfo-folder-context-menu";
    menu.className = "gfo-folder-context-menu";

    const header = document.createElement("div");
    header.className = "gfo-folder-context-menu-header";
    header.textContent = `Add "${chatContext.title}" to:`;
    menu.appendChild(header);

    const removeItem = document.createElement("button");
    removeItem.type = "button";
    removeItem.className = "gfo-folder-context-menu-item gfo-folder-context-menu-item-remove";
    removeItem.textContent = "Remove from folder";
    removeItem.disabled = !mappedEntry || !chatContext.folderId;
    removeItem.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      GF.fireAndForget(
        (async () => {
          const saved = await GF.removeChatFromFolder(chatContext.chatId, chatContext.folderId);
          if (saved) {
            await GF.refreshFolderUI();
            GF.closeFolderContextMenu();
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
          GF.fireAndForget(
            (async () => {
              const saved = folderIDSet.has(folder.id)
                ? await GF.removeChatFromFolder(chatContext.chatId, folder.id)
                : await GF.assignChatToFolder(chatContext, folder.id);
              if (saved) {
                await GF.refreshFolderUI();
                GF.openFolderContextMenu(event, chatContext);
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

    GF.folderContextMenu = menu;

    GF.folderContextMenuOutsideHandler = (pointerEvent) => {
      if (GF.folderContextMenu && GF.folderContextMenu.contains(pointerEvent.target)) {
        return;
      }

      GF.closeFolderContextMenu();
    };

    document.addEventListener("pointerdown", GF.folderContextMenuOutsideHandler, true);
  };

  GF.bindFolderContextMenuListener = function() {
    if (GF.folderContextMenuBound) {
      return;
    }

    GF.folderContextMenuBound = true;

    document.addEventListener(
      "contextmenu",
      (event) => {
        if (!GF.isContextAlive) {
          return;
        }

        const link = event.target.closest("a[data-test-id=\"conversation\"]");
        const customChat = event.target.closest(".gfo-folder-chat-item");

        if (!link && !customChat) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();

        const chatId = link ? GF.extractChatIdFromLink(link) : customChat.dataset.chatId || null;
        if (!chatId) {
          return;
        }

        GF.activeChatContext = {
          chatId,
          folderId: customChat?.dataset.folderId || null,
          title: link ? GF.getChatDisplayTitleFromLink(link) : (customChat.dataset.chatTitle || customChat.textContent || "Untitled Chat").trim()
        };

        GF.fireAndForget(GF.openFolderContextMenu(event, GF.activeChatContext), "openFolderContextMenu failed");
      },
      true
    );
  };

  GF.observeMainHeaderArea = function() {
    if (!GF.isContextAlive) {
      return;
    }

    GF.syncUserContextWrapper();

    const target = document.querySelector("main") || document.body;
    if (!target) {
      return;
    }

    if (GF.mainHeaderObserver) {
      GF.mainHeaderObserver.disconnect();
      GF.mainHeaderObserver = null;
    }

    GF.ensureQuickAddButton();

    GF.mainHeaderObserver = new MutationObserver(() => {
      if (!GF.isContextAlive || !GF.mainHeaderObserver) {
        return;
      }

      GF.syncUserContextWrapper();
      GF.scheduleEnsureQuickAddButton();
    });

    GF.mainHeaderObserver.observe(target, {
      childList: true,
      subtree: true
    });
  };

  GF.observeGeminiSidebar = function() {
    if (!GF.isContextAlive) {
      return;
    }

    const sidebarProbeSelector = "bard-sidenav, nav[aria-label*='Recent' i], .sidenav-with-history-container";

    const hasRecentChatList = () => {
      const recentNav = document.querySelector("nav[aria-label*='Recent' i]");
      if (!recentNav) {
        return false;
      }

      // Some layouts show an empty Recent section before list entries are hydrated.
      return Boolean(recentNav.querySelector("a[href*='/app/'], [data-test-id*='conversation' i]")) || recentNav.childElementCount > 0;
    };

    const mutationTouchesSidebar = (mutations) => {
      return mutations.some((mutation) => {
        return Array.from(mutation.addedNodes || []).some((node) => {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) {
            return false;
          }

          return (
            (node.matches && node.matches(sidebarProbeSelector)) ||
            (node.querySelector && node.querySelector(sidebarProbeSelector))
          );
        });
      });
    };

    const tryInject = () => {
      if (!GF.isContextAlive) {
        return;
      }

      GF.syncUserContextWrapper();

      const sidebar = GF.findSidebar();
      if (!sidebar) {
        return;
      }

      const existingRoot = document.getElementById(ROOT_ID);
      if (existingRoot) {
        if (!sidebar.contains(existingRoot)) {
          GF.fireAndForget(GF.injectFoldersUI(sidebar), "injectFoldersUI remount failed");
        }
        return;
      }

      if (hasRecentChatList() || sidebar.matches("bard-sidenav") || sidebar.querySelector(".sidenav-with-history-container")) {
        GF.fireAndForget(GF.injectFoldersUI(sidebar), "injectFoldersUI failed");
      }
    };

    tryInject();

    if (GF.sidebarObserver) {
      GF.sidebarObserver.disconnect();
      GF.sidebarObserver = null;
    }

    GF.sidebarObserver = new MutationObserver((mutations) => {
      if (!GF.isContextAlive || !GF.sidebarObserver) {
        return;
      }

      const rootExists = Boolean(document.getElementById(ROOT_ID));
      if (!rootExists && !mutationTouchesSidebar(mutations) && !hasRecentChatList()) {
        return;
      }

      GF.syncUserContextWrapper();
      GF.bindFolderContextMenuListener();
      GF.scheduleEnsureQuickAddButton();
      GF.syncSelectedCustomChatFromCurrentPath();
      tryInject();
    });

    if (!GF.sidebarObserver || !GF.isContextAlive || !document.documentElement) {
      return;
    }

    GF.sidebarObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  // Startup
  function startWhenReady() {
    function handleUnhandledRejection(event) {
      try {
        if (GF.isExtensionContextInvalidated(event.reason)) {
          event.preventDefault();
          GF.shutdownOnContextInvalidation();
        }
      } catch {
        GF.shutdownOnContextInvalidation();
      }
    }

    function handleGlobalError(event) {
      try {
        const candidate = event.error || event.message;
        if (GF.isExtensionContextInvalidated(candidate)) {
          event.preventDefault();
          GF.shutdownOnContextInvalidation();
        }
      } catch {
        GF.shutdownOnContextInvalidation();
      }
    }

    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    window.addEventListener("error", handleGlobalError);
    window.addEventListener("focus", () => {
      GF.syncUserContextWrapper();
    });
    window.addEventListener("popstate", () => {
      GF.syncSelectedCustomChatFromCurrentPath();
    });
    window.addEventListener("pagehide", () => {
      GF.shutdownOnContextInvalidation();
    });
    window.addEventListener("beforeunload", () => {
      GF.shutdownOnContextInvalidation();
    });

    const init = () => {
      setTimeout(() => {
        GF.syncUserContextWrapper();
        GF.observeGeminiSidebar();
        GF.observeMainHeaderArea();
        GF.ensureQuickAddButton();
        GF.syncSelectedCustomChatFromCurrentPath();
      }, 1000);
    };

    if (document.readyState === "complete") {
      init();
      return;
    }

    window.addEventListener("load", init, { once: true });
  }

  // Message listener for popup refresh
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.action !== "refreshUI") {
        return;
      }

      GF.fireAndForget(GF.refreshFolderUI(), "refreshFolderUI message failed");
    });
  }

  startWhenReady();
})();
