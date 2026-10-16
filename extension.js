import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const HELPER = '/usr/local/bin/gnome-hotspot-helper';
const MODES = [['never', 'Never'], ['always', 'Always'], ['auto', 'Only on selected networks']];

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

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Wi-Fi Hotspot Auto');
        this._ext = ext;
        this._icon = new St.Icon({icon_name: 'network-wireless-hotspot-symbolic', style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._status = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._status);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._modeItems = {};
        for (const [id, label] of MODES) {
            const item = new PopupMenu.PopupMenuItem(_(label));
            item.connect('activate', () => ext.settings.set_string('mode', id));
            this.menu.addMenuItem(item);
            this._modeItems[id] = item;
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._addCurrent = new PopupMenu.PopupMenuItem(_('Add current network to triggers'));
        this._addCurrent.connect('activate', () => ext.addCurrentNetwork());
        this.menu.addMenuItem(this._addCurrent);

        const prefs = new PopupMenu.PopupMenuItem(_('Settings'));
        prefs.connect('activate', () => ext.openPreferences());
        this.menu.addMenuItem(prefs);
    }

    update(mode, active, ssid, busy) {
        for (const [id, item] of Object.entries(this._modeItems))
            item.setOrnament(id === mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
        this._icon.opacity = active ? 255 : 110;
        this._icon.style = active ? 'color: #57e389;' : '';
        const state = busy ? _('working…') : active ? _('ON') : _('off');
        this._status.label.text = `${_('Hotspot')}: ${state}  ·  ${_('Wi-Fi')}: ${ssid ?? _('not connected')}`;
        this._addCurrent.visible = !!ssid;
    }
});

export default class WifiHotspotAuto extends Extension {
    enable() {
        this.settings = this.getSettings();
        this._active = false;
        this._busy = false;
        this._pending = false;
        this._ssid = null;
        this._apWatch = null;
        this._timer = 0;

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settingsIds = ['mode', 'trigger-ssids', 'hotspot-ssid', 'hotspot-password', 'wifi-interface', 'ap-interface']
            .map(k => this.settings.connect(`changed::${k}`, () => this._schedule()));

        NM.Client.new_async(null, (obj, res) => {
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                console.error(`wifi-hotspot-auto: NM client: ${e}`);
                return;
            }
            if (!this._indicator) return;
            this._devAddedId = this._client.connect('device-added', () => this._watchDevice());
            this._watchDevice();
            this._refreshActive().then(() => this._schedule(0));
        });
        this._refreshUi();
    }

    disable() {
        for (const id of this._settingsIds ?? []) this.settings.disconnect(id);
        this._settingsIds = null;
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
        this._unwatchDevice();
        if (this._client && this._devAddedId) this._client.disconnect(this._devAddedId);
        this._client = null;
        this._indicator?.destroy();
        this._indicator = null;
        this.settings = null;
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
            this._apWatch.dev.disconnect(this._apWatch.id);
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
        this._ssid = bytes ? NM.utils_ssid_to_utf8(bytes.get_data()) : null;
        this._refreshUi();
        this._schedule();
    }

    addCurrentNetwork() {
        if (!this._ssid) return;
        const list = this.settings.get_strv('trigger-ssids');
        if (!list.includes(this._ssid))
            this.settings.set_strv('trigger-ssids', [...list, this._ssid]);
        Main.notify('Wi-Fi Hotspot Auto', `${this._ssid} ${_('added to trigger networks')}`);
    }

    _refreshUi() {
        this._indicator?.update(this.settings.get_string('mode'), this._active, this._ssid, this._busy);
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
        try {
            const [ok, data] = GLib.file_get_contents('/run/gnome-hotspot-ext/hostapd.pid');
            const pid = ok ? new TextDecoder().decode(data).trim() : '';
            this._active = /^\d+$/.test(pid) && GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
        } catch (e) {
            this._active = false;
        }
    }

    async _evaluate() {
        if (!this._indicator) return;
        if (this._busy) { this._pending = true; return; }
        const want = this._wanted();
        if (want === this._active) { this._refreshUi(); return; }
        this._busy = true;
        this._refreshUi();
        try {
            const err = want ? await this._start() : await this._stop();
            if (err) Main.notify('Wi-Fi Hotspot Auto', err);
        } finally {
            await this._refreshActive();
            this._busy = false;
            this._refreshUi();
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
        const r = await run(['pkexec', HELPER, 'start', parent, ap, ssid, String(chan)], `${pw}\n`);
        if (!r.ok) return `${_('Hotspot failed to start')}\n${r.err}`;
        return null;
    }

    async _stop() {
        const ap = this.settings.get_string('ap-interface');
        const parent = this._wifiIface() ?? 'none';
        await run(['pkexec', HELPER, 'stop', parent, ap]);
        return null;
    }
}
