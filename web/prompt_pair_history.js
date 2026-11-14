/**
 * Select Prompt Pair From History — ComfyUI frontend extension
 *
 * Each stored entry keeps a positive and a negative prompt together, so
 * random/sequential always yields a matching pair. The panel, file manager,
 * queueing and node widgets are shared with the single-prompt node and live in
 * shared/panel_core.js; this file only describes what is specific to pairs.
 */

import { registerHistoryNode } from "./shared/panel_core.js";

registerHistoryNode({
    nodeType:      "SelectPromptPairHistory",
    extensionName: "prompt_pair_history.v1",
    tag:           "SelectPromptPairHistory",
    storageKey:    "pair",

    // Replaced at registration with the backend's default (see panel_core.js).
    defaultPath: "custom_nodes/comfyui-PromptHistory/history/prompt_pair_history.json",

    // Text widgets of the node; a history entry has fields of the same names.
    fields: [
        { name: "positive", label: "Positive", tone: "pos" },
        { name: "negative", label: "Negative", tone: "neg", emptyText: "no negative" },
    ],

    // Widget names in Python INPUT_TYPES order (must match the backend).
    widgetOrder: [
        "mode", "positive", "negative", "auto_save",
        "history_paths", "save_to_path", "active_paths", "max_entries",
    ],

    endpoints: {
        list:    "/prompt_pair_history/list",
        save:    "/prompt_pair_history/save",
        delete:  "/prompt_pair_history/delete",
        restore: "/prompt_pair_history/restore",
        clear:   "/prompt_pair_history/clear",
    },

    labels: {
        panelTitle:     "Select Prompt Pair From History",
        panelButton:    "Select Pairs…",
        manageTitle:    "Pair History Files",
        noun:           "pair",
        nouns:          "pairs",
        addPlaceholder: "my_pairs.json",
    },

    // Which prompt of the pair a search looks at (also limits highlighting).
    scopes: {
        options: [["positive", "Positive"], ["negative", "Negative"], ["both", "Both"]],
        default: "positive",
        fieldsFor(scope) {
            return scope === "both" ? ["positive", "negative"] : [scope];
        },
        placeholder(scope) {
            return {
                positive: "Search positive prompts…",
                negative: "Search negative prompts…",
                both:     "Search positive or negative…",
            }[scope];
        },
    },
});
