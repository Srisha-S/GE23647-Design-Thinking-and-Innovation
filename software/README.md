# CHROMA — Colour, understood.

A responsive colour workspace built with **React, TypeScript, Vite, Tailwind CSS and Lucide**. Local state and browser storage only: no account, backend, AI API or cloud upload.

## Run on this computer

The latest ChromaPod tools, navigation and project folder update is documented in [CHROMAPOD_WORKFLOW_UPDATE.md](CHROMAPOD_WORKFLOW_UPDATE.md). The preceding UI wireframe implementation is documented in [WIREFRAME_UI_UPDATE.md](WIREFRAME_UI_UPDATE.md).

Visualize Colour now includes local tap selection, an optional SAM 3 server connection, six material profiles, LightShift and a before/after slider. See [VISUALIZE_MATERIAL_UPDATE.md](VISUALIZE_MATERIAL_UPDATE.md) and the [local SAM 3 setup](server/sam3/README.md). SAM 3 needs a separate model environment and approved weights; local editing works without it.

Open a terminal in this project folder:

```powershell
python scripts/npm.py run dev
```

Open **http://127.0.0.1:8000**. Keep the terminal open; press Ctrl+C to stop. The launcher uses the portable Node runtime in `.tools` or a normal Node installation. It does not change Windows execution-policy settings.

Use Vite, not the previous `python -m http.server` command against source files. React/TypeScript must be compiled first. If port 8000 is occupied by an old server, stop that server first.

## On another computer

With Node.js 22.12 or newer:

```sh
npm ci
npm run dev
```

On Windows without Node, `python scripts/setup_node.py` downloads an official portable Node 22 LTS distribution and verifies its checksum. Then run `python scripts/npm.py ci`.

## Android app

The existing UI is also packaged by **Capacitor 8** as **CHROMA** (`com.chroma.app`). After installing Android Studio and its SDK:

```powershell
python scripts/npm.py run android:sync
python scripts/npm.py run android:open
```

With Node on PATH, use `npm run android:sync` and `npm run android:open`. The first command builds the UI and syncs the Android project; the second opens it in Android Studio. See [CHROMA_MOBILE_SETUP.md](CHROMA_MOBILE_SETUP.md) for prerequisites, APK generation, installation, permissions and the rebuild cycle.

The Android app uses the native BLE plugin to find devices named **CHROMA**. Both Android and web Bluetooth use the permanent service, DATA and COMMAND identifiers from [src/config/ble.ts](src/config/ble.ts). Android subscribes to DATA notifications before reporting a successful connection. The first native BLE colour protocol uses compact UTF-8 packets: `SCAN,R,G,B,CLEAR`, `REF,R,G,B`, and `CMP,R,G,B,DELTA_E`. Send one complete packet per notification. Scan results use the existing app conversion utilities; comparisons preserve the device-provided Delta E. The Device page retains **Latest BLE data:** for raw debugging, including `CHROMA_TEST`. Disconnect stops notifications and clears the debug display and live comparison reference. Website BLE remains connection-only. Existing USB, Wi-Fi and demo workflows remain available.

Android JSON export opens the system share menu; choose a save/share destination to keep a backup outside the app cache. Saved comparisons retain device-provided Delta E through JSON export/import. The user reports working physical Android/ESP32 BLE Scan and Compare workflows, following verified discovery, connection and raw `CHROMA_TEST` DATA delivery. Convert and matching use the same app on the website and Android. Image-derived colours and saved Library colours now share the existing Image Match workflow; see [LIBRARY_MATCH.md](LIBRARY_MATCH.md) for this revision and its remaining phone checks.

## Included workflows

| Page | Functionality |
| --- | --- |
| Home | Accepted ChromaPod card, latest colour, saved colours and four quick actions |
| Scan | Captured/demo readings, recent scan history, all five formats and capture details, save/share |
| Compare | Digital, digital + scan and physical history workflows, individual swatch editors, shared match/result dial, device-provided or app-calculated Delta E, save/share |
| Convert | HEX/RGB/HSL/LAB/CMYK input, colour wheel, ChromaPod scan, searchable Saved Library selection, large swatch, all five outputs, copy/save/share |
| Image | Upload/camera capture, pixel picker, original-pixel averaging, extracted palettes, Image/Library targets and shared comparison results |
| Colour Library | Names, RGB, HEX, tags, dates, rename/edit, search/filter, Use as Match Target, delete confirmation and JSON import/export |
| Projects | Create/edit/delete, user folders, individual/bulk grouping, colours/comparisons, notes and JSON sharing |
| Device | Device Information and Connection Method, demo/USB/Wi-Fi/Bluetooth LE, disconnect and Android raw BLE preview |

