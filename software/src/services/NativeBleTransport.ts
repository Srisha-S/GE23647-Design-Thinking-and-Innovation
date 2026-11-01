import { BleClient, type BleClientInterface, type BleDevice } from '@capacitor-community/bluetooth-le';
import { ChromaDevice, type TransportReading } from '../../device.js';
import { CHROMA_BLE_CONFIG, hasBleDataConfiguration, type ChromaBleConfig } from '../config/ble';
import { encodeImageMatchResultCommand, isChromaDeviceMessage, type ChromaDeviceCommand, type ChromaDeviceMessage } from '../types/deviceProtocol';
import type { ChromaReferenceMessage } from '../types/deviceProtocol';
import { parseBlePacket } from '../lib/bleProtocol';

export type BleState = 'available' | 'searching' | 'found' | 'connecting' | 'connected' |
  'disconnected' | 'unavailable' | 'permission-denied' | 'error';
export interface BleConnectionState {
  state: BleState;
  label: string;
  configured: boolean;
  message?: string;
  device?: BleDevice;
  devices?: BleDevice[];
}

/** Small injectable boundary: tests never need a radio or native permission prompt. */
export type NativeBleClient = Pick<BleClientInterface, 'initialize' | 'isEnabled' | 'requestEnable' |
  'requestDevice' | 'requestLEScan' | 'stopLEScan' | 'connect' | 'disconnect' |
  'read' | 'write' | 'getServices' | 'startNotifications' | 'stopNotifications'>;

const LABELS: Record<BleState, string> = {
  available: 'Bluetooth available', searching: 'Searching for CHROMA...', found: 'CHROMA found',
  connecting: 'Connecting...', connected: 'Connected to CHROMA', disconnected: 'Disconnected',
  unavailable: 'Bluetooth unavailable', 'permission-denied': 'Permission denied', error: 'Bluetooth connection failed',
};
const UUID_SETUP_MESSAGE = 'Add the ESP32 service, data and command UUIDs in src/config/ble.ts, then rebuild the Android app to receive colours.';
const COLOUR_TRANSFER_DISABLED_MESSAGE = 'BLE commands and reads are not defined yet. Use the controls on CHROMA.';
const MAX_MESSAGE_LENGTH = 65_536;
interface Session {
  generation: number;
  device: BleDevice;
  connected: boolean;
  subscribed: boolean;
  decoder: TextDecoder;
  buffer: string;
  reference?: ChromaReferenceMessage;
  commandWritable?: boolean;
}

/** Native BLE plus the existing USB, Wi-Fi and explicitly simulated demo transport. */
export class NativeBleTransport extends EventTarget {
  private generation = 0;
  private session: Session | null = null;
  private cancelConnection: (() => void) | null = null;
  private cancelScan: (() => void) | null = null;
  private scanning = false;
  private found = new Map<string, BleDevice>();
  private writes: Promise<void> = Promise.resolve();
  private bleState: BleConnectionState;

  constructor(
    private client: NativeBleClient = BleClient,
    private fallback: ChromaDevice = new ChromaDevice(),
    private config: ChromaBleConfig = CHROMA_BLE_CONFIG,
  ) {
    super();
    this.bleState = { state: 'available', label: LABELS.available, configured: hasBleDataConfiguration(config) };
    for (const type of ['status', 'reading', 'error', 'device-mode']) {
      fallback.addEventListener(type, event => {
        // A previous transport cannot overwrite an active native BLE session.
        if (!this.session) this.emit(type, (event as CustomEvent).detail);
      });
    }
  }

