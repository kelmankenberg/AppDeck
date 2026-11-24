#!/usr/bin/env python3
"""Resolve desktop-entry icons using the active GTK icon theme."""

import base64
import json
import sys
from pathlib import Path

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk


def main():
    icons = json.load(sys.stdin)
    display = Gdk.Display.get_default()
    if not display:
        raise RuntimeError("The desktop display is unavailable")
    theme = Gtk.IconTheme.get_for_display(display)
    result = {}

    for app_id, icon_name in icons.items():
        if not isinstance(icon_name, str) or not icon_name or len(icon_name) > 1024:
            continue
        path = Path(icon_name)
        if not path.is_absolute():
            if "/" in icon_name or "\\" in icon_name:
                continue
            icon = theme.lookup_icon(
                icon_name, None, 96, 1, Gtk.TextDirection.NONE,
                Gtk.IconLookupFlags.FORCE_REGULAR,
            )
            file = icon.get_file() if icon else None
            if not file or not file.get_path():
                continue
            path = Path(file.get_path())

        try:
            if not path.is_file() or path.stat().st_size > 5 * 1024 * 1024:
                continue
            pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(str(path), 96, 96, True)
            success, data = pixbuf.save_to_bufferv("png", [], [])
            if success and len(data) <= 128 * 1024:
                result[app_id] = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        except (OSError, GLib.Error):
            continue
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
