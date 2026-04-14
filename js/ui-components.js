(() => {
  // UI component creation and rendering for the Gemini Folders extension

  const GF = window.GeminiFolders;

  const ROOT_ID = "gfo-folders-root";
  const QUICK_ADD_BUTTON_ID = "gfo-quick-add";
  const QUICK_ADD_MENU_ID = "gfo-quick-add-menu";
  const TOAST_ID = "gfo-login-toast";
  const TOAST_DISMISSED_KEY = "gfoLoginToastDismissed";

  GF.createFolderId = function() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }

    return `folder_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  GF.collectFolderIds = function(folder) {
    const folderIds = [folder.id];

    (folder.children || []).forEach((child) => {
      folderIds.push(...GF.collectFolderIds(child));
    });

    return folderIds;
  };

  GF.flattenFolderTree = function(folders, depth = 0) {
    const rows = [];

    folders.forEach((folder) => {
      rows.push({
        id: folder.id,
        name: folder.name,
        depth
      });

      if (Array.isArray(folder.children) && folder.children.length) {
        rows.push(...GF.flattenFolderTree(folder.children, depth + 1));
      }
    });

    return rows;
  };

  GF.getChatsForFolder = function(folderId, chatToFolderMap) {
    return Object.entries(chatToFolderMap || {})
      .filter(([, entry]) => Array.isArray(entry?.folderIDs) && entry.folderIDs.includes(folderId))
      .map(([chatId, entry]) => ({
        chatId,
        title: entry.title || "Untitled Chat"
      }))
      .sort((left, right) => left.title.localeCompare(right.title));
  };

  GF.getFolderStateIconMarkup = function(isOpen) {
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
  };

  GF.getQuickAddFolderIconMarkup = function() {
    return `
      <svg class="gfo-quick-add-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v-2H4V8h16v3h2V8c0-1.1-.9-2-2-2Z"></path>
        <path d="M16 12c-.55 0-1 .45-1 1v2h-2c-.55 0-1 .45-1 1s.45 1 1 1h2v2c0 .55.45 1 1 1s1-.45 1-1v-2h2c.55 0 1-.45 1-1s-.45-1-1-1h-2v-2c0-.55-.45-1-1-1Z"></path>
      </svg>
    `;
  };

  GF.createFolderIcon = function() {
    const icon = document.createElement("span");
    icon.className = "gfo-title-dot gfo-title-folder-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
        <path d="M3 7.5C3 6.12 4.12 5 5.5 5h4.38c.53 0 1.04.21 1.41.59L12.7 7H18.5C19.88 7 21 8.12 21 9.5v7c0 1.38-1.12 2.5-2.5 2.5h-13C4.12 19 3 17.88 3 16.5v-9Z"></path>
      </svg>
    `;
    return icon;
  };

  GF.isFolderCollapsed = function(folderId) {
    return !GF.expandedFolderIds.has(folderId);
  };

  GF.setFolderCollapsed = function(folderId, collapsed) {
    if (collapsed) {
      GF.expandedFolderIds.delete(folderId);
      return;
    }

    GF.expandedFolderIds.add(folderId);
  };

  GF.renderFolderNode = function(folder, depth = 0, chatToFolderMap = {}) {
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

    const assignedChats = GF.getChatsForFolder(folder.id, chatToFolderMap);
    const hasChildren = Array.isArray(folder.children) && folder.children.length > 0;
    const hasNestedContent = hasChildren || assignedChats.length > 0;
    const isCollapsed = GF.isFolderCollapsed(folder.id);
    node.classList.toggle("gfo-folder-node--collapsed", isCollapsed);

    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "gfo-toggle-folder";
    toggleButton.innerHTML = GF.getFolderStateIconMarkup(!isCollapsed);
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
        childrenContainer.appendChild(GF.renderFolderNode(childFolder, depth + 1, chatToFolderMap));
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
        chatButton.href = GF.getChatUrl(chat.chatId);
        chatButton.setAttribute("aria-label", `Open ${chat.title}`);
        chatButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          GF.handleCustomChatItemClick(event, chat.chatId);
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
      GF.setFolderCollapsed(folder.id, nextCollapsed);
      node.classList.toggle("gfo-folder-node--collapsed", nextCollapsed);
      childrenContainer.hidden = nextCollapsed;
      childrenContainer.style.setProperty("display", nextCollapsed ? "none" : "flex", "important");
      toggleButton.classList.toggle("is-open", !nextCollapsed);
      toggleButton.setAttribute("aria-expanded", String(!nextCollapsed));
      toggleButton.setAttribute("aria-label", nextCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`);
      toggleButton.innerHTML = GF.getFolderStateIconMarkup(!nextCollapsed);
    });

    addSubFolderButton.addEventListener("click", (event) => {
      event.stopPropagation();
      GF.fireAndForget(GF.handleCreateFolder(folder.id), "handleCreateFolder failed");
    });

    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      GF.fireAndForget(GF.handleDeleteFolder(folder.id, folder.name), "handleDeleteFolder failed");
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
  };

  GF.renderFolders = function(listEl, folders, chatToFolderMap) {
    listEl.innerHTML = "";

    if (!folders.length) {
      const empty = document.createElement("div");
      empty.className = "gfo-empty-state";
      empty.textContent = "No folders yet";
      listEl.appendChild(empty);
      return;
    }

    folders.forEach((folder) => {
      listEl.appendChild(GF.renderFolderNode(folder, 0, chatToFolderMap || {}));
    });
  };

  GF.showLoginToast = function() {
    if (document.getElementById(TOAST_ID)) {
      return;
    }

    let isDismissed = false;
    try {
      isDismissed = sessionStorage.getItem(TOAST_DISMISSED_KEY) === "1";
    } catch {
      isDismissed = false;
    }

    if (isDismissed) {
      return;
    }

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.className = "gfo-toast";

    const message = document.createElement("span");
    message.className = "gfo-toast-message";
    message.textContent = "Log in to Gemini to organize your chats into folders.";

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "gfo-toast-dismiss";
    dismissButton.textContent = "Dismiss";
    dismissButton.setAttribute("aria-label", "Dismiss login message");
    dismissButton.addEventListener("click", () => {
      toast.remove();
      try {
        sessionStorage.setItem(TOAST_DISMISSED_KEY, "1");
      } catch {
        // Ignore sessionStorage failures.
      }
    });

    toast.append(message, dismissButton);
    document.body.appendChild(toast);
  };

  GF.findSidebar = function() {
    const bardSideNav = document.querySelector("bard-sidenav[role='navigation']") || document.querySelector("bard-sidenav");
    if (bardSideNav) {
      return bardSideNav;
    }

    return document.querySelector("nav[aria-label*='Recent' i]");
  };

  GF.findHistoryContainer = function(sidebar) {
    if (!sidebar) {
      return null;
    }

    return (
      sidebar.querySelector(".sidenav-with-history-container") ||
      sidebar.querySelector("nav[aria-label*='Recent' i]") ||
      (sidebar.matches("nav[aria-label*='Recent' i]") ? sidebar : null)
    );
  };

  GF.findSidebarWrapper = function(sidebar) {
    if (!sidebar) {
      return null;
    }

    return sidebar.closest("bard-sidenav, aside") || sidebar;
  };

  GF.isExpanded = function(historyContainer) {
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
  };

  GF.syncState = function(root, historyContainer) {
    const expanded = GF.isExpanded(historyContainer);
    root.classList.toggle("gfo-expanded", expanded);
    root.classList.toggle("gfo-collapsed", !expanded);
  };

  GF.watchState = function(root, historyContainer) {
    if (!historyContainer || historyContainer.dataset.gfoStateObserverAttached === "true") {
      return;
    }

    historyContainer.dataset.gfoStateObserverAttached = "true";

    const observer = new MutationObserver(() => {
      GF.syncState(root, historyContainer);
    });

    observer.observe(historyContainer, {
      attributes: true,
      attributeFilter: ["class"]
    });
  };

  GF.mountRoot = function(sidebar, root) {
    const wrapper = GF.findSidebarWrapper(sidebar);
    if (!wrapper) {
      return false;
    }

    const anchor = wrapper.querySelector(
      'side-nav-entry-button[data-test-id="my-stuff-side-nav-entry-button"]'
    );

    if (anchor) {
      if (root.parentElement !== anchor.parentElement || root.previousElementSibling !== anchor) {
        anchor.insertAdjacentElement("afterend", root);
      }

      return true;
    }

    const recentHeading = Array.from(wrapper.querySelectorAll("h1, h2, h3, [role='heading']")).find((node) => {
      const label = (node.textContent || "").trim();
      return /recent/i.test(label);
    });

    const fallbackAnchor = recentHeading || wrapper.querySelector("h2");
    if (fallbackAnchor?.parentElement) {
      if (root.parentElement !== fallbackAnchor.parentElement || root.nextElementSibling !== fallbackAnchor) {
        fallbackAnchor.insertAdjacentElement("beforebegin", root);
      }
      return true;
    }

    if (wrapper.firstElementChild !== root || root.parentElement !== wrapper) {
      wrapper.prepend(root);
    }

    return true;
  };

  GF.injectFoldersUI = async function(sidebar) {
    try {
      if (!sidebar) {
        return;
      }

      const historyContainer = GF.findHistoryContainer(sidebar);
      if (!historyContainer) {
        return;
      }

      const isLoggedOut = GF.getUserId() === null;

      if (isLoggedOut) {
        const staleRoot = document.getElementById(ROOT_ID);
        if (staleRoot) {
          staleRoot.remove();
        }

        GF.activeFoldersRoot = null;
        GF.activeFoldersList = null;
        GF.showLoginToast();
        return;
      }

      const existingToast = document.getElementById(TOAST_ID);
      if (existingToast) {
        existingToast.remove();
      }

      let existing = document.getElementById(ROOT_ID);
      if (existing && !existing.querySelector(".gfo-list")) {
        existing.remove();
        existing = null;
      }

      if (existing) {
        const mounted = GF.mountRoot(sidebar, existing);
        if (!mounted) {
          return;
        }

        GF.activeFoldersRoot = existing;
        GF.activeFoldersList = existing.querySelector(".gfo-list");
        if (!GF.activeFoldersList) {
          return;
        }
        GF.syncState(existing, historyContainer);
        GF.watchState(existing, historyContainer);
        GF.bindFolderContextMenuListener();
        await GF.refreshFolderUI();
        return;
      }

      const root = document.createElement("section");
      root.id = ROOT_ID;
      root.className = "gfo-root";
      root.setAttribute("aria-label", "Folders");

      const header = document.createElement("div");
      header.className = "gfo-header";

      const titleIcon = GF.createFolderIcon();

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

      const mounted = GF.mountRoot(sidebar, root);
      if (!mounted) {
        return;
      }

      GF.activeFoldersRoot = root;
      GF.activeFoldersList = list;
      GF.syncState(root, historyContainer);
      GF.watchState(root, historyContainer);
      GF.bindFolderContextMenuListener();

      const state = await GF.loadFolderState();
      GF.renderFolders(list, state.folders, state.chatToFolderMap);
      GF.syncSelectedCustomChatFromCurrentPath();

      newFolderButton.addEventListener("click", () => {
        GF.fireAndForget(GF.handleCreateFolder(), "handleCreateFolder failed");
      });
    } catch (error) {
      if (GF.warnIfUnexpected) {
        GF.warnIfUnexpected(error, "safe inject skipped due to runtime error");
      }
    }
  };

})();
