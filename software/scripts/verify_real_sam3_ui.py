"""Verify actual localhost SAM 3 inference through CHROMA Visualize.

Uses a real photo and an isolated Chrome profile. HTTP requests and responses
are observed through CDP; fetch and the model are never replaced. Run only
after the real server reports ready and its first inference has been warmed up.

Example:
  python scripts/verify_real_sam3_ui.py --photo path/to/photo.jpg --tap-x .5 --tap-y .5
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
import zlib

import check_chroma
from check_chroma import Browser


ROOT = Path(__file__).resolve().parents[1]
PAGE = "document.querySelector('[data-page=visualize]:not([hidden])')"
CANVAS = "document.querySelector('#visualize-canvas')"
OVERLAY = "document.querySelector('.visualize-mask-overlay')"


class ObservedSocket:
    """Read CDP network events without intercepting browser HTTP requests."""

    def __init__(self, socket, endpoint):
        self.socket = socket
        self.endpoint = endpoint
        self.requests: list[dict] = []

    def __getattr__(self, name):
        return getattr(self.socket, name)

    def recv(self):
        raw = self.socket.recv()
        message = json.loads(raw)
        method, params = message.get('method'), message.get('params', {})
        if method == 'Network.requestWillBeSent':
            request = params.get('request', {})
            if request.get('url') == self.endpoint and request.get('method') == 'POST':
                body = json.loads(request.get('postData') or '{}')
                image = body.get('image', '')
                self.requests.append({
                    'request_id': params['requestId'], 'url': self.endpoint,
                    'method': 'POST', 'width': body.get('width'), 'height': body.get('height'),
                    'points': body.get('points'), 'working_png': image.startswith('data:image/png;base64,'),
                    'png_data_url_length': len(image), 'started_at': params.get('timestamp'),
                    'finished': False,
                })
        elif method in ('Network.responseReceived', 'Network.loadingFinished', 'Network.loadingFailed'):
            request = next((entry for entry in self.requests if entry['request_id'] == params.get('requestId')), None)
            if request is not None:
                if method == 'Network.responseReceived':
                    response = params['response']
                    request.update(status=response.get('status'), mime_type=response.get('mimeType'),
                                   from_service_worker=response.get('fromServiceWorker', False),
                                   from_disk_cache=response.get('fromDiskCache', False))
                elif method == 'Network.loadingFinished':
                    request.update(finished=True, finished_at=params.get('timestamp'),
                                   transferred_bytes=params.get('encodedDataLength'))
                else:
                    request.update(failed=True, network_error=params.get('errorText'))
        return raw


def mask_summary(browser):
    return browser.evaluate("""(() => {
      const c=document.querySelector('.visualize-mask-overlay');
      const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let count=0,sum=0,hash=0;
      for(let i=3;i<d.length;i+=4){if(d[i])count++;sum+=d[i];hash=(Math.imul(hash,31)+d[i])|0;}
      return {width:c.width,height:c.height,count,sum,hash};
    })()""")


def exact_sam_overlay_restored(browser):
    return browser.evaluate("""(() => {
      const c=document.querySelector('.visualize-mask-overlay');
      const current=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const original=window.__realSamOverlay;
      return current.length===original.length && current.every((value,index)=>value===original[index]);
    })()""")


def settled(browser):
    browser.wait("!document.querySelector('.visualize-progress')", timeout=60)
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def click_text(browser, label):
    browser.click_text(label, scope=PAGE)
    settled(browser)


def canvas_pointer(browser, start, end=None):
    browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
    rect = browser.evaluate("(() => {const r=" + CANVAS + ".getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()")
    end = start if end is None else end
    first = {'x': rect['left'] + start[0] * rect['width'], 'y': rect['top'] + start[1] * rect['height']}
    last = {'x': rect['left'] + end[0] * rect['width'], 'y': rect['top'] + end[1] * rect['height']}
    browser.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', **first})
    browser.call('Input.dispatchMouseEvent', {'type': 'mousePressed', **first, 'button': 'left', 'buttons': 1, 'clickCount': 1})
    if end != start:
        browser.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', **last, 'button': 'left', 'buttons': 1})
    browser.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', **last, 'button': 'left', 'buttons': 0, 'clickCount': 1})


def screenshot(browser, destination):
    browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
    shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    destination.write_bytes(base64.b64decode(shot['data']))
    return str(destination.relative_to(ROOT))


def grayscale_png(width, height, alpha):
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
    rows = b''.join(b'\0' + alpha[y * width:(y + 1) * width] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b''))


def background_point(alpha, width, height):
    """Pick a genuine unselected interior patch to prove Brush/Local change masks."""
    margin = min(20, max(2, min(width, height) // 15))
    for y in range(margin, height - margin, max(1, height // 60)):
        for x in range(margin, width - margin, max(1, width // 60)):
            if not any(alpha[(y + dy) * width + x + dx] for dy in (-margin // 2, 0, margin // 2)
                       for dx in (-margin // 2, 0, margin // 2)):
                return ((x + .5) / width, (y + .5) / height)
    for index, value in enumerate(alpha):
        if not value:
            return ((index % width + .5) / width, (index // width + .5) / height)
    raise AssertionError('Choose a photo with visible background; this mask selects the entire image.')


def verify(browser, observer, args, output):
    report = {'status': 'running', 'real_inference': True, 'mocked_transport': False, 'checks': [], 'screenshots': []}
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    browser.call('Network.enable', {'maxTotalBufferSize': 20_000_000, 'maxResourceBufferSize': 8_000_000})
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    browser.call('Emulation.setFocusEmulationEnabled', {'enabled': True})
    browser.call('Page.navigate', {'url': args.url})
    browser.wait("document.querySelector('[data-page=home]:not([hidden])')")
    browser.route('visualize')
    browser.wait(PAGE)
    if not browser.evaluate("Boolean(document.querySelector('.visualize-colour-chooser'))"):
        click_text(browser, 'Change Colour')
    click_text(browser, 'Library')
    library = browser.state()['library']
    assert library, 'A saved Library colour is required for the actual photographic preview.'
    colour = next((entry for entry in library if entry['hex'].upper() not in ('#000000', '#FFFFFF')), library[0])
    browser.fill('#visualize-library-colour', colour['id'])
    browser.wait("document.querySelector('[data-testid=visualize-target]')?.textContent.includes(" + json.dumps(colour['hex']) + ')')
    report['target'] = {'hex': colour['hex'], 'name': colour['name'], 'source': 'Library'}
    document = browser.call('DOM.getDocument')
    node = browser.call('DOM.querySelector', {'nodeId': document['root']['nodeId'], 'selector': '#visualize-photo-input'})
    browser.call('DOM.setFileInputFiles', {'nodeId': node['nodeId'], 'files': [str(args.photo)]})
    browser.wait(CANVAS + '?.width>0', timeout=15)
    settled(browser)
    size = browser.evaluate('({width:' + CANVAS + '.width,height:' + CANVAS + '.height})')
    report['photo'] = {'name': args.photo.name, 'sha256': hashlib.sha256(args.photo.read_bytes()).hexdigest(), **size}
    browser.evaluate('void(window.__realSamOriginal=' + CANVAS + ".getContext('2d').getImageData(0,0," + CANVAS + '.width,' + CANVAS + '.height).data.slice())')
    browser.fill('#visualize-selection-engine', 'sam3')
    browser.fill('#visualize-selection-mode', 'replace')
    click_text(browser, 'SAM 3 server')
    browser.fill('#visualize-server-url', args.server)
    browser.click_text('Save server address', scope="document.querySelector('dialog[open]')")
    browser.wait("!document.querySelector('dialog[open]')")
    started = time.monotonic()
    canvas_pointer(browser, (args.tap_x, args.tap_y))
    browser.wait(PAGE + ".querySelector('[role=alert]') || document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('SAM 3 selection ready')", timeout=60)
    settled(browser)
    error = browser.evaluate(PAGE + ".querySelector('[role=alert]')?.textContent")
    assert not error, 'Actual SAM 3 selection failed: ' + str(error)
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('SAM 3 selection ready')", timeout=5)
    assert len(observer.requests) == 1, 'Expected exactly one actual SAM 3 HTTP request.'
    request = observer.requests[0]
    browser.wait("!document.querySelector('.visualize-progress')")
    assert request.get('status') == 200 and request.get('finished'), 'Actual SAM endpoint did not finish with HTTP 200.'
    assert not request.get('from_service_worker') and not request.get('from_disk_cache'), 'SAM response must come from the model server, not a browser cache.'
    body = browser.call('Network.getResponseBody', {'requestId': request['request_id']})
    text = base64.b64decode(body['body']).decode('utf-8') if body.get('base64Encoded') else body['body']
    response = json.loads(text)
    assert response['model'] == 'sam3' and (response['width'], response['height']) == (size['width'], size['height'])
    assert isinstance(response['score'], (int, float)) and math.isfinite(response['score']) and 0 <= response['score'] <= 1
    alpha = base64.b64decode(response['mask_base64'], validate=True)
    assert len(alpha) == size['width'] * size['height'] and set(alpha).issubset({0, 255}), 'Actual server mask must contain one binary alpha byte per working pixel.'
    count = sum(value > 0 for value in alpha)
    assert 0 < count < len(alpha), 'An object mask should select a nonempty surface with visible unselected background.'
    point = request['points'][0]
    assert point['label'] == 1 and abs(point['x'] - args.tap_x * size['width']) < 1 and abs(point['y'] - args.tap_y * size['height']) < 1
    assert alpha[int(point['y']) * size['width'] + int(point['x'])] > 0, 'Actual mask must contain the positive object tap.'
    sam_mask = mask_summary(browser)
    assert sam_mask['count'] == count and sam_mask['sum'] == count * 122, 'Rendered selection must match the actual returned mask alpha.'
    assert request['working_png'] and (request['width'], request['height']) == (size['width'], size['height'])
    (output / 'actual-server-mask.png').write_bytes(grayscale_png(size['width'], size['height'], alpha))
    report['sam3'] = {'duration_seconds': round(time.monotonic() - started, 3), 'http_status': 200, 'score': response['score'],
                      'mask_selected_pixels': count, 'mask_pixel_count': len(alpha), 'mask_sha256': hashlib.sha256(alpha).hexdigest(),
                      'point': point, 'overlay': sam_mask, 'network': request}
    report['checks'].append('Real photograph passed through an observed, uncached HTTP 200 SAM 3 request; returned mask dimensions, count, binary alpha and tap coverage match the UI')
    report['screenshots'].append(screenshot(browser, output / 'actual-sam3-selection.png'))
    browser.evaluate('void(window.__realSamOverlay=' + OVERLAY + ".getContext('2d').getImageData(0,0," + OVERLAY + '.width,' + OVERLAY + '.height).data.slice())')
    click_text(browser, 'Apply Colour')
    browser.wait("document.querySelector('#visualize-intensity')", timeout=15)
    settled(browser)
    click_text(browser, 'After')
    preview = browser.evaluate("""(() => {
      const c=document.querySelector('#visualize-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const original=window.__realSamOriginal,mask=window.__realSamOverlay;
      let changed=0,outsideChanged=0,alphaChanged=0;
      for(let i=0;i<d.length;i+=4){const differs=d[i]!==original[i]||d[i+1]!==original[i+1]||d[i+2]!==original[i+2];
        if(differs){changed++;if(!mask[i+3])outsideChanged++;}if(d[i+3]!==original[i+3])alphaChanged++;}
      return {changed,outsideChanged,alphaChanged};
    })()""")
    assert preview['changed'] > 0 and preview['outsideChanged'] == 0 and preview['alphaChanged'] == 0
    report['preview'] = preview
    report['screenshots'].append(screenshot(browser, output / 'actual-sam3-preview.png'))
    report['checks'].append('Existing material recolouring changes real selected photo pixels while leaving every unselected pixel and original alpha unchanged')
    click_text(browser, 'Edit Selection')
    click_text(browser, 'Brush')
    browser.fill('#visualize-brush-size', '12')
    background = background_point(alpha, size['width'], size['height'])
    canvas_pointer(browser, background, (min(.999, background[0] + .02), background[1]))
    settled(browser)
    brush = mask_summary(browser)
    assert brush != sam_mask and brush['count'] > sam_mask['count'], 'Brush must refine an actual SAM selection.'
    click_text(browser, 'Undo')
    assert mask_summary(browser) == sam_mask, 'Undo must restore every alpha byte of the actual SAM mask.'
    assert exact_sam_overlay_restored(browser), 'Undo must restore every rendered byte of the real SAM overlay.'
    click_text(browser, 'Auto Select')
    browser.fill('#visualize-selection-engine', 'local')
    canvas_pointer(browser, background)
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Local region selected')", timeout=15)
    settled(browser)
    local = mask_summary(browser)
    assert local['count'] > 0 and local != sam_mask, 'The local region selector must still operate independently after real SAM selection.'
    click_text(browser, 'Undo')
    assert mask_summary(browser) == sam_mask, 'Undo local selection must restore the actual SAM mask.'
    assert exact_sam_overlay_restored(browser), 'Local Undo must restore every rendered byte of the real SAM overlay.'
    assert len(observer.requests) == 1, 'Brush, Undo and local selection must not send additional photos to SAM 3.'
    assert browser.state()['library'] == library, 'Real SAM selection and preview must preserve saved Library entries and metadata.'
    assert not browser.errors, 'Unexpected browser errors: ' + ' | '.join(browser.errors)
    report['refinement'] = {'background_point': background, 'brush': brush, 'local': local, 'restored': sam_mask, 'byte_exact_undo_verified': True, 'sam_http_requests': len(observer.requests)}
    report['checks'].append('Manual Brush and local Tap remain available; both Undo paths restore the exact real SAM mask, without further SAM uploads or saved Library mutations')
    report['status'] = 'passed'
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--photo', type=Path, required=True)
    parser.add_argument('--tap-x', type=float, required=True, help='Horizontal tap position as a fraction of the photo width.')
    parser.add_argument('--tap-y', type=float, required=True, help='Vertical tap position as a fraction of the photo height.')
    parser.add_argument('--url', default='http://127.0.0.1:8000')
    parser.add_argument('--server', default='http://127.0.0.1:8001')
    parser.add_argument('--port', type=int, default=9230)
    parser.add_argument('--chrome', default=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    args = parser.parse_args()
    args.photo = args.photo.resolve()
    if not args.photo.is_file() or not 0 < args.tap_x < 1 or not 0 < args.tap_y < 1:
        parser.error('Provide an existing real photo and tap fractions strictly between 0 and 1.')
    server = urllib.parse.urlparse(args.server)
    if server.scheme != 'http' or server.hostname not in ('localhost', '127.0.0.1', '::1') or server.username or server.password or server.query or server.fragment:
        parser.error('This real-runtime check requires a local HTTP server without credentials or URL parameters.')
    args.server = args.server.rstrip('/')
    output = ROOT / 'artifacts' / 'sam3-runtime'
    output.mkdir(parents=True, exist_ok=True)
    process, browser = None, None
    report = {'status': 'failed', 'real_inference': False, 'mocked_transport': False}
    try:
        with urllib.request.urlopen(args.server + '/health', timeout=5) as response:
            health = json.load(response)
        assert health.get('ready') is True and health.get('model') == 'sam3', 'The actual model server must report ready before browser verification.'
        profile = Path(tempfile.mkdtemp(prefix='isolated-browser-', dir=output))
        check_chroma.PORT = args.port
        process = subprocess.Popen([args.chrome, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                                    '--disable-background-networking', f'--remote-debugging-port={args.port}',
                                    f'--remote-allow-origins=http://localhost:{args.port}', f'--user-data-dir={profile}', 'about:blank'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        deadline, target = time.monotonic() + 15, None
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{args.port}/json/list', timeout=1) as response:
                    target = next((tab for tab in json.load(response) if tab.get('type') == 'page'), None)
                if target:
                    break
            except (OSError, ValueError):
                pass
            if process.poll() is not None:
                raise RuntimeError(f'Isolated Chrome exited with status {process.returncode}.')
            time.sleep(.1)
        assert target, 'The isolated browser debugging endpoint did not start.'
        browser = Browser(target['webSocketDebuggerUrl'])
        observer = ObservedSocket(browser.socket, args.server + '/segment')
        browser.socket = observer
        report = verify(browser, observer, args, output)
        report['health'] = health
    except Exception as error:
        report.update(status='failed', error=str(error), last_command=browser.last_command if browser else 'server readiness/browser startup',
                      browser_errors=browser.errors if browser else [])
        if browser:
            try:
                shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
                (output / 'real-ui-failure.png').write_bytes(base64.b64decode(shot['data']))
            except Exception:
                pass
    finally:
        (output / 'real-ui-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        if browser:
            try:
                browser.call('Browser.close')
            except Exception:
                pass
            browser.socket.close()
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
    print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
