"""
comfyui-PromptHistory — ComfyUI custom node package

Loads all modules in this folder that expose NODE_CLASS_MAPPINGS.
The web/ directory is registered so ComfyUI serves the JS extension files.
"""

import importlib
import pkgutil
from pathlib import Path

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_pkg_name = __name__
_pkg_path = Path(__file__).parent

for _info in pkgutil.iter_modules([str(_pkg_path)]):
    _name = _info.name
    if _name.startswith("_"):
        continue
    _mod = importlib.import_module(f"{_pkg_name}.{_name}")
    for _k, _v in getattr(_mod, "NODE_CLASS_MAPPINGS", {}).items():
        NODE_CLASS_MAPPINGS[_k] = _v
    for _k, _v in getattr(_mod, "NODE_DISPLAY_NAME_MAPPINGS", {}).items():
        NODE_DISPLAY_NAME_MAPPINGS[_k] = _v

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
