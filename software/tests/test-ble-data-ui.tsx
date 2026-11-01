/** Browser-only integration checks. No real radio, chooser or Android API is used. */
import { createRoot, type Root } from 'react-dom/client';
import { useLayoutEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { DeviceProvider, useDevice } from '../src/state/DeviceContext';
import { WorkspaceProvider, useWorkspace } from '../src/state/WorkspaceContext';
import { DevicePage } from '../src/pages/DevicePage';
import ScanPage from '../src/pages/ScanPage';
import ComparePage from '../src/pages/ComparePage';
import ImagePage from '../src/pages/ImagePage';
import LibraryPage from '../src/pages/LibraryPage';
import ConvertPage from '../src/pages/ConvertPage';
import { AppHeader } from '../src/components/AppHeader';
import { colourValues } from '../src/components/ui';
import { deltaE, hexToRgb } from '../src/lib/color';
import { parseConvertInput } from '../src/lib/convertInput';
import type { ColourFormat } from '../src/types';
import { STORAGE_KEY, seedWorkspace } from '../src/state/storage';
import { CHROMA_DEVICE_NAME, CHROMA_SERVICE_UUID, CHROMA_DATA_CHARACTERISTIC_UUID, CHROMA_COMMAND_CHARACTERISTIC_UUID } from '../src/config/ble';

const pause = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, description: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (predicate()) return;
    await pause(10);
  }
  throw new Error(`Raw BLE UI: timed out waiting for ${description}.`);
}
function view(text: string): DataView {
  // A characteristic value may be a view into a larger backing buffer.
  const bytes = new TextEncoder().encode(text);
  const backing = new Uint8Array(bytes.length + 4);
  backing.set(bytes, 2);
  return new DataView(backing.buffer, 2, bytes.length);
}

