#!/bin/bash
# Installs the Wi-Fi Hotspot Auto GNOME extension. Run from the cloned gist directory:  bash install.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
UUID=wifi-hotspot-auto@taghouti
DEST=$HOME/.local/share/gnome-shell/extensions/$UUID

mkdir -p "$DEST/schemas" "$DEST/helper"
cp "$here/metadata.json" "$here/extension.js" "$here/prefs.js" "$DEST/"
cp "$here"/org.gnome.shell.extensions.wifi-hotspot-auto.gschema.xml "$DEST/schemas/"
cp "$here/gnome-hotspot-helper" "$here/org.gnome.hotspotext.helper.policy" "$DEST/helper/"
glib-compile-schemas "$DEST/schemas"

echo "Installing root helper (sudo password needed)..."
sudo install -m 755 "$here/gnome-hotspot-helper" /usr/local/bin/gnome-hotspot-helper
sudo install -m 644 "$here/org.gnome.hotspotext.helper.policy" /usr/share/polkit-1/actions/org.gnome.hotspotext.helper.policy

gnome-extensions enable "$UUID" 2>/dev/null || true
echo
echo "Done. Restart GNOME Shell: X11 -> Alt+F2, type r, Enter. Wayland -> log out and back in."
echo "Then open the extension settings and set the hotspot name and password."
