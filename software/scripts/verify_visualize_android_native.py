"""Verify native cancel/export/back paths using the already-tested public photo.

No capture, share destination, GPU job, app reload or persisted-data mutation.
Requires an authorized phone, forwarded CHROMA WebView on 9240 and the real
SAM truck preview left by verify_visualize_android_controls.py.
"""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.request

from PIL import Image
from verify_real_cloud_sam3_android import PhysicalBrowser, STORAGE_DIGEST_JS, compare_storage, require
from verify_real_cloud_sam3_ui import CloudObservedSocket, PAGE, mask_summary, settled

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/real-cloud-sam3-physical-android/2026-10-11-native'
ADB = Path(os.environ['LOCALAPPDATA']) / 'Android/Sdk/platform-tools/adb.exe'


def adb(*args):
    return subprocess.check_output([str(ADB), *args])


def focus():
    text = adb('shell', 'dumpsys', 'window').decode('utf-8', errors='replace')
    line = next((line for line in text.splitlines() if 'mCurrentFocus=' in line), '')
    match = re.search(r'u0 ([\w.$]+/[\w.$]+)', line)
    return match.group(1) if match else None


def await_native():
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        current = focus()
        if current and not current.startswith('com.chroma.app/'):
            return current
        time.sleep(.15)
    raise AssertionError('Native activity did not open.')


def cancel_native():
    for _ in range(3):
        if (focus() or '').startswith('com.chroma.app/'):
            return
        adb('shell', 'input', 'keyevent', '4')
        time.sleep(.4)
    assert (focus() or '').startswith('com.chroma.app/'), 'Native cancellation did not return to CHROMA.'


def touch(browser, expression):
    point = browser.evaluate("(()=>{const b=" + expression + ";if(!b||b.disabled)throw Error('Unavailable test control');b.scrollIntoView({block:'center',behavior:'instant'});const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()")
    browser.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{**point, 'id': 1}]})
    browser.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def button(label):
    return 'Array.from(' + PAGE + '.querySelectorAll("button")).find(b=>b.textContent.trim()===' + json.dumps(label) + ')'


