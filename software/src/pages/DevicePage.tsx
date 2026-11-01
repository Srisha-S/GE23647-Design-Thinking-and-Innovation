import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BatteryMedium, Bluetooth, Check, Cpu, LoaderCircle, Power, Radio, ScanLine, SlidersHorizontal, Usb, Wifi } from 'lucide-react';
import { useDevice } from '../state/DeviceContext';
import { useWorkspace } from '../state/WorkspaceContext';
import './device.css';

export function DevicePage() {
  const { status, reading, scanning, activeMode, error, bleState, latestBleData, isNative, connectDevice, disconnectDevice } = useDevice();
  const { workspace } = useWorkspace();
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState('ws://192.168.1.42:81');
  const connectionAttempt = useRef(0);
  useEffect(() => () => { ++connectionAttempt.current; }, []);
  const simulated = status.mode === 'demo';
  const available = status.mode !== 'disconnected';
  const bluetoothSupported = isNative || (window.isSecureContext && typeof (navigator as Navigator & { bluetooth?: { requestDevice?: unknown } }).bluetooth?.requestDevice === 'function');
  const bluetoothBusy = ['searching', 'found', 'connecting'].includes(bleState.state);
  const latest = reading?.hex || workspace.latest.hex;
  const latestSource = reading?.source || workspace.latest.source;
  const labels = { available: 'Bluetooth available', searching: 'Searching for CHROMA...', found: 'CHROMA found', connecting: 'Connecting...', connected: 'Connected to CHROMA', disconnected: 'Disconnected', unavailable: 'Bluetooth unavailable', 'permission-denied': 'Permission denied', error: 'Bluetooth connection failed' };
  async function connect(kind: 'demo' | 'usb' | 'wifi' | 'bluetooth') {
    const attempt = ++connectionAttempt.current;
    setConnecting(true);
    try { await connectDevice(kind, kind === 'wifi' ? address : undefined); }
    finally { if (attempt === connectionAttempt.current) setConnecting(false); }
  }
  function cancelConnection() { ++connectionAttempt.current; setConnecting(false); void disconnectDevice(); }
  return <div className="wireframe-page chroma-device">
    <h1 className="sr-only" tabIndex={-1}>ChromaPod</h1>
    <section className="chroma-device-section" aria-labelledby="device-information-title">
      <div className="chroma-device-heading"><h2 id="device-information-title">Device Information</h2><span className="chroma-device-status"><i className={`status-dot ${!status.connected || simulated ? 'offline' : ''}`} />{simulated ? 'Demo mode' : status.connected ? 'Connected' : 'Disconnected'}</span></div>
      <dl className="chroma-device-specs">
        <div><dt>Name</dt><dd>ChromaPod</dd></div>
        <div><dt><BatteryMedium size={16} />Battery</dt><dd>{status.battery === null ? 'Not reported' : status.battery + '%'}{simulated && <small>Demo</small>}</dd></div>
        <div><dt><Cpu size={16} />Firmware</dt><dd>{status.firmware || 'Not reported'}{simulated && <small>Demo</small>}</dd></div>
        <div><dt><ScanLine size={16} />Last reading</dt><dd>{latestSource === 'sample' ? 'No scan yet' : latest}{latestSource === 'demo' && <small>Demo</small>}</dd></div>
        <div><dt><SlidersHorizontal size={16} />Current mode</dt><dd>{scanning ? 'Scanning...' : activeMode.replace('-', ' ')}</dd></div>
      </dl>
      {available && <button className="btn secondary full-width" onClick={() => void disconnectDevice()}><Power size={16} />Disconnect</button>}
    </section>
    <section className="chroma-device-section" aria-labelledby="connect-title">
      <h2 id="connect-title">Connection Method</h2>
      <div className="chroma-connection-options">
        <button className={`connection-choice ${status.mode === 'bluetooth' ? 'selected' : ''}`} onClick={() => void connect('bluetooth')} disabled={connecting || status.mode === 'bluetooth' || !bluetoothSupported} aria-describedby="device-bluetooth-help" aria-busy={bluetoothBusy}>{bluetoothBusy ? <LoaderCircle className="device-spinning" /> : <Bluetooth />}<span><strong>{status.mode === 'bluetooth' ? isNative ? 'Connected to CHROMA' : 'Connected by Bluetooth' : isNative ? 'Connect CHROMA' : bluetoothSupported ? 'Connect Bluetooth' : 'Bluetooth unavailable'}</strong><small>Bluetooth Low Energy</small></span>{status.mode === 'bluetooth' && <Check size={17} />}</button>
        <div id="device-bluetooth-help"><p className="helper">{bluetoothSupported ? 'Turn on Bluetooth, keep ChromaPod nearby and select CHROMA.' : 'Use the Android app, or Chrome/Edge on a supported device with HTTPS or localhost.'}</p>{isNative && <div className={`device-bluetooth-state ${bleState.state}`} role="status"><strong>{labels[bleState.state]}</strong>{bleState.message && <span>{bleState.message}</span>}</div>}</div>
        <button className={`connection-choice ${status.mode === 'usb' ? 'selected' : ''}`} onClick={() => void connect('usb')} disabled={connecting || status.mode === 'usb'}><Usb /><span><strong>{status.mode === 'usb' ? 'Connected by USB' : 'Connect with USB'}</strong><small>Chrome or Edge with a USB data cable</small></span>{status.mode === 'usb' && <Check size={17} />}</button>
        <form className="chroma-device-wifi" onSubmit={event => { event.preventDefault(); void connect('wifi'); }}><label htmlFor="device-address"><Wifi size={19} />Wi-Fi</label><div className="input-row"><input id="device-address" className="input" type="url" value={address} onChange={event => setAddress(event.target.value)} required spellCheck={false} placeholder="ws://192.168.1.42:81" aria-describedby="device-wifi-help" /><button className="btn secondary" type="submit" disabled={connecting || !address.trim()}><ArrowUpRight size={16} />Connect</button></div><small id="device-wifi-help">Use your ESP32 address on the same Wi-Fi network.</small></form>
        <button className={`connection-choice ${simulated ? 'selected' : ''}`} onClick={() => void connect('demo')} disabled={connecting || simulated}><Radio /><span><strong>{simulated ? 'Demo mode active' : 'Enable demo mode'}</strong><small>Clearly labelled simulated readings</small></span>{simulated && <Check size={17} />}</button>
      </div>
      {error && <p className="error-message" role="alert">{error}</p>}
      {connecting && <p className="helper" role="status">Waiting for the connection... <button className="text-button" type="button" onClick={cancelConnection}>Cancel</button></p>}
      {isNative && <details className="chroma-ble-debug"><summary>BLE data preview</summary><strong>Latest BLE data:</strong><pre data-testid="latest-ble-data">{latestBleData ?? 'No BLE data received yet.'}</pre></details>}
    </section>
  </div>;
}
export default DevicePage;