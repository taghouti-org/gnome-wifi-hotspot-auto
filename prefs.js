import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class Prefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Hotspot', icon_name: 'network-wireless-hotspot-symbolic'});
        window.add(page);

        const mode = new Adw.PreferencesGroup({title: 'When to share the connection'});
        page.add(mode);
        const ids = ['never', 'always', 'auto'];
        const combo = new Adw.ComboRow({
            title: 'Hotspot mode',
            subtitle: '"Selected networks" turns it on only while connected to the networks below',
            model: Gtk.StringList.new(['Never', 'Always', 'Only on selected networks']),
            selected: Math.max(0, ids.indexOf(s.get_string('mode'))),
        });
        combo.connect('notify::selected', () => s.set_string('mode', ids[combo.selected]));
        mode.add(combo);

        const trig = new Adw.EntryRow({title: 'Selected networks (comma-separated SSIDs)'});
        trig.text = s.get_strv('trigger-ssids').join(', ');
        trig.connect('changed', () => s.set_strv('trigger-ssids',
            trig.text.split(',').map(x => x.trim()).filter(Boolean)));
        mode.add(trig);

        const hs = new Adw.PreferencesGroup({title: 'Hotspot'});
        page.add(hs);
        const ssid = new Adw.EntryRow({title: 'Hotspot name'});
        ssid.text = s.get_string('hotspot-ssid');
        ssid.connect('changed', () => s.set_string('hotspot-ssid', ssid.text));
        hs.add(ssid);
        const pw = new Adw.PasswordEntryRow({title: 'Password (min 8 characters)'});
        pw.text = s.get_string('hotspot-password');
        pw.connect('changed', () => s.set_string('hotspot-password', pw.text));
        hs.add(pw);

        const adv = new Adw.PreferencesGroup({title: 'Advanced'});
        page.add(adv);
        const wif = new Adw.EntryRow({title: 'Wi-Fi interface (empty = auto-detect)'});
        wif.text = s.get_string('wifi-interface');
        wif.connect('changed', () => s.set_string('wifi-interface', wif.text.trim()));
        adv.add(wif);
        const api = new Adw.EntryRow({title: 'Virtual AP interface name'});
        api.text = s.get_string('ap-interface');
        api.connect('changed', () => s.set_string('ap-interface', api.text.trim() || 'ap0'));
        adv.add(api);
    }
}
