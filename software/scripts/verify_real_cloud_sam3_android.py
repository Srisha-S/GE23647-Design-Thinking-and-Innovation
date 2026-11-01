"""Attach to an already-forwarded physical CHROMA Android WebView.

Root must open Visualize, stop local SAM and supply the official truck on the
phone first. This helper does not install/start apps, run ADB, navigate/reload,
emulate a device, clear/seed storage, inject photos, or close the native app.
Default checks use the real device photo, HTTPS no-GPU health, Manual/on-device
selection, recolouring and Undo. Only explicit --segment submits one actual
public Gradio GPU job. Do not use --segment while anonymous quota is exhausted.

  python scripts/verify_real_cloud_sam3_android.py --self-test
  python scripts/verify_real_cloud_sam3_android.py --cdp-port 9240
  python scripts/verify_real_cloud_sam3_android.py --cdp-port 9240 --segment

Use --native-picker on Android WebViews that cannot attach device files with
DOM.setFileInputFiles. The helper opens Choose Photo and waits for selection in
the real Android picker; it still validates the actual File bytes before use.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import time
import urllib.parse
import urllib.request

import websocket
from verify_real_cloud_sam3_ui import (
    ROOT, SPACE, SPACE_ORIGIN, TRUCK_SHA256, PAGE, CANVAS, OVERLAY,
    CloudObservedSocket, ObservedBrowser, assert_local_sam_off, pointer,
    settled, click_text, validate_actual_mask, mask_summary,
    grayscale_png, background_point, exact_sam_overlay_restored,
)


class SafeFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise SafeFailure(code)


class PhysicalBrowser(ObservedBrowser):
    def __init__(self, socket_url):
        self.socket = websocket.create_connection(socket_url, suppress_origin=True, timeout=15)
        self.sequence, self.errors, self.last_command = 0, [], 'Physical WebView attached'


STORAGE_DIGEST_JS = r"""(async()=>{
  const sha=async(value)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
  const pairs=store=>Object.keys(store).sort().map(key=>[key,store.getItem(key)]);
  const local=pairs(localStorage),session=pairs(sessionStorage);
  const w=JSON.parse(localStorage.getItem('chroma-workspace-v2')||'{}');
  const history=[...local.map(pair=>['local',...pair]),...session.map(pair=>['session',...pair])].filter(pair=>pair[1].startsWith('gradio:run-history'));
  return {local_key_count:local.length,session_key_count:session.length,
    local_sha256:await sha(JSON.stringify(local)),session_sha256:await sha(JSON.stringify(session)),
    library_count:(w.library||[]).length,library_sha256:await sha(JSON.stringify(w.library||[])),
    projects_count:(w.projects||[]).length,projects_sha256:await sha(JSON.stringify(w.projects||[])),
    history_key_count:history.length,history_sha256:await sha(JSON.stringify(history))};
})()"""


def compare_storage(before, after):
    return {'full_local_storage_preserved': before['local_sha256'] == after['local_sha256'],
            'full_session_storage_preserved': before['session_sha256'] == after['session_sha256'],
            'library_preserved': before['library_sha256'] == after['library_sha256'],
            'projects_preserved': before['projects_sha256'] == after['projects_sha256'],
            'existing_gradio_history_preserved': before['history_sha256'] == after['history_sha256']}


def target_hex(browser):
    return browser.evaluate("document.querySelector('[data-testid=visualize-target] .visualize-target-summary strong')?.textContent?.match(/^#[0-9a-f]{6}$/i)?.[0]?.toUpperCase()||null")


def choose_existing_target(browser):
    if not browser.evaluate("Boolean(document.querySelector('.visualize-colour-chooser'))"):
        click_text(browser, 'Change Colour')
    click_text(browser, 'Library')
    library = browser.state().get('library', [])
    chosen = bool(library) and browser.evaluate("Boolean(document.querySelector('#visualize-library-colour')&&!document.querySelector('#visualize-library-colour').disabled)")
    if chosen:
        colour = next((entry for entry in library if entry['hex'].upper() not in ('#000000', '#FFFFFF')), library[0])
        browser.fill('#visualize-library-colour', colour['id'])
    if not chosen:
        click_text(browser, 'Latest Scan')
        available = browser.evaluate("Array.from(" + PAGE + ".querySelectorAll('button')).some(b=>b.textContent.trim()==='Use scan'&&!b.disabled)")
        require(available, 'no_existing_library_or_latest_scan_target')
        click_text(browser, 'Use scan')
    browser.wait("document.querySelector('[data-testid=visualize-target]')", timeout=5)
    value = target_hex(browser)
    require(value is not None, 'existing_target_hex_unavailable')
    return value


def stream_support(browser):
    try:
        browser.call('Network.streamResourceContent', {'requestId': 'chroma-method-only-probe-no-http'})
    except RuntimeError as error:
        message = str(error)
        require('-32601' not in message and 'wasn\'t found' not in message and 'Method not found' not in message,
                'physical_webview_stream_observation_unsupported_no_job')
        require(any(marker in message.lower() for marker in ('resource', 'request', '-32602', 'identifier')),
                'physical_webview_stream_probe_inconclusive_no_job')


def configured_production_space(browser):
    result = browser.evaluate("""(async()=>{
      const names=[...Array.from(document.scripts,s=>s.src),...performance.getEntriesByType('resource').filter(r=>r.initiatorType==='script').map(r=>r.name)];
      const urls=[...new Set(names)].filter(name=>{try{const u=new URL(name);return u.origin===location.origin&&u.pathname.endsWith('.js');}catch{return false;}}).slice(0,40);
      let bytes=0;for(const url of urls){const response=await fetch(url);if(!response.ok)continue;const text=await response.text();bytes+=text.length;if(bytes>16000000)throw Error('asset bound');
        if(text.includes(""" + json.dumps(SPACE) + ")||text.includes(" + json.dumps(SPACE_ORIGIN) + """))return true;}
      return false;
    })()""")
    require(result, 'installed_production_space_configuration_missing_no_job')


def upload_device_fixture(browser, path, native_picker=False):
    browser.evaluate(r"""(()=>{
      const input=document.querySelector('#visualize-photo-input');
      if(!input)throw Error('input missing');
      window.__chromaPhysicalFixtureHash=null;
      window.__chromaPhysicalFixtureListener=()=>{
        const file=input.files?.[0];
        window.__chromaPhysicalFixtureHash=file?file.arrayBuffer().then(bytes=>crypto.subtle.digest('SHA-256',bytes)).then(bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('')):Promise.resolve(null);
      };
      input.addEventListener('change',window.__chromaPhysicalFixtureListener,{capture:true,once:true});
    })()""")
    try:
        if native_picker:
            # A genuine touch gives WebView the user activation required for
            # its file chooser; HTMLElement.click() cannot open it here.
            point = browser.evaluate("(()=>{const b=Array.from(" + PAGE + ".querySelectorAll('button')).find(b=>b.textContent.trim()==='Choose Photo');if(!b)throw Error('photo button missing');b.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()")
            browser.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': point['x'], 'y': point['y'], 'id': 1}]})
            browser.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            print('Waiting for the official truck fixture in the native Android photo picker.', flush=True)
            browser.wait('window.__chromaPhysicalFixtureHash!==null', timeout=150)
        else:
            document = browser.call('DOM.getDocument')
            node = browser.call('DOM.querySelector', {'nodeId': document['root']['nodeId'], 'selector': '#visualize-photo-input'})
            browser.call('DOM.setFileInputFiles', {'nodeId': node['nodeId'], 'files': [path]})
        file_hash = browser.evaluate('window.__chromaPhysicalFixtureHash')
        require(file_hash == TRUCK_SHA256, 'android_official_fixture_hash_unavailable_or_mismatch_no_job')
        browser.wait(CANVAS + '?.width===1200&&' + CANVAS + '?.height===800', timeout=15)
        settled(browser)
    except SafeFailure:
        raise
    except Exception:
        raise SafeFailure('android_file_upload_unavailable_no_job_use_accessible_device_path') from None
    finally:
        browser.evaluate("(()=>{const i=document.querySelector('#visualize-photo-input');if(i&&window.__chromaPhysicalFixtureListener)i.removeEventListener('change',window.__chromaPhysicalFixtureListener,true);delete window.__chromaPhysicalFixtureListener;delete window.__chromaPhysicalFixtureHash;})()")


def capture_canvas(browser, destination):
    browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
    clip = browser.evaluate("(()=>{const r=" + CANVAS + ".getBoundingClientRect();return{x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1};})()")
    shot = browser.call('Page.captureScreenshot', {'format': 'png', 'clip': clip, 'captureBeyondViewport': True})
    destination.write_bytes(base64.b64decode(shot['data']))
    return str(destination)


def no_gpu_health(browser):
    health = browser.evaluate("""(async()=>{const response=await fetch(""" + json.dumps(SPACE_ORIGIN + '/gradio_api/run/health') + """,{
      method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:[]})});
      const data=await response.json();const h=data?.data?.[0];
      return{http_status:response.status,ready:h?.ready,provider:h?.provider,model:h?.model,version:h?.version};})()""")
    require(health.get('http_status') == 200 and health.get('ready') is True
            and health.get('provider') == 'huggingface-zerogpu' and health.get('model') == 'sam3', 'physical_https_no_gpu_health_invalid')
    return {**health, 'gpu_requested': False}


def local_controls(browser, args, report):
    """No cloud tap: create a real Manual mask and exercise existing UI paths."""
    click_text(browser, 'Brush')
    browser.fill('#visualize-brush-size', '28')
    pointer(browser, (.611111, .4666667), (.631111, .4666667), mobile=True)
    settled(browser)
    manual = mask_summary(browser)
    require(manual['count'] > 0, 'physical_manual_selection_did_not_operate')
    browser.evaluate('void(window.__realSamOverlay=' + OVERLAY + ".getContext('2d').getImageData(0,0,1200,800).data.slice())")
    click_text(browser, 'Apply Colour')
    click_text(browser, 'After')
    preview = browser.evaluate("""(()=>{const c=document.querySelector('#visualize-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let changed=0,outside=0,alphaChanged=0;for(let i=0;i<d.length;i+=4){if(d[i]!==window.__realSamOriginal[i]||d[i+1]!==window.__realSamOriginal[i+1]||d[i+2]!==window.__realSamOriginal[i+2]){changed++;if(!window.__realSamOverlay[i+3])outside++;}if(d[i+3]!==window.__realSamOriginal[i+3])alphaChanged++;}return{changed,outside,alphaChanged};})()""")
    require(preview['changed'] > 0 and preview['outside'] == 0 and preview['alphaChanged'] == 0, 'physical_local_recolour_changed_unselected_pixels')
    report['preview'] = preview
    report['screenshots'].append(capture_canvas(browser, args.output / 'actual-physical-local-preview.png'))
    click_text(browser, 'Edit Selection')
    click_text(browser, 'Brush')
    pointer(browser, (.1, .1), (.12, .1), mobile=True)
    settled(browser)
    require(mask_summary(browser)['count'] > manual['count'], 'physical_manual_refinement_did_not_operate')
    click_text(browser, 'Undo')
    require(mask_summary(browser) == manual and exact_sam_overlay_restored(browser), 'physical_manual_undo_not_exact')
    click_text(browser, 'Auto Select')
    browser.fill('#visualize-selection-engine', 'local')
    pointer(browser, (.1, .1), mobile=True)
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Local region selected')", timeout=15)
    settled(browser)
    require(mask_summary(browser)['count'] > 0 and mask_summary(browser) != manual, 'physical_on_device_selection_did_not_operate')
    click_text(browser, 'Undo')
    require(mask_summary(browser) == manual and exact_sam_overlay_restored(browser), 'physical_local_undo_not_exact')
    require(target_hex(browser) == report['target_hex'], 'physical_target_colour_changed')
    browser.fill('#visualize-selection-engine', 'cloud')  # Choice only; never tap cloud in local-only mode.
    report.update(status='passed', manual_undo_exact=True, local_undo_exact=True, manual_selected_pixels=manual['count'])


def verify(browser, observer, args, report):
    page = browser.evaluate("({origin:location.origin,platform:window.Capacitor?.getPlatform?.(),native:window.Capacitor?.isNativePlatform?.(),width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visualize:Boolean(" + PAGE + "),unsaved:Boolean(" + CANVAS + "?.width),busy:Boolean(document.querySelector('.visualize-progress'))})")
    require(page['origin'] in ('http://localhost', 'https://localhost') and page.get('platform') == 'android' and page.get('native') is True,
            'target_is_not_physical_capacitor_android_webview')
    require(not page['unsaved'], 'existing_unsaved_visualize_photo_protected_no_job')
    require(page['visualize'] and not page['busy'], 'open_idle_visualize_page_before_verification_no_job')
    report['device'] = {key: page[key] for key in ('origin', 'platform', 'native', 'width', 'height', 'dpr')}
    report['storage_before'] = browser.evaluate(STORAGE_DIGEST_JS)
    report['excluded_storage_keys'] = []  # Route is a URL hash; this app stores no route/ephemeral keys.
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    browser.call('Network.enable', {'maxTotalBufferSize': 32_000_000, 'maxResourceBufferSize': 12_000_000, 'maxPostDataSize': 12_000_000})
    browser.chroma_observation_started = True
    browser.call('Network.setCacheDisabled', {'cacheDisabled': True})
    browser.call('Network.setBypassServiceWorker', {'bypass': True})
    if args.segment:
        stream_support(browser)
    configured_production_space(browser)
    report['https_health'] = no_gpu_health(browser)
    report['target_hex'] = choose_existing_target(browser)
    upload_device_fixture(browser, args.android_photo, native_picker=args.native_picker)
    report['photo_upload_method'] = 'native Android photo picker' if args.native_picker else 'CDP device file attachment'
    report['photo_sha256'] = TRUCK_SHA256
    require(browser.evaluate("document.querySelector('#visualize-selection-engine')?.dataset.value==='cloud'") and 'sam3' not in browser.picker_values('#visualize-selection-engine'),
            'installed_ui_is_not_production_cloud_auto_select_no_job')
    browser.fill('#visualize-selection-mode', 'replace')
    browser.evaluate('void(window.__realSamOriginal=' + CANVAS + ".getContext('2d').getImageData(0,0,1200,800).data.slice())")
    browser.chroma_public_fixture_globals = True
    if not args.segment:
        local_controls(browser, args, report)
        require(not observer.jobs and observer.local_sam_calls == 0 and observer.credential_headers == 0,
                'local_only_mode_unexpected_gpu_or_local_provider_request')
        return
    started = time.monotonic()
    report['attempted_real_inference'] = True
    pointer(browser, (.611111, .4666667), mobile=True)
    deadline = started + args.timeout
    while time.monotonic() < deadline:
        status = browser.evaluate("({error:Boolean(" + PAGE + ".querySelector('[role=alert]')),ready:document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Surface selected'),busy:Boolean(document.querySelector('.visualize-progress'))})")
        require(not status['error'], 'physical_cloud_selection_failed_safe_ui_error')
        if status.get('ready') and not status['busy']:
            break
        time.sleep(.08)
    else:
        raise SafeFailure('physical_cloud_selection_180_second_deadline')
    settled(browser)
    require(len(observer.jobs) == 1 and observer.config and observer.info, 'physical_named_queue_job_metadata_missing')
    dependency = next((item for item in observer.config.get('dependencies', []) if str(item.get('api_name', '')).lstrip('/') == 'segment'), None)
    require(dependency and '/segment' in observer.info.get('named_endpoints', {}), 'physical_named_segment_api_missing')
    job = observer.jobs[0]
    require(job.get('finished') and job.get('status') == 200 and job.get('event_id'), 'physical_queue_join_not_successful')
    payload = job['payload']
    require(payload.get('fn_index') == dependency['id'] and len(payload.get('data', [])) == 1, 'physical_named_segment_dependency_mismatch')
    request = payload['data'][0]
    require((request.get('width'), request.get('height')) == (1200, 800) and len(request.get('points', [])) == 1, 'physical_photo_request_geometry_mismatch')
    require(request.get('image', '').startswith('data:image/png;base64,'), 'physical_photo_request_not_working_png')
    point = request['points'][0]
    require(point.get('label') == 1 and abs(point['x'] - .611111 * 1200) < 1 and abs(point['y'] - .4666667 * 800) < 1, 'physical_touch_working_coordinates_mismatch')
    complete = observer.completed.get(job['event_id'])
    require(complete and complete.get('success') is True, 'physical_real_stream_completion_missing')
    outputs = complete.get('output', {}).get('data')
    require(isinstance(outputs, list) and len(outputs) == 1, 'physical_real_stream_output_invalid')
    alpha, count = validate_actual_mask(outputs[0], 1200, 800, point)
    sam_mask = mask_summary(browser)
    require((sam_mask['width'], sam_mask['height'], sam_mask['count'], sam_mask['sum']) == (1200, 800, count, count * 122), 'physical_returned_mask_overlay_mismatch')
    rendered = browser.evaluate("(()=>{const d=" + OVERLAY + ".getContext('2d').getImageData(0,0,1200,800).data;let raw='';for(let i=3;i<d.length;i+=4)raw+=String.fromCharCode(d[i]?255:0);return btoa(raw);})()")
    require(base64.b64decode(rendered) == alpha, 'physical_returned_mask_every_pixel_mismatch')
    browser.evaluate('void(window.__realSamOverlay=' + OVERLAY + ".getContext('2d').getImageData(0,0,1200,800).data.slice())")
    (args.output / 'actual-physical-mask.png').write_bytes(grayscale_png(1200, 800, alpha))
    report['real_inference'] = True
    report['selection'] = {'wall_seconds': round(time.monotonic() - started, 3), 'width': 1200, 'height': 800, 'score': outputs[0]['score'],
                           'selected_pixels': count, 'mask_bytes': len(alpha), 'mask_sha256': hashlib.sha256(alpha).hexdigest(),
                           'point': point, 'named_api': '/segment', 'queue_status': 200, 'every_overlay_pixel_verified': True}
    report['screenshots'].append(capture_canvas(browser, args.output / 'actual-physical-selection.png'))
    click_text(browser, 'Apply Colour')
    click_text(browser, 'After')
    preview = browser.evaluate("""(()=>{const c=document.querySelector('#visualize-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let changed=0,outside=0,alphaChanged=0;for(let i=0;i<d.length;i+=4){if(d[i]!==window.__realSamOriginal[i]||d[i+1]!==window.__realSamOriginal[i+1]||d[i+2]!==window.__realSamOriginal[i+2]){changed++;if(!window.__realSamOverlay[i+3])outside++;}if(d[i+3]!==window.__realSamOriginal[i+3])alphaChanged++;}return{changed,outside,alphaChanged};})()""")
    require(preview['changed'] > 0 and preview['outside'] == 0 and preview['alphaChanged'] == 0, 'physical_recolour_changed_unselected_pixels')
    report['preview'] = preview
    report['screenshots'].append(capture_canvas(browser, args.output / 'actual-physical-preview.png'))
    click_text(browser, 'Edit Selection')
    click_text(browser, 'Brush')
    browser.fill('#visualize-brush-size', '12')
    background = background_point(alpha, 1200, 800)
    pointer(browser, background, (min(.999, background[0] + .02), background[1]), mobile=True)
    settled(browser)
    require(mask_summary(browser)['count'] > count, 'physical_manual_brush_did_not_refine')
    click_text(browser, 'Undo')
    require(mask_summary(browser) == sam_mask and exact_sam_overlay_restored(browser), 'physical_manual_undo_not_exact')
    click_text(browser, 'Auto Select')
    browser.fill('#visualize-selection-engine', 'local')
    pointer(browser, background, mobile=True)
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Local region selected')", timeout=15)
    settled(browser)
    require(mask_summary(browser) != sam_mask, 'physical_on_device_selection_did_not_operate')
    click_text(browser, 'Undo')
    require(mask_summary(browser) == sam_mask and exact_sam_overlay_restored(browser), 'physical_local_undo_not_exact')
    require(target_hex(browser) == report['target_hex'], 'physical_target_colour_changed')
    require(len(observer.jobs) == 1 and observer.local_sam_calls == 0 and observer.credential_headers == 0 and not observer.unexpected_segment_origins,
            'physical_extra_job_local_provider_or_authorization_detected')
    report.update(submitted_jobs=1, local_sam_requests=0, authorization_headers=0, manual_undo_exact=True, local_undo_exact=True)
    require(not browser.errors, 'physical_webview_runtime_error')
    report['status'] = 'passed'


def self_test():
    before = {key: 'same' for key in ('local_sha256', 'session_sha256', 'library_sha256', 'projects_sha256', 'history_sha256')}
    assert all(compare_storage(before, dict(before)).values())
    after = {**before, 'library_sha256': 'changed', 'local_sha256': 'changed'}
    compared = compare_storage(before, after)
    assert not compared['library_preserved'] and not compared['full_local_storage_preserved'] and compared['existing_gradio_history_preserved']
    assert 'localStorage.clear' not in STORAGE_DIGEST_JS and 'setItem' not in STORAGE_DIGEST_JS
    class Probe:
        def call(self, *_args):
            raise RuntimeError("Network.streamResourceContent: {'code': -32602, 'message': 'No resource with given identifier found'}")
    stream_support(Probe())
    class Unsupported:
        def call(self, *_args):
            raise RuntimeError("{'code': -32601, 'message': 'Method not found'}")
    try:
        stream_support(Unsupported())
    except SafeFailure:
        pass
    else:
        raise AssertionError('Unsupported CDP capture was accepted.')
    class Health:
        def __init__(self, ready):
            self.ready = ready
        def evaluate(self, _expression):
            return {'http_status': 200, 'ready': self.ready, 'provider': 'huggingface-zerogpu', 'model': 'sam3'}
    assert no_gpu_health(Health(True))['ready'] is True
    for unavailable in (False, None, 1, 'true'):
        try:
            no_gpu_health(Health(unavailable))
        except SafeFailure:
            pass
        else:
            raise AssertionError('Unready/invalid health must stop before a GPU job.')
    print('PASS: offline physical attachment/storage/stream-support contracts; no device, HTTP or inference calls.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--segment', action='store_true', help='Explicitly submit one real cloud GPU job; avoid while quota is exhausted.')
    mode.add_argument('--local-checks-only', action='store_true', help='Default: photo, HTTPS no-GPU health, Manual/local, recolour and Undo only.')
    parser.add_argument('--cdp-port', type=int, default=9240)
    parser.add_argument('--android-photo', default='/sdcard/Download/chroma-sam3-truck-verification.jpg')
    parser.add_argument('--native-picker', action='store_true', help='Open the genuine Android picker and wait for the official fixture; never inject photo bytes.')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/real-cloud-sam3-physical-android')
    parser.add_argument('--timeout', type=float, default=180)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not 1 <= args.cdp_port <= 65535 or not 0 < args.timeout <= 180 or not args.android_photo.startswith('/sdcard/'):
        parser.error('Use an already-forwarded CDP port, /sdcard/ photo path, and timeout at most 180 seconds.')
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'status': 'failed', 'physical_android_verified': False, 'real_inference': False, 'attempted_real_inference': False,
              'physical_local_checks_verified': False, 'inference_requested': args.segment,
              'validation_scope': 'real-cloud-selection' if args.segment else 'local-controls-and-https-health',
              'mocked_transport': False, 'space': SPACE, 'input_method': 'automated CDP touch in physical Android WebView', 'screenshots': []}
    browser = observer = None
    try:
        assert_local_sam_off(8001)
        with urllib.request.urlopen(f'http://127.0.0.1:{args.cdp_port}/json/list', timeout=5) as response:
            targets = json.load(response)
        targets = [target for target in targets if target.get('type') == 'page' and urllib.parse.urlsplit(target.get('url', '')).hostname == 'localhost']
        require(len(targets) == 1, 'physical_chroma_webview_target_ambiguous_or_missing')
        target_url = urllib.parse.urlsplit(targets[0]['webSocketDebuggerUrl'])
        require(target_url.scheme == 'ws' and target_url.hostname in ('127.0.0.1', 'localhost') and target_url.port == args.cdp_port,
                'forwarded_webview_debugger_url_invalid')
        browser = PhysicalBrowser(targets[0]['webSocketDebuggerUrl'])
        observer = CloudObservedSocket(browser.socket)
        browser.socket = observer
        verify(browser, observer, args, report)
    except SafeFailure as error:
        report.update(status='failed', error_code=str(error))
    except Exception:
        report.update(status='failed', error_code='physical_verification_failed_safe_diagnostics')
    finally:
        if browser:
            try:
                if report['status'] != 'passed' and report['attempted_real_inference']:
                    browser.evaluate("Array.from(" + PAGE + ".querySelectorAll('button')).find(b=>b.textContent.trim()==='Cancel')?.click()")
                if 'storage_before' in report:
                    report['storage_after'] = browser.evaluate(STORAGE_DIGEST_JS)
                    report['preservation'] = compare_storage(report['storage_before'], report['storage_after'])
                    if not all(report['preservation'].values()):
                        report.update(status='failed', error_code='physical_existing_storage_changed')
                if getattr(browser, 'chroma_public_fixture_globals', False):
                    browser.evaluate('delete window.__realSamOriginal;delete window.__realSamOverlay')
                if getattr(browser, 'chroma_observation_started', False):
                    browser.call('Network.setCacheDisabled', {'cacheDisabled': False})
                    browser.call('Network.setBypassServiceWorker', {'bypass': False})
            except Exception:
                report.update(status='failed', error_code='physical_storage_verification_or_detach_failed')
            browser.socket.close()  # Never Browser.close, Page.close or app termination.
        if observer:
            report['submitted_jobs'] = len(observer.jobs)
            report['local_sam_requests'] = observer.local_sam_calls
            report['authorization_headers'] = observer.credential_headers
        report['physical_android_verified'] = report['status'] == 'passed' and args.segment
        report['physical_local_checks_verified'] = report['status'] == 'passed' and not args.segment
        report['note'] = 'Local-only checks do not establish physical cloud SAM 3 acceptance. Anonymous GPU quota must be available before an explicit --segment run.'
        (args.output / 'physical-android-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
