"""Portable runtime locations; importing this module creates no directories."""
import os
from pathlib import Path


def configured_path(name, default, *, canonicalize=True):
    value = os.environ.get(name)
    result = Path(value).expanduser() if value else Path(default)
    if not result.is_absolute():
        raise ValueError(f"{name} must be an absolute path")
    return result.resolve() if canonicalize else result


def workspace_root(*, canonicalize=True):
    return configured_path("NEXUS_WORKSPACE", Path(__file__).resolve().parents[2], canonicalize=canonicalize)


def context_root():
    return configured_path("NEXUS_CONTEXT_ROOT", workspace_root() / "local-state/upstream-sources")
