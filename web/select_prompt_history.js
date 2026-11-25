/**
 * Select Prompt From History — ComfyUI frontend extension
 *
 * The panel, file manager, queueing and node widgets are shared with the pair
 * node and live in shared/panel_core.js. This file only describes what is
 * specific to the single-prompt node.
 */

import { registerHistoryNode } from "./shared/panel_core.js";

registerHistoryNode({
    nodeType:      "SelectPromptHistory",
    extensionName: "select_prompt_history.v1",
    tag:           "SelectPromptHistory",
    storageKey:    "single",

    // Replaced at registration with the backend's default (see panel_core.js).
    defaultPath: "custom_nodes/comfyui-PromptHistory/history/prompt_history.json",

    // Text widgets of the node; a history entry has a field of the same name.
    fields: [
        { name: "text", label: "Prompt" },
    ],

    // Widget names in Python INPUT_TYPES order (must match the backend).
    widgetOrder: [
        "mode", "text", "auto_save",
        "history_paths", "save_to_path", "active_paths", "max_entries",
        "pair_side",
    ],

    endpoints: {
        list:    "/select_prompt_history/list",
        save:    "/prompt_history/save",
        delete:  "/prompt_history/delete",
        restore: "/prompt_history/restore",
        clear:   "/prompt_history/clear",
        // Pair files can be used as sources (read-only); this tells them apart.
        info:    "/select_prompt_history/file_info",
    },

    labels: {
        panelTitle:     "Select Prompt From History",
        panelButton:    "Select Prompts…",
        manageTitle:    "History Files",
        noun:           "prompt",
        nouns:          "prompts",
        addPlaceholder: "my_history.json",
    },
});