  get mode(): ChromaDevice['mode'] { return this.session?.connected ? 'bluetooth' : this.fallback.mode; }
  get connected(): boolean { return this.session?.connected === true || this.fallback.connected; }
  getBleState(): BleConnectionState {
    return { ...this.bleState, ...(this.bleState.devices ? { devices: [...this.bleState.devices] } : {}) };
  }
  private emit(type: string, detail: unknown) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  private state(state: BleState, extra: Partial<BleConnectionState> = {}) {
    this.bleState = { state, label: LABELS[state], configured: hasBleDataConfiguration(this.config), ...extra };
    this.emit('ble-state', this.getBleState());
  }
  private current(session: Session): boolean { return this.session === session && session.generation === this.generation; }
  private reportError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    const state: BleState = /permission|denied|not authorized/i.test(message) ? 'permission-denied' :
      /unsupported|unavailable|not supported|switched off/i.test(message) ? 'unavailable' : 'error';
    const guidance = state === 'permission-denied' ? ' Allow Nearby devices (or Location on older Android) in Android app permissions, then retry.' : '';
    this.state(state, { message: message + guidance });
    this.emit('error', { message: message + guidance });
    return new Error(message + guidance);
  }
  private async initialize(generation: number): Promise<boolean> {
    // The plugin requests Android runtime permissions here. neverForLocation
    // matches the manifest; Android <= 30 still needs location compatibility.
    await this.client.initialize({ androidNeverForLocation: true });
    if (generation !== this.generation) return false;
    if (!await this.client.isEnabled()) {
      if (generation !== this.generation) return false;
      try { await this.client.requestEnable(); }
      catch { throw new Error('Bluetooth is switched off. Turn it on and retry.'); }
      if (!await this.client.isEnabled()) throw new Error('Bluetooth is switched off. Turn it on and retry.');
    }
    if (generation !== this.generation) return false;
    this.state('available');
    return true;
  }
  async initializeBluetooth(): Promise<boolean> {
    try { return await this.initialize(this.generation); }
    catch (error) { throw this.reportError(error); }
  }

  /** Optional in-app discovery API. The default Connect button uses the native chooser. */
  async scanBluetooth(): Promise<BleDevice[]> {
    const cleanup = this.disconnect();
    const generation = this.generation;
    await cleanup;
    if (generation !== this.generation) return [];
    this.found.clear();
    try {
      if (!await this.initialize(generation)) return [];
      this.state('searching', { devices: [] });
      this.scanning = true;
      let finish!: () => void;
      const stopped = new Promise<void>(resolve => { finish = resolve; });
      this.cancelScan = finish;
      const timer = setTimeout(finish, this.config.scanDurationMs);
      try {
        await this.client.requestLEScan({ name: this.config.deviceName, allowDuplicates: false }, result => {
          if (generation !== this.generation || !this.scanning) return;
          const name = result.localName || result.device.name;
          if (name !== this.config.deviceName) return;
          this.found.set(result.device.deviceId, { ...result.device, name });
          this.state('found', { devices: [...this.found.values()], device: { ...result.device, name } });
        });
        await stopped;
      } finally {
        clearTimeout(timer);
        if (this.cancelScan === finish) this.cancelScan = null;
        // disconnect() owns cleanup once the generation changes. Otherwise an
        // old scan's finally block could stop a newer discovery session.
        if (generation === this.generation) await this.client.stopLEScan().catch(() => {});
        if (generation === this.generation) this.scanning = false;
      }
      if (generation !== this.generation) return [];
      const devices = [...this.found.values()];
      this.state(devices.length ? 'found' : 'available', {
        devices, ...(devices.length ? {} : { message: 'No CHROMA found. Keep it nearby and make sure its BLE firmware is advertising.' }),
      });
      return devices;
    } catch (error) {
      if (generation !== this.generation) return [];
      throw this.reportError(error);
    }
  }

  /** Discover only the peripheral advertised by the ESP32 as CHROMA. */
  async connectBluetooth(deviceId?: string): Promise<boolean> {
    const selectedFromScan = deviceId ? this.found.get(deviceId) : undefined;
    const cleanup = this.disconnect();
    const generation = this.generation;
    await cleanup;
    if (generation !== this.generation) return false;
    let cancel!: () => void;
    const cancelled = new Promise<boolean>(resolve => { cancel = () => resolve(false); });
    this.cancelConnection = cancel;
    const attempt = (async () => {
      try {
        if (!await this.initialize(generation)) return false;
        this.state('searching');
        const device = deviceId ? selectedFromScan : await this.client.requestDevice({ name: this.config.deviceName });
        if (generation !== this.generation) return false;
        if (!device || device.name !== this.config.deviceName) throw new Error('Select a device advertising as CHROMA. Search again if it is no longer nearby.');
        this.state('found', { device });
        const session: Session = { generation, device, connected: false, subscribed: false, decoder: new TextDecoder(), buffer: '' };
        this.session = session;
        this.state('connecting', { device });
        await this.client.connect(device.deviceId, () => this.onDisconnect(session), { timeout: this.config.connectTimeoutMs });
        if (!this.current(session)) { await this.closeSession(session); return false; }
        session.connected = true;
        // Raw DATA notifications are useful before the colour protocol exists.
        // The protocol flag still gates parsing, reads and command writes.
        if (hasBleDataConfiguration(this.config)) await this.subscribeToData();
        if (!this.current(session)) { await this.closeSession(session); return false; }
        this.emit('status', { mode: 'bluetooth', connected: true, label: 'CHROMA connected · Bluetooth' });
        this.state('connected', { device, ...(!hasBleDataConfiguration(this.config) ? { message: UUID_SETUP_MESSAGE } :
          !this.config.colourProtocolEnabled ? { message: 'Ready for Scan and Compare results. Use the controls on CHROMA.' } : {}) });
        return true;
      } catch (error) {
        if (generation !== this.generation) return false;
        const message = error instanceof Error ? error.message : String(error);
        const chooserCancelled = !this.session && /cancel|no device selected/i.test(message);
        // Do not let our own cleanup resolve this attempt before its error.
        if (this.cancelConnection === cancel) this.cancelConnection = null;
        await this.disconnect();
        if (chooserCancelled) return false;
        throw this.reportError(error);
      }
    })();
    try { return await Promise.race([attempt, cancelled]); }
    finally { if (this.cancelConnection === cancel) this.cancelConnection = null; }
  }

  private onDisconnect(session: Session) {
    if (!this.current(session)) return;
    void this.disconnect();
    this.state('disconnected', { message: 'CHROMA disconnected. Keep it nearby and reconnect to continue.' });
  }
  private async closeSession(session: Session) {
    // A late completion from a cancelled attempt must not drop a newer link.
    if (this.session && this.session !== session && this.session.device.deviceId === session.device.deviceId) return;
    if (session.subscribed) {
      await this.client.stopNotifications(session.device.deviceId, this.config.serviceUUID, this.config.dataCharacteristicUUID).catch(() => {});
    }
    session.subscribed = false;
    // Subscription teardown itself is asynchronous. A new session may have
    // claimed the same peripheral while we were awaiting it.
    if (this.session && this.session !== session && this.session.device.deviceId === session.device.deviceId) return;
    await this.client.disconnect(session.device.deviceId).catch(() => {});
  }
  async disconnect(): Promise<void> {
    ++this.generation;
    this.cancelConnection?.(); this.cancelConnection = null;
    this.cancelScan?.(); this.cancelScan = null;
    const wasScanning = this.scanning;
    this.scanning = false;
    const session = this.session;
    this.session = null;
    this.writes = Promise.resolve();
    this.state('disconnected');
    const cleanup = this.fallback.disconnect();
    if (wasScanning) await this.client.stopLEScan().catch(() => {});
    if (session) await this.closeSession(session);
    await cleanup;
  }
  async startDemo(): Promise<void> {
    const cleanup = this.disconnect();
    const generation = this.generation;
    await cleanup;
    if (generation === this.generation) await this.fallback.startDemo();
  }
  async connectUSB(): Promise<boolean> {
    const cleanup = this.disconnect();
    const generation = this.generation;
    await cleanup;
    return generation === this.generation ? this.fallback.connectUSB() : false;
  }
  async connectWifi(address: string): Promise<boolean> {
    const cleanup = this.disconnect();
    const generation = this.generation;
    await cleanup;
    return generation === this.generation ? this.fallback.connectWifi(address) : false;
  }

  private requireNotificationSession(): Session {
    if (!this.session?.connected) throw new Error('Connect CHROMA over Bluetooth first.');
    if (!hasBleDataConfiguration(this.config)) throw new Error(UUID_SETUP_MESSAGE);
    return this.session;
  }
  private requireDataSession(): Session {
    const session = this.requireNotificationSession();
    if (!this.config.colourProtocolEnabled) throw new Error(COLOUR_TRANSFER_DISABLED_MESSAGE);
    return session;
  }
  async subscribeToData(): Promise<void> {
    const session = this.requireNotificationSession();
    if (session.subscribed) return;
    session.subscribed = true;
    await this.client.startNotifications(session.device.deviceId, this.config.serviceUUID, this.config.dataCharacteristicUUID,
      value => { if (this.current(session)) this.receive(session, value); });
    if (!this.current(session)) await this.closeSession(session);
  }
  async readData(): Promise<ChromaDeviceMessage> {
    const session = this.requireDataSession();
    const value = await this.client.read(session.device.deviceId, this.config.serviceUUID, this.config.dataCharacteristicUUID);
    if (!this.current(session)) throw new Error('CHROMA disconnected before the reading arrived.');
    const text = new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    const message: unknown = JSON.parse(text);
    if (!isChromaDeviceMessage(message)) throw new Error('CHROMA sent an invalid colour or compare message.');
    return message;
  }
  private receive(session: Session, value: DataView) {
    const text = session.decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), { stream: true });
    // Keep the raw debug preview independently of parsing. Whole compact packets
    // need no newline; multiple complete lines in one value are also allowed.
    if (text) this.emit('ble-data', { text: text.slice(-MAX_MESSAGE_LENGTH) });
    if (!this.config.colourProtocolEnabled) {
      if (text.length > MAX_MESSAGE_LENGTH) return;
      for (const line of text.split(/\r?\n/)) {
        const packet = parseBlePacket(line);
        if (!packet) continue;
        if (packet.type === 'scan') {
          this.emit('reading', { hex: packet.hex, clear: packet.clear, source: 'bluetooth', timestamp: new Date().toISOString(), data: packet });
        } else if (packet.type === 'reference') {
          session.reference = packet;
          this.emit('ble-reference', packet);
        } else if (session.reference) {
          this.emit('comparison', { type: 'compare', reference: session.reference, sample: packet.sample, deltaE: packet.deltaE });
        }
      }
      return;
    }
    // Legacy JSON prototype is opt-in only; shipped native BLE uses CSV above.
    session.buffer += text;
    if (session.buffer.length > MAX_MESSAGE_LENGTH) {
      session.buffer = ''; session.decoder = new TextDecoder();
      this.emit('error', { message: 'Ignored a BLE message larger than 64 KB.' });
      return;
    }
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message: unknown = JSON.parse(line);
        if (!isChromaDeviceMessage(message)) throw new Error('Invalid colour or compare message.');
        this.emit('device-data', message);
        if (message.type === 'scan') {
          this.emit('reading', { hex: message.hex.toUpperCase(), source: 'bluetooth', timestamp: new Date().toISOString(), data: message });
        } else this.emit('comparison', message);
      } catch {
        this.emit('error', { message: 'Ignored an invalid CHROMA BLE message. Check the firmware data format.' });
      }
    }
  }
  async writeCommand(command: ChromaDeviceCommand): Promise<void> {
    const imageMatch = command.command === 'image-match-result';
    const session = imageMatch ? this.requireNotificationSession() : this.requireDataSession();
    if (imageMatch && this.bleState.state !== 'connected') throw new Error('Wait for the approved CHROMA connection.');
    const bytes = command.command === 'image-match-result' ? encodeImageMatchResultCommand(command.rgb, command.deltaE00) :
      new TextEncoder().encode(JSON.stringify(command) + '\n');
    const pending = this.writes.then(async () => {
      try {
        if (imageMatch) {
          if (!this.current(session)) throw new Error('CHROMA disconnected before the command was sent.');
          if (session.commandWritable === undefined) {
            const services = await this.client.getServices(session.device.deviceId);
            if (!this.current(session)) throw new Error('CHROMA disconnected before the command was sent.');
            const service = services.find(item => item.uuid.toLowerCase() === this.config.serviceUUID.toLowerCase());
            session.commandWritable = service?.characteristics.some(item =>
              item.uuid.toLowerCase() === this.config.commandCharacteristicUUID.toLowerCase() && item.properties.write) === true;
          }
          if (!session.commandWritable) throw new Error('CHROMA COMMAND characteristic is not writable.');
        }
        // Conservative BLE payload size; the firmware must reassemble up to LF.
        for (let offset = 0; offset < bytes.length; offset += 20) {
          if (!this.current(session)) throw new Error('CHROMA disconnected before the command was sent.');
          const chunk = bytes.slice(offset, offset + 20);
          await this.client.write(session.device.deviceId, this.config.serviceUUID, this.config.commandCharacteristicUUID, new DataView(chunk.buffer));
        }
      } catch (error) {
        // Invalidate this session before allowing another queued command to
        // start, so a truncated JSON command cannot corrupt the next command.
        if (!imageMatch && this.current(session)) await this.disconnect();
        throw error;
      }
    });
    this.writes = pending.catch(() => {});
    await pending;
  }
  async scan(): Promise<TransportReading | null> {
    if (!this.session?.connected) return this.fallback.scan();
    this.requireNotificationSession();
    // v1 defines incoming results only. Wait for the physical device's SCAN.
    if (!this.config.colourProtocolEnabled) return null;
    await this.writeCommand({ command: 'scan' });
    return null;
  }
  async setMode(value: string): Promise<void> {
    if (!this.session?.connected) return this.fallback.setMode(value);
    if (!['scan', 'compare', 'convert', 'image-match'].includes(value)) throw new Error('Choose a valid CHROMA mode.');
    // Changing website tabs stays usable before the firmware protocol is set.
    if (!hasBleDataConfiguration(this.config) || !this.config.colourProtocolEnabled) return;
    await this.writeCommand({ command: 'mode', mode: value as 'scan' | 'compare' | 'convert' | 'image-match' });
  }
}
