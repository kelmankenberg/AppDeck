#!/usr/bin/env python3
"""Read Omarchy's palette and prepare its current still wallpaper for phones."""

from __future__ import annotations

import hashlib
import re
import stat
import subprocess
import sys
import threading
import tomllib
from pathlib import Path
from typing import Any


MAX_WALLPAPER_BYTES = 32 * 1024 * 1024
MAX_PREVIEW_BYTES = 1024 * 1024
COLOR_KEYS = (
    "background", "foreground", "accent", "lighter_background",
    "dark_background", "selection", "red", "green",
)


class DesktopAppearance:
    def __init__(self, state_home: Path, config_home: Path) -> None:
        self.locations = [state_home / "omarchy/current", config_home / "omarchy/current"]
        self.lock = threading.Lock()
        self.cached_revision = ""
        self.cached_wallpaper = b""

    def current(self) -> Path:
        return next((path for path in self.locations if path.is_dir()), self.locations[0])

    def background(self) -> tuple[Path, str]:
        try:
            path = (self.current() / "background").resolve(strict=True)
            info = path.stat()
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_WALLPAPER_BYTES:
                raise ValueError("Invalid wallpaper size")
            if path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
                raise ValueError("Unsupported wallpaper")
            identity = f"{path}:{info.st_ino}:{info.st_mtime_ns}:{info.st_ctime_ns}:{info.st_size}"
            return path, hashlib.sha256(identity.encode()).hexdigest()
        except (OSError, ValueError, RuntimeError) as error:
            raise RuntimeError("Desktop wallpaper is unavailable. Use a PNG, JPEG, or WebP still image up to 32 MB.") from error

    def snapshot(self) -> dict[str, Any]:
        result: dict[str, Any] = {"colors": None, "colorError": "", "wallpaper": None, "wallpaperError": ""}
        try:
            with (self.current() / "theme/colors.toml").open("rb") as file:
                raw = file.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise ValueError("Palette too large")
            palette = tomllib.loads(raw.decode("utf-8"))
            colors = {}
            for key in COLOR_KEYS:
                value = palette.get(key)
                if value is None and key not in ("background", "foreground", "accent"):
                    continue
                if not isinstance(value, str) or not re.fullmatch(r"#[a-fA-F0-9]{6}", value):
                    raise ValueError("Invalid palette color")
                colors[key] = value
            result["colors"] = colors
        except (OSError, ValueError, UnicodeError):
            result["colorError"] = "Desktop theme colors are unavailable or invalid."
        try:
            _, result["wallpaper"] = self.background()
        except RuntimeError as error:
            result["wallpaperError"] = str(error)
        return result

    def wallpaper(self) -> bytes:
        with self.lock:
            path, revision = self.background()
            if self.cached_revision != revision:
                try:
                    result = subprocess.run(
                        [sys.executable, str(Path(__file__).resolve()), str(path)],
                        capture_output=True, timeout=8, check=False,
                    )
                except (OSError, subprocess.SubprocessError) as error:
                    raise RuntimeError("Could not prepare the desktop wallpaper.") from error
                if result.returncode or not 0 < len(result.stdout) <= MAX_PREVIEW_BYTES or not result.stdout.startswith(b"\xff\xd8"):
                    raise RuntimeError("Could not prepare the desktop wallpaper. PyGObject and GdkPixbuf with image-format support are required.")
                self.cached_wallpaper = result.stdout
                self.cached_revision = revision
            return self.cached_wallpaper


def main() -> None:
    import gi

    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf

    path = Path(sys.argv[1])
    if not 0 < path.stat().st_size <= MAX_WALLPAPER_BYTES:
        raise ValueError("Wallpaper is too large")
    image_format, width, height = GdkPixbuf.Pixbuf.get_file_info(str(path))
    if not image_format or image_format.get_name() not in ("png", "jpeg", "webp"):
        raise ValueError("Unsupported wallpaper format")
    if not 0 < width * height <= 80_000_000:
        raise ValueError("Wallpaper dimensions are too large")
    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(path), 1440, 1440, True)
    if pixbuf.get_has_alpha():
        background = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, False, 8, pixbuf.get_width(), pixbuf.get_height())
        background.fill(0x191919FF)
        pixbuf.composite(background, 0, 0, pixbuf.get_width(), pixbuf.get_height(), 0, 0, 1, 1, GdkPixbuf.InterpType.BILINEAR, 255)
        pixbuf = background
    success, data = pixbuf.save_to_bufferv("jpeg", ["quality"], ["80"])
    if not success or len(data) > MAX_PREVIEW_BYTES:
        raise ValueError("Wallpaper preview is too large")
    sys.stdout.buffer.write(data)


if __name__ == "__main__":
    main()