Desktop, tablet and mobile layouts include collapsed mobile navigation, stacked comparisons, visible keyboard focus, Escape support in dialogs, and reduced-motion support.

## Prototype boundaries

- Starts in **Demo mode**. Battery 78% and firmware v1.0 are explicitly labelled mock data. No real hardware connection is invented.
- ESP32 input requires compatible firmware. The user reports working physical Android BLE Scan and Compare. The new Image Match workflow, browser BLE, USB and Wi-Fi still need their hardware checks. In the **website**, use **Connect Bluetooth** with a BLE-capable ESP32 named **CHROMA** advertising the configured service. A secure context (`http://127.0.0.1:8000` locally or HTTPS) and a supported Web Bluetooth browser are required; Bluetooth Classic SPP is not supported. Website BLE remains connection-only. Native Android accepts compact Scan/Compare notifications, but no outgoing BLE command protocol has been defined: Scan and Image Match wait for a physical-device reading. Image Match reuses the existing SCAN packet and calculates its own comparison against an Image or Library target. See [DEVICE_SETUP.md](DEVICE_SETUP.md) for the unchanged wire format and USB/Wi-Fi contract.
- Colour names are approximate. LAB uses D65; CMYK is unprofiled. Material/print accuracy depends on profiles, lighting and calibration.
- Image Match photos stay in browser/app memory and are not uploaded. Visualize also works locally with tap selection and manual editing; choosing the optional SAM 3 mode sends its resized working photo to the configured server only when selecting a surface. Back from an Image Match result returns to its editor with the attachment intact. Leaving Image Match releases the attachment and its image-derived target, so returning asks for another image. The latest matching sample and saved Library targets remain available during the session. Image files and unsaved matching state do not survive a reload. Library and projects use localStorage and support JSON backups.
- Existing v1 colours and collections migrate on the **same browser origin**. Keep using `http://127.0.0.1:8000`; another port, `localhost`, or another browser has separate storage. The legacy key remains intact. Old JSON backups can also be imported.

## Build and verify

```powershell
python scripts/npm.py run build
python scripts/npm.py test
python scripts/check_chroma.py
```

Browser checks require the development server, Chrome and Python's `websocket-client`. They run in an isolated profile and test all eight pages at 1440px, 820px and 390px. Screenshots and results are in `artifacts/`.

The build command checks TypeScript and creates `dist/`. Deploy the **contents of dist** to a static host. `npm run preview` serves the build on http://127.0.0.1:4173. Google Fonts have local system fallbacks; artwork is bundled locally.

## Code map

- `src/pages/`: typed React pages.
- `src/components/`: swatches, metrics, dialogs, OLED and concept visuals.
- `src/state/`: React providers, storage validation and v1 migration.
- `src/services/DeviceService.ts`: typed device abstraction.
- `src/services/NativeBleTransport.ts` / `deviceTransport.ts`: native BLE and platform selection.
- `src/services/libraryExport.ts`: web downloads and native JSON backup sharing.
- `src/config/ble.ts`: shared permanent ESP32 BLE UUIDs, discovery settings and disabled legacy JSON opt-in.
- `src/lib/bleProtocol.ts`: compact native BLE packet validation and existing colour conversion reuse.
- `src/types/deviceProtocol.ts`: typed scan/reference/compare app models and legacy payload validation.
- `capacitor.config.ts` / `android/`: CHROMA's Capacitor configuration and Android project.
- `src/lib/imagePalette.ts`: deterministic local palette extraction.
- `src/lib/convertInput.ts`: Convert-only six-digit HEX validation with the shared colour parser.
- `src/lib/imageSampling.ts` / `imageMatch.ts`: scaled-coordinate mapping, local 3 × 3 sampling and session-only Image/Library target and sample state.
- `color.js` / `color.d.ts`: tested colour maths, re-exported through `src/lib/color.ts`.
- `device.js` / `device.d.ts`: USB, WebSocket and Bluetooth LE transports with mocked device tests.
- `tests/`: colour, storage, image and device tests.

See [REQUIREMENTS_AUDIT.md](REQUIREMENTS_AUDIT.md) for the completed checklist.

See [CONVERT_IMAGE_MATCH.md](CONVERT_IMAGE_MATCH.md) for conversion and image-sampling details. See [LIBRARY_MATCH.md](LIBRARY_MATCH.md) for Library → Use as Match Target, order-independent matching, changed files, current verification and remaining phone tests.