SNAPSHOT = """(async()=>{
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 const canvasHash=async selector=>{const c=document.querySelector(selector);return c?digest(c.getContext('2d').getImageData(0,0,c.width,c.height).data):null;};
 return{photo:document.querySelector('.visualize-photo-info img')?.src,name:document.querySelector('.visualize-photo-info strong')?.textContent,
   canvas:await canvasHash('#visualize-canvas'),mask:await canvasHash('.visualize-mask-overlay'),
   target:document.querySelector('[data-testid=visualize-target] .visualize-target-summary strong')?.textContent,
   material:document.querySelector('[data-material][aria-pressed=true]')?.dataset.material,
   lighting:document.querySelector('[data-lighting][aria-pressed=true]')?.dataset.lighting,
   intensity:document.querySelector('#visualize-intensity')?.value,
   view:document.querySelector('.visualize-view-tabs [aria-pressed=true]')?.textContent};
})()"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'status': 'failed', 'gpu_jobs': 0, 'native_camera_capture_verified': False, 'share_destination_selected': False}
    browser = None
    native_open = False
    try:
        with urllib.request.urlopen('http://127.0.0.1:9240/json/list') as response:
            targets = json.load(response)
        targets = [target for target in targets if target.get('type') == 'page' and target.get('url', '').startswith('http://localhost/')]
        require(len(targets) == 1, 'ambiguous_physical_webview')
        browser = PhysicalBrowser(targets[0]['webSocketDebuggerUrl'])
        require((focus() or '').startswith('com.chroma.app/'), 'open_chroma_before_testing')
        observer = CloudObservedSocket(browser.socket)
        browser.socket = observer
        browser.call('Runtime.enable'); browser.call('Log.enable'); browser.call('Network.enable')
        require(browser.evaluate("window.Capacitor?.getPlatform?.()==='android'&&window.Capacitor?.isNativePlatform?.()"), 'not_native_android')
        cloud = json.loads((ROOT / 'artifacts/real-cloud-sam3-physical-android/physical-android-verification.json').read_text(encoding='utf-8'))
        require(cloud.get('physical_android_verified') is True and cloud.get('status') == 'passed', 'genuine_cloud_evidence_missing')
        require(mask_summary(browser)['count'] == cloud['selection']['selected_pixels'], 'expected_test_mask_missing')
        mask_hash = browser.evaluate("(async()=>{const c=document.querySelector('.visualize-mask-overlay'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,a=new Uint8Array(c.width*c.height);for(let i=0;i<a.length;i++)a[i]=d[i*4+3]?255:0;return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',a)),v=>v.toString(16).padStart(2,'0')).join('');})()")
        require(mask_hash == cloud['selection']['mask_sha256'], 'expected_genuine_cloud_mask_mismatch')
        before = browser.evaluate(SNAPSHOT)
        require(before['name'] == 'chroma-sam3-truck-verification.jpg' and before['target'] == '#C82A3D', 'public_test_photo_or_target_missing')
        require(before['canvas'] and before['mask'] and before['view'] == 'After', 'expected_preview_missing')
        report['storage_before'] = browser.evaluate(STORAGE_DIGEST_JS)
        for label, key in [('Replace Photo', 'photo_picker_cancel'), ('Camera', 'camera_intent_cancel')]:
            touch(browser, button(label))
            activity = await_native()
            native_open = True
            print(label + ': native activity opened; cancelling.', flush=True)
            cancel_native(); native_open = False; settled(browser)
            require(browser.evaluate(SNAPSHOT) == before, 'editor_changed_on_' + key)
            report[key] = {'opened_activity': activity, 'editor_preserved': True}
            if label == 'Camera':
                require('camera' in activity.lower() and 'photopicker' not in activity.lower(), 'camera_opens_file_picker_instead_of_capture')

        previous = set(adb('shell', 'run-as', 'com.chroma.app', 'find', 'cache', '-maxdepth', '2', '-type', 'f', '-name', 'chroma-visualize-*.png').decode().splitlines())
        touch(browser, button('Save Preview'))
        activity = await_native()
        native_open = True
        require('ChooserActivity' in activity, 'native_export_share_sheet_missing')
        files = set(adb('shell', 'run-as', 'com.chroma.app', 'find', 'cache', '-maxdepth', '2', '-type', 'f', '-name', 'chroma-visualize-*.png').decode().splitlines()) - previous
        require(len(files) == 1, 'native_export_file_missing_or_ambiguous')
        filename = next(iter(files))
        require(re.fullmatch(r'cache/chroma-visualize-[\w-]+\.png', filename) is not None, 'unsafe_generated_cache_path')
        png = adb('exec-out', 'run-as', 'com.chroma.app', 'cat', filename)
        destination = OUT / 'actual-native-export.png'
        destination.write_bytes(png)
        with Image.open(destination) as image:
            image.load()
            metadata = json.loads(image.info['CHROMA'])
            require(image.format == 'PNG' and image.size == (metadata['outputWidth'], metadata['outputHeight']), 'invalid_native_export_geometry')
            require(metadata['targetHex'] == '#C82A3D' and metadata['colourSource'] == 'Library' and metadata['material'] == 'paint'
                    and metadata['lighting'] == 'daylight' and metadata['intensity'] == 100 and metadata['selectionMethod'] == 'sam3' and metadata['selectionRefined'] is False
                    and metadata['renderer'] == 'lab-material-v2' and metadata['lightShiftModel'] == 'lab-cast-approximation', 'native_export_metadata_incorrect')
            report['export'] = {'width': image.width, 'height': image.height, 'bytes': len(png), 'sha256': hashlib.sha256(png).hexdigest(),
                                'png_decoded': True, 'embedded_metadata_valid': True, 'share_sheet_activity': activity,
                                'destination': str(destination), 'target': metadata['targetHex'], 'material': metadata['material'],
                                'lighting': metadata['lighting'], 'selection_method': metadata['selectionMethod'], 'selection_refined': metadata['selectionRefined']}
        cancel_native(); native_open = False; settled(browser)
        browser.wait("!document.querySelector('.visualize-progress')", timeout=10)
        require(browser.evaluate(SNAPSHOT) == before, 'editor_changed_on_share_cancel')
        report['export']['cancel_preserved_editor'] = True

        touch(browser, "document.querySelector('header [aria-label=\"Open navigation\"]')")
        browser.wait("document.querySelector('#navigation-drawer[open]')")
        adb('shell', 'input', 'keyevent', '4')
        browser.wait("!document.querySelector('#navigation-drawer[open]')&&location.hash==='#visualize'")
        touch(browser, "document.querySelector('[data-bottom-nav=home]')")
        browser.wait("document.querySelector('[data-page=home]:not([hidden])')")
        adb('shell', 'input', 'keyevent', '4')
        browser.wait("document.querySelector('[data-page=visualize]:not([hidden])')")
        settled(browser)
        require(browser.evaluate(SNAPSHOT) == before, 'editor_changed_on_android_back')
        report['android_back'] = {'drawer_closed_before_route': True, 'home_returns_to_visualize': True, 'editor_preserved': True}
        report['storage_after'] = browser.evaluate(STORAGE_DIGEST_JS)
        report['preservation'] = compare_storage(report['storage_before'], report['storage_after'])
        require(all(report['preservation'].values()), 'existing_storage_changed')
        require(not browser.errors and not observer.jobs and not observer.local_sam_calls and not observer.credential_headers, 'unexpected_runtime_or_inference')
        report.update(status='passed', gpu_jobs=len(observer.jobs), local_sam_requests=observer.local_sam_calls, runtime_errors=browser.errors)
    except Exception as error:
        report['error'] = str(error)
    finally:
        if native_open:
            cancel_native()
        if browser:
            if 'storage_before' in report and 'storage_after' not in report:
                report['storage_after'] = browser.evaluate(STORAGE_DIGEST_JS)
                report['preservation'] = compare_storage(report['storage_before'], report['storage_after'])
            browser.socket.close()
        (OUT / 'native-controls-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
