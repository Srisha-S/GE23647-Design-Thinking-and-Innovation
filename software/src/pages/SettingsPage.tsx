import { useState } from 'react';
import { Bell, Check, ChevronRight, CircleHelp, Heart, Info, MonitorSmartphone, Moon, Sun } from 'lucide-react';
import { useWorkspace } from '../state/WorkspaceContext';
import { useDevice } from '../state/DeviceContext';
import { useAppearance, accentColours } from '../state/AppearanceContext';
import { Modal } from '../components/ui';
import { ChromaPodArtwork } from '../components/FeatureArtwork';
import { readScanAlerts, writeScanAlerts } from '../lib/uiPreferences';

export default function SettingsPage() {
  const { navigate, toast } = useWorkspace();
  const { status } = useDevice();
  const { theme, resolvedTheme, setTheme, accent, setAccent } = useAppearance();
  const [panel, setPanel] = useState<'appearance' | 'colour' | 'notifications' | 'help' | null>(null);
  const [alerts, setAlerts] = useState(readScanAlerts);
  const deviceLabel = status.mode === 'demo' ? 'Demo mode' : status.connected ? 'Connected' : 'Disconnected';
  return <div className="wireframe-page wireframe-settings">
    <h1 className="sr-only">Settings</h1>
    <div className="wireframe-settings-group">
      <button data-settings-row="appearance" className="wireframe-settings-row" onClick={() => setPanel('appearance')}><Sun size={23} /><span><strong>Appearance</strong><small>{resolvedTheme === 'dark' ? 'Dark' : 'Light'} / Auto</small></span><ChevronRight size={18} /></button>
      <button data-settings-row="colour" className="wireframe-settings-row" onClick={() => setPanel('colour')}><Heart size={23} /><span><strong>Theme Colour</strong><span className="wireframe-colour-dots">{accentColours.map(item => <i key={item.id} style={{ background: item.hex }} />)}</span></span><ChevronRight size={18} /></button>
    </div>
    <button data-settings-row="device" className="wireframe-settings-row wireframe-device-setting" onClick={() => navigate('device')}><ChromaPodArtwork /><span><strong>Device</strong><small>ChromaPod</small><small>{deviceLabel} <i className={`status-dot ${status.connected && status.mode !== 'demo' ? '' : 'offline'}`} /></small></span><ChevronRight size={18} /></button>
    <div className="wireframe-settings-group">
      <button data-settings-row="notifications" className="wireframe-settings-row" onClick={() => setPanel('notifications')}><Bell size={22} /><span><strong>Notifications</strong></span><ChevronRight size={18} /></button>
      <button data-settings-row="help" className="wireframe-settings-row" onClick={() => setPanel('help')}><CircleHelp size={22} /><span><strong>Help &amp; Support</strong></span><ChevronRight size={18} /></button>
      <button data-settings-row="about" className="wireframe-settings-row" onClick={() => navigate('about')}><Info size={22} /><span><strong>About</strong></span><ChevronRight size={18} /></button>
    </div>
    {panel === 'appearance' && <Modal title="Appearance" onClose={() => setPanel(null)}><div className="reference-theme-options">{([{ value: 'light', label: 'Light', icon: Sun }, { value: 'dark', label: 'Dark', icon: Moon }, { value: 'system', label: 'Auto', icon: MonitorSmartphone }] as const).map(({ value, label, icon: Icon }) => <button type="button" key={value} data-theme-option={value} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon size={19} />{label}</button>)}</div></Modal>}
    {panel === 'colour' && <Modal title="Theme Colour" onClose={() => setPanel(null)}><div className="wireframe-accent-options">{accentColours.map(item => <button key={item.id} data-accent-option={item.id} aria-pressed={accent === item.id} onClick={() => setAccent(item.id)}><i style={{ background: item.hex }}>{accent === item.id && <Check size={19} style={{ color: item.ink }} />}</i><span>{item.name}</span></button>)}</div></Modal>}
    {panel === 'notifications' && <Modal title="Notifications" onClose={() => setPanel(null)}><label className="wireframe-alert-toggle"><span><strong>Scan result alerts</strong><small>Show an in-app message when a colour is captured.</small></span><input type="checkbox" checked={alerts} onChange={event => { const enabled = event.target.checked; setAlerts(enabled); if (!writeScanAlerts(enabled)) toast('This preference could not be saved on this device.'); }} /></label></Modal>}
    {panel === 'help' && <Modal title="Help & Support" onClose={() => setPanel(null)}><p>Scan captures a colour with ChromaPod or demo mode. Compare measures two colours. Convert changes colour formats. Image Match finds a colour in your photo.</p><p>Open the ChromaPod card to connect by Bluetooth, USB or Wi-Fi. Demo mode is clearly labelled.</p><p>Your saved colours, comparisons and projects remain on this device. Export or import a JSON backup from the Library menu.</p><button className="btn primary" onClick={() => navigate('device')}>Open Device</button></Modal>}
  </div>;
}
