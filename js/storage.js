(() => {
  // Storage management for the Gemini Folders extension

  const GF = window.GeminiFolders;

  const STORAGE_KEY = "geminiFolders";
  let currentUserId = null;
  let currentStorageKey = STORAGE_KEY;

  GF.getStorageConstants = function() {
    return { STORAGE_KEY };
  };

  GF.getCurrentUserId = function() {
    return currentUserId;
  };

  GF.setCurrentUserId = function(userId) {
    currentUserId = userId;
  };

  GF.getCurrentStorageKey = function() {
    return currentStorageKey;
  };

  GF.setCurrentStorageKey = function(key) {
    currentStorageKey = key;
  };

  GF.getStorageKey = function(userId = GF.getUserId()) {
    return userId ? `${STORAGE_KEY}_${encodeURIComponent(String(userId))}` : STORAGE_KEY;
  };

  GF.syncUserContext = function() {
    const nextUserId = GF.getUserId() || "";
    const nextStorageKey = GF.getStorageKey(nextUserId);

    if (nextUserId === currentUserId && nextStorageKey === currentStorageKey) {
      return false;
    }

    currentUserId = nextUserId;
    currentStorageKey = nextStorageKey;

    if (GF.expandedFolderIds) {
      GF.expandedFolderIds.clear();
    }

    return true;
  };

  GF.isPlainObject = function(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  };

  GF.normalizeFolderNode = function(node) {
    if (typeof node === "string") {
      return {
        id: GF.createFolderId(),
        name: node.trim() || "Untitled Folder",
        children: []
      };
    }

    if (!GF.isPlainObject(node)) {
      return null;
    }

    const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : "Untitled Folder";
    const children = Array.isArray(node.children) ? node.children.map(GF.normalizeFolderNode).filter(Boolean) : [];

    return {
      id: typeof node.id === "string" && node.id ? node.id : GF.createFolderId(),
      name,
      children
    };
  };

  GF.normalizeFolderTree = function(value) {
    return Array.isArray(value) ? value.map(GF.normalizeFolderNode).filter(Boolean) : [];
  };

  GF.folderTreeNeedsMigration = function(value) {
    if (!Array.isArray(value)) {
      return Boolean(value);
    }

    return value.some((node) => {
      if (typeof node === "string") {
        return true;
      }

      if (!GF.isPlainObject(node)) {
        return true;
      }

      if (typeof node.id !== "string" || !node.id) {
        return true;
      }

      return GF.folderTreeNeedsMigration(node.children);
    });
  };

  GF.normalizeChatMappingEntry = function(value) {
    if (typeof value === "string") {
      return {
        folderIDs: [value],
        title: ""
      };
    }

    if (!GF.isPlainObject(value)) {
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
  };

  GF.normalizeChatToFolderMap = function(value) {
    if (!GF.isPlainObject(value)) {
      return {};
    }

    const nextMap = {};

    Object.entries(value).forEach(([chatId, entry]) => {
      const normalizedEntry = GF.normalizeChatMappingEntry(entry);
      if (normalizedEntry) {
        nextMap[chatId] = normalizedEntry;
      }
    });

    return nextMap;
  };

  GF.normalizeState = function(rawState) {
    if (Array.isArray(rawState)) {
      return {
        folders: GF.normalizeFolderTree(rawState),
        chatToFolderMap: {}
      };
    }

    if (GF.isPlainObject(rawState)) {
      return {
        folders: GF.normalizeFolderTree(rawState.folders),
        chatToFolderMap: GF.normalizeChatToFolderMap(rawState.chatToFolderMap ?? rawState.chatFolderMappings)
      };
    }

    return {
      folders: [],
      chatToFolderMap: {}
    };
  };

  GF.chatMappingsNeedMigration = function(rawState) {
    if (!GF.isPlainObject(rawState)) {
      return false;
    }

    const sourceMap = rawState.chatToFolderMap ?? rawState.chatFolderMappings;

    if (sourceMap !== undefined && !GF.isPlainObject(sourceMap)) {
      return true;
    }

    return Object.values(sourceMap || {}).some((entry) => {
      return (
        !GF.isPlainObject(entry) ||
        !Array.isArray(entry.folderIDs) ||
        typeof entry.title !== "string"
      );
    });
  };

  GF.loadFolderState = async function() {
    if (!GF.isContextAlive) {
      return GF.normalizeState(undefined);
    }

    if (!GF.hasRuntimeContext()) {
      if (GF.shutdownOnContextInvalidation) {
        GF.shutdownOnContextInvalidation();
      }
      return GF.normalizeState(undefined);
    }

    GF.syncUserContext();

    try {
      const storageKey = GF.getCurrentStorageKey() || GF.getStorageKey();
      const result = await chrome.storage.local.get(storageKey);
      const rawState = result[storageKey];
      const state = GF.normalizeState(rawState);

      if (GF.folderTreeNeedsMigration(rawState?.folders ?? rawState) || GF.chatMappingsNeedMigration(rawState)) {
        await GF.saveFolderState(state);
      }

      return state;
    } catch (error) {
      if (GF.warnIfUnexpected) {
        GF.warnIfUnexpected(error, "loadFolderState failed");
      }
      return GF.normalizeState(undefined);
    }
  };

  GF.saveFolderState = async function(state) {
    if (!GF.isContextAlive) {
      return false;
    }

    if (!GF.hasRuntimeContext()) {
      if (GF.shutdownOnContextInvalidation) {
        GF.shutdownOnContextInvalidation();
      }
      return false;
    }

    GF.syncUserContext();

    try {
      const storageKey = GF.getCurrentStorageKey() || GF.getStorageKey();
      await chrome.storage.local.set({ [storageKey]: state });
      return true;
    } catch (error) {
      if (GF.warnIfUnexpected) {
        GF.warnIfUnexpected(error, "saveFolderState failed");
      }
      return false;
    }
  };

  GF.getFolders = async function() {
    if (!GF.isContextAlive) {
      return [];
    }

    const state = await GF.loadFolderState();
    return state.folders;
  };

})();