export async function runRawBleUiTests() {
  const descriptions: string[] = [];
  const check = (condition: unknown, description: string) => {
    if (!condition) throw new Error(`Raw BLE UI: ${description}`);
    descriptions.push(description);
  };
  const restorers: Array<() => void> = [];
  const replace = (target: object, key: string, value: unknown) => {
    const original = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    restorers.push(() => {
      if (original) Object.defineProperty(target, key, original);
      else Reflect.deleteProperty(target, key);
    });
  };
  const savedWorkspace = localStorage.getItem(STORAGE_KEY);
  const savedHash = location.hash;
  // Use a deterministic fixture in the harness's disposable browser profile.
  // Restore the exact preceding snapshot in finally, including on failure.
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seedWorkspace()));
  location.hash = '#device';
  const host = document.createElement('div');
  host.setAttribute('data-testid', 'raw-ble-ui-test-root');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147480000;width:min(390px,100vw);max-width:100vw;overflow:auto;background:#f6f5f1;padding:12px;box-sizing:border-box;';
  // Put the fixture's real header first so document-ID portals target its
  // slots rather than controls belonging to the untouched app behind it.
  document.body.prepend(host);

  let root: Root | null = null;
  let device: ReturnType<typeof useDevice> | null = null;
  let workspace: ReturnType<typeof useWorkspace> | null = null;
  const callbacks: Array<(value: DataView) => void> = [];
  const links: Array<() => void> = [];
  let chooserName: string | undefined;
  let connections = 0;
  let disconnects = 0;
  const subscriptions: string[][] = [];
  const unsubscriptions: string[][] = [];
  let allowSubscription: (() => void) | null = null;
  let waitForSubscription = true;
  let unexpectedCommands = 0;
  const imageMatchCommands: string[] = [];
  let nativePlatform = true;
  let exportedBlob: Blob | null = null;
  let editReferenceOnMount: string | null = null;
  let referenceMountEdits = 0;
  const testDevice = { deviceId: 'chroma-raw-ui-test', name: CHROMA_DEVICE_NAME };

  function Probe() {
    device = useDevice();
    workspace = useWorkspace();
    const [convertVisited, setConvertVisited] = useState(false);
    useLayoutEffect(() => { if (workspace?.route === 'convert') setConvertVisited(true); }, [workspace.route]);
    // Match the current app: local images are disposed when Image Match is left.
    // Model a first edit before passive mount effects run. This makes the
    // previous Compare input-reset race reproducible without timing sleeps.
    useLayoutEffect(() => {
      if (workspace?.route !== 'compare' || !editReferenceOnMount) return;
      const input = host.querySelector<HTMLInputElement>('#compareA')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, editReferenceOnMount);
      editReferenceOnMount = null;
      referenceMountEdits++;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, [workspace.route]);
    return <>
      <AppHeader menuOpen={false} onOpenMenu={() => {}} />
      {workspace.route === 'scan' ? <ScanPage /> : workspace.route === 'compare' ? <ComparePage /> : workspace.route === 'library' ? <LibraryPage /> : !['image', 'convert'].includes(workspace.route) ? <DevicePage /> : null}
      {workspace.route === 'image' && <div data-testid="image-test-page"><ImagePage /></div>}
      {(convertVisited || workspace.route === 'convert') && <div data-testid="convert-test-page" hidden={workspace.route !== 'convert'}><ConvertPage /></div>}
    </>;
  }
  const choice = () => host.querySelector<HTMLButtonElement>('[aria-describedby="device-bluetooth-help"]');
  const output = () => host.querySelector<HTMLElement>('[data-testid="latest-ble-data"]');
  const clickDisconnect = () => {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Disconnect');
    if (!button) throw new Error('Raw BLE UI: Disconnect button is missing.');
    button.click();
  };
  const connect = async () => {
    const previous = connections;
    await until(() => !!choice() && !choice()!.disabled, 'an enabled native Connect CHROMA button');
    choice()!.click();
    await until(() => connections === previous + 1, 'the native connection');
    await until(() => device?.status.mode === 'bluetooth', 'Bluetooth connected status');
  };
  const navigate = async (route: 'device' | 'scan' | 'compare' | 'image' | 'library' | 'convert') => {
    workspace!.navigate(route);
    await until(() => workspace?.route === route && workspace.view === '', `${route} route`);
    await pause();
  };
  const button = (label: string) => {
    const target = [...host.querySelectorAll('button')].find(item => !item.closest('[hidden], dialog:not([open])') && item.textContent?.trim() === label);
    if (!target) throw new Error(`Raw BLE UI: ${label} button is missing.`);
    return target;
  };
  const protocolSnapshot = () => JSON.stringify({
    reading: device!.reading, reference: device!.bleReference, comparison: device!.bleComparison,
    latest: workspace!.workspace.latest, history: workspace!.workspace.history, pair: workspace!.compare,
    imageMatch: workspace!.imageMatch,
  });
  const send = async (text: string, index = 0) => {
    callbacks[index](view(text));
    await until(() => device?.latestBleData === text, `raw preview of ${text}`);
    await pause();
  };
  const convertPage = () => host.querySelector<HTMLElement>('[data-testid="convert-test-page"]')!;
  const convertPreview = () => convertPage().querySelector('.convert-large-preview')?.getAttribute('aria-label') || '';
  const convertSource = () => convertPage().querySelector('[data-testid="convert-colour-source"]')?.textContent || '';
  const changeConvertFormat = async (format: ColourFormat) => {
    convertPage().querySelector<HTMLButtonElement>('#convert-format')!.click();
    await until(() => !!convertPage().querySelector(`[data-choice-value="${format}"]`), 'Convert format picker');
    convertPage().querySelector<HTMLButtonElement>(`[data-choice-value="${format}"]`)!.click();
    await until(() => convertPage().querySelector<HTMLInputElement>('#convert-input')?.getAttribute('aria-label') === `${format} colour value`, `Convert ${format} input`);
  };
  const fillConvert = async (selector: string, value: string) => {
    const input = convertPage().querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await pause();
  };
  const checkConvertValues = (hex: string, description: string) => {
    check(convertPreview().includes(hex), `${description}: the large Convert swatch shows the chosen colour.`);
    const format = convertPage().querySelector<HTMLButtonElement>('#convert-format')!.dataset.value as ColourFormat;
    const input = convertPage().querySelector<HTMLInputElement>('#convert-input')!;
    check(parseConvertInput(input.value, format) === hex && input.getAttribute('aria-invalid') !== 'true', `${description}: the current-format input represents the same valid colour.`);
    const values = colourValues(hex);
    for (const name of ['HEX', 'RGB', 'HSL', 'LAB', 'CMYK'] as const) {
      check(!!convertPage().querySelector(`[aria-label="Copy ${name}: ${values[name]}"]`), `${description}: Convert updates the shared ${name} conversion.`);
    }
  };
  const chooseConvertLibrary = async (id: string, query: string) => {
    convertPage().querySelector<HTMLButtonElement>('[data-action="convert-library"]')!.click();
    await until(() => !!convertPage().querySelector('dialog[open] #convert-library-search'), 'searchable Convert Library picker');
    await fillConvert('#convert-library-search', query);
    await until(() => !!convertPage().querySelector(`[data-convert-colour="${id}"]`), 'the filtered saved Convert colour');
    convertPage().querySelector<HTMLButtonElement>(`[data-convert-colour="${id}"]`)!.click();
    await until(() => !convertPage().querySelector('dialog[open]'), 'closed Convert Library picker');
  };
  const startConvertScan = async () => {
    const scan = convertPage().querySelector<HTMLButtonElement>('[data-action="convert-scan"]')!;
    check(!scan.disabled, 'Convert exposes an enabled scan source when the device is ready.');
    scan.click();
    await until(() => device!.scanning, 'a pending Convert capture');
  };
  const imagePage = () => host.querySelector<HTMLElement>('[data-testid="image-test-page"]')!;
  const imageDelta = () => {
    const result = imagePage().querySelector('[data-testid="delta-e"]')?.textContent;
    const preview = imagePage().querySelector('.image-open-result span')?.textContent;
    return (result || preview)?.match(/(\d+\.\d{2})/)?.[1];
  };
  const showResult = async (route: 'compare' | 'image') => {
    workspace!.navigate(route, 'result');
    await until(() => workspace?.route === route && workspace.view === 'result', route + ' result view');
    await pause();
  };
  const openCompareEditor = async (target: 'a' | 'b' = 'a') => {
    host.querySelector<HTMLButtonElement>(`[data-action="compare-edit-${target}"]`)!.click();
    await until(() => !!host.querySelector('#compare-edit[open]'), 'visible Compare editor');
  };
  const openImageTools = async () => {
    if (!imagePage().querySelector('dialog[open]')) {
      const actions = imagePage().querySelector<HTMLButtonElement>('.wireframe-eyedropper')
        || host.querySelector<HTMLButtonElement>('[aria-label="Image Match actions"]');
      if (!actions) throw new Error('Raw BLE UI: Image Match actions are missing.');
      actions.click();
    }
    await until(() => !!imagePage().querySelector('dialog[open]'), 'visible Image Match actions');
  };
  const closeImageTools = async () => {
    imagePage().querySelector<HTMLButtonElement>('dialog[open] [aria-label="Close dialog"]')?.click();
    await until(() => !imagePage().querySelector('dialog[open]'), 'closed Image Match actions');
  };
  const backImageEditor = async () => {
    if (workspace!.view !== 'result') return;
    host.querySelector<HTMLButtonElement>('[aria-label="Back to Image Match"]')!.click();
    await until(() => workspace?.route === 'image' && workspace.view === '', 'back to Image Match inputs');
    await pause();
  };
  const uploadFile = (file?: File) => {
    const transfer = new DataTransfer();
    if (file) transfer.items.add(file);
    const input = imagePage().querySelector<HTMLInputElement>('#image-input')!;
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const uploadImage = async (name: string, solid?: string) => {
    const source = document.createElement('canvas'); source.width = source.height = 6;
    const context = source.getContext('2d')!;
    context.fillStyle = solid || '#FF0000'; context.fillRect(0, 0, 6, 6);
    if (!solid) {
      context.fillStyle = '#0012EF'; context.fillRect(0, 0, 3, 3);
      context.fillStyle = '#12AB34'; context.fillRect(3, 3, 3, 3);
    }
    const blob = await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), 'image/png'));
    uploadFile(new File([blob], name, { type: 'image/png' }));
    const expected = hexToRgb(solid || '#0012EF');
    await until(() => {
      const canvas = imagePage().querySelector<HTMLCanvasElement>('#image-canvas');
      if (!canvas || canvas.width !== 6 || canvas.height !== 6 || imagePage().querySelector('.wireframe-canvas-wrap')?.getAttribute('aria-busy') === 'true') return false;
      const pixel = canvas.getContext('2d')?.getImageData(0, 0, 1, 1).data;
      return pixel?.[0] === expected.r && pixel[1] === expected.g && pixel[2] === expected.b;
    }, 'decoded local image pixels in the wireframe preview');
    await pause();
  };
  const pick = async (x: number, y: number, pointerType: 'mouse' | 'touch' = 'mouse') => {
    const canvas = imagePage().querySelector<HTMLCanvasElement>('#image-canvas')!;
    const bounds = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('click', { bubbles: true, pointerType, clientX: bounds.left + (x + 0.5) / 6 * bounds.width, clientY: bounds.top + (y + 0.5) / 6 * bounds.height }));
    await pause();
  };

  try {
    replace(Capacitor, 'isNativePlatform', () => nativePlatform);
    replace(BleClient, 'initialize', async () => {});
    replace(BleClient, 'isEnabled', async () => true);
    replace(BleClient, 'requestEnable', async () => { throw new Error('The test radio should already be enabled.'); });
    replace(BleClient, 'requestDevice', async (options: { name?: string }) => { chooserName = options.name; return testDevice; });
    replace(BleClient, 'requestLEScan', async () => { throw new Error('Native chooser is used by this test.'); });
    replace(BleClient, 'stopLEScan', async () => {});
    replace(BleClient, 'connect', async (_id: string, onDisconnect: () => void) => { connections++; links.push(onDisconnect); });
    replace(BleClient, 'disconnect', async () => { disconnects++; });
    replace(BleClient, 'read', async () => { throw new Error('Raw notifications must not read or parse colour data.'); });
    replace(BleClient, 'getServices', async (id: string) => {
      check(id === testDevice.deviceId, 'IMR checks writability on the existing connected peripheral.');
      return [{ uuid: CHROMA_SERVICE_UUID, characteristics: [{ uuid: CHROMA_COMMAND_CHARACTERISTIC_UUID,
        properties: { write: true }, descriptors: [] }] }];
    });
    replace(BleClient, 'write', async (id: string, service: string, characteristic: string, value: DataView) => {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const command = new TextDecoder().decode(bytes);
      if (!/^IMR,\d+,\d+,\d+,\d+\.\d$/.test(command)) {
        unexpectedCommands++;
        throw new Error('Only a completed Image Match may send an IMR command.');
      }
      check(id === testDevice.deviceId && service === CHROMA_SERVICE_UUID && characteristic === CHROMA_COMMAND_CHARACTERISTIC_UUID && bytes.length <= 20,
        'IMR uses one compact write to the existing COMMAND UUID.');
      imageMatchCommands.push(command);
    });
    replace(BleClient, 'startNotifications', async (id: string, service: string, characteristic: string, callback: (value: DataView) => void) => {
      subscriptions.push([id, service, characteristic]);
      callbacks.push(callback);
      if (waitForSubscription) await new Promise<void>(resolve => { allowSubscription = resolve; });
    });
    replace(BleClient, 'stopNotifications', async (id: string, service: string, characteristic: string) => { unsubscriptions.push([id, service, characteristic]); });

    root = createRoot(host);
    root.render(<DeviceProvider><WorkspaceProvider><Probe /></WorkspaceProvider></DeviceProvider>);
    await until(() => device?.status.mode === 'demo' && !!choice(), 'the initial demo render');
    // Exercise the same in-place capture action in demo mode before mocking a
    // physical connection. The persistent Convert page then remains mounted
    // while the rest of the fixture checks unsolicited and pending BLE data.
    await navigate('convert');
    await changeConvertFormat('RGB');
    const demoHash = location.hash;
    const beforeConvertDemo = workspace!.workspace.latest.id;
    await startConvertScan();
    await until(() => !device!.scanning && workspace!.workspace.latest.id !== beforeConvertDemo, 'a completed Convert demo scan');
    const demoConvertHex = workspace!.workspace.latest.hex;
    await until(() => convertPreview().includes(demoConvertHex), 'demo capture applied in Convert');
    checkConvertValues(demoConvertHex, 'Demo capture');
    check(workspace!.route === 'convert' && location.hash === demoHash && workspace!.view === '', 'Convert demo scan updates in place without navigating to Scan or a result view.');
    check(convertPage().querySelector<HTMLButtonElement>('#convert-format')!.dataset.value === 'RGB' && /Demo/i.test(convertSource()), 'Convert retains the selected input format and labels a simulated demo capture.');
    await navigate('device');
    const initialReading = JSON.stringify(device!.reading);
    const initialLatest = JSON.stringify(workspace!.workspace.latest);
    const initialHistory = JSON.stringify(workspace!.workspace.history);
    check(choice()!.textContent!.includes('Connect CHROMA'), 'The Android Device page exposes its native CHROMA connection control.');
    choice()!.click();
    await until(() => subscriptions.length === 1 && !!allowSubscription, 'automatic DATA subscription');
    check(chooserName === CHROMA_DEVICE_NAME, 'The native chooser requests CHROMA by its configured name.');
    check(JSON.stringify(subscriptions[0]) === JSON.stringify([testDevice.deviceId, CHROMA_SERVICE_UUID, CHROMA_DATA_CHARACTERISTIC_UUID]), 'Notifications subscribe on the configured peripheral, service and DATA UUID.');
    allowSubscription!();
    waitForSubscription = false;
    await until(() => device?.status.mode === 'bluetooth' && device.status.connected, 'Bluetooth connected status');
    check(host.textContent!.includes('Latest BLE data:'), 'The Device page displays the Latest BLE data label.');

    callbacks[0](view('CHROMA_TEST'));
    await until(() => output()?.textContent === 'CHROMA_TEST', 'CHROMA_TEST on the Device page');
    check(true, 'A raw CHROMA_TEST notification reaches the Device page through the real transport, service and context.');
    callbacks[0](view('café 🌈 — CHROMA'));
    await until(() => output()?.textContent === 'café 🌈 — CHROMA', 'UTF-8 characters');
    check(true, 'UTF-8 characters and offset DataViews display correctly.');

    const literal = '<img src=x onerror="window.__chromaRawHtmlExecuted=true"> arbitrary text';
    callbacks[0](view(literal));
    await until(() => output()?.textContent === literal, 'literal non-JSON text');
    check(output()!.querySelector('img') === null, 'Incoming HTML-like text is displayed literally and never interpreted as markup.');
    callbacks[0](view('{"type":"scan","hex":"#ABCDEF","rgb":{"r":171,"g":205,"b":239}}\n'));
    await until(() => !!output()?.textContent?.includes('#ABCDEF'), 'unparsed JSON-like text');
    check(JSON.stringify(device!.reading) === initialReading && JSON.stringify(workspace!.workspace.latest) === initialLatest && JSON.stringify(workspace!.workspace.history) === initialHistory, 'Raw BLE text does not create colour readings or change workspace colour/history.');
    check(![...host.querySelectorAll('[role="alert"]')].some(item => !item.closest('[hidden]')), 'Arbitrary non-JSON text does not produce a colour-protocol error.');

    const longText = 'CHROMA_'.repeat(100) + '\nsecond line — plain UTF-8';
    callbacks[0](view(longText));
    await until(() => output()?.textContent === longText, 'long multiline text');
    await pause(30);
    const debugDetails = output()!.closest<HTMLDetailsElement>('details');
    if (debugDetails) debugDetails.open = true;
    check(output()!.scrollWidth <= output()!.clientWidth + 1, 'Long multiline notification text wraps within the mobile-width output.');
    check(getComputedStyle(output()!).whiteSpace === 'pre-wrap', 'The debug output preserves notification line breaks.');
    check(unexpectedCommands === 0, 'Notification display never sends colour commands.');

    // A complete compact packet is one UTF-8 DATA notification; the app does
    // not send a COMMAND or require the old JSON protocol to request a scan.
    await navigate('scan');
    const beforePendingScan = workspace!.workspace.history.length;
    host.querySelector<HTMLButtonElement>('[data-action="scan"]')!.click();
    await until(() => device!.scanning, 'a scan waiting for the physical device');
    await send('SCAN,224,53,77,630');
    await until(() => workspace!.workspace.latest.hex === '#E0354D' && !device!.scanning, 'the real BLE scan on the Scan page');
    check(device!.reading?.source === 'bluetooth' && workspace!.workspace.latest.source === 'bluetooth', 'A compact SCAN creates a real Bluetooth reading rather than a demo capture.');
    check(device!.reading?.clear === 630, 'The raw CLEAR channel is retained in the scan data model.');
    check(workspace!.workspace.history.length === Math.min(50, beforePendingScan + 1), 'A physical scan resolves the pending scan and adds one workspace history entry.');
    const values = colourValues('#E0354D');
    for (const format of ['HEX', 'RGB', 'HSL', 'CMYK', 'LAB'] as const) {
      check(!!host.querySelector(`[aria-label="Copy ${format}: ${values[format]}"]`), `The real BLE Scan page exposes the calculated ${format} value.`);
    }
    check(/BLE capture|Bluetooth capture|Bluetooth reading|BLE reading/i.test(host.textContent!), 'The Scan page visibly labels the physical Bluetooth capture.');
    check(!host.textContent!.includes('Demo capture'), 'Real BLE scan results are not labelled as demo data.');
    check(unexpectedCommands === 0, 'Waiting for and receiving a physical BLE SCAN sends no provisional command packets.');

    // Identical RGB values do not make a digital target a physical capture.
    // Exercise the real workspace save path while a BLE reading has CLEAR.
    for (const source of ['image', 'convert']) {
      const digital = workspace!.saveColour({ hex: '#E0354D', source });
      check(digital.source === source && digital.clear === undefined, `Saving a ${source} colour equal to the latest BLE reading keeps its digital source and no sensor clear channel.`);
    }
    const physical = workspace!.saveColour({ hex: '#E0354D' });
    check(physical.source === 'bluetooth' && physical.clear === 630, 'Saving the actual latest physical capture still retains its Bluetooth source and clear channel.');
    const renamedPhysical = workspace!.saveColour({ id: physical.id, hex: physical.hex, name: 'Renamed physical capture' });
    check(renamedPhysical.source === 'bluetooth' && renamedPhysical.clear === 630, 'Renaming an unchanged physical capture retains its sensor metadata.');
    const reclassified = workspace!.saveColour({ id: physical.id, hex: physical.hex, source: 'image' });
    check(reclassified.source === 'image' && reclassified.clear === undefined, 'Changing an existing capture to an explicit digital source removes its sensor clear channel.');
    await pause();

    const convertLibraryColour = workspace!.saveColour({ hex: '#E0354D', name: 'Convert Library capture', tags: ['convert-regression', 'favourite'], projectId: workspace!.workspace.projects[0]?.id });
    await pause();
    const convertLibrarySnapshot = JSON.stringify(workspace!.workspace.library);
    await navigate('convert');
    check(convertPreview().includes(demoConvertHex), 'A physical SCAN received while Convert is hidden does not overwrite its existing colour.');
    await changeConvertFormat('RGB');
    convertPage().querySelector<HTMLButtonElement>('[data-action="convert-library"]')!.click();
    await until(() => !!convertPage().querySelector('dialog[open] #convert-library-search'), 'the Convert Library source picker');
    await fillConvert('#convert-library-search', 'no-convert-colour-with-this-name');
    check(convertPage().querySelectorAll('[data-convert-colour]').length === 0, 'The Convert Library picker safely handles a search with no saved matches.');
    await fillConvert('#convert-library-search', 'convert-regression');
    await until(() => !!convertPage().querySelector(`[data-convert-colour="${convertLibraryColour.id}"]`), 'saved Convert colour filtered by tag');
    convertPage().querySelector<HTMLButtonElement>(`[data-convert-colour="${convertLibraryColour.id}"]`)!.click();
    await until(() => !convertPage().querySelector('dialog[open]') && convertPreview().includes(convertLibraryColour.hex), 'a saved Library colour applied to Convert');
    checkConvertValues(convertLibraryColour.hex, 'Library selection');
    check(convertPage().querySelector<HTMLButtonElement>('#convert-format')!.dataset.value === 'RGB' && /Library/i.test(convertSource()) && convertSource().includes(convertLibraryColour.name), 'Library selection retains the input format and visibly identifies the saved source and name.');
    check(JSON.stringify(workspace!.workspace.library) === convertLibrarySnapshot && JSON.stringify(workspace!.workspace.library.find(item => item.id === convertLibraryColour.id)) === JSON.stringify(convertLibraryColour), 'Converting a saved Library colour preserves every original record, including its tags, project, timestamp, physical source and clear channel.');

    button('Save to Library').click();
    await until(() => workspace!.dialog?.type === 'edit', 'the Library-source Convert save editor');
    check(workspace!.dialog?.type === 'edit' && workspace!.dialog.id === convertLibraryColour.id && workspace!.dialog.source === undefined, 'Saving the selected Library colour edits its existing record and preserves its original provenance.');
    workspace!.closeDialog();
    await pause();

    const convertBleHash = location.hash;
    await startConvertScan();
    await changeConvertFormat('LAB');
    await send('SCAN,18,52,86,631');
    await until(() => !device!.scanning && convertPreview().includes('#123456'), 'a fresh BLE capture applied to Convert');
    checkConvertValues('#123456', 'BLE capture');
    check(workspace!.route === 'convert' && location.hash === convertBleHash && workspace!.view === '' && convertPage().querySelector<HTMLButtonElement>('#convert-format')!.dataset.value === 'LAB', 'A fresh BLE Convert scan updates in place using the input format chosen while it was pending.');
    check(/BLE|Bluetooth/i.test(convertSource()) && !/Demo/i.test(convertSource()), 'Convert visibly labels the resolved real BLE capture.');
    check(unexpectedCommands === 0, 'Convert waits for the existing physical SCAN notification without inventing a BLE command.');

    button('Save to Library').click();
    await until(() => workspace!.dialog?.type === 'edit', 'the BLE-source Convert save editor');
    check(workspace!.dialog?.type === 'edit' && workspace!.dialog.source === 'bluetooth' && workspace!.dialog.captureId === workspace!.workspace.latest.id, 'Saving a resolved Convert BLE capture retains its physical source and exact captured record.');
    workspace!.closeDialog();
    await pause();

    await changeConvertFormat('HEX');
    await startConvertScan();
    await fillConvert('#convert-input', '#ABCDEF');
    await send('SCAN,1,2,3,632');
    await until(() => !device!.scanning, 'physical completion after manual Convert replacement');
    checkConvertValues('#ABCDEF', 'Manual replacement during a pending scan');
    check(!convertSource(), 'Manual replacement clears the earlier capture provenance in Convert.');
    check(workspace!.workspace.latest.hex === '#010203', 'Cancelling a pending Convert application still lets the same SCAN update normal capture history.');

    await startConvertScan();
    await chooseConvertLibrary(convertLibraryColour.id, convertLibraryColour.name);
    await send('SCAN,4,5,6,633');
    await until(() => !device!.scanning, 'physical completion after Library Convert replacement');
    checkConvertValues(convertLibraryColour.hex, 'Library replacement during a pending scan');
    check(/Library/i.test(convertSource()) && convertSource().includes(convertLibraryColour.name), 'A late BLE completion cannot replace a more recent Library choice or its visible source.');

    await startConvertScan();
    convertPage().querySelector<HTMLButtonElement>('[data-action="convert-picker"]')!.click();
    await until(() => !!convertPage().querySelector('dialog[open] #convert-picker-hue'), 'the Convert colour wheel during a pending scan');
    await fillConvert('#convert-picker-hue', '120');
    await fillConvert('#convert-picker-saturation', '100');
    await fillConvert('#convert-picker-lightness', '50');
    await until(() => convertPreview().includes('#00FF00'), 'the replacement Convert wheel colour');
    button('Use colour').click();
    await until(() => !convertPage().querySelector('dialog[open]'), 'closed Convert wheel');
    await send('SCAN,7,8,9,634');
    await until(() => !device!.scanning, 'physical completion after Convert wheel replacement');
    checkConvertValues('#00FF00', 'Wheel replacement during a pending scan');
    check(!convertSource(), 'A wheel replacement clears the earlier saved Library provenance in Convert.');

    await fillConvert('#convert-input', '#FA1234');
    await startConvertScan();
    await navigate('scan');
    await navigate('convert');
    await send('SCAN,9,10,11,635');
    await until(() => !device!.scanning, 'physical completion after leaving and returning to Convert');
    checkConvertValues('#FA1234', 'Leaving Convert cancels its pending application');
    check(workspace!.route === 'convert' && workspace!.workspace.latest.hex === '#090A0B', 'Returning before an old request completes cannot revive its cancelled Convert update.');
    await send('SCAN,12,13,14,636');
    checkConvertValues('#FA1234', 'An unsolicited active-page SCAN preserves the manual choice');
    await chooseConvertLibrary(convertLibraryColour.id, convertLibraryColour.name);
    await navigate('scan');
    await send('SCAN,15,16,17,637');
    await navigate('convert');
    checkConvertValues(convertLibraryColour.hex, 'An off-page SCAN preserves the Library choice');
    check(JSON.stringify(workspace!.workspace.library) === convertLibrarySnapshot, 'Scanning and replacing Convert sources never mutate the saved Library metadata.');
    check(unexpectedCommands === 0, 'All Convert source and cancellation paths keep the current incoming-only BLE protocol.');

    // Convert keeps its selected snapshot while hidden. A later Library edit or
    // deletion must not let Save reuse an id whose colour no longer matches it.
    await navigate('library');
    const editedConvertLibraryColour = workspace!.saveColour({ id: convertLibraryColour.id, hex: '#314159', name: 'Edited Convert Library capture', projectId: convertLibraryColour.projectId });
    await pause();
    const editedConvertLibrarySnapshot = JSON.stringify(editedConvertLibraryColour);
    await navigate('convert');
    checkConvertValues(convertLibraryColour.hex, 'The retained Convert snapshot after editing its saved source');
    button('Save to Library').click();
    await until(() => workspace!.dialog?.type === 'edit', 'the detached Convert save editor after a Library HEX edit');
    const editedSourceDialog = workspace!.dialog!;
    check(editedSourceDialog.type === 'edit' && editedSourceDialog.id === undefined && editedSourceDialog.source === 'convert', 'A retained Convert colour detaches from a Library record whose HEX was subsequently edited.');
    if (editedSourceDialog.type !== 'edit') throw new Error('Raw BLE UI: edited-source Convert save editor is missing.');
    const detachedEditedColour = workspace!.saveColour({ id: editedSourceDialog.id, hex: editedSourceDialog.hex, source: editedSourceDialog.source, captureId: editedSourceDialog.captureId, name: 'Detached edited Convert snapshot' });
    await pause();
    check(detachedEditedColour.id !== convertLibraryColour.id && detachedEditedColour.source === 'convert' && JSON.stringify(workspace!.workspace.library.find(item => item.id === convertLibraryColour.id)) === editedConvertLibrarySnapshot, 'Saving the old Convert snapshot creates a separate colour and leaves every field of the edited Library record intact.');
    workspace!.closeDialog();
    await pause();

    await chooseConvertLibrary(editedConvertLibraryColour.id, editedConvertLibraryColour.name);
    await navigate('library');
    workspace!.deleteColour(editedConvertLibraryColour.id);
    await pause();
    const libraryAfterSourceDeletion = JSON.stringify(workspace!.workspace.library);
    await navigate('convert');
    checkConvertValues(editedConvertLibraryColour.hex, 'The retained Convert snapshot after deleting its saved source');
    button('Save to Library').click();
    await until(() => workspace!.dialog?.type === 'edit', 'the detached Convert save editor after a Library deletion');
    const deletedSourceDialog = workspace!.dialog!;
    check(deletedSourceDialog.type === 'edit' && deletedSourceDialog.id === undefined && deletedSourceDialog.source === 'convert', 'A retained Convert colour detaches safely when its original Library record is deleted.');
    if (deletedSourceDialog.type !== 'edit') throw new Error('Raw BLE UI: deleted-source Convert save editor is missing.');
    const detachedDeletedColour = workspace!.saveColour({ id: deletedSourceDialog.id, hex: deletedSourceDialog.hex, source: deletedSourceDialog.source, captureId: deletedSourceDialog.captureId, name: 'Detached deleted Convert snapshot' });
    await pause();
    check(detachedDeletedColour.id !== editedConvertLibraryColour.id && !workspace!.workspace.library.some(item => item.id === editedConvertLibraryColour.id) && JSON.stringify(workspace!.workspace.library.filter(item => item.id !== detachedDeletedColour.id)) === libraryAfterSourceDeletion, 'Saving a deleted-source Convert snapshot creates a new record without restoring the deleted id or changing any remaining Library record.');
    workspace!.closeDialog();
    await pause();
    await navigate('scan');
    // Retain the physical fixture expected by the existing Match regressions.
    await send('SCAN,224,53,77,630');

    const pairBeforeFastEdit = workspace!.compare;
    editReferenceOnMount = '#FF0000';
    await navigate('compare');
    check(referenceMountEdits === 1 && host.querySelector<HTMLInputElement>('#compareA')?.value === '#FF0000', 'The first reference edit immediately after Compare mounts survives its initial input synchronization.');
    check(![...host.querySelectorAll('button')].some(item => ['Digital', 'Physical', 'Digital + Scan'].includes(item.textContent?.trim() || '')), 'Compare presents a single workflow without Digital, Physical or Digital + Scan mode buttons.');
    await openCompareEditor();
    const fastSample = host.querySelector<HTMLInputElement>('#compareB')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(fastSample, '#FF0000');
    fastSample.dispatchEvent(new Event('input', { bubbles: true }));
    await pause();
    host.querySelector<HTMLFormElement>('#compare-form')!.requestSubmit();
    await until(() => workspace!.compare.a === '#FF0000' && workspace!.compare.b === '#FF0000', 'both fast manual comparison edits');
    check(host.querySelector('[data-testid="delta-e"]')?.childNodes[0].textContent === '0.00', 'Submitting two identical colours after a fast first edit displays Delta E zero.');
    for (const side of ['a', 'b'] as const) {
      await openCompareEditor(side);
      check(!!host.querySelector(`#compare-edit[open] #compare-picker-${side}-hue`)?.getClientRects().length, `The ${side === 'a' ? 'reference' : 'sample'} editor always exposes its colour wheel.`);
      check(!!host.querySelector(`#compare-edit[open] [data-action="compare-library-${side}"]`)?.getClientRects().length, `The ${side === 'a' ? 'reference' : 'sample'} editor always exposes the shared saved-library chooser.`);
      const captures = host.querySelector<HTMLDetailsElement>('#compare-edit[open] #compare-form > div:not([hidden]) .compare-capture-options');
      check(!!captures?.querySelector('summary')?.getClientRects().length, `The ${side === 'a' ? 'reference' : 'sample'} editor exposes recent physical captures alongside its colour wheel.`);
      captures!.open = true;
      check(!!captures!.querySelector('.compare-capture-choice')?.getClientRects().length, `Recent ${side === 'a' ? 'reference' : 'sample'} captures can be expanded and selected.`);
      check(host.querySelector<HTMLButtonElement>(`#compare-edit[open] [data-action="compare-scan-${side}"]`)?.disabled === false, `The ${side === 'a' ? 'reference' : 'sample'} editor always offers a new scan when connected.`);
      host.querySelector<HTMLButtonElement>('#compare-edit[open] [aria-label="Close dialog"]')!.click();
      await until(() => !host.querySelector('#compare-edit[open]'), 'closed unified Compare editor');
    }
    workspace!.setCompare(pairBeforeFastEdit.a, pairBeforeFastEdit.b, pairBeforeFastEdit.deviceDeltaE, pairBeforeFastEdit.sampleSource);
    await navigate('scan');

    const withoutReference = protocolSnapshot();
    await send('CMP,220,55,80,2.4');
    check(protocolSnapshot() === withoutReference, 'CMP without a session reference is safely ignored.');
    const referenceHash = location.hash;
    await send('REF,224,53,77');
    await until(() => workspace!.compare.a === '#E0354D' && !!device!.bleReference, 'the BLE reference');
    check(location.hash === referenceHash && workspace!.route === 'scan', 'REF saves the comparison reference without navigating away from Scan.');
    check(workspace!.compare.deviceDeltaE === undefined, 'A new reference has no stale device Delta E.');
    await navigate('compare');
    check(!host.querySelector('[data-testid="delta-e"]') && host.querySelector('.wireframe-compare-waiting')?.textContent?.includes('Waiting'), 'REF alone renders the waiting state without inventing a comparison value.');
    check(host.querySelector<HTMLButtonElement>('[data-action="compare-result"]')?.disabled, 'A reference without a CMP sample cannot open a completed comparison result.');
    await navigate('scan');
    await send('CMP,220,55,80,2.4');
    await until(() => workspace!.compare.b === '#DC3750' && workspace!.compare.deviceDeltaE === 2.4, 'the device comparison');
    check(workspace!.compare.a === '#E0354D', 'CMP pairs the sample with the previously received REF colour.');
    await navigate('compare');
    check([...host.querySelectorAll('.wireframe-compare-card strong')].map(element => element.textContent).join(',') === '#E0354D,#DC3750', 'The Compare workflow displays the reference and sample from the ESP32.');
    check([...host.querySelectorAll('.wireframe-compare-card strong')].map(element => element.textContent).join(',') === '#E0354D,#DC3750', 'The visible wireframe swatches show the actual BLE reference and sample.');
    check(Math.abs(deltaE('#E0354D', '#DC3750') - 2.4) > 0.01 && host.querySelector('[data-testid="delta-e"]')?.childNodes[0].textContent === '2.40', 'Compare displays device-provided 2.40 rather than replacing it with the app calculation.');
    check(host.textContent!.includes('Device-provided') && host.textContent!.includes('CHROMA BLE'), 'The comparison labels the Delta E as device-provided.');
    await showResult('compare');
    check(host.querySelectorAll('.colour-result-formats .metric').length === 10, 'All five conversion formats are visible for both colours in the device comparison result.');
    check(host.querySelector('[data-testid="delta-e"]')?.textContent === '2.40', 'The separate result preserves the device Delta E.');
    check(host.querySelector('[aria-label="Back to Compare"]'), 'The comparison result exposes its proper Back to Compare action.');

    const validState = protocolSnapshot();
    for (const malformed of ['SCAN,256,53,77,630', 'SCAN,224,-1,77,630', 'SCAN,224,53,77', 'SCAN,224,53,77,NaN', 'REF,224,53', 'REF,1,2,Infinity', 'CMP,220,55,80,NaN', 'CMP,220,55,80,-1', 'CMP,220,55,80,2.4,extra', 'UNKNOWN,1,2,3', '{"type":"scan","hex":"#FFFFFF"}']) {
      await send(malformed);
      check(protocolSnapshot() === validState, `Invalid or unknown packet ${malformed} cannot mutate the reading or comparison.`);
    }
    check(!device!.error, 'Ignored malformed packets do not crash the connected workflow.');

    await send('REF,10,20,30');
    await until(() => workspace!.compare.a === '#0A141E' && workspace!.compare.deviceDeltaE === undefined, 'a replacement reference');
    check(host.querySelector('[data-testid="delta-e"]')?.childNodes[0].textContent !== '2.40', 'Replacing REF removes the previous device comparison result.');
    await send('CMP,20,30,40,8.7');
    await until(() => workspace!.compare.deviceDeltaE === 8.7, 'the replacement comparison');
    await navigate('compare');
    await openCompareEditor('b');
    const edited = host.querySelector<HTMLInputElement>('#compareB')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(edited, '#123456');
    edited.dispatchEvent(new Event('input', { bubbles: true }));
    await pause();
    host.querySelector<HTMLFormElement>('#compare-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await until(() => workspace!.compare.b === '#123456', 'a manual comparison edit');
    check(workspace!.compare.deviceDeltaE === undefined && !host.textContent!.includes('Device-provided'), 'Manually editing the colour pair invalidates the device-provided Delta E.');
    check(host.querySelector('[data-testid="delta-e"]')?.childNodes[0].textContent === deltaE('#0A141E', '#123456').toFixed(2), 'A manual comparison uses the existing app conversion and Delta E calculation.');

    // Use the actual Library action and existing Match page, including a SCAN
    // that arrived before either source was selected.
    const libraryProject = workspace!.workspace.projects[0]?.id;
    const libraryTarget = workspace!.saveColour({ hex: '#E0354D', name: 'Library match reference', source: 'manual', tags: ['match-test'], projectId: libraryProject });
    const secondLibraryTarget = workspace!.saveColour({ hex: '#12AB34', name: 'Second library match reference', source: 'convert' });
    await pause();
    const originalLibrary = JSON.stringify(workspace!.workspace.library);
    const originalHistory = JSON.stringify(workspace!.workspace.history);
    const originalCompare = JSON.stringify(workspace!.compare);
    await navigate('library');
    const activateLibraryTarget = async (name: string) => {
      const colour = host.querySelector<HTMLButtonElement>(`[aria-label="View ${name}"]`);
      check(!!colour, 'The compact saved Library swatch has an accessible colour name.');
      colour!.click();
      await until(() => host.querySelector('dialog[open] h2')?.textContent === name, 'Library colour actions');
      const action = button('Use as Match Target');
      check(!action.disabled, 'A saved Library colour exposes Use as Match Target in its actions dialog.');
      action.click();
      await until(() => workspace!.route === 'image' && workspace!.imageMatch.target?.source === 'library', 'Library to Match navigation');
      await pause();
    };
    await activateLibraryTarget(libraryTarget.name);
    const selectedLibraryTarget = workspace!.imageMatch.target!;
    check(location.hash === '#image' && imagePage().querySelector('h1')?.textContent === 'Image Match', 'Use as Match Target opens the existing Image Match route and shared page.');
    check(selectedLibraryTarget.hex === '#E0354D' && JSON.stringify(selectedLibraryTarget.rgb) === JSON.stringify({ r: 224, g: 53, b: 77 }), 'A Library target preserves its exact HEX and RGB.');
    check(selectedLibraryTarget.source === 'library' && selectedLibraryTarget.name === libraryTarget.name && selectedLibraryTarget.libraryItemId === libraryTarget.id && selectedLibraryTarget.libraryProjectId === libraryProject, 'The target snapshot retains Library source, item id, name and project association.');
    check(imagePage().querySelector('[data-testid="match-target-source"]')?.textContent?.includes('Library') && imagePage().querySelector('[data-testid="image-match-target"]')?.textContent?.includes('#E0354D'), 'The Match page visibly identifies the Library target without requiring an image upload.');
    check(!imagePage().querySelector('#image-canvas') && workspace!.imageMatch.sample?.hex === '#E0354D' && imageDelta() === '0.00', 'SCAN first then Library target compares immediately through existing app CIEDE2000.');
    check(JSON.stringify(workspace!.workspace.library) === originalLibrary && JSON.stringify(workspace!.workspace.history) === originalHistory, 'Using a saved colour as a target leaves every Library item and scan-history record unchanged.');
    check(JSON.stringify(workspace!.compare) === originalCompare, 'Library target selection leaves the independent Compare pair unchanged.');

    await openImageTools();
    imagePage().querySelector<HTMLButtonElement>('#match-library-colour')!.click();
    await until(() => !!imagePage().querySelector(`[data-library-colour="${secondLibraryTarget.id}"]`), 'Image Match saved Library picker');
    imagePage().querySelector<HTMLButtonElement>(`[data-library-colour="${secondLibraryTarget.id}"]`)!.click();
    await until(() => workspace!.imageMatch.target?.libraryItemId === secondLibraryTarget.id, 'replacement Library target');
    check(workspace!.imageMatch.sample?.hex === '#E0354D' && imageDelta() === deltaE('#12AB34', '#E0354D').toFixed(2), 'Replacing a Library target preserves the physical scan and automatically recomputes CIEDE2000.');
    await openImageTools();
    imagePage().querySelector<HTMLButtonElement>('#match-clear-target')!.click();
    await until(() => workspace!.imageMatch.target === null, 'cleared digital target');
    check(workspace!.imageMatch.sample?.hex === '#E0354D' && !imagePage().querySelector('[data-testid="delta-e"]'), 'Clear target preserves the stored physical sample while removing the result.');
    imagePage().querySelector<HTMLButtonElement>('#match-clear-sample')!.click();
    await until(() => workspace!.imageMatch.sample === null, 'cleared physical sample');
    await closeImageTools();
    await navigate('library');
    await activateLibraryTarget(libraryTarget.name);
    check(workspace!.imageMatch.sample === null && !imagePage().querySelector('[data-testid="delta-e"]'), 'Library target first waits for a sample without replaying the last SCAN after an explicit clear.');
    await send('SCAN,224,53,77,812');
    await until(() => workspace!.imageMatch.sample?.clear === 812, 'target-first Library BLE sample');
    check(workspace!.workspace.latest.clear === 812 && imageDelta() === '0.00', 'Library target first then ordinary BLE SCAN updates normal Scan and immediately displays the app-calculated match.');
    const libraryMatchBeforeCompare = JSON.stringify(workspace!.imageMatch);
    await send('REF,11,22,33');
    await send('CMP,12,23,34,1.8');
    check(JSON.stringify(workspace!.imageMatch) === libraryMatchBeforeCompare && workspace!.compare.deviceDeltaE === 1.8, 'REF and CMP remain independent while a Library match is active.');
    const beforeLibrarySave = workspace!.workspace.comparisons.length;
    await openImageTools();
    button('Save comparison').click();
    await until(() => workspace!.workspace.comparisons.length === beforeLibrarySave + 1, 'saved Library match');
    const savedLibraryMatch = workspace!.workspace.comparisons[0];
    check(savedLibraryMatch.a === '#E0354D' && savedLibraryMatch.b === '#E0354D' && savedLibraryMatch.deviceDeltaE === undefined && savedLibraryMatch.sampleSource === 'bluetooth', 'A Library match saves through the existing comparison model with physical sample provenance.');
    check(savedLibraryMatch.matchTarget?.source === 'library' && savedLibraryMatch.matchTarget.libraryItemId === libraryTarget.id && savedLibraryMatch.matchTarget.name === libraryTarget.name, 'Saving preserves useful Library target source, item id and name metadata.');
    const oldCreate = URL.createObjectURL, oldClick = HTMLAnchorElement.prototype.click;
    let resultBlob: Blob | null = null;
    try {
      URL.createObjectURL = value => { resultBlob = value as Blob; return oldCreate.call(URL, value); };
      HTMLAnchorElement.prototype.click = () => {};
      nativePlatform = false;
      button('Share / export result').click();
      await until(() => !!resultBlob, 'Library match result export');
    } finally { nativePlatform = true; URL.createObjectURL = oldCreate; HTMLAnchorElement.prototype.click = oldClick; }
    const resultExport = JSON.parse(await resultBlob!.text());
    const sharedLibraryMatch = resultExport.comparisons[0];
    check(resultExport.product === 'CHROMA' && resultExport.version === 2 && sharedLibraryMatch.matchTarget.source === 'library' && sharedLibraryMatch.matchTarget.libraryItemId === libraryTarget.id, 'Share/export retains Library target metadata in the existing backward-compatible CHROMA JSON envelope.');
    check(sharedLibraryMatch.deltaE === 0 && sharedLibraryMatch.method === 'CIEDE2000' && sharedLibraryMatch.reference.hex === '#E0354D' && sharedLibraryMatch.sample.hex === '#E0354D', 'Library result export uses the existing CIEDE2000 calculation and colour-format conversion path.');
    imagePage().querySelector<HTMLButtonElement>('#match-clear-sample')!.click();
    await until(() => workspace!.imageMatch.sample === null, 'sample-only reset with a target');
    check(workspace!.imageMatch.target?.libraryItemId === libraryTarget.id && !imagePage().querySelector('[data-testid="delta-e"]'), 'Clear sample preserves the Library target and waits safely for a rescan.');
    await send('SCAN,224,53,77,813');
    check(workspace!.imageMatch.target?.libraryItemId === libraryTarget.id && workspace!.imageMatch.sample?.clear === 813, 'A physical rescan replaces only the sample against the retained Library target.');
    check(JSON.stringify(workspace!.workspace.library) === originalLibrary, 'Target replacement, clearing, scanning, saving and sharing never mutate the source Library records.');
    await closeImageTools();
    check(imagePage().scrollWidth <= imagePage().clientWidth + 1, 'The populated Library-target Match workflow fits the mobile-width layout.');
    await openImageTools();
    imagePage().querySelector<HTMLButtonElement>('#match-clear-target')!.click();
    await until(() => workspace!.imageMatch.target === null, 'target clear before the image-source regression');
    button('Image').click();
    await pause();
    await closeImageTools();

    await navigate('image');
    check(workspace!.imageMatch.target === null && workspace!.imageMatch.sample?.hex === '#E0354D', 'Image Match retains the earlier ordinary physical SCAN without inventing a target.');
    uploadFile();
    await pause();
    check(workspace!.imageMatch.target === null, 'Cancelling image selection safely leaves the empty target unchanged.');
    await uploadImage('ble-image-match-fixture.png');
    check(workspace!.imageMatch.target === null && !imagePage().querySelector('[data-testid="image-crosshair"]'), 'Loading an image waits for an explicit point selection.');
    const preview = imagePage().querySelector<HTMLCanvasElement>('#image-canvas')!;
    check(Math.abs(preview.getBoundingClientRect().width - preview.width) > 1, 'The mobile test samples an image displayed at a different size from its original pixels.');
    await pick(0, 0, 'touch');
    await until(() => workspace!.imageMatch.target?.hex === '#0012EF', 'the mobile corner target');
    const marker = imagePage().querySelector<HTMLElement>('[data-testid="image-crosshair"]');
    check(!!marker && Math.abs(parseFloat(marker.style.left) - 100 / 12) < 0.01, 'Touch coordinates map to original pixel zero and position the visible crosshair at its centre.');
    check(imagePage().querySelector('[data-testid="match-target-source"]')?.textContent?.includes('#0012EF') && imagePage().querySelector('[data-testid="match-target-source"]')?.textContent?.includes('Image colour'), 'Image Match visibly identifies the selected image colour after point selection.');
    check(workspace!.imageMatch.target?.source === 'image' && workspace!.imageMatch.target.imageName === 'ble-image-match-fixture.png' && imageDelta() === deltaE('#0012EF', '#E0354D').toFixed(2), 'An image target after a scan uses the same shared model and calculates immediately.');
    await openImageTools();
    imagePage().querySelectorAll<HTMLDetailsElement>('dialog[open] details').forEach(detail => { detail.open = true; });
    for (const format of ['HEX', 'RGB', 'HSL', 'CMYK', 'LAB'] as const) {
      check(!!imagePage().querySelector(`[aria-label="Copy ${format}: ${colourValues('#0012EF')[format]}"]`), `The image target exposes its shared ${format} conversion.`);
    }
    await closeImageTools();

    await navigate('library');
    check(workspace!.imageMatch.target === null && !host.querySelector('[data-testid="image-test-page"]'), 'Leaving Image Match disposes the local image view and its image target without deleting the physical sample.');
    await activateLibraryTarget(secondLibraryTarget.name);
    check(!imagePage().querySelector('#image-canvas'), 'Returning from Library does not restore a disposed local image.');
    await openImageTools();
    button('Image').click();
    await pause();
    await closeImageTools();
    await uploadImage('ble-image-match-fixture.png');
    await pick(0, 0, 'touch');
    await until(() => workspace!.imageMatch.target?.source === 'image', 'Library target replaced with an image point');
    check(workspace!.imageMatch.target?.hex === '#0012EF' && workspace!.imageMatch.target.libraryItemId === undefined && workspace!.imageMatch.sample?.hex === '#E0354D', 'An image point replaces a Library target in the same state, discards stale Library metadata and retains the physical sample.');

    const comparisonBeforeImageScan = JSON.stringify(workspace!.compare);
    await navigate('scan');
    check(workspace!.imageMatch.target === null && !host.querySelector('[data-testid="image-test-page"]'), 'Navigating to Scan clears only the temporary image target and unmounts its local canvas.');
    const historyBeforeImageScan = workspace!.workspace.history.length;
    await send('SCAN,0,18,239,741');
    await until(() => workspace!.imageMatch.sample?.hex === '#0012EF', 'the off-page physical Image Match sample');
    check(workspace!.route === 'scan' && workspace!.workspace.latest.hex === '#0012EF' && workspace!.workspace.latest.clear === 741, 'A BLE SCAN updates normal Scan and the independent physical Match sample without navigating.');
    check(workspace!.workspace.history.length === Math.min(50, historyBeforeImageScan + 1) && JSON.stringify(workspace!.imageMatch.sample) === JSON.stringify(device!.reading), 'The same shared real reading feeds Image Match and adds just one normal Scan history entry.');
    check(JSON.stringify(workspace!.compare) === comparisonBeforeImageScan, 'A SCAN used by Image Match does not overwrite the independent Compare workflow.');
    await navigate('image');
    check(!imagePage().querySelector('#image-canvas') && workspace!.imageMatch.target === null && !imagePage().querySelector('[data-testid="image-crosshair"]'), 'Returning to Image Match starts with no local image, temporary target or selected-point marker.');
    check(imageDelta() === undefined && workspace!.imageMatch.sample?.hex === '#0012EF', 'Route leave preserves the real sample but does not invent a target or result.');
    await uploadImage('ble-image-match-fixture.png');
    await pick(0, 0, 'touch');
    await until(() => workspace!.imageMatch.target?.hex === '#0012EF', 'the reuploaded image target');
    check(imageDelta() === '0.00', 'Selecting a new target calculates Delta E from the retained real SCAN using the existing utility, without a CMP packet.');
    check(imagePage().querySelector('[data-testid="image-match-sample"]')?.textContent?.includes('#0012EF') && /BLE|Bluetooth/.test(imagePage().textContent!), 'Image Match displays the received sample and clearly labels its real BLE origin.');
    const imageMatchBeforeCompare = JSON.stringify(workspace!.imageMatch);
    await send('REF,224,53,77');
    await send('CMP,220,55,80,2.4');
    check(JSON.stringify(workspace!.imageMatch) === imageMatchBeforeCompare && workspace!.compare.deviceDeltaE === 2.4, 'REF and CMP continue updating Compare while leaving the active Image Match target and sample untouched.');
    check(imageDelta() === '0.00', 'Image Match never substitutes the independent device-provided Compare value.');
    const commandsBeforeRescan = imageMatchCommands.length;

    imagePage().querySelector<HTMLButtonElement>('#image-scan')!.click();
    await until(() => device!.scanning, 'a pending physical rescan');
    check(workspace!.imageMatch.target?.hex === '#0012EF', 'Requesting another physical scan retains the selected digital target.');
    await pick(4, 4);
    check(workspace!.view === '' && workspace!.imageMatch.target?.hex === '#12AB34', 'Changing the target during a pending BLE scan cannot open a result using an old physical sample.');
    await pick(0, 0);
    check(workspace!.view === '' && device!.scanning, 'Restoring the target still waits for a fresh physical SCAN notification.');
    check(imageMatchCommands.length === commandsBeforeRescan, 'Editing a target during a pending physical scan does not transmit a provisional result.');
    await send('SCAN,2,20,235,750');
    await until(() => workspace!.imageMatch.sample?.hex === '#0214EB' && !device!.scanning && workspace!.view === 'result', 'the replacement physical sample and separate result view');
    check(workspace!.imageMatch.target?.hex === '#0012EF' && imageDelta() === deltaE('#0012EF', '#0214EB').toFixed(2), 'A new SCAN replaces the physical sample and recalculates app Delta E against the unchanged target.');
    const expectedImageCommand = `IMR,0,18,239,${deltaE('#0012EF', '#0214EB').toFixed(1)}`;
    await until(() => imageMatchCommands.length === commandsBeforeRescan + 1, 'the completed Image Match IMR write');
    check(imageMatchCommands.at(-1) === expectedImageCommand, 'The real Image Match page transmits image RGB, rather than scanned RGB, and its existing CIEDE2000 result rounded to one decimal.');
    check(unexpectedCommands === 0, 'SCAN, REF and CMP reception produces no other command packets.');
    const commandsBeforeSave = imageMatchCommands.length;
    const comparisonsBeforeImageSave = workspace!.workspace.comparisons.length;
    await openImageTools();
    button('Save comparison').click();
    await until(() => workspace!.workspace.comparisons.length === comparisonsBeforeImageSave + 1, 'the saved image match');
    const savedImageMatch = workspace!.workspace.comparisons[0];
    check(savedImageMatch.a === '#0012EF' && savedImageMatch.b === '#0214EB' && savedImageMatch.deviceDeltaE === undefined, 'Image Match saves through the existing comparison model with app-calculated colour difference.');
    check(savedImageMatch.sampleSource === 'bluetooth' && savedImageMatch.matchTarget?.source === 'image' && savedImageMatch.matchTarget.imageName === 'ble-image-match-fixture.png', 'The redesigned Image actions save both the BLE sample provenance and image target metadata.');
    await closeImageTools();
    check(imageMatchCommands.length === commandsBeforeSave, 'Opening tools, saving and closing the result dialog do not duplicate IMR on unrelated rerenders.');
    check(imagePage().scrollWidth <= imagePage().clientWidth + 1, 'The populated Image Match workflow fits the mobile-width layout without horizontal overflow.');

    await backImageEditor();
    check(!!imagePage().querySelector('#image-canvas'), 'Back from the Match result restores its still-open editor and local image.');
    await pick(4, 4);
    await until(() => workspace!.imageMatch.target?.hex === '#12AB34', 'a replacement target on the same image');
    await openImageTools();
    check(workspace!.imageMatch.sample?.hex === '#0214EB' && !!imagePage().querySelector<HTMLButtonElement>('#image-clear'), 'Choosing another target preserves the physical sample and keeps image controls available.');
    await closeImageTools();
    check(imageDelta() === deltaE('#12AB34', '#0214EB').toFixed(2), 'Replacing an image target immediately recalculates against the stored physical sample.');
    const beforeInvalidImage = JSON.stringify(workspace!.imageMatch);
    uploadFile(new File(['not an image'], 'broken.png', { type: 'image/png' }));
    await until(() => !!imagePage().querySelector('#image-error')?.textContent, 'invalid local image feedback');
    check(JSON.stringify(workspace!.imageMatch) === beforeInvalidImage && !!imagePage().querySelector('#image-canvas'), 'A malformed image reports an error while preserving the last usable local image and target.');
    uploadFile(new File(['plain text'], 'unsupported.txt', { type: 'text/plain' }));
    await pause();
    check(JSON.stringify(workspace!.imageMatch) === beforeInvalidImage, 'Unsupported file types cannot corrupt Image Match state.');
    await uploadImage('replacement.png', '#E0354D');
    check(workspace!.imageMatch.target === null && workspace!.imageMatch.sample?.hex === '#0214EB' && !imagePage().querySelector('[data-testid="image-crosshair"]'), 'Replacing the image clears the old image target and marker while retaining the physical sample.');
    await pick(5, 5, 'touch');
    await until(() => workspace!.imageMatch.target?.hex === '#E0354D', 'the bottom-right edge sample');
    await openImageTools();
    check(imagePage().querySelector<HTMLInputElement>('#pixel-x')?.value === '5' && imagePage().querySelector<HTMLInputElement>('#pixel-y')?.value === '5', 'Sampling the bottom-right edge clamps the averaging neighbourhood to real image pixels.');
    imagePage().querySelector<HTMLButtonElement>('#image-clear')!.click();
    await until(() => !imagePage().querySelector('#image-canvas') && workspace!.imageMatch.target === null, 'cleared local image state');
    check(workspace!.imageMatch.sample?.hex === '#0214EB' && !imagePage().querySelector('[data-testid="image-crosshair"]'), 'Clear image removes its target and marker while retaining the independent physical sample.');
    await send('SCAN,1,2,3,752');
    check(workspace!.workspace.latest.hex === '#010203' && workspace!.imageMatch.target === null && workspace!.imageMatch.sample?.hex === '#010203', 'A BLE SCAN updates normal Scan and stores the Match sample safely when no target exists.');
    await navigate('compare');

    await send('REF,224,53,77');
    await send('CMP,220,55,80,2.4');
    await until(() => workspace!.compare.deviceDeltaE === 2.4, 'the comparison to save');
    const beforeSaved = workspace!.workspace.comparisons.length;
    await showResult('compare');
    button('Save').click();
    await until(() => workspace!.workspace.comparisons.length === beforeSaved + 1, 'the saved device comparison');
    const saved = workspace!.workspace.comparisons[0];
    check(saved.a === '#E0354D' && saved.b === '#DC3750' && saved.deviceDeltaE === 2.4, 'Saving a comparison retains the device value with the exact reference/sample pair.');
    // Intercept the existing web download path to inspect the real JSON export.
    // The BLE transport stays mounted; native Filesystem/Share APIs are never used.
    replace(URL, 'createObjectURL', (blob: Blob) => { exportedBlob = blob; return 'blob:chroma-protocol-test'; });
    replace(URL, 'revokeObjectURL', () => {});
    replace(HTMLAnchorElement.prototype, 'click', () => {});
    nativePlatform = false;
    workspace!.exportLibrary();
    await until(() => !!exportedBlob, 'the real library JSON export');
    nativePlatform = true;
    const backup = await exportedBlob!.text();
    const exported = JSON.parse(backup).comparisons.find((item: { id: string }) => item.id === saved.id);
    check(exported?.deviceDeltaE === 2.4 && exported.a === saved.a && exported.b === saved.b, 'JSON export preserves the device Delta E and its provenance.');
    const exportedImageMatch = JSON.parse(backup).comparisons.find((item: { id: string }) => item.id === savedImageMatch.id);
    check(exportedImageMatch?.a === savedImageMatch.a && exportedImageMatch.b === savedImageMatch.b && exportedImageMatch.deviceDeltaE === undefined, 'The existing JSON export preserves image comparisons separately from device-provided Compare values.');
    const exportedLibraryMatch = JSON.parse(backup).comparisons.find((item: { id: string }) => item.id === savedLibraryMatch.id);
    check(exportedLibraryMatch?.matchTarget?.source === 'library' && exportedLibraryMatch.matchTarget.libraryItemId === libraryTarget.id, 'Library backups retain saved match-target metadata alongside existing comparisons.');
    workspace!.deleteComparison(savedLibraryMatch.id);
    workspace!.deleteComparison(saved.id);
    await until(() => !workspace!.workspace.comparisons.some(item => item.id === saved.id), 'removing the saved test comparison before import');
    await workspace!.importLibrary(new File([backup], 'chroma-protocol.json', { type: 'application/json' }));
    await until(() => workspace!.workspace.comparisons.some(item => item.id === saved.id), 'the imported comparison');
    check(workspace!.workspace.comparisons.find(item => item.id === saved.id)?.deviceDeltaE === 2.4, 'Import restores a saved device-provided Delta E rather than silently recomputing it.');

    check(workspace!.workspace.comparisons.find(item => item.id === savedLibraryMatch.id)?.matchTarget?.libraryItemId === libraryTarget.id, 'Import restores saved Library-target comparison metadata.');

    await navigate('device');
    check(output()?.textContent === 'CMP,220,55,80,2.4', 'The raw debug preview stays available after parsed scan and comparison packets.');

    clickDisconnect();
    await until(() => device?.status.mode === 'disconnected' && unsubscriptions.length === 1 && disconnects === 1, 'manual disconnect cleanup');
    check(JSON.stringify(unsubscriptions[0]) === JSON.stringify(subscriptions[0]), 'Manual disconnect stops the same DATA subscription.');
    check(!host.textContent!.includes(longText), 'Disconnect clears the previously received debug text.');
    check(device!.bleReference === null && device!.bleComparison === null && workspace!.compare.deviceDeltaE === undefined, 'Disconnect clears the session reference and live device comparison.');
    callbacks[0](view('STALE_NOTIFICATION'));
    await pause(20);
    check(!host.textContent!.includes('STALE_NOTIFICATION'), 'A callback from a disconnected session cannot restore stale debug text.');

    await connect();
    const reconnectedPair = JSON.stringify(workspace!.compare);
    await send('CMP,1,2,3,4.5', 1);
    check(JSON.stringify(workspace!.compare) === reconnectedPair && device!.bleComparison === null, 'A fresh session cannot use a reference from the previous connection.');
    callbacks[1](view('RECONNECTED'));
    await until(() => output()?.textContent === 'RECONNECTED', 'data after reconnect');
    check(subscriptions.length === 2, 'Reconnecting starts a fresh DATA subscription.');
    links[1]();
    await until(() => device?.status.mode === 'disconnected' && unsubscriptions.length === 2 && disconnects === 2, 'peripheral link-loss cleanup');
    check(!host.textContent!.includes('RECONNECTED'), 'Peripheral disconnect updates connection status and clears the raw text.');
    callbacks[1](view('LATE_LINK_LOSS_DATA'));
    await pause(20);
    check(!host.textContent!.includes('LATE_LINK_LOSS_DATA'), 'A late notification after link loss is ignored.');

    await connect();
    root.unmount();
    root = null;
    await until(() => unsubscriptions.length === 3 && disconnects === 3, 'provider teardown');
    check(true, 'Unmounting the Device provider cleanly stops notifications and disconnects.');
    return { checks: descriptions.length, descriptions, hardware: 'All native BLE APIs mocked; no radio or permission prompt used.' };
  } finally {
    // Await native cleanup while its APIs are still mocked, including on failure.
    (allowSubscription as (() => void) | null)?.();
    if (root) {
      await (device as ReturnType<typeof useDevice> | null)?.disconnectDevice().catch(() => {});
      root.unmount();
    }
    await pause();
    host.remove();
    location.hash = savedHash;
    if (savedWorkspace === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, savedWorkspace);
    restorers.reverse().forEach(restore => restore());
  }
}
