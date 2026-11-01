"""Verify local Visualize controls in an already-open physical Android WebView.

Requires the current public truck and genuine SAM mask from the physical cloud
report. Attaches passively: no navigation, upload, native picker, camera, export,
HTTP request, mocked transport or GPU submission. Leaves Paint/Daylight, After,
100% intensity and cloud selected by choice only. App storage is never written.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
import urllib.parse
import urllib.request

from verify_real_cloud_sam3_android import (
    PhysicalBrowser, STORAGE_DIGEST_JS, compare_storage, target_hex, capture_canvas,
)
from verify_real_cloud_sam3_ui import (
    ROOT, SPACE, PAGE, CANVAS, OVERLAY, CloudObservedSocket, assert_local_sam_off,
)


class CheckFailure(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckFailure(code)


def idle(browser):
    browser.wait("document.querySelector('.visualize-workspace')?.getAttribute('aria-busy')==='false'&&!document.querySelector('.visualize-progress')", timeout=30)
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def click(browser, label):
    browser.click_text(label, scope=PAGE)
    idle(browser)


SNAPSHOT_JS = r"""(async()=>{
  if(window.__chromaAndroidControls)throw Error('verification snapshot already present');
  const canvas=document.querySelector('#visualize-canvas'),overlay=document.querySelector('.visualize-mask-overlay');
  const bytes=c=>c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  const sha=async(value)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),b=>b.toString(16).padStart(2,'0')).join('');
  const s={original:bytes(canvas).slice(),mask:bytes(overlay).slice(),photoUrl:document.querySelector('.visualize-photo-info img')?.src,
    photoName:document.querySelector('.visualize-photo-info strong')?.textContent,target:document.querySelector('[data-testid=visualize-target] .visualize-target-summary strong')?.textContent};
  s.bytes=bytes;s.sha=sha;
  s.preserved=()=>({photo:document.querySelector('.visualize-photo-info img')?.src===s.photoUrl&&document.querySelector('.visualize-photo-info strong')?.textContent===s.photoName,
    target:document.querySelector('[data-testid=visualize-target] .visualize-target-summary strong')?.textContent===s.target,
    mask:bytes(document.querySelector('.visualize-mask-overlay')).every((v,i)=>v===s.mask[i])});
  s.stats=async()=>{const d=bytes(document.querySelector('#visualize-canvas'));let changed=0,outside=0,alphaChanged=0;
    for(let i=0;i<d.length;i+=4){if(d[i]!==s.original[i]||d[i+1]!==s.original[i+1]||d[i+2]!==s.original[i+2]){changed++;if(!s.mask[i+3])outside++;}if(d[i+3]!==s.original[i+3])alphaChanged++;}
    return{changed,outside,alphaChanged,sha256:await sha(d)};};
  s.intensityExact=n=>{const d=bytes(document.querySelector('#visualize-canvas'));if(n===0)return d.every((v,i)=>v===s.original[i]);if(n===100)return d.every((v,i)=>v===s.full[i]);
    const expected=s.original.slice();for(let i=0;i<expected.length;i++)if(i%4!==3)expected[i]=(s.original[i]+s.full[i])/2;
    return d.every((v,i)=>v===expected[i]);};
  const alpha=new Uint8Array(canvas.width*canvas.height);let count=0;for(let i=0;i<alpha.length;i++){alpha[i]=s.mask[i*4+3]?255:0;if(alpha[i])count++;}
  window.__chromaAndroidControls=s;
  return{width:canvas.width,height:canvas.height,count,mask_sha256:await sha(alpha),original_sha256:await sha(s.original),target:s.target,photo_name:s.photoName};
})()"""


def preserved(browser):
    values = browser.evaluate('window.__chromaAndroidControls.preserved()')
    require(all(values.values()), 'app_photo_mask_or_target_changed')
    return values


def preview_stats(browser):
    stats = browser.evaluate('window.__chromaAndroidControls.stats()')
    require(stats['changed'] > 0, 'app_preview_did_not_recolour_selected_pixels')
    require(stats['outside'] == 0 and stats['alphaChanged'] == 0, 'app_preview_changed_outside_pixels_or_original_alpha')
    preserved(browser)
    return stats


def verify(browser, observer, args, report):
    state = browser.evaluate("({origin:location.origin,platform:window.Capacitor?.getPlatform?.(),native:window.Capacitor?.isNativePlatform?.(),width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visualize:Boolean(" + PAGE + "),editing:Boolean(document.querySelector('.visualize-mask-toolbar')),busy:document.querySelector('.visualize-workspace')?.getAttribute('aria-busy')})")
    require(state['origin'] in ('http://localhost', 'https://localhost') and state['platform'] == 'android' and state['native'] is True,
            'precondition_not_physical_capacitor_android')
    require(state['visualize'] and state['editing'] and state['busy'] == 'false', 'precondition_expected_idle_visualize_editor')
    report['device'] = state
    report['storage_before'] = browser.evaluate(STORAGE_DIGEST_JS)
    require(target_hex(browser) == '#C82A3D', 'precondition_existing_target_mismatch')
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    browser.call('Network.enable')
    report['initial'] = browser.evaluate(SNAPSHOT_JS)
    initial = report['initial']
    baseline = json.loads(args.cloud_report.read_text(encoding='utf-8'))
    require(baseline.get('status') == 'passed' and baseline.get('physical_android_verified') is True,
            'precondition_physical_cloud_evidence_missing')
    require((initial['width'], initial['height'], initial['count']) == (baseline['selection']['width'], baseline['selection']['height'], baseline['selection']['selected_pixels']), 'precondition_existing_sam_mask_geometry_or_count_mismatch')
    require(initial['mask_sha256'] == baseline['selection']['mask_sha256'], 'precondition_existing_sam_mask_hash_mismatch')
    report['checks'].append('Exact genuine physical cloud mask and existing target protected before controls testing.')

    click(browser, 'Apply Colour')
    click(browser, 'After')
    report['materials'] = []
    for material in ('fabric', 'paint', 'wood', 'plastic', 'metal', 'ceramic'):
        selector = f'[data-material="{material}"]'
        browser.click(selector)
        idle(browser)
        require(browser.evaluate(f'document.querySelector({json.dumps(selector)}).getAttribute("aria-pressed")==="true"'), 'app_material_pressed_state_incorrect_' + material)
        require(browser.evaluate("Boolean(document.querySelector('#visualize-intensity'))&&!document.querySelector('.visualize-mask-toolbar')"), 'app_material_discarded_preview_' + material)
        report['materials'].append({'id': material, **preview_stats(browser)})
    require(len({item['sha256'] for item in report['materials']}) >= 3, 'app_material_profiles_did_not_produce_distinct_previews')
    report['checks'].append('All six material buttons rerendered locally; selected-only colour changes, original alpha and exact mask/target preserved.')
    print('PASS: six physical Android material controls and exact outside/alpha/mask preservation.', flush=True)

    browser.click('[data-material="paint"]')
    idle(browser)
    report['lighting'] = []
    for lighting, kelvin in (('daylight', 6500), ('neutral', 4000), ('warm', 2700), ('cool', 8000)):
        selector = f'[data-lighting="{lighting}"]'
        browser.click(selector)
        idle(browser)
        require(browser.evaluate(f'document.querySelector({json.dumps(selector)}).getAttribute("aria-pressed")==="true"'), 'app_lighting_pressed_state_incorrect_' + lighting)
        require(browser.evaluate(f'document.querySelector({json.dumps(selector)}).textContent.includes("{kelvin}K")'), 'app_lighting_kelvin_label_incorrect_' + lighting)
        report['lighting'].append({'id': lighting, 'kelvin': kelvin, **preview_stats(browser)})
    require(len({item['sha256'] for item in report['lighting']}) == 4, 'app_lightshift_presets_did_not_produce_distinct_previews')
    browser.click('[data-lighting="daylight"]')
    idle(browser)
    browser.evaluate("void(window.__chromaAndroidControls.full=window.__chromaAndroidControls.bytes(document.querySelector('#visualize-canvas')).slice())")
    report['checks'].append('All four LightShift buttons, Kelvin labels and distinct previews verified with exact outside/alpha/mask preservation.')

    click(browser, 'Before')
    require(browser.evaluate('window.__chromaAndroidControls.intensityExact(0)'), 'app_before_not_byte_exact_original')
    click(browser, 'After')
    require(browser.evaluate('window.__chromaAndroidControls.intensityExact(100)'), 'app_after_not_byte_exact_full_preview')
    click(browser, 'Slider')
    require(browser.evaluate('window.__chromaAndroidControls.intensityExact(0)'), 'app_slider_base_not_byte_exact_original')
    require(browser.evaluate("window.__chromaAndroidControls.bytes(document.querySelector('#visualize-comparison-canvas')).every((v,i)=>v===window.__chromaAndroidControls.full[i])"), 'app_slider_overlay_not_byte_exact_full_preview')
    report['wipe'] = []
    for position in (0, 50, 100):
        browser.fill('#visualize-wipe', str(position))
        idle(browser)
        split = browser.evaluate("({value:document.querySelector('#visualize-wipe').value,clip:document.querySelector('#visualize-comparison-canvas').style.clipPath,left:document.querySelector('.visualize-comparison-divider').style.left})")
        require(split == {'value': str(position), 'clip': f'inset(0px 0px 0px {position}%)', 'left': f'{position}%'}, 'app_slider_split_position_incorrect_' + str(position))
        report['wipe'].append(split)
        preserved(browser)
    report['checks'].append('Before/After exact pixels and Slider original/preview layers plus 0/50/100% split verified.')

    click(browser, 'After')
    report['intensity'] = []
    for intensity in (0, 50, 100):
        browser.fill('#visualize-intensity', str(intensity))
        idle(browser)
        require(browser.evaluate(f'window.__chromaAndroidControls.intensityExact({intensity})'), 'app_intensity_pixels_not_exact_' + str(intensity))
        require(browser.evaluate(f'document.querySelector("#visualize-intensity").value==="{intensity}"'), 'app_intensity_input_incorrect_' + str(intensity))
        report['intensity'].append({'percent': intensity, 'pixel_behavior_exact': True})
        preserved(browser)
    report['checks'].append('0/50/100% intensity produced exact original, Uint8Clamped rounded midpoint and full preview pixels.')
    print('PASS: four lighting controls, preview modes, split positions and exact intensity pixels.', flush=True)

    click(browser, 'Edit Selection')
    require(browser.evaluate("Boolean(document.querySelector('.visualize-mask-toolbar'))"), 'app_edit_selection_did_not_open')
    preserved(browser)
    browser.fill('#visualize-selection-engine', 'cloud')  # Choice only; never tap the photo.
    idle(browser)
    click(browser, 'Back to Preview')
    require(browser.evaluate('window.__chromaAndroidControls.intensityExact(100)'), 'app_edit_preview_roundtrip_changed_pixels')
    require(browser.evaluate("document.querySelector('.visualize-view-tabs button[aria-pressed=true]')?.textContent==='After'&&document.querySelector('#visualize-intensity').value==='100'&&document.querySelector('[data-material=paint]').getAttribute('aria-pressed')==='true'&&document.querySelector('[data-lighting=daylight]').getAttribute('aria-pressed')==='true'"), 'app_final_preview_settings_incorrect')
    report['final_preservation'] = preserved(browser)
    require(not observer.jobs and not observer.local_sam_calls and not observer.credential_headers and not observer.unexpected_segment_origins,
            'app_controls_submitted_unexpected_cloud_or_local_job')
    require(not browser.errors, 'app_physical_webview_runtime_error')
    report['checks'].append('Edit Selection/Back to Preview preserved exact cloud mask, photo, target and preview; cloud engine restored by choice only.')
    report['screenshots'].append(capture_canvas(browser, args.output / 'actual-physical-controls-preview.png'))
    report['final'] = {'material': 'paint', 'lighting': 'daylight', 'view': 'After', 'intensity': 100, 'selection_engine': 'cloud', 'mask_selected_pixels': 45709}
    report['status'] = 'passed'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cdp-port', type=int, default=9240)
    parser.add_argument('--cloud-report', type=Path, default=ROOT / 'artifacts/real-cloud-sam3-physical-android/2026-10-11-cloud/physical-android-verification.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/real-cloud-sam3-physical-android/2026-10-11-controls')
    args = parser.parse_args()
    if not 1 <= args.cdp_port <= 65535:
        parser.error('Use the existing forwarded local CDP port.')
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'status': 'failed', 'scope': 'physical Android synchronous local Visualize controls', 'space': SPACE,
              'mocked_transport': False, 'gpu_requested': False, 'checks': [], 'screenshots': []}
    browser = observer = None
    started = time.monotonic()
    try:
        assert_local_sam_off(8001)
        with urllib.request.urlopen(f'http://127.0.0.1:{args.cdp_port}/json/list', timeout=5) as response:
            targets = json.load(response)
        targets = [target for target in targets if target.get('type') == 'page' and urllib.parse.urlsplit(target.get('url', '')).hostname == 'localhost']
        require(len(targets) == 1, 'precondition_physical_webview_target_ambiguous_or_missing')
        target_url = urllib.parse.urlsplit(targets[0]['webSocketDebuggerUrl'])
        require(target_url.scheme == 'ws' and target_url.hostname in ('127.0.0.1', 'localhost') and target_url.port == args.cdp_port,
                'precondition_forwarded_webview_debugger_url_invalid')
        browser = PhysicalBrowser(targets[0]['webSocketDebuggerUrl'])
        observer = CloudObservedSocket(browser.socket)
        browser.socket = observer
        verify(browser, observer, args, report)
    except CheckFailure as error:
        code = str(error)
        report.update(error_code=code, failure_kind='precondition' if code.startswith('precondition_') else 'observed_app_behavior')
    except Exception as error:
        report.update(error_code='controls_observer_or_harness_failure', failure_kind='observer_or_harness', exception_class=type(error).__name__)
        if browser:
            report['last_command'] = browser.last_command
    finally:
        if browser:
            try:
                if 'storage_before' in report:
                    report['storage_after'] = browser.evaluate(STORAGE_DIGEST_JS)
                    report['preservation'] = compare_storage(report['storage_before'], report['storage_after'])
                    if not all(report['preservation'].values()):
                        report.update(status='failed', error_code='observed_storage_changed_during_controls', failure_kind='observed_app_behavior_or_concurrent_real_reading')
                browser.evaluate('delete window.__chromaAndroidControls')
            except Exception as error:
                report.update(status='failed', error_code='controls_storage_verification_or_detach_failure', failure_kind='observer_or_harness', exception_class=type(error).__name__)
            browser.socket.close()  # Never close/navigate/reload the page or native app.
        if observer:
            report.update(submitted_jobs=len(observer.jobs), local_sam_requests=observer.local_sam_calls, authorization_headers=observer.credential_headers)
        if browser:
            report['webview_error_count'] = len(browser.errors)
        report['wall_seconds'] = round(time.monotonic() - started, 3)
        (args.output / 'physical-android-controls-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
