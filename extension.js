import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const HELPER = '/usr/local/bin/gnome-hotspot-helper';
const RUN_DIR = '/run/gnome-hotspot-ext';
const MODES = [
    ['never', 'Never', 'Hotspot stays off'],
    ['always', 'Always', 'Hotspot stays on'],
    ['auto', 'Selected networks', 'On only while connected to a selected network'],
];
const COLOR_ON = '#57e389';
const COLOR_ERR = '#ffa348';
const MAX_LOG = 300;

function run(argv, stdin = null) {
    return new Promise(resolve => {
        try {
            const p = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE |
                (stdin !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0));
            p.communicate_utf8_async(stdin, null, (proc, res) => {
                try {
                    const [, out, err] = proc.communicate_utf8_finish(res);
                    resolve({ok: proc.get_successful(), out: out ?? '', err: (err ?? '').trim()});
                } catch (e) {
                    resolve({ok: false, out: '', err: String(e)});
                }
            });
        } catch (e) {
            resolve({ok: false, out: '', err: String(e)});
        }
    });
}

function fmtBytes(n) {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function readFile(path) {
    try {
        const [ok, data] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(data) : '';
    } catch (e) {
        return '';
    }
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Wi-Fi Hotspot Auto');
        this._ext = ext;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({icon_name: 'network-wireless-hotspot-symbolic', style_class: 'system-status-icon'});
        this._count = new St.Label({y_align: Clutter.ActorAlign.CENTER, visible: false, style: 'font-weight: bold; padding-left: 2px;'});
        box.add_child(this._icon);
        box.add_child(this._count);
        this.add_child(box);

        // On/off switch
        this._toggle = new PopupMenu.PopupSwitchMenuItem(_('Hotspot'), false);
        this._toggle.connect('toggled', (_item, state) => {
            if (this._syncing) return;
            ext.setEnabled(state);
        });
        this.menu.addMenuItem(this._toggle);

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._status.label.style = 'font-size: 0.9em;';
        this.menu.addMenuItem(this._status);
        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._errorItem.label.style = `color: ${COLOR_ERR}; font-size: 0.9em;`;
        this._errorItem.label.clutter_text.line_wrap = true;
        this._errorItem.visible = false;
        this.menu.addMenuItem(this._errorItem);

        this._traffic = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._traffic.label.style = 'font-size: 0.9em;';
        this._traffic.visible = false;
        this.menu.addMenuItem(this._traffic);

        // Connected devices
        this._clients = new PopupMenu.PopupSubMenuMenuItem(_('Connected devices'));
        this.menu.addMenuItem(this._clients);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Mode
        this._modeMenu = new PopupMenu.PopupSubMenuMenuItem('');
        this._modeItems = {};
        for (const [id, label, hint] of MODES) {
            const item = new PopupMenu.PopupMenuItem(_(label));
            item.setSensitive(true);
            item.connect('activate', () => ext.settings.set_string('mode', id));
            this._modeMenu.menu.addMenuItem(item);
            this._modeItems[id] = {item, hint};
        }
        this.menu.addMenuItem(this._modeMenu);

        this._addCurrent = new PopupMenu.PopupMenuItem(_('Add current network to triggers'));
        this._addCurrent.connect('activate', () => ext.addCurrentNetwork());
        this.menu.addMenuItem(this._addCurrent);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const logs = new PopupMenu.PopupMenuItem(_('Show logs'));
        logs.connect('activate', () => ext.showLogs());
        this.menu.addMenuItem(logs);
        const prefs = new PopupMenu.PopupMenuItem(_('Settings'));
        prefs.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(prefs);
    }

    update(s) {
        const {mode, active, ssid, busy, error, hotspotSsid, channel, clients, traffic} = s;

        // Show the requested state, not the (lagging) actual one, so the switch never snaps back.
        this._syncing = true;
        this._toggle.setToggleState(s.want && !error);
        this._syncing = false;
        this._toggle.label.text = busy ? _('Hotspot (working…)') : _('Hotspot');

        for (const [id, {item}] of Object.entries(this._modeItems))
            item.setOrnament(id === mode ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        const modeLabel = MODES.find(m => m[0] === mode)?.[1] ?? mode;
        this._modeMenu.label.text = `${_('Mode')}: ${_(modeLabel)}`;

        const line = active
            ? `${hotspotSsid}${channel ? ` · ch ${channel}` : ''} · ${clients.length} ${_('device(s)')}`
            : `${_('Off')} · Wi-Fi: ${ssid ?? _('not connected')}`;
        this._traffic.visible = active;
        this._traffic.label.text = traffic
            ? `↓ ${fmtBytes(traffic.down)} (${fmtBytes(traffic.downRate)}/s)   ↑ ${fmtBytes(traffic.up)} (${fmtBytes(traffic.upRate)}/s)`
            : '';
        this._status.label.text = line;

        this._icon.opacity = active || error ? 255 : 110;
        this._icon.style = active ? `color: ${COLOR_ON};` : error ? `color: ${COLOR_ERR};` : '';
        this._count.visible = active && clients.length > 0;
        this._count.text = String(clients.length);
        this._count.style = `font-weight: bold; padding-left: 2px; color: ${COLOR_ON};`;

        this._errorItem.visible = !!error && !active;
        this._errorItem.label.text = error ?? '';

        this._clients.visible = active;
        this._clients.label.text = `${_('Connected devices')} (${clients.length})`;
        this._clients.menu.removeAll();
        if (clients.length === 0) {
            const none = new PopupMenu.PopupMenuItem(_('No devices connected'), {reactive: false});
            this._clients.menu.addMenuItem(none);
        }
        for (const c of clients) {
            const name = c.host && c.host !== '*' ? c.host : c.mac;
            const it = new PopupMenu.PopupMenuItem(name, {reactive: false});
            it.label.style = 'font-weight: bold;';
            this._clients.menu.addMenuItem(it);
            const detail = [c.ip, c.signal ? `${c.signal} dBm` : null, c.mac].filter(Boolean).join('  ·  ');
            const d1 = new PopupMenu.PopupMenuItem(`    ${detail}`, {reactive: false});
            const d2 = new PopupMenu.PopupMenuItem(`    ↓ ${fmtBytes(c.down ?? 0)} (${fmtBytes(c.downRate ?? 0)}/s)   ↑ ${fmtBytes(c.up ?? 0)} (${fmtBytes(c.upRate ?? 0)}/s)`, {reactive: false});
            for (const x of [d1, d2]) x.label.style = 'font-size: 0.85em;';
            this._clients.menu.addMenuItem(d1);
            this._clients.menu.addMenuItem(d2);
        }

        this._addCurrent.visible = !!ssid && mode !== 'never';
    }
});

