import { CHROMA_BLE_CONFIG, CHROMA_SERVICE_UUID, CHROMA_DATA_CHARACTERISTIC_UUID,
  CHROMA_COMMAND_CHARACTERISTIC_UUID } from './src/config/ble.ts';

const DEMO_COLOURS = [
  { hex: '#C76B4A', name: 'Terracotta' },
  { hex: '#A3B18A', name: 'Soft sage' },
  { hex: '#D4808E', name: 'Dusty rose' },
  { hex: '#E9C46A', name: 'Golden hour' },
  { hex: '#597C8B', name: 'Coastal blue' },
  { hex: '#8B779E', name: 'Wild lavender' },
  { hex: '#E6DDCE', name: 'Warm linen' },
  { hex: '#264653', name: 'Deep ocean' },
];

const VALID_MODES = new Set(['scan', 'compare', 'convert', 'image-match']);
const MAX_MESSAGE_LENGTH = 65536;
// Compatibility export for callers; the firmware values live only in ble.ts.
export const CHROMA_BLE = Object.freeze({
  service: CHROMA_SERVICE_UUID,
  write: CHROMA_COMMAND_CHARACTERISTIC_UUID,
  notify: CHROMA_DATA_CHARACTERISTIC_UUID,
});
const BLE_WRITE_CHUNK_BYTES = 20;

function normalizeMode(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase().replace(/[ _]+/g, '-');
  return VALID_MODES.has(mode) ? mode : null;
}

/** Browser transport for the CHROMA prototype. No connection starts automatically. */
export class ChromaDevice extends EventTarget {
  constructor(bleConfig = CHROMA_BLE_CONFIG) {
    super();
    this._bleConfig = bleConfig;
    this._mode = 'disconnected';
    this._generation = 0;
    this._port = null;
    this._reader = null;
    this._writer = null;
    this._readTask = null;
    this._socket = null;
    this._cancelConnect = null;
    this._buffer = '';
    this._demoPending = null;
    this._lastDemo = -1;
    this._bleSession = null;
    this._bleWriteQueue = Promise.resolve();
  }

  get mode() { return this._mode; }
  // A simulated device is deliberately never reported as physically connected.
  get connected() { return this._mode === 'usb' || this._mode === 'wifi' || this._mode === 'bluetooth'; }

  _status(mode) {
    this._mode = mode;
    const labels = {
      demo: 'Demo mode', usb: 'CHROMA connected · USB',
      wifi: 'CHROMA connected · Wi-Fi', bluetooth: 'CHROMA connected · Bluetooth', disconnected: 'Device disconnected',
    };
    this.dispatchEvent(new CustomEvent('status', {
      detail: { mode, connected: this.connected, label: labels[mode] },
    }));
  }

  _error(message) {
    this.dispatchEvent(new CustomEvent('error', { detail: { message } }));
    return new Error(message);
  }

  async startDemo() {
    const cleanup = this.disconnect();
    const generation = this._generation;
    await cleanup;
    if (generation === this._generation) this._status('demo');
  }

  async connectUSB() {
    if (!globalThis.isSecureContext || !globalThis.navigator?.serial) {
      throw this._error('USB connection needs a browser with Web Serial, such as desktop Chrome or Edge, on localhost or HTTPS.');
    }
    const cleanup = this.disconnect();
    const generation = this._generation;
    let port;
    try {
      // Keep the chooser within the click handler's user activation.
      const [selectedPort] = await Promise.all([navigator.serial.requestPort(), cleanup]);
      port = selectedPort;
      if (generation !== this._generation) return false;
      await port.open({ baudRate: 115200 });
      if (generation !== this._generation) {
        await port.close();
        return false;
      }
      this._port = port;
      this._writer = port.writable.getWriter();
      this._reader = port.readable.getReader();
      this._status('usb');
      this._readTask = this._readUSB(this._reader, generation);
      return true;
    } catch (error) {
      if (generation !== this._generation) return false;
      await this.disconnect();
      if (port && !this._port) {
        try { await port.close(); } catch { /* Already closed or never opened. */ }
      }
      if (error.name === 'NotFoundError' || error.name === 'AbortError') return false;
      throw this._error(`Could not connect by USB: ${error.message}`);
    }
  }

