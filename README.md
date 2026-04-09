# Gemini Folders Extension

A Manifest V3 Chrome extension that adds a custom folder organizer to the Gemini sidebar.

## What It Adds

- Folder tree in Gemini sidebar
- Nested sub-folders
- Collapse and expand per folder (default is collapsed)
- Assign chats to one or more folders
- Remove chats from folders one folder at a time
- Render assigned chats as clickable sub-items under folders
- Context menu assignment from Gemini chat items (right-click)
- Quick Add button in chat header to add or remove the current chat per folder
- Auto cleanup of chat mappings when folders are deleted
- Selection sync: highlights custom folder chat that matches current URL

## Project Files

- `manifest.json`: extension metadata, permissions, and content script wiring
- `content.js`: all runtime logic, DOM injection, storage, observers, and interaction handlers
- `styles.css`: all extension UI styling

## Installation (Load Unpacked)

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select this folder: `Gemini Folder Extenstion`.
5. Open `https://gemini.google.com/`.

## Permissions

- `storage`: stores folders and chat mappings
- `scripting`: declared in manifest
- Host permission: `https://gemini.google.com/*`

## Data Model (chrome.storage.local)

Storage key: `geminiFolders`

Structure:

```json
{
  "folders": [
    {
      "id": "uuid",
      "name": "Folder Name",
      "children": []
    }
  ],
  "chatToFolderMap": {
    "chatId123": {
      "folderIDs": ["uuid-1", "uuid-2"],
      "title": "Chat Title"
    }
  }
}
```

Notes:

- `folderIDs` is always an array.
- Old single-folder entries are migrated automatically on load.

## How To Use

### Create folders

- Click `New Folder` in the folders block
- Click `+` on a folder row to add a sub-folder

### Collapse and expand

- Click the folder icon on a row, or click the row itself
- Folders are collapsed by default

### Assign chats to folders

Option A (chat page):

- Open a chat page (`/app/<chatId>`)
- Click the Quick Add icon in the chat header
- Choose a folder from the menu
- Folders that already contain the chat show a checkmark and clicking them removes that folder from the chat

Option B (sidebar):

- Right-click a Gemini conversation item
- Choose the target folder
- Right-clicking a custom folder chat item lets you remove that chat from that specific folder

### Remove a chat from a folder

- Right-click the chat in a custom folder chat list
- Choose `Remove from folder`
- In the Quick Add menu, click a checked folder to toggle it off

### Delete folder behavior

- Deleting a folder also deletes its sub-folders
- Any chat mappings that point to deleted folders are removed automatically

## Visual Customization

### Folder state icon colors

In `styles.css`, inside `#gfo-folders-root.gfo-root`:

- `--gfo-folder-icon-closed-color`
- `--gfo-folder-icon-open-color`

### Quick Add icon color (dark mode)

In `styles.css`, edit:

- `#gfo-quick-add.gfo-quick-add { color: ... }`

### Folder list max height

In `styles.css`, edit:

- `.gfo-list { max-height: 350px; }`

## Stability and Recovery Notes

- The script guards against extension context invalidation
- MutationObservers are re-created safely
- UI injection is idempotent and checks for existing roots before mounting

## Limitations

- Gemini DOM selectors can change over time
- Header Quick Add injection depends on matching Gemini action group selectors
- Chat title extraction is heuristic-based and falls back when needed

## Version

Current manifest version: `1.0.0`
