# comfyui-PromptHistory

A ComfyUI custom node for saving, searching, and reusing prompts across sessions.

## Features

- **Persistent history** — prompts are saved to JSON files and survive restarts
- **Multiple history files** — manage separate collections (e.g. per-project or per-style)
- **Full-text search** — real-time search with case-sensitive, whole-word, and regex modes
- **Three operating modes** — edit a prompt manually, pick one randomly, or cycle sequentially
- **Deduplication** — identical prompts are merged; reuse increments a hit counter
- **Batch queue** — select multiple prompts and queue them as separate workflow runs
- **CLIP encoding** — optional direct conditioning output when a CLIP model is connected

## Installation

### ComfyUI Manager (recommended)

Search for **Prompt History** in the ComfyUI Manager custom node browser and install.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/dawncreatescode/comfyui-PromptHistory
```

Restart ComfyUI. No extra Python packages are required.

## Node: Select Prompt From History

**Category:** Prompt Tools

### Inputs

| Name | Type | Description |
|------|------|-------------|
| `mode` | dropdown | `edit` · `random` · `sequential` |
| `text` | string | Prompt text (active in edit mode) |
| `clip` | CLIP | Optional — enables conditioning output |
| `auto_save` | boolean | Save used prompts automatically (default: on) |
| `history_paths` | string | Newline-separated list of history file paths |
| `save_to_path` | string | File that receives new prompts |
| `active_paths` | JSON | Array of paths currently used for random/sequential |
| `max_entries` | integer | Max prompts per file (default: 500 000) |

### Outputs

| Name | Type | Description |
|------|------|-------------|
| `text` | STRING | Selected or edited prompt |
| `conditioning` | CONDITIONING | CLIP-encoded output (requires CLIP input) |

## Usage

1. Add **Select Prompt From History** to your workflow.
2. Click **Select Prompts…** on the node to open the history panel.
3. On first use, click **Manage Files…** to add or discover history file paths.
4. Type in the search box to filter prompts. Click any result to load it.
5. To save a new prompt, type in the `text` widget and run the workflow with `auto_save` enabled — or click a result to save it immediately.
6. To batch-run multiple prompts, check their checkboxes and click **Queue N**.

## History File Format

History is stored as a plain JSON array — easy to back up, share, or edit manually.

```json
[
  {
    "key": "abc123def456abcd",
    "text": "a futuristic city at dusk, neon reflections, cinematic",
    "ts": "2026-03-12 14:05:00",
    "hits": 7
  }
]
```

The default file is created at:
```
ComfyUI/custom_nodes/comfyui-PromptHistory/history/prompt_history.json
```

Any JSON file path (absolute or relative to the ComfyUI root) is accepted.

## License

MIT
