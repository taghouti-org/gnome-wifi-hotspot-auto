# Wi-Fi Hotspot Auto (GNOME Shell extension)

Share your PC's connection as a Wi-Fi hotspot **while staying connected to Wi-Fi**, with three modes:

- **Never**
- **Always**
- **Only on selected networks** – the hotspot turns on when you join a listed network and off when you leave it

Tested design target: GNOME Shell 47/48/49, NetworkManager 1.4x+, a Wi-Fi card that supports AP + client at once.

## How it works
NetworkManager can't run a hotspot on the interface that is also connected as a client (and its `wpa_supplicant` can't bring up a second interface on the same radio). So the extension creates a **virtual AP interface** (`ap0`) next to your Wi-Fi card (`iw dev <wlan> interface add ap0 type __ap`) and runs **hostapd** (access point) + **dnsmasq** (DHCP) on it, with iptables NAT through your normal connection. This needs root, so a small helper (`/usr/local/bin/gnome-hotspot-helper`) is installed once with a polkit rule that lets the active local user run it without a password prompt. The hotspot password is passed to the helper on stdin.

## Requirements
- `hostapd` (installed by `install.sh` via apt), `dnsmasq`, `iptables`, `iw`, `nmcli`, `pkexec`, `gnome-extensions`
- Check your card supports it – you need a line with both `managed` and `AP` in one combination:
  ```
  iw list | grep -A6 "valid interface combinations"
  ```
  e.g. `#{ managed } <= 1, #{ AP, P2P-client, P2P-GO } <= 1 ... #channels <= 1`

## Install
```bash
git clone https://gist.github.com/267a91e305a469835a45992c9de30db0.git wifi-hotspot-auto
cd wifi-hotspot-auto
bash install.sh
```
Then restart GNOME Shell (X11: `Alt+F2`, `r`, Enter; Wayland: log out/in) and make sure it is enabled:
```bash
gnome-extensions enable wifi-hotspot-auto@taghouti
```

## Use
1. Click the hotspot icon in the top bar → **Settings**, set the **hotspot name** and **password** (min 8 characters).
2. Pick a mode (Settings or the top-bar menu).
3. For selected-networks mode: connect to the network you want, open the menu and click **Add current network to triggers** (or type SSIDs, comma-separated, in Settings).

### Top-bar menu
- **Hotspot switch** – quick on/off (sets mode to Always / Never)
- **Status** – hotspot name, channel, number of devices, total traffic (↓ download / ↑ upload) and live speed
- **Connected devices** – per device: hostname, IP, MAC, signal strength, traffic and speed
- **Mode** – Never / Always / Selected networks
- **Show logs** – extension events, hostapd log, traffic and DHCP leases (Refresh / Copy)
- **Settings**

The panel icon is **green** (with a device count) when the hotspot is on, **orange** if it failed to start (the reason is shown in the menu), and dim when off.

### Notifications
Hotspot on/off, failures, and devices joining/leaving (can be disabled in Settings).

## Limitations
- The hotspot must use the **same channel** as your Wi-Fi connection (single radio), so speed is shared and a 5 GHz network gives a 5 GHz-only hotspot.
- **DFS channels** (5.26–5.72 GHz, e.g. channel 132): many cards refuse to host an AP there. You'll get a notification and keep your connection, but no hotspot on that network.
  **Workaround:** if the network also broadcasts on 2.4 GHz, force your laptop onto it so the hotspot runs there too:
  ```bash
  nmcli con modify "<your-wifi>" 802-11-wireless.band bg      # undo: ... 802-11-wireless.band ""
  nmcli con up "<your-wifi>"
  ```
- The hotspot password is stored in plain text in GSettings.
- Clients get Cloudflare/Google DNS (1.1.1.1, 8.8.8.8); internal/VPN DNS names are not resolvable from hotspot clients.

## Uninstall
```bash
gnome-extensions disable wifi-hotspot-auto@taghouti
rm -rf ~/.local/share/gnome-shell/extensions/wifi-hotspot-auto@taghouti
sudo rm /etc/NetworkManager/conf.d/99-hotspot-ext.conf /usr/local/bin/gnome-hotspot-helper /usr/share/polkit-1/actions/org.gnome.hotspotext.helper.policy
```

---

First published as a [gist](https://gist.github.com/taghouttarek/267a91e305a469835a45992c9de30db0).
