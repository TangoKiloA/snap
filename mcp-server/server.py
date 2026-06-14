import json
import os
import time
import base64
from pathlib import Path

from fastmcp import FastMCP

mcp = FastMCP(name="snap-mcp")

INBOX = Path.home() / ".snap" / "inbox"
STATE_FILE = Path.home() / ".snap" / ".last_read"
LOG_FILE = Path.home() / ".snap" / "snap.log"


# ----- Helpers -----


def _log(msg: str):
    """Append a log line. Rotates at 1MB."""
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Rotate if over 1MB
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 1_000_000:
            backup = LOG_FILE.with_suffix(".log.old")
            LOG_FILE.rename(backup)
        with open(LOG_FILE, "a") as f:
            ts = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
            f.write(f"[{ts}] [mcp] {msg}\n")
    except Exception:
        pass


def _load_annotation(
    json_path: Path,
    include_image_data: bool = False,
    max_image_bytes: int = 5_000_000,
) -> dict:
    """Load a sidecar JSON and attach the image path."""
    try:
        with open(json_path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        return {
            "filename": json_path.stem,
            "error": f"corrupt or unreadable: {e}",
            "image_path": None,
        }

    png_path = json_path.with_suffix(".png")
    data["image_path"] = str(png_path) if png_path.exists() else None
    data["filename"] = json_path.stem

    if not png_path.exists():
        data["warning"] = "image file missing"
        return data

    if include_image_data:
        try:
            size = png_path.stat().st_size
            if size > max_image_bytes:
                data["image_inline_warning"] = (
                    f"image too large for inline payload ({size} bytes > {max_image_bytes} bytes)"
                )
            else:
                data["image_base64"] = base64.b64encode(png_path.read_bytes()).decode("ascii")
                data["image_media_type"] = "image/png"
        except OSError as e:
            data["image_inline_warning"] = f"failed to inline image: {e}"

    return data


def _list_annotations_sorted() -> list[Path]:
    """Return all sidecar JSON files sorted newest first."""
    if not INBOX.exists():
        return []
    return sorted(INBOX.glob("snap-*.json"), reverse=True)


def _get_last_read() -> float:
    """Return the timestamp of the last read, or 0 if never read."""
    try:
        if STATE_FILE.exists():
            return float(STATE_FILE.read_text().strip())
    except (ValueError, OSError):
        pass
    return 0.0


def _mark_read():
    """Update the last-read timestamp to now."""
    try:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(str(time.time()))
    except OSError:
        pass


# ----- MCP Tools -----


@mcp.tool
def check_new_annotations() -> dict:
    """Check if there are new screen annotations since the last time Claude Code
    looked. Returns the count of new annotations and their filenames. Call this
    at the start of UI tasks to see if the user has provided visual feedback."""
    _log("check_new_annotations called")
    last_read = _get_last_read()
    files = _list_annotations_sorted()
    new_files = []
    for f in files:
        try:
            if f.stat().st_mtime > last_read:
                new_files.append(f.stem)
            else:
                break
        except OSError:
            continue

    total = len(files)
    result = {
        "new_count": len(new_files),
        "new_annotations": new_files,
        "has_new": len(new_files) > 0,
        "total_in_inbox": total,
    }

    if total > 100:
        result["note"] = f"inbox has {total} files, consider clearing old annotations"

    return result


@mcp.tool
def get_latest_annotation(
    include_image_data: bool = True, max_image_bytes: int = 5_000_000
) -> dict:
    """Get the most recent screen annotation. Returns the image path and
    structured metadata including annotation positions, labels, colors, and
    source window context. Claude Code should read the image at the returned
    image_path to see the annotated screenshot."""
    _log("get_latest_annotation called")
    files = _list_annotations_sorted()
    if not files:
        return {"error": "No annotations in inbox"}
    result = _load_annotation(
        files[0], include_image_data=include_image_data, max_image_bytes=max_image_bytes
    )
    _mark_read()
    return result


@mcp.tool
def list_annotations(
    last_n: int = 5, include_image_data: bool = False, max_image_bytes: int = 5_000_000
) -> list[dict]:
    """List recent screen annotations. Returns metadata for the N most recent
    annotations, newest first. Each entry includes the image_path that Claude
    Code can read to see the annotated screenshot."""
    _log(f"list_annotations called (last_n={last_n})")
    files = _list_annotations_sorted()[:last_n]
    results = [
        _load_annotation(f, include_image_data=include_image_data, max_image_bytes=max_image_bytes)
        for f in files
    ]
    _mark_read()
    return results


@mcp.tool
def get_annotation(
    filename: str, include_image_data: bool = True, max_image_bytes: int = 5_000_000
) -> dict:
    """Get a specific annotation by filename (without extension).
    Example: get_annotation('snap-20260408-142300')"""
    _log(f"get_annotation called: {filename}")
    json_path = INBOX / f"{filename}.json"
    if not json_path.exists():
        return {"error": f"Annotation '{filename}' not found"}
    return _load_annotation(
        json_path, include_image_data=include_image_data, max_image_bytes=max_image_bytes
    )


@mcp.tool
def clear_inbox() -> dict:
    """Delete all processed annotations from the inbox. Use after Claude Code
    has addressed all pending annotations."""
    _log("clear_inbox called")
    files = _list_annotations_sorted()
    png_count = 0
    json_count = 0
    errors = []

    for json_path in files:
        png_path = json_path.with_suffix(".png")
        try:
            if png_path.exists():
                png_path.unlink()
                png_count += 1
            json_path.unlink()
            json_count += 1
        except OSError as e:
            errors.append(f"{json_path.name}: {e}")

    result = {"deleted_json": json_count, "deleted_png": png_count}
    if errors:
        result["errors"] = errors

    # Reset the read marker
    try:
        if STATE_FILE.exists():
            STATE_FILE.unlink()
    except OSError:
        pass

    return result


# ----- Entry point -----


def main():
    _log("snap server starting")
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
