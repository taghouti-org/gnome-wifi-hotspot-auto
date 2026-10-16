# Wi-Fi Hotspot Auto (GNOME Shell extension)

Share your PC's connection as a Wi-Fi hotspot **while staying connected to Wi-Fi**, with three modes:

- **Never**
- **Always**
- **Only on selected networks** – the hotspot turns on when you join a listed network and off when you leave it

Tested design target: GNOME Shell 47/48/49, NetworkManager 1.4x+, a Wi-Fi card that supports AP + client at once.

## How it works
NetworkManager can't run a hotspot on the interface that is also connected as a client (it drops the connection). The extension creates a **virtual AP interface** (`ap0`) next to your Wi-Fi card (`iw dev <wlan> interface add ap0 type __ap`) and starts a shared (NAT) hotspot on it with `nmcli`. This needs root, so a tiny helper is installed once, with a polkit rule that lets the active local user run it without a password prompt.

## Requirements
- `iw`, `nmcli` (NetworkManager), `pkexec` (polkit), `gnome-extensions`
- Check your card supports it – you need a line with both `managed` and `AP` in one combination:
  ```
  iw list | grep -A6 "valid interface combinations"
  ```
  e.g. `#{ managed } <= 1, #{ AP, P2P-client, P2P-GO } <= 1 ... #channels <= 1`

## Install
```bash
git clone https://gist.github.com/<GIST_ID>.git wifi-hotspot-auto
cd wifi-hotspot-auto
bash install.sh
```
Then restart GNOME Shell (X11: `Alt+F2`, `r`, Enter; Wayland: log out/in) and make sure it is enabled:
```bash
gnome-extensions enable wifi-hotspot-auto@taghouti
```

## Use
1. Click the hotspot icon in the top bar → **Settings**.
2. Set the **hotspot name** and **password** (min 8 characters).
3. Pick a mode, either in Settings or from the top-bar menu.
4. For auto mode: connect to the network you want, open the menu and click **Add current network to triggers** (or type SSIDs, comma-separated, in Settings).

The icon is dimmed when the hotspot is off; the menu shows hotspot state and current Wi-Fi.

## Limitations
- The hotspot must use the **same channel** as your Wi-Fi connection (single radio), so speed is shared and a 5 GHz network gives a 5 GHz-only hotspot.
- **DFS channels** (5.26–5.72 GHz, e.g. channel 132): many cards refuse to host an AP there. You'll get a notification and keep your connection, but no hotspot on that network.
- The hotspot password is stored in plain text in GSettings and briefly appears in the `nmcli` command line when the hotspot starts.

## Uninstall
```bash
gnome-extensions disable wifi-hotspot-auto@taghouti
rm -rf ~/.local/share/gnome-shell/extensions/wifi-hotspot-auto@taghouti
sudo rm /usr/local/bin/gnome-hotspot-helper /usr/share/polkit-1/actions/org.gnome.hotspotext.helper.policy
```