  async connectWifi(address) {
    let url;
    try { url = new URL(String(address).trim()); } catch {
      throw this._error('Enter a valid device address, such as ws://192.168.1.42:81.');
    }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw this._error('Use a ws:// or wss:// device address without credentials or a fragment.');
    }
    if (globalThis.location?.protocol === 'https:' && url.protocol !== 'wss:') {
      throw this._error('An HTTPS website needs a secure wss:// connection. For a local ws:// prototype, open the site on localhost.');
    }
    const cleanup = this.disconnect();
    const generation = this._generation;
    await cleanup;
    if (generation !== this._generation) return false;

    return new Promise((resolve, reject) => {
      let socket;
      let settled = false;
      let timer;
      const finish = (error, connected = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this._cancelConnect === cancel) this._cancelConnect = null;
        if (error) reject(this._error(error));
        else resolve(connected);
      };
      const cancel = () => finish(null, false);
      try { socket = new WebSocket(url.href); } catch (error) {
        finish(`Could not open Wi-Fi connection: ${error.message}`);
        return;
      }
      this._socket = socket;
      this._cancelConnect = cancel;
      timer = setTimeout(() => {
        finish('The device did not respond. Check its Wi-Fi address and that both devices are on the same network.');
        if (generation === this._generation) void this.disconnect();
      }, 10000);
      socket.addEventListener('open', () => {
        if (generation !== this._generation) { socket.close(); return; }
        this._status('wifi');
        finish(null, true);
      });
      socket.addEventListener('message', (event) => {
        if (generation !== this._generation) return;
        if (typeof event.data !== 'string') {
          this._error('The device sent binary data. CHROMA expects JSON text messages.');
          return;
        }
        this._receiveText(event.data, 'wifi', true);
      });
      socket.addEventListener('error', () => {
        if (generation !== this._generation) return;
        if (!settled) finish('Could not reach CHROMA over Wi-Fi. Check the address and network connection.');
        else this._error('The Wi-Fi connection was interrupted. Reconnect to continue scanning.');
        void this.disconnect();
      });
      socket.addEventListener('close', () => {
        if (generation !== this._generation) return;
        if (!settled) finish('The device closed the connection before it was ready.');
        void this.disconnect();
      });
    });
  }

  async connectBluetooth() {
    if (!globalThis.isSecureContext || typeof globalThis.navigator?.bluetooth?.requestDevice !== 'function') {
      throw this._error('Bluetooth needs a browser with Web Bluetooth, such as desktop Chrome or Edge, on localhost or HTTPS. You can still use USB, Wi-Fi or demo mode.');
    }
    const cleanup = this.disconnect();
    const generation = this._generation;
    const session = { generation, device: null, server: null, write: null, notify: null,
      onValue: null, onDisconnect: null, notifications: false, decoder: new TextDecoder() };
    this._bleSession = session;
    let timeout;
    let cancel;
    let rejectAttempt;
    const cancelled = new Promise((resolve, reject) => { cancel = () => resolve(false); rejectAttempt = reject; });
    this._cancelConnect = cancel;
    const isCurrent = () => generation === this._generation && this._bleSession === session;
    const connectTask = (async () => {
      try {
        // Invoke the browser chooser before the first await: its user activation
        // must come directly from the Connect Bluetooth button.
        const chooser = navigator.bluetooth.requestDevice({
          filters: [{ name: this._bleConfig.deviceName }],
          optionalServices: [this._bleConfig.serviceUUID],
        });
        const [selected] = await Promise.all([chooser, cleanup]);
        session.device = selected;
        if (!isCurrent()) return false;
        if (selected.name !== this._bleConfig.deviceName) throw new Error('Select a device advertising as CHROMA.');
        if (!selected.gatt) throw new Error('The selected device does not expose a Bluetooth GATT server.');
        // The chooser is controlled by the user. Bound only GATT setup, not the
        // time the user spends choosing a device.
        timeout = setTimeout(() => {
          if (!isCurrent()) return;
          const error = this._error('CHROMA did not finish connecting over Bluetooth. Check that its BLE firmware is running, then try again.');
          if (this._cancelConnect === cancel) this._cancelConnect = null;
          void this.disconnect();
          rejectAttempt(error);
        }, this._bleConfig.connectTimeoutMs);
        session.onDisconnect = () => {
          if (!isCurrent()) return;
          this._error('CHROMA disconnected from Bluetooth. Move it closer and reconnect to continue.');
          void this.disconnect();
        };
        selected.addEventListener('gattserverdisconnected', session.onDisconnect);
        session.server = await selected.gatt.connect();
        if (!isCurrent()) { this._closeBluetooth(session); return false; }
        // A GATT connection is useful before the colour protocol is final.
        // Do not discover/subscribe/write characteristics merely because UUIDs exist.
        if (!this._bleConfig.colourProtocolEnabled) {
          this._status('bluetooth');
          return true;
        }
        const service = await session.server.getPrimaryService(this._bleConfig.serviceUUID);
        if (!isCurrent()) { this._closeBluetooth(session); return false; }
        session.write = await service.getCharacteristic(this._bleConfig.commandCharacteristicUUID);
        if (!isCurrent()) { this._closeBluetooth(session); return false; }
        session.notify = await service.getCharacteristic(this._bleConfig.dataCharacteristicUUID);
        if (!isCurrent()) { this._closeBluetooth(session); return false; }
        const canWrite = (session.write.properties?.write && typeof session.write.writeValueWithResponse === 'function') ||
          (session.write.properties?.writeWithoutResponse && typeof session.write.writeValueWithoutResponse === 'function');
        if (!canWrite) throw new Error('CHROMA firmware must expose a writable command characteristic.');
        if (!session.notify.properties?.notify && !session.notify.properties?.indicate) throw new Error('CHROMA firmware must expose colour notifications.');
        session.onValue = event => {
          if (!isCurrent() || !session.notifications) return;
          const value = event.target?.value;
          if (!value || !(value.buffer instanceof ArrayBuffer)) return;
          const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          this._receiveText(session.decoder.decode(bytes, { stream: true }), 'bluetooth');
        };
        session.notify.addEventListener('characteristicvaluechanged', session.onValue);
        session.notifications = true;
        await session.notify.startNotifications();
        if (!isCurrent()) { this._closeBluetooth(session); return false; }
        this._status('bluetooth');
        return true;
      } catch (error) {
        if (!isCurrent()) { this._closeBluetooth(session); return false; }
        // NotFoundError also means an absent GATT service. Only a chooser
        // cancellation, before a device was selected, is a quiet cancellation.
        const chooserCancelled = !session.device && (error.name === 'NotFoundError' || error.name === 'AbortError');
        if (this._cancelConnect === cancel) this._cancelConnect = null;
        await this.disconnect();
        if (chooserCancelled) return false;
        throw this._error(`Could not connect by Bluetooth: ${error.message} Check the CHROMA BLE firmware and try again.`);
      } finally {
        clearTimeout(timeout);
        if (this._cancelConnect === cancel) this._cancelConnect = null;
      }
    })();
    try { return await Promise.race([connectTask, cancelled]); }
    finally { clearTimeout(timeout); if (this._cancelConnect === cancel) this._cancelConnect = null; }
  }

  _closeBluetooth(session) {
    if (!session) return;
    if (session.onValue) session.notify?.removeEventListener('characteristicvaluechanged', session.onValue);
    if (session.onDisconnect) session.device?.removeEventListener('gattserverdisconnected', session.onDisconnect);
    // A late resolution from an old connection must not disconnect a newer
    // connection to the same device object.
    const reusedByNewSession = this._bleSession && this._bleSession !== session && this._bleSession.device === session.device;
    if (reusedByNewSession) return;
    if (session.notify && session.notifications) {
      try { Promise.resolve(session.notify.stopNotifications()).catch(() => {}); } catch { /* Already disconnected. */ }
    }
    session.notifications = false;
    try { if (session.device?.gatt?.connected) session.device.gatt.disconnect(); } catch { /* Already disconnected. */ }
  }

  async disconnect() {
    ++this._generation;
    const reader = this._reader;
    const writer = this._writer;
    const port = this._port;
    const readTask = this._readTask;
    const socket = this._socket;
    const bluetooth = this._bleSession;
    this._bleSession = null;
    this._bleWriteQueue = Promise.resolve();
    this._reader = this._writer = this._port = this._readTask = this._socket = null;
    this._buffer = '';
    if (this._cancelConnect) this._cancelConnect();
    this._cancelConnect = null;
    if (this._demoPending) {
      clearTimeout(this._demoPending.timer);
      this._demoPending.resolve(null);
      this._demoPending = null;
    }
    this._status('disconnected');
    this._closeBluetooth(bluetooth);
    if (socket && socket.readyState < 2) {
      try { socket.close(); } catch { /* Browser already closed this socket. */ }
    }
    if (reader) {
      try { await reader.cancel(); } catch { /* Unplugged device. */ }
    }
    if (readTask) await readTask.catch(() => {});
    if (writer) {
      try { await writer.abort(); } catch { /* Unplugged device. */ }
      try { writer.releaseLock(); } catch { /* Lock was already released. */ }
    }
    if (port) {
      try { await port.close(); } catch { /* Port may already be closed. */ }
    }
  }

  async _readUSB(reader, generation) {
    const decoder = new TextDecoder();
    try {
      while (generation === this._generation) {
        const { value, done } = await reader.read();
        if (done || generation !== this._generation) break;
        this._receiveText(decoder.decode(value, { stream: true }), 'usb');
      }
    } catch (error) {
      if (generation === this._generation) this._error(`USB reading stopped: ${error.message}`);
    } finally {
      try { reader.releaseLock(); } catch { /* Reader no longer owns the stream. */ }
      if (generation === this._generation) {
        this._reader = null;
        this._readTask = null;
        // Do not await our own read loop while closing a removed port.
        void this.disconnect();
      }
    }
  }

  _receiveText(text, source, completeMessage = false) {
    this._buffer += text;
    if (this._buffer.length > MAX_MESSAGE_LENGTH) {
      this._buffer = '';
      this._error('A device message exceeded the 64 KB limit and was ignored.');
      return;
    }
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop();
    for (const line of lines) this._parseMessage(line, source);
    if (completeMessage && this._buffer.trim()) {
      // WebSocket messages are already framed; a trailing newline is optional.
      const message = this._buffer;
      this._buffer = '';
      this._parseMessage(message, source);
    }
  }

  _parseMessage(text, source) {
    if (!text.trim()) return;
    let message;
    try { message = JSON.parse(text); } catch {
      this._error('Ignored a device message that was not valid JSON.');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this._error('Ignored a device message: expected a colour object.');
      return;
    }
    const deviceMode = normalizeMode(message.mode);
    if (deviceMode) this.dispatchEvent(new CustomEvent('device-mode', { detail: { mode: deviceMode } }));
    let hex;
    if (typeof message.hex === 'string' && /^#?[\da-f]{6}$/i.test(message.hex.trim())) {
      hex = `#${message.hex.trim().replace('#', '').toUpperCase()}`;
    } else if (['r', 'g', 'b'].every((key) => Number.isInteger(message[key]) && message[key] >= 0 && message[key] <= 255)) {
      hex = '#' + ['r', 'g', 'b'].map((key) => message[key].toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    if (!hex) {
      // Permit mode acknowledgements without inventing a colour reading.
      if (!deviceMode || 'hex' in message || ['r', 'g', 'b'].some((key) => key in message)) {
        this._error('Ignored an invalid colour. Send a six-digit HEX value or integer RGB values from 0 to 255.');
      }
      return;
    }
    this.dispatchEvent(new CustomEvent('reading', {
      detail: { hex, source, timestamp: new Date().toISOString(), ...(deviceMode ? { deviceMode } : {}) },
    }));
  }

  async scan() {
    if (this._mode === 'demo') {
      if (this._demoPending) return this._demoPending.promise;
      const generation = this._generation;
      const pending = {};
      pending.promise = new Promise((resolve) => {
        pending.resolve = resolve;
        pending.timer = setTimeout(() => {
          this._demoPending = null;
          if (generation !== this._generation || this._mode !== 'demo') { resolve(null); return; }
          const offset = 1 + Math.floor(Math.random() * (DEMO_COLOURS.length - 1));
          this._lastDemo = (this._lastDemo + offset) % DEMO_COLOURS.length;
          const reading = { ...DEMO_COLOURS[this._lastDemo], source: 'demo', timestamp: new Date().toISOString() };
          this.dispatchEvent(new CustomEvent('reading', { detail: reading }));
          resolve(reading);
        }, 900);
      });
      this._demoPending = pending;
      return pending.promise;
    }
    await this._send({ command: 'scan' });
    return null;
  }

  async setMode(value) {
    const mode = normalizeMode(value);
    if (!mode) throw this._error('Choose scan, compare, convert or image-match mode.');
    if (this._mode === 'bluetooth' && !this._bleConfig.colourProtocolEnabled) return;
    if (this.connected) await this._send({ command: 'mode', mode });
  }

  async _send(command) {
    if (this._mode === 'bluetooth' && !this._bleConfig.colourProtocolEnabled) {
      throw this._error('BLE is connected. Colour transfer is not enabled yet.');
    }
    const payload = JSON.stringify(command) + '\n';
    const generation = this._generation;
    try {
      if (this._mode === 'usb' && this._writer) {
        await this._writer.write(new TextEncoder().encode(payload));
      } else if (this._mode === 'wifi' && this._socket?.readyState === WebSocket.OPEN) {
        if (this._socket.bufferedAmount > MAX_MESSAGE_LENGTH) throw new Error('The device connection is busy. Try again.');
        this._socket.send(payload);
      } else if (this._mode === 'bluetooth' && this._bleSession?.write) {
        const session = this._bleSession;
        const bytes = new TextEncoder().encode(payload);
        const writeMessage = async () => {
          for (let offset = 0; offset < bytes.length; offset += BLE_WRITE_CHUNK_BYTES) {
            if (generation !== this._generation || this._bleSession !== session) return;
            const chunk = bytes.slice(offset, offset + BLE_WRITE_CHUNK_BYTES);
            if (session.write.properties.write && typeof session.write.writeValueWithResponse === 'function') {
              await session.write.writeValueWithResponse(chunk);
            } else {
              await session.write.writeValueWithoutResponse(chunk);
            }
          }
        };
        // Never interleave chunks of a scan command with a mode command.
        const pending = this._bleWriteQueue.then(writeMessage);
        this._bleWriteQueue = pending.catch(() => {});
        await pending;
      } else {
        throw new Error('Connect CHROMA or enable demo mode before scanning.');
      }
    } catch (error) {
      if (generation === this._generation) {
        const reported = this._error(error.message);
        // A failed chunk may leave a partial command in the firmware buffer.
        // Reconnect before sending a new command on this BLE stream.
        if (this._mode === 'bluetooth') await this.disconnect();
        throw reported;
      }
    }
  }
}