export default class WifiHotspotAuto extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._active = false;
        this._busy = false;
        this._pending = false;
        this._lastError = null;
        this._ssid = null;
        this._channel = null;
        this._clients = [];
        this._traffic = null;
        this._prevStats = null;
        this._apWatch = null;
        this._timer = 0;
        this._pollTimer = 0;
        this._logLines = [];
        this._log('Extension enabled');

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settingsIds = ['mode', 'trigger-ssids', 'hotspot-ssid', 'hotspot-password', 'wifi-interface', 'ap-interface']
            .map(k => this.settings.connect(`changed::${k}`, () => {
                if (k === 'mode') this._log(`Mode set to ${this.settings.get_string('mode')}`);
                this._schedule();
            }));

        NM.Client.new_async(null, (obj, res) => {
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                this._log(`NetworkManager client error: ${e}`);
                return;
            }
            if (!this._indicator) return;
            this._devAddedId = this._client.connect('device-added', () => this._watchDevice());
            this._watchDevice();
            this._refreshActive().then(() => this._schedule(0));
        });

        this._pollTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
        this._refreshUi();
    }

    disable() {
        for (const id of this._settingsIds ?? []) this.settings.disconnect(id);
        this._settingsIds = null;
        if (this._timer) GLib.source_remove(this._timer);
        if (this._pollTimer) GLib.source_remove(this._pollTimer);
        this._timer = this._pollTimer = 0;
        this._unwatchDevice();
        if (this._client && this._devAddedId) GObject.signal_handler_disconnect(this._client, this._devAddedId);
        this._client = null;
        this._logDialog?.destroy();
        this._logDialog = null;
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
    }

    // ---------------------------------------------------------------- logging / notifications
    _log(msg) {
        const ts = GLib.DateTime.new_now_local().format('%H:%M:%S');
        this._logLines.push(`${ts}  ${msg}`);
        if (this._logLines.length > MAX_LOG) this._logLines.shift();
        console.log(`wifi-hotspot-auto: ${msg}`);
    }

    _notify(title, body, force = false) {
        if (force || this.settings?.get_boolean('notifications'))
            Main.notify(title, body);
    }

    showLogs() {
        this._logDialog?.destroy();
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: false});
        const label = new St.Label({style: 'font-family: monospace; font-size: 9pt;'});
        label.clutter_text.line_wrap = true;
        label.clutter_text.selectable = true;
        const scroll = new St.ScrollView({style: 'min-width: 640px; max-width: 760px; height: 420px;', overlay_scrollbars: true});
        const holder = new St.BoxLayout({vertical: true});
        holder.add_child(label);
        scroll.set_child(holder);
        dialog.contentLayout.add_child(new St.Label({text: _('Wi-Fi Hotspot logs'), style: 'font-weight: bold; padding-bottom: 8px;'}));
        dialog.contentLayout.add_child(scroll);

        const build = () => {
            const tail = (txt, n) => txt.trim().split('\n').slice(-n).join('\n');
            const host = readFile(`${RUN_DIR}/hostapd.log`);
            const leases = readFile(`${RUN_DIR}/dnsmasq.leases`);
            label.text = [
                `── ${_('Extension')} ──`, this._logLines.join('\n') || _('(empty)'),
                '', '── hostapd ──', host ? tail(host, 40) : _('(no log: hotspot not running or log not readable)'),
                '', `── ${_('Traffic')} ──`,
                this._traffic ? `↓ ${fmtBytes(this._traffic.down)}  ↑ ${fmtBytes(this._traffic.up)}` : _('(hotspot off)'),
                ...this._clients.map(c => `${c.host ?? c.mac} ${c.ip ?? ''}  ↓ ${fmtBytes(c.down)}  ↑ ${fmtBytes(c.up)}  ${c.signal ?? '?'} dBm`),
                '', `── ${_('DHCP leases')} ──`, leases.trim() || _('(none)'),
            ].join('\n');
        };
        build();

        dialog.addButton({label: _('Refresh'), action: () => build()});
        dialog.addButton({label: _('Copy'), action: () =>
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, label.text)});
        dialog.addButton({label: _('Close'), action: () => dialog.close(), default: true});
        this._logDialog = dialog;
        dialog.open();
    }

    // ---------------------------------------------------------------- state
    setEnabled(on) {
        this._log(`Manual toggle: ${on ? 'ON' : 'OFF'} (mode -> ${on ? 'always' : 'never'})`);
        // Defer so the settings cascade runs outside the switch's own signal emission.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.settings?.set_string('mode', on ? 'always' : 'never');
            return GLib.SOURCE_REMOVE;
        });
    }

    _wifiIface() {
        const cfg = this.settings.get_string('wifi-interface');
        if (cfg) return cfg;
        const apName = this.settings.get_string('ap-interface');
        const dev = this._client?.get_devices().find(d =>
            d.get_device_type() === NM.DeviceType.WIFI && d.get_iface() !== apName);
        return dev?.get_iface() ?? null;
    }

    _unwatchDevice() {
        if (this._apWatch) {
            GObject.signal_handler_disconnect(this._apWatch.dev, this._apWatch.id);
            this._apWatch = null;
        }
    }

    _watchDevice() {
        const iface = this._wifiIface();
        const dev = this._client?.get_devices().find(d => d.get_iface() === iface);
        if (!dev || dev.get_device_type() !== NM.DeviceType.WIFI) return;
        if (this._apWatch?.dev === dev) return;
        this._unwatchDevice();
        this._apWatch = {dev, id: dev.connect('notify::active-access-point', () => this._onApChanged())};
        this._onApChanged();
    }

    _currentAp() {
        return this._apWatch?.dev.get_active_access_point() ?? null;
    }

    _onApChanged() {
        const ap = this._currentAp();
        const bytes = ap?.get_ssid();
        const ssid = bytes ? NM.utils_ssid_to_utf8(bytes.get_data()) : null;
        if (ssid !== this._ssid) this._log(`Wi-Fi network: ${ssid ?? 'disconnected'}`);
        this._ssid = ssid;
        this._refreshUi();
        this._schedule();
    }

    addCurrentNetwork() {
        if (!this._ssid) return;
        const list = this.settings.get_strv('trigger-ssids');
        if (!list.includes(this._ssid))
            this.settings.set_strv('trigger-ssids', [...list, this._ssid]);
        this._log(`Added trigger network: ${this._ssid}`);
        this._notify('Wi-Fi Hotspot Auto', `${this._ssid} ${_('added to trigger networks')}`, true);
    }

    _refreshUi() {
        this._indicator?.update({
            mode: this.settings.get_string('mode'),
            active: this._active,
            ssid: this._ssid,
            busy: this._busy,
            want: this._wanted(),
            error: this._lastError ? this._lastError.split('\n')[0] : null,
            hotspotSsid: this.settings.get_string('hotspot-ssid'),
            channel: this._channel,
            clients: this._clients,
            traffic: this._traffic,
        });
    }

    _schedule(delayMs = 1500) {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timer = 0;
            this._evaluate();
            return GLib.SOURCE_REMOVE;
        });
        this._refreshUi();
    }

    _wanted() {
        const mode = this.settings.get_string('mode');
        if (mode === 'always') return true;
        if (mode === 'auto') return !!this._ssid && this.settings.get_strv('trigger-ssids').includes(this._ssid);
        return false;
    }

    async _refreshActive() {
        const pid = readFile(`${RUN_DIR}/hostapd.pid`).trim();
        this._active = /^\d+$/.test(pid) && GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
    }

    // Periodic: sync running state, list connected devices, notify on join/leave.
    async _poll() {
        if (!this._indicator || this._busy) return;
        const was = this._active;
        await this._refreshActive();
        if (was && !this._active) {
            this._log('Hotspot stopped unexpectedly');
            this._notify('Wi-Fi Hotspot Auto', _('Hotspot stopped unexpectedly'));
        }
        const prev = this._clients;
        if (this._active) {
            const ap = this.settings.get_string('ap-interface');
            const [st, info] = await Promise.all([
                run(['iw', 'dev', ap, 'station', 'dump']),
                run(['iw', 'dev', ap, 'info']),
            ]);
            const leases = {};
            for (const l of readFile(`${RUN_DIR}/dnsmasq.leases`).split('\n')) {
                const f = l.split(' ');
                if (f.length >= 4) leases[f[1].toLowerCase()] = {ip: f[2], host: f[3]};
            }
            this._channel = /channel (\d+)/.exec(info.out)?.[1] ?? this._channel;
            const now = GLib.get_monotonic_time() / 1e6;
            const prevStats = this._prevStats;
            const dt = prevStats ? Math.max(now - prevStats.t, 0.5) : 0;
            const perMac = {};
            this._clients = st.out.split(/^Station /m).slice(1).map(b => {
                const mac = b.split(/\s/)[0].toLowerCase();
                // station "tx bytes" = sent to the device (its download), "rx bytes" = its upload
                const up = Number(/rx bytes:\s+(\d+)/.exec(b)?.[1] ?? 0);
                const down = Number(/tx bytes:\s+(\d+)/.exec(b)?.[1] ?? 0);
                const p = prevStats?.perMac[mac];
                perMac[mac] = {up, down};
                return {
                    mac, up, down,
                    upRate: p && up >= p.up ? (up - p.up) / dt : 0,
                    downRate: p && down >= p.down ? (down - p.down) / dt : 0,
                    signal: /signal:\s+(-?\d+)/.exec(b)?.[1], ...(leases[mac] ?? {}),
                };
            });
            // interface totals (include devices that already left): tx = downloads, rx = uploads
            const stat = n => Number(readFile(`/sys/class/net/${ap}/statistics/${n}`).trim() || 0);
            const down = stat('tx_bytes'), up = stat('rx_bytes');
            this._traffic = {
                down, up,
                downRate: prevStats && down >= prevStats.down ? (down - prevStats.down) / dt : 0,
                upRate: prevStats && up >= prevStats.up ? (up - prevStats.up) / dt : 0,
            };
            this._prevStats = {t: now, down, up, perMac};
        } else {
            this._clients = [];
            this._channel = null;
            this._traffic = null;
            this._prevStats = null;
        }
        const name = c => (c.host && c.host !== '*' ? c.host : c.mac);
        for (const c of this._clients)
            if (!prev.some(p => p.mac === c.mac)) {
                this._log(`Device joined: ${name(c)} ${c.ip ?? ''}`);
                this._notify(_('Hotspot'), `${name(c)} ${_('connected')}`);
            }
        for (const p of prev)
            if (!this._clients.some(c => c.mac === p.mac)) {
                this._log(`Device left: ${name(p)}`);
                this._notify(_('Hotspot'), `${name(p)} ${_('disconnected')}`);
            }
        this._refreshUi();
    }

    async _evaluate() {
        if (!this._indicator) return;
        if (this._busy) { this._pending = true; return; }
        const want = this._wanted();
        if (want === this._active) { this._lastError = null; this._refreshUi(); return; }
        this._busy = true;
        this._lastError = null;
        this._refreshUi();
        try {
            const err = want ? await this._start() : await this._stop();
            if (err) {
                this._lastError = err;
                this._log(`ERROR: ${err}`);
                this._notify(_('Hotspot failed'), err, true);
            } else {
                const ssid = this.settings.get_string('hotspot-ssid');
                this._log(want ? `Hotspot ON (${ssid})` : 'Hotspot OFF');
                this._notify(want ? _('Hotspot ON') : _('Hotspot OFF'),
                    want ? `"${ssid}" ${_('is now available')}` : _('The hotspot was turned off'));
            }
        } finally {
            this._busy = false;
            await this._refreshActive();
            await this._poll();
            if (this._pending) { this._pending = false; this._schedule(500); }
        }
    }

    async _start() {
        const parent = this._wifiIface();
        const ap = this.settings.get_string('ap-interface');
        const ssid = this.settings.get_string('hotspot-ssid');
        const pw = this.settings.get_string('hotspot-password');
        if (!parent) return _('No Wi-Fi interface found');
        if (pw.length < 8) return _('Hotspot password must be at least 8 characters (see Settings)');
        if (!ssid) return _('Hotspot name is empty (see Settings)');

        // The AP must share the channel of the active client connection.
        let chan = 0;
        const apObj = this._currentAp();
        if (apObj) {
            const freq = apObj.get_frequency();
            if (freq >= 5260 && freq <= 5720)
                return _('Cannot start the hotspot: your Wi-Fi is on a DFS channel (%d MHz), where this card cannot host an access point. Use a 2.4 GHz or non-DFS 5 GHz network.').format(freq);
            chan = NM.utils_wifi_freq_to_channel(freq);
        }
        this._log(`Starting hotspot on ${parent} -> ${ap}, channel ${chan || 'default'}`);
        const r = await run(['pkexec', HELPER, 'start', parent, ap, ssid, String(chan)], `${pw}\n`);
        if (!r.ok) return `${_('Hotspot failed to start')}: ${r.err}`;
        return null;
    }

    async _stop() {
        const ap = this.settings.get_string('ap-interface');
        const parent = this._wifiIface() ?? 'none';
        this._log('Stopping hotspot');
        await run(['pkexec', HELPER, 'stop', parent, ap]);
        return null;
    }
}
