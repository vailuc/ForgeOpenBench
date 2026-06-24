import io
import logging
import os
import asyncio
import json
import base64
import datetime
import fcntl
import struct
import termios
import zipfile
import mimetypes
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Any
from fastapi import FastAPI, Query, Body, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.core.config_manager import ConfigManager
from backend.pocketforge.ble_bridge import handle_bridge_ws
from backend.lensforge.routes import router as lens_router, set_config_manager as lens_set_cm
from backend.monitorforge.serial_routes import router as serial_router

# Configure clean, scannable logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("fob.core.app")

APP_VERSION = "0.2.1"

# Initialize global platform managers
config_manager = ConfigManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Handles core application boot and teardown sequences gracefully."""
    logger.info("Initializing Forge Open Bench Core System...")
    config_manager.load_initial_sync()
    lens_set_cm(config_manager)

    yield

    logger.info("Tearing down platform context. Cleaning up hardware threads...")
    from backend.lensforge.camera_service import lens_camera_service
    lens_camera_service.stop_all()
    # This is where we will safely terminate PTY tasks and detach USB drivers later

app = FastAPI(
    title="Forge Open Bench Core API",
    version="0.2.1",
    lifespan=lifespan
)

# Enforce strict local network boundaries
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_LOGS_DIR = Path(__file__).parent.parent / "logs"
_LOG_SOURCES = {"backend": "backend.log", "bridge": "bridge.log", "frontend": "frontend.log", "usb-bridge": "usb-bridge.log"}
_LOG_LEVEL_MAP = {"INFO": "info", "WARNING": "warn", "ERROR": "error", "CRITICAL": "error", "DEBUG": "debug"}

@app.get("/api/v1/logs/recent")
async def recent_logs(n: int = 200, source: str = "backend"):
    """Return last N log lines from the named log source parsed into structured rows."""
    filename = _LOG_SOURCES.get(source, "backend.log")
    log_file = _LOGS_DIR / filename
    rows = []
    if log_file.exists():
        try:
            lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
            for line in lines[-n:]:
                level = "info"
                for k, v in _LOG_LEVEL_MAP.items():
                    if f"[{k}]" in line:
                        level = v
                        break
                rows.append({"level": level, "msg": line})
        except Exception:
            pass
    return {"rows": rows, "source": source}


@app.delete("/api/v1/logs/{source}")
async def clear_log(source: str):
    """Truncate the named log file (clear its contents)."""
    filename = _LOG_SOURCES.get(source)
    if not filename:
        raise HTTPException(status_code=404, detail=f"Unknown log source: {source}")
    log_file = _LOGS_DIR / filename
    try:
        if log_file.exists():
            log_file.write_text("", encoding="utf-8")
        return {"cleared": source}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/health")
async def health_check():
    """System diagnostic triage route."""
    return {
        "status": "healthy",
        "platform": "Forge Open Bench Core",
        "version": "0.2.1"
    }

@app.websocket("/api/v1/control")
async def control_plane_websocket(websocket: WebSocket):
    """
    The central control plane channel for handling configuration sync and actions.
    This is the JSON control plane — not the binary data plane.
    """
    await websocket.accept()
    logger.info(f"Control plane connection established from {websocket.client.host}")

    try:
        # Instantly stream down current configuration snapshot on initial handshake
        current_settings = await config_manager.get_all()
        await websocket.send_json({"type": "settings_snapshot", "payload": current_settings})

        while True:
            # Standby for incoming state changes or hardware directives from Bench Studio
            data = await websocket.receive_json()
            msg_type = data.get("type")

            if msg_type == "settings_update":
                block_key = data.get("key")
                block_payload = data.get("payload")

                if block_key and isinstance(block_payload, dict):
                    await config_manager.set_block(block_key, block_payload)
                    await websocket.send_json({
                        "type": "settings_ack",
                        "status": "success",
                        "key": block_key
                    })
                    logger.info(f"Config block '{block_key}' modified atomically over control socket.")
                else:
                    await websocket.send_json({"type": "settings_ack", "status": "error", "reason": "Malformed block payload"})

            else:
                await websocket.send_json({"type": "unknown_command_error"})

    except WebSocketDisconnect:
        logger.info("Control plane client disconnected gracefully.")
    except Exception as e:
        logger.error(f"Control plane processing fault: {str(e)}")


@app.websocket("/api/v1/system/terminal")
async def terminal_websocket(websocket: WebSocket):
    """
    Bidirectional pseudo-terminal WebSocket bridge.
    Spawns a local bash shell and proxies raw bytes between the PTY and the client.
    Restricted to loopback connections only (127.0.0.1 / ::1).
    """
    client_host = websocket.client.host if websocket.client else None
    if client_host not in ("127.0.0.1", "::1"):
        await websocket.close(code=1008)
        logger.warning(f"Terminal access denied from non-loopback host: {client_host}")
        return
    await websocket.accept()
    logger.info(f"Terminal session initiated from {client_host}")

    # Resolve shell working directory: active project, or Projects root
    ws_cfg = await config_manager.get("workspace") or {}
    active_project = ws_cfg.get("active_project")
    root = _projects_root().resolve()
    if active_project:
        project_dir = (root / active_project).resolve()
        if not str(project_dir).startswith(str(root) + "/") or not project_dir.is_dir():
            project_dir = root
    else:
        project_dir = root
    shell_cwd = str(project_dir)

    # Spawn bash in a PTY, restricted to the project workspace
    import ptyprocess
    proc = ptyprocess.PtyProcess.spawn(["/bin/bash"], cwd=shell_cwd)
    fd = proc.fd

    # Welcome banner — sent directly over WebSocket so bash never sees it
    import getpass as _getpass
    operator = _getpass.getuser()
    version = APP_VERSION
    banner = "\r\n".join([
        "",
        "  \x1b[36m███████\x1b[0m  \x1b[32m██████\x1b[0m   \x1b[35m██████\x1b[0m ",
        "  \x1b[36m██\x1b[0m      \x1b[32m██    ██\x1b[0m  \x1b[35m██   ██\x1b[0m",
        "  \x1b[36m█████\x1b[0m   \x1b[32m██    ██\x1b[0m  \x1b[35m██████\x1b[0m ",
        "  \x1b[36m██\x1b[0m      \x1b[32m██    ██\x1b[0m  \x1b[35m██   ██\x1b[0m",
        f"  \x1b[36m██\x1b[0m       \x1b[32m██████\x1b[0m   \x1b[35m██████\x1b[0m  \x1b[33m{version}\x1b[0m",
        "",
        f"  \x1b[90m■\x1b[0m Operator : \x1b[32m{operator}\x1b[0m",
        f"  \x1b[90m■\x1b[0m Project  : \x1b[34m{active_project or '(none)'}\x1b[0m",
        f"  \x1b[90m■\x1b[0m CWD      : \x1b[34m{shell_cwd}\x1b[0m",
        "  \x1b[90m■\x1b[0m Runtime  : \x1b[33mLocal-First Engine (Air-Gapped)\x1b[0m",
        "  \x1b[90m■\x1b[0m Note     : \x1b[33mThis is your local shell. You can cd anywhere.\x1b[0m",
        "  \x1b[90m■ Garbled art? Use a Nerd Font: https://www.nerdfonts.com\x1b[0m",
        "",
        "",
    ])
    await websocket.send_text(banner)

    # Set non-blocking mode
    fl = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, fl | os.O_NONBLOCK)

    async def pty_to_ws():
        """Pump PTY stdout → WebSocket."""
        try:
            while proc.isalive():
                try:
                    data = os.read(fd, 4096)
                    if data:
                        await websocket.send_text(data.decode("utf-8", errors="replace"))
                except BlockingIOError:
                    await asyncio.sleep(0.01)
                except Exception:
                    break
        except Exception:
            pass

    async def ws_to_pty():
        """Pump WebSocket → PTY stdin."""
        try:
            while proc.isalive():
                msg = await websocket.receive_text()
                if msg.startswith("__RESIZE__:"):
                    # Handle terminal resize: __RESIZE__:cols,rows
                    try:
                        _, dims = msg.split(":", 1)
                        cols, rows = map(int, dims.split(","))
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
                    except ValueError:
                        pass
                else:
                    os.write(fd, msg.encode("utf-8"))
        except WebSocketDisconnect:
            logger.info("Terminal client disconnected.")
        except Exception:
            pass

    # Run both directions concurrently
    try:
        await asyncio.gather(pty_to_ws(), ws_to_pty())
    finally:
        if proc.isalive():
            proc.terminate(force=True)
        logger.info("Terminal session closed.")


@app.websocket("/api/v1/ble-bridge")
async def ble_bridge_websocket(websocket: WebSocket):
    """WebSocket bridge to local Bluetooth adapter via bleak."""
    await handle_bridge_ws(websocket)


# ── Workspace helpers ──────────────────────────────────────────────────────────

PROJECTS_ROOT = Path.home() / "Documents" / "Forge"
PROJECT_SUBDIRS = ["captures", "notes", "waveforms", "firmware", "scripts"]
TEMPLATE_DIR = PROJECTS_ROOT / "_template"

# ide2 — built-in project templates
BUILTIN_TEMPLATES: dict[str, dict] = {
    "blank": {
        "label": "Blank",
        "description": "Empty project with standard folders.",
        "readme": "# {name}\n\n## Session Log\n\n## Notes\n\n- [ ] \n",
    },
    "teardown": {
        "label": "Teardown",
        "description": "IC teardown / reverse-engineering template.",
        "readme": (
            "# {name}\n\n"
            "## Overview\n\nDevice: \nDate: \nEngineer: \n\n"
            "## Board Photos\n\n"
            "## ICs / Chips\n\n"
            "| Ref | Part | Function |\n"
            "|-----|------|----------|\n"
            "| U1  |      |          |\n\n"
            "## Measurements\n\n"
            "## Findings\n\n"
            "## References\n"
        ),
    },
    "firmware-debug": {
        "label": "Firmware Debug",
        "description": "UART/JTAG debug session with signal capture workflow.",
        "readme": (
            "# {name}\n\n"
            "## Target\n\nDevice: \nFW version: \nInterface: UART / JTAG / SWD\n\n"
            "## Setup\n\n"
            "- Baud: \n"
            "- Voltage: \n"
            "- Logic level: \n\n"
            "## Session Log\n\n"
            "## Signal Notes\n\n"
            "## TODO\n\n"
            "- [ ] \n"
        ),
    },
    "signal-capture": {
        "label": "Signal Capture",
        "description": "LA / DSO capture session with measurement notes.",
        "readme": (
            "# {name}\n\n"
            "## Capture Setup\n\n"
            "- Sample rate: \n"
            "- Channels: \n"
            "- Trigger: \n\n"
            "## Captures\n\n"
            "## Measurements\n\n"
            "| Signal | Freq | Period | Duty |\n"
            "|--------|------|--------|------|\n\n"
            "## Notes\n"
        ),
    },
}


def _projects_root() -> Path:
    ws = config_manager.get_sync("workspace") or {}
    custom_dir = ws.get("project_dir")
    if custom_dir:
        root = Path(custom_dir).expanduser().resolve()
    else:
        root = PROJECTS_ROOT
    root.mkdir(parents=True, exist_ok=True)
    return root


def _safe_project_path(name: str) -> Path:
    """Resolve project path and guard against directory traversal."""
    root = _projects_root().resolve()
    path = (root / name).resolve()
    if path == root or not str(path).startswith(str(root) + "/"):
        raise HTTPException(status_code=400, detail="Invalid project name")
    return path


def _scaffold_project(path: Path) -> None:
    """Create standard subdirectory layout for a new project."""
    for sub in PROJECT_SUBDIRS:
        (path / sub).mkdir(parents=True, exist_ok=True)
    readme = path / "README.md"
    if not readme.exists():
        template_readme = TEMPLATE_DIR / "README.md"
        if template_readme.exists():
            readme.write_text(template_readme.read_text(encoding="utf-8"), encoding="utf-8")
        else:
            readme.write_text(f"# {path.name}\n\n## Session Log\n\n## Notes\n\n- [ ] \n", encoding="utf-8")


async def _active_project_dir() -> Path:
    ws = await config_manager.get("workspace") or {}
    active = ws.get("active_project")
    if active:
        p = _projects_root() / active
        if p.is_dir():
            return p
    # Fall back to first project alphabetically, or create default
    projects = sorted([p for p in _projects_root().iterdir() if p.is_dir() and not p.name.startswith("_")])
    if projects:
        return projects[0]
    default = _projects_root() / "default-project"
    _scaffold_project(default)
    return default


async def _notes_dir() -> Path:
    project = await _active_project_dir()
    notes_dir = project / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)
    return notes_dir


# ── Workspace API ──────────────────────────────────────────────────────────────

@app.get("/api/v1/workspace/projects")
async def list_projects():
    """List all projects under Projects/ root."""
    root = _projects_root()
    projects = []
    for p in sorted(root.iterdir()):
        if not p.is_dir() or p.name.startswith("_") or p.name.startswith("."):
            continue
        notes_dir = p / "notes"
        all_notes = list(notes_dir.glob("*.md")) if notes_dir.exists() else []
        captures_count = len([f for f in all_notes if f.name.startswith("lens-")])
        notes_count = len(all_notes) - captures_count + (len(list((p / "captures").iterdir())) if (p / "captures").exists() else 0)
        readme = p / "README.md"
        projects.append({
            "name": p.name,
            "path": str(p),
            "notes": notes_count,
            "captures": captures_count,
            "has_readme": readme.exists(),
            "updated_at": p.stat().st_mtime,
        })
    ws = await config_manager.get("workspace") or {}
    return {"projects": projects, "active": ws.get("active_project"), "default_project": ws.get("default_project")}


@app.get("/api/v1/workspace/templates")
async def list_templates():
    """List available project templates (built-in + custom from _template/)."""
    templates = []
    for key, meta in BUILTIN_TEMPLATES.items():
        templates.append({"id": key, "label": meta["label"], "description": meta["description"], "builtin": True})
    # Custom templates: subdirs inside Projects/_templates/
    custom_dir = _projects_root() / "_templates"
    if custom_dir.is_dir():
        for d in sorted(custom_dir.iterdir()):
            if d.is_dir() and not d.name.startswith("."):
                readme = d / "README.md"
                desc = readme.read_text(encoding="utf-8").split("\n")[0].lstrip("# ").strip() if readme.exists() else ""
                templates.append({"id": f"custom:{d.name}", "label": d.name, "description": desc, "builtin": False})
    return {"templates": templates}


@app.post("/api/v1/workspace/projects/{name}")
async def create_project(name: str, template: str = Query(default="blank")):
    """Create a new scaffolded project folder, optionally from a template."""
    safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip().replace(" ", "-")
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid project name")
    path = _projects_root() / safe
    if path.exists():
        raise HTTPException(status_code=409, detail="Project already exists")
    _scaffold_project(path)
    # Write template README
    readme_path = path / "README.md"
    if template.startswith("custom:"):
        custom_name = template[7:]
        custom_readme = _projects_root() / "_templates" / custom_name / "README.md"
        if custom_readme.exists():
            readme_path.write_text(custom_readme.read_text(encoding="utf-8").replace("{name}", safe), encoding="utf-8")
    elif template in BUILTIN_TEMPLATES:
        readme_path.write_text(BUILTIN_TEMPLATES[template]["readme"].format(name=safe), encoding="utf-8")
    return {"name": safe, "path": str(path), "ok": True, "template": template}


@app.get("/api/v1/workspace/projects/{name}/export")
async def export_project(name: str):
    """Stream project folder as a .zip archive (ide3)."""
    path = _safe_project_path(name)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Project not found")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for f in path.rglob("*"):
            if f.is_file() and not f.name.startswith("."):
                zf.write(f, arcname=str(f.relative_to(path.parent)))
    buf.seek(0)

    def iterfile():
        yield buf.read()

    return StreamingResponse(
        iterfile(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{name}.zip"'},
    )


@app.put("/api/v1/workspace/active")
async def set_active_project(payload: dict):
    """Set the active project by name."""
    name = payload.get("project")
    if not name:
        raise HTTPException(status_code=400, detail="project required")
    path = _safe_project_path(name)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Project not found")
    ws = await config_manager.get("workspace") or {}
    ws["active_project"] = name
    await config_manager.set_block("workspace", ws)
    return {"active": name, "ok": True}


@app.get("/api/v1/workspace/projects/{name}/counts")
async def project_counts(name: str):
    """Return file counts per subfolder for a project."""
    path = _safe_project_path(name)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Project not found")
    result: dict[str, int] = {}
    notes_dir = path / "notes"
    all_notes = list(notes_dir.glob("*.md")) if notes_dir.exists() else []
    lens_notes = [f for f in all_notes if f.name.startswith("lens-")]
    result["captures"] = len(lens_notes) + (len(list((path / "captures").iterdir())) if (path / "captures").exists() else 0)
    result["notes"] = len(all_notes) - len(lens_notes)
    for sub in ["waveforms", "firmware", "scripts"]:
        d = path / sub
        result[sub] = len(list(d.iterdir())) if d.exists() else 0
    return result


@app.put("/api/v1/workspace/default")
async def set_default_project(payload: dict):
    """Set the default project (restored on next load if no active project is set)."""
    name = payload.get("project")
    if not name:
        raise HTTPException(status_code=400, detail="project required")
    path = _safe_project_path(name)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Project not found")
    ws = await config_manager.get("workspace") or {}
    ws["default_project"] = name
    await config_manager.set_block("workspace", ws)
    return {"default": name, "ok": True}


@app.get("/api/v1/workspace/projects/{name}/tree")
async def project_tree(name: str):
    """Return recursive file tree for a project (notes, captures, waveforms, firmware, scripts)."""
    path = _safe_project_path(name)
    if not path.is_dir():
        raise HTTPException(status_code=404, detail="Project not found")

    def build_tree(folder: Path, rel: str) -> list[dict]:
        items = []
        try:
            entries = sorted(folder.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except PermissionError:
            return items
        for entry in entries:
            if entry.name.startswith("."):
                continue
            node: dict = {
                "name": entry.name,
                "path": f"{rel}/{entry.name}",
                "type": "file" if entry.is_file() else "dir",
            }
            if entry.is_file():
                node["ext"] = entry.suffix.lower()
                node["size"] = entry.stat().st_size
            else:
                node["children"] = build_tree(entry, f"{rel}/{entry.name}")
            items.append(node)
        return items

    tree = []
    # Include project README at the top level
    readme = path / "README.md"
    if readme.is_file():
        tree.append({
            "name": "README.md",
            "path": f"{name}/README.md",
            "type": "file",
            "ext": ".md",
            "size": readme.stat().st_size,
        })
    for sub in PROJECT_SUBDIRS:
        sub_path = path / sub
        if sub_path.exists():
            tree.append({
                "name": sub,
                "path": f"{name}/{sub}",
                "type": "dir",
                "children": build_tree(sub_path, f"{name}/{sub}"),
            })
    return {"name": name, "tree": tree}


@app.get("/api/v1/workspace/projects/{name}/file")
async def read_project_file(name: str, path: str = Query(...)):
    """Read a text file inside a project. Returns metadata and text content."""
    project_path = _safe_project_path(name)
    target = (project_path / path).resolve()
    if not target.is_file() or not str(target).startswith(str(project_path.resolve()) + "/"):
        raise HTTPException(status_code=404, detail="File not found")
    ext = target.suffix.lower()
    is_binary = ext in (".bin", ".hex", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".so", ".o", ".elf")
    stat = target.stat()
    content = ""
    if not is_binary and target.stat().st_size <= 2 * 1024 * 1024:
        content = target.read_text(encoding="utf-8", errors="replace")
    return {
        "name": target.name,
        "path": f"{name}/{path}",
        "ext": ext,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
        "content": content,
    }


@app.post("/api/v1/workspace/projects/{name}/file")
async def write_project_file(name: str, path: str = Query(...), body: dict = Body(...)):
    """Write a text file inside a project. Used for README.md and other project docs."""
    project_path = _safe_project_path(name)
    target = (project_path / path).resolve()
    if not str(target).startswith(str(project_path.resolve()) + "/"):
        raise HTTPException(status_code=400, detail="Invalid path")
    ext = target.suffix.lower()
    if ext in (".bin", ".hex", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".so", ".o", ".elf"):
        raise HTTPException(status_code=400, detail="Refusing to write binary file")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.get("content", ""), encoding="utf-8")
    return {"ok": True, "path": f"{name}/{path}"}


@app.get("/api/v1/workspace/projects/{name}/rawfile")
async def read_project_raw_file(name: str, path: str = Query(...)):
    """Serve a raw project file (images, csv, binary assets) for preview/download."""
    project_path = _safe_project_path(name)
    target = (project_path / path).resolve()
    if not target.is_file() or not str(target).startswith(str(project_path.resolve()) + "/"):
        raise HTTPException(status_code=404, detail="File not found")
    media_type, _ = mimetypes.guess_type(str(target))
    filename = target.name
    headers = {
        "Content-Disposition": f'inline; filename="{filename}"',
    }
    return FileResponse(target, media_type=media_type, filename=filename, headers=headers)


@app.post("/api/v1/workspace/projects/{name}/asset")
async def write_project_asset(name: str, path: str = Query(...), body: dict = Body(...)):
    """Write a binary or text asset file inside a project.
    Pass either {"content": "plain text"} or {"data": "base64 bytes"}.
    """
    project_path = _safe_project_path(name)
    target = (project_path / path).resolve()
    if not str(target).startswith(str(project_path.resolve()) + "/"):
        raise HTTPException(status_code=400, detail="Invalid path")
    target.parent.mkdir(parents=True, exist_ok=True)

    b64 = body.get("data")
    if isinstance(b64, str):
        try:
            decoded = base64.b64decode(b64)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid base64 data: {e}")
        await asyncio.to_thread(target.write_bytes, decoded)
    else:
        await asyncio.to_thread(target.write_text, body.get("content", ""), encoding="utf-8")

    return {"ok": True, "path": f"{name}/{path}"}


@app.get("/api/v1/workspace/active")
async def get_active_project():
    """Get the currently active project."""
    project = await _active_project_dir()
    return {
        "name": project.name,
        "path": str(project),
        "subdirs": {sub: str(project / sub) for sub in PROJECT_SUBDIRS},
    }


def _safe_name(name: str) -> str:
    """Sanitize note filename — alphanumeric, dash, underscore only."""
    safe = "".join(c for c in name if c.isalnum() or c in "-_ ")
    safe = safe.strip().replace(" ", "-")
    if not safe:
        safe = "untitled"
    return safe


@app.get("/api/v1/notes/search")
async def search_notes(q: str = ""):
    """Full-text search across all notes in active project. Returns matching notes with snippet."""
    if not q or not q.strip():
        return {"results": [], "query": q}
    needle = q.strip().lower()
    d = await _notes_dir()
    files: list[Path] = []
    files.extend(d.glob("*.md"))
    for sub in d.iterdir():
        if sub.is_dir() and not sub.name.startswith("."):
            files.extend(sub.glob("*.md"))
    results = []
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        if needle not in text.lower():
            continue
        lines = text.splitlines()
        snippet = ""
        for line in lines:
            if needle in line.lower():
                snippet = line.strip()[:120]
                break
        results.append({
            "name": f.stem,
            "folder": f.parent.name if f.parent != d else "",
            "snippet": snippet,
            "updated_at": f.stat().st_mtime,
        })
    results.sort(key=lambda r: r["updated_at"], reverse=True)
    return {"results": results, "query": q}


@app.get("/api/v1/notes")
async def list_notes():
    """List all markdown notes (root + one level of subfolders)."""
    d = await _notes_dir()
    files: list[Path] = []
    files.extend(d.glob("*.md"))
    for sub in d.iterdir():
        if sub.is_dir() and not sub.name.startswith("."):
            files.extend(sub.glob("*.md"))
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [
        {
            "name": f.stem,
            "updated_at": f.stat().st_mtime,
        }
        for f in files
    ]


@app.get("/api/v1/notes/folders")
async def list_note_folders():
    """List subdirectories under the notes dir (project folders)."""
    d = await _notes_dir()
    folders = sorted(
        [p.name for p in d.iterdir() if p.is_dir() and not p.name.startswith(".")],
    )
    return {"folders": folders}


@app.post("/api/v1/notes/folders/{folder}")
async def create_note_folder(folder: str):
    """Create a subfolder under the notes dir."""
    d = await _notes_dir()
    target = d / _safe_name(folder)
    target.mkdir(parents=True, exist_ok=True)
    return {"folder": target.name, "ok": True}


@app.get("/api/v1/notes/{name}")
async def read_note(name: str):
    """Read the contents of a specific note."""
    d = await _notes_dir()
    path = d / f"{_safe_name(name)}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Note not found")
    return {"name": path.stem, "content": path.read_text(encoding="utf-8")}


from pydantic import BaseModel

class NotePayload(BaseModel):
    content: str
    folder: str | None = None


@app.post("/api/v1/notes/{name}")
async def write_note(name: str, payload: NotePayload):
    """Write or overwrite a note file, optionally inside a subfolder."""
    d = await _notes_dir()
    if payload.folder:
        d = d / _safe_name(payload.folder)
        d.mkdir(parents=True, exist_ok=True)
    path = d / f"{_safe_name(name)}.md"
    path.write_text(payload.content, encoding="utf-8")
    return {"name": path.stem, "folder": payload.folder or "", "ok": True}


@app.delete("/api/v1/notes/{name}")
async def delete_note(name: str):
    """Delete a note file."""
    d = await _notes_dir()
    path = d / f"{_safe_name(name)}.md"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Note not found")
    path.unlink()
    return {"name": path.stem, "ok": True}


# ── Capture / Data logging ─────────────────────────────────────────────────
class CapturePayload(BaseModel):
    plugin: str
    name: str | None = None
    timestamp: float
    value: Any          # scalar float OR array (DSO/logic waveforms)
    unit: str
    meta: dict | None = None


@app.post("/api/v1/waveforge/snapshot")
async def save_waveforge_snapshot(payload: CapturePayload):
    """Save a WaveForge canvas snapshot PNG to the active project's captures dir.
    payload.value should be a data:image/png;base64,... string."""
    project_dir = await _active_project_dir()
    capture_dir = project_dir / "captures"
    capture_dir.mkdir(parents=True, exist_ok=True)
    b64 = str(payload.value)
    if b64.startswith("data:image/png;base64,"):
        b64 = b64.split(",", 1)[1]
    try:
        png_bytes = base64.b64decode(b64)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 data: {e}")
    name = _safe_name(payload.name or "waveforge-snapshot")
    if not name.endswith(".png"):
        name += ".png"
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = capture_dir / f"{ts}-{name}"
    path.write_bytes(png_bytes)
    return {"ok": True, "path": str(path), "rel": f"{project_dir.name}/captures/{path.name}", "filename": path.name}


@app.post("/api/v1/capture")
async def save_capture(payload: CapturePayload):
    """Save a measurement snapshot to the active project's captures directory."""
    project_dir = await _active_project_dir()
    capture_dir = project_dir / "captures"
    capture_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{payload.plugin}_{int(payload.timestamp * 1000)}.json"
    path = capture_dir / filename
    path.write_text(
        json.dumps({
            "plugin": payload.plugin,
            "name": payload.name,
            "timestamp": payload.timestamp,
            "value": payload.value,
            "unit": payload.unit,
            "meta": payload.meta or {},
        }, indent=2),
        encoding="utf-8",
    )
    return {"ok": True, "file": filename}


app.include_router(lens_router)
app.include_router(serial_router)

# Serve built frontend from frontend/dist/ (only if it exists — fresh clones
# or dev mode may not have it yet; the Vite dev server handles serving then)
_frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_frontend_dist), html=True), name="frontend")
