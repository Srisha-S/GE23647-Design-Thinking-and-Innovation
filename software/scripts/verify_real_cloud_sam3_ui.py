"""Observe real public ZeroGPU SAM 3 inference through CHROMA's production UI.

The default run serves the existing dist, uploads the official truck.jpg fixture,
and submits one real /segment Gradio job to Vizhodhan/chroma-sam3. It never
replaces fetch, intercepts HTTP, accelerates timers, or supplies a token. Run
only after the Space is ready and localhost SAM is stopped. --self-test checks
the observer/parser contract entirely offline and does not start a browser.

  python scripts/verify_real_cloud_sam3_ui.py --self-test
  python scripts/verify_real_cloud_sam3_ui.py
  python scripts/verify_real_cloud_sam3_ui.py --url http://127.0.0.1:4173 --mobile
"""
from __future__ import annotations

import argparse
import base64
from functools import partial
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import check_chroma
from check_chroma import Browser
from verify_real_sam3_ui import (
    PAGE, CANVAS, OVERLAY, background_point, canvas_pointer,
    exact_sam_overlay_restored, grayscale_png, mask_summary,
)


ROOT = Path(__file__).resolve().parents[1]
SPACE = 'Vizhodhan/chroma-sam3'
SPACE_ORIGIN = 'https://vizhodhan-chroma-sam3.hf.space'
TRUCK_SHA256 = '941715e721c8864324a1425b445ea4dde0498b995c45ddce0141a58971c6ff99'
TRUCK_SOURCE = 'https://raw.githubusercontent.com/facebookresearch/sam3/0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc/assets/images/truck.jpg'
MAX_STREAM_BYTES = 20_000_000
MAX_METADATA_BODY_ATTEMPTS = 4
METADATA_RETRY_DELAY = .1
MAX_STREAM_BODY_ATTEMPTS = 4
STREAM_RETRY_DELAY = .1


def safe_url(raw):
    """Keep public origin/path evidence; discard session hashes and URL parameters."""
    parsed = urllib.parse.urlsplit(raw)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))


def response_bytes(browser, request_id):
    result = browser.call('Network.getResponseBody', {'requestId': request_id})
    return base64.b64decode(result['body']) if result.get('base64Encoded') else result['body'].encode('utf-8')


def response_json(browser, request_id):
    return json.loads(response_bytes(browser, request_id).decode('utf-8'))


def body_unavailable(error):
    return any(message in str(error) for message in ('No resource with given identifier found', 'No data found for resource with given identifier'))


class CloudObservedSocket:
    """Passively record CDP events and fetch-stream SSE bytes, without HTTP hooks.

    Network.streamResourceContent exposes real response bytes in dataReceived.
    Browser.call pumps events while waiting for its own CDP response. Stream
    commands and response-body reads are therefore deferred until that command
    returns, rather than recursively consuming its CDP reply inside recv().
    """

    def __init__(self, connection):
        self.socket = connection
        self.requests = {}
        self.jobs = []
        self.config = None
        self.info = None
        self.metadata_pending = []
        self.stream_pending = []
        self.streams = {}
        self.completed = {}
        self.events = []
        self.local_sam_calls = 0
        self.credential_headers = 0
        self.unexpected_segment_origins = []
        self.violation = None
        self.servicing = False

    def metadata_kind(self, record):
        # CORS preflights use the same URL as the POST, but Chrome does not
        # expose their response body. Redirects/failed requests have no usable
        # API metadata either. Only read a successfully completed API response.
        if not record.get('finished') or record.get('status') != 200 or record.get('type') == 'Preflight':
            return None
        path, method = record['path'], record['method']
        if method == 'GET' and path.endswith('/config'):
            return 'config'
        if method == 'GET' and path.endswith('/info'):
            return 'info'
        if method == 'POST' and path.endswith('/queue/join'):
            return 'join'
        return None

    def __getattr__(self, name):
        return getattr(self.socket, name)

    def recv(self):
        raw = self.socket.recv()
        self.observe(json.loads(raw))
        return raw

    def observe(self, message):
        method, params = message.get('method'), message.get('params', {})
        request_id = params.get('requestId')
        if method == 'Network.requestWillBeSent':
            request = params.get('request', {})
            parsed = urllib.parse.urlsplit(request.get('url', ''))
            endpoint = parsed.path.rstrip('/')
            if parsed.hostname in ('localhost', '127.0.0.1', '::1') and endpoint.endswith('/segment'):
                self.local_sam_calls += 1
            if request.get('method') == 'POST' and endpoint.endswith('/queue/join'):
                if safe_url(request.get('url', '')).split('/gradio_api/')[0] != SPACE_ORIGIN:
                    self.unexpected_segment_origins.append(safe_url(request.get('url', '')))
                else:
                    payload = json.loads(request.get('postData') or '{}')
                    job = {'request_id': request_id, 'url': safe_url(request['url']),
                           'started_at': params.get('timestamp'), 'payload': payload, 'finished': False}
                    self.jobs.append(job)
            if parsed.scheme == 'https' and parsed.hostname == 'vizhodhan-chroma-sam3.hf.space':
                headers = request.get('headers', {})
                self.credential_headers += sum(key.lower() == 'authorization' for key in headers)
                if parsed.username or parsed.password or any(key.lower() in ('token', 'hf_token', 'access_token') for key, _ in urllib.parse.parse_qsl(parsed.query)):
                    self.violation = 'Public Space request unexpectedly includes URL credentials.'
                self.requests[request_id] = {'url': safe_url(request['url']), 'path': endpoint,
                                             'method': request.get('method'), 'type': params.get('type'),
                                             'finished': False}
        elif method == 'Network.requestWillBeSentExtraInfo' and request_id in self.requests:
            self.credential_headers += sum(key.lower() == 'authorization' for key in params.get('headers', {}))
        elif method == 'Network.responseReceived' and request_id in self.requests:
            record, response = self.requests[request_id], params['response']
            record.update(status=response.get('status'), mime_type=response.get('mimeType'),
                          from_service_worker=response.get('fromServiceWorker', False),
                          from_disk_cache=response.get('fromDiskCache', False))
            if record['path'].endswith('/queue/data') and record['method'] == 'GET' and request_id not in self.streams:
                self.streams[request_id] = {'chunks': [], 'buffer': b'', 'bytes': 0, 'started': False}
                self.stream_pending.append(request_id)
        elif method == 'Network.dataReceived' and request_id in self.streams:
            # A completed response body contains all bytes. Replaying streamed
            # chunks after that fallback would count every event twice.
            if params.get('data') and self.streams[request_id].get('capture_mode') != 'body':
                self.streams[request_id]['chunks'].append(base64.b64decode(params['data']))
        elif method in ('Network.loadingFinished', 'Network.loadingFailed') and request_id in self.requests:
            record = self.requests[request_id]
            record.update(finished=method == 'Network.loadingFinished',
                          failed=method == 'Network.loadingFailed', finished_at=params.get('timestamp'))
            if self.metadata_kind(record) and not record.get('metadata_state'):
                # Replayed completion events must not enqueue the same ID twice.
                record['metadata_state'] = 'pending'
                self.metadata_pending.append(request_id)

    def feed_sse(self, request_id, chunk):
        stream = self.streams[request_id]
        stream['bytes'] += len(chunk)
        if stream['bytes'] > MAX_STREAM_BYTES:
            raise AssertionError('Observed Gradio stream exceeded the bounded capture size.')
        stream['buffer'] += chunk
        while b'\n\n' in stream['buffer'] or b'\r\n\r\n' in stream['buffer']:
            # Preserve split CRLF/UTF-8 bytes until a whole event is available.
            lf = stream['buffer'].find(b'\n\n')
            crlf = stream['buffer'].find(b'\r\n\r\n')
            boundaries = [(index, length) for index, length in ((lf, 2), (crlf, 4)) if index >= 0]
            index, separator = min(boundaries)
            block, stream['buffer'] = stream['buffer'][:index], stream['buffer'][index + separator:]
            lines = block.decode('utf-8').splitlines()
            data = '\n'.join(line[5:].lstrip(' ') for line in lines if line.startswith('data:'))
            if not data:
                continue
            event = json.loads(data)
            event_id = event.get('event_id')
            self.events.append({'msg': event.get('msg'), 'event_id': event_id, 'observed_at': time.monotonic()})
            if event.get('msg') == 'process_completed' and event_id:
                self.completed[event_id] = event

    def capture_stream(self, browser, request_id):
        record, stream = self.requests[request_id], self.streams[request_id]
        if stream['started']:
            return
        assert record['status'] == 200 and not record['from_service_worker'] and not record['from_disk_cache'], 'Real Gradio SSE must be an uncached HTTPS 200 response.'
        if record.get('finished') or stream.get('capture_mode') == 'body':
            # A fast/warm job can close its fetch stream before this deferred
            # command runs. Read the actual completed CDP response instead.
            stream['capture_mode'] = 'body'
            if not record.get('finished') or time.monotonic() < stream.get('body_retry_at', 0):
                self.stream_pending.append(request_id)
                return
            stream['body_attempts'] = stream.get('body_attempts', 0) + 1
            try:
                raw = response_bytes(browser, request_id)
            except RuntimeError as error:
                if not body_unavailable(error):
                    raise
                if stream['body_attempts'] >= MAX_STREAM_BODY_ATTEMPTS:
                    raise AssertionError('Completed real Gradio SSE body unavailable after bounded CDP retries.') from None
                stream['body_retry_at'] = time.monotonic() + STREAM_RETRY_DELAY
                self.stream_pending.append(request_id)
                return
            stream['chunks'].clear()
            stream['started'] = True
            self.feed_sse(request_id, raw)
            return
        try:
            result = browser.call('Network.streamResourceContent', {'requestId': request_id})
        except RuntimeError as error:
            if not any(message in str(error) for message in (
                'Request with provided ID has already finished loading',
                'Request with the provided ID has already finished loading',
            )):
                raise
            # loadingFinished may have been pumped while this CDP call waited.
            # Defer the fallback until that event is observed; never re-fetch.
            stream['capture_mode'] = 'body'
            self.stream_pending.append(request_id)
            return
        stream['capture_mode'] = 'stream'
        stream['started'] = True
        self.feed_sse(request_id, base64.b64decode(result.get('bufferedData', '')))

    def service(self, browser):
        if self.servicing:
            return
        self.servicing = True
        try:
            pending_streams, self.stream_pending = self.stream_pending, []
            for request_id in pending_streams:
                self.capture_stream(browser, request_id)
            for request_id, stream in self.streams.items():
                if stream['started']:
                    while stream['chunks']:
                        self.feed_sse(request_id, stream['chunks'].pop(0))
            # Process one bounded batch. Browser.call can pump further events
            # while reading a body, so preserve newly queued IDs for the next
            # service pass instead of recursively draining the CDP connection.
            pending, self.metadata_pending = self.metadata_pending, []
            for request_id in pending:
                record = self.requests[request_id]
                kind = self.metadata_kind(record)
                job = next((job for job in self.jobs if job['request_id'] == request_id), None) if kind == 'join' else None
                if not kind or (kind == 'config' and self.config is not None) or (kind == 'info' and self.info is not None) or (kind == 'join' and (job is None or job['finished'])):
                    record['metadata_state'] = 'ignored'
                    continue
                if time.monotonic() < record.get('metadata_retry_at', 0):
                    self.metadata_pending.append(request_id)
                    continue
                record['metadata_attempts'] = record.get('metadata_attempts', 0) + 1
                try:
                    body = response_json(browser, request_id)
                except RuntimeError as error:
                    # An evicted/temporarily unavailable CDP resource must not
                    # abort an otherwise successful UI job. Retry only these
                    # known body-availability errors; unrelated CDP errors fail.
                    if not body_unavailable(error):
                        raise
                    if record['metadata_attempts'] < MAX_METADATA_BODY_ATTEMPTS:
                        record['metadata_retry_at'] = time.monotonic() + METADATA_RETRY_DELAY
                        self.metadata_pending.append(request_id)
                    else:
                        record['metadata_state'] = 'unavailable'
                    continue
                except (ValueError, UnicodeDecodeError):
                    # Ignore an unusable duplicate response without replacing
                    # metadata already captured from the live API. Acceptance
                    # still requires actual config, info and queue event ID.
                    record['metadata_state'] = 'invalid'
                    continue
                if not isinstance(body, dict):
                    record['metadata_state'] = 'invalid'
                    continue
                record['metadata_state'] = 'captured'
                if kind == 'config':
                    self.config = body
                elif kind == 'info':
                    self.info = body.get('api', body)
                elif kind == 'join':
                    job.update(event_id=body.get('event_id'), finished=True, status=record.get('status'))
            assert not self.violation, self.violation
        finally:
            self.servicing = False


class ObservedBrowser(Browser):
    def call(self, method, params=None):
        result = super().call(method, params)
        if isinstance(self.socket, CloudObservedSocket):
            self.socket.service(self)
        return result


def settled(browser, timeout=30):
    browser.wait("!document.querySelector('.visualize-progress')", timeout=timeout)
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def click_text(browser, label):
    browser.click_text(label, scope=PAGE)
    settled(browser)


def pointer(browser, start, end=None, mobile=False):
    if not mobile:
        return canvas_pointer(browser, start, end)
    browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
    rect = browser.evaluate("(() => {const r=" + CANVAS + ".getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()")
    def point(position):
        return {'x': rect['left'] + position[0] * rect['width'], 'y': rect['top'] + position[1] * rect['height'], 'id': 1}
    browser.call('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [point(start)]})
    if end is not None and end != start:
        browser.call('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [point(end)]})
    browser.call('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


def capture(browser, destination):
    browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
    shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    destination.write_bytes(base64.b64decode(shot['data']))
    return str(destination)


def build_contract(dist):
    env = {}
    for line in (ROOT / '.env.production').read_text(encoding='utf-8').splitlines():
        if line.strip() and not line.lstrip().startswith('#') and '=' in line:
            key, value = line.split('=', 1)
            if key in ('VITE_CHROMA_SAM_PROVIDER', 'VITE_CHROMA_SAM_SPACE'):
                env[key] = value.strip().strip('"').strip("'")
    assert env == {'VITE_CHROMA_SAM_PROVIDER': 'cloud', 'VITE_CHROMA_SAM_SPACE': SPACE}, 'The central .env.production must select the official cloud Space.'
    assert (dist / 'index.html').is_file(), 'Run npm run build to create the real production dist.'
    scripts = sorted((dist / 'assets').glob('*.js'))
    assert scripts and any(SPACE.encode() in script.read_bytes() for script in scripts), 'The production JavaScript does not contain the central official Space configuration; rebuild dist.'
    return {'mode': 'production', 'dist': str(dist), 'space': SPACE,
            'assets_sha256': hashlib.sha256(b''.join(hashlib.sha256(script.read_bytes()).digest() for script in scripts)).hexdigest()}


def assert_local_sam_off(port):
    for address in ('127.0.0.1', '::1'):
        try:
            connection = socket.create_connection((address, port), timeout=.5)
        except OSError:
            continue
        connection.close()
        raise AssertionError(f'Local SAM port {port} is reachable. Stop it before proving standalone cloud selection.')


def validate_actual_mask(response, width, height, point):
    assert isinstance(response, dict) and response.get('model') == 'sam3', 'The named /segment output must identify the real SAM 3 model.'
    assert (response.get('width'), response.get('height')) == (width, height), 'Actual mask dimensions must match working-image coordinates.'
    score = response.get('score')
    assert isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score) and 0 <= score <= 1, 'Actual mask must include a finite confidence score.'
    alpha = base64.b64decode(response['mask_base64'], validate=True)
    assert len(alpha) == width * height and set(alpha).issubset({0, 255}), 'Actual mask must contain one binary alpha byte per working pixel.'
    count = alpha.count(255)
    assert 0 < count < len(alpha), 'Actual object mask must include selected object and unselected background.'
    assert alpha[int(point['y']) * width + int(point['x'])] == 255, 'Actual cloud mask must contain the positive object tap.'
    return alpha, count


def verify(browser, observer, args, url, output, report):
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    browser.call('Network.enable', {'maxTotalBufferSize': 32_000_000, 'maxResourceBufferSize': 12_000_000, 'maxPostDataSize': 12_000_000})
    browser.call('Network.setCacheDisabled', {'cacheDisabled': True})
    browser.call('Network.setBypassServiceWorker', {'bypass': True})
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 390 if args.mobile else 1440, 'height': 844 if args.mobile else 1100, 'deviceScaleFactor': 1, 'mobile': args.mobile})
    browser.call('Emulation.setFocusEmulationEnabled', {'enabled': True})
    if args.mobile:
        browser.call('Emulation.setTouchEmulationEnabled', {'enabled': True, 'maxTouchPoints': 1})
    browser.call('Page.navigate', {'url': url})
    browser.wait("document.querySelector('[data-page=home]:not([hidden])')")
    browser.route('visualize')
    browser.wait(PAGE)
    if not browser.evaluate("Boolean(document.querySelector('.visualize-colour-chooser'))"):
        click_text(browser, 'Change Colour')
    click_text(browser, 'Library')
    library = browser.state()['library']
    assert library, 'Existing Library colours are required for the photographic recolour preview.'
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
    assert size == {'width': 1200, 'height': 800}, 'Official truck working image must be 1200 by 800.'
    report['photo'] = {'name': args.photo.name, 'sha256': TRUCK_SHA256, 'source': TRUCK_SOURCE, **size}
    browser.evaluate('void(window.__realSamOriginal=' + CANVAS + ".getContext('2d').getImageData(0,0," + CANVAS + '.width,' + CANVAS + '.height).data.slice())')
    assert browser.evaluate("document.querySelector('#visualize-selection-engine').dataset.value") == 'cloud', 'Production must start with cloud Auto Select.'
    assert 'sam3' not in browser.picker_values('#visualize-selection-engine'), 'Local SAM development configuration must be absent in production.'
    browser.fill('#visualize-selection-mode', 'replace')
    started = time.monotonic()
    report['attempted_real_inference'] = True
    pointer(browser, (args.tap_x, args.tap_y), mobile=args.mobile)
    deadline, progress = time.monotonic() + args.timeout, []
    while time.monotonic() < deadline:
        status = browser.evaluate("({error:" + PAGE + ".querySelector('[role=alert]')?.textContent,ready:document.querySelector('[data-testid=visualize-selection-status]')?.textContent,progress:document.querySelector('.visualize-progress')?.textContent})")
        if status.get('progress') and status['progress'] not in progress:
            progress.append(status['progress'])
        assert not status.get('error'), 'Actual cloud selection failed: ' + str(status.get('error'))
        if (status.get('ready') or '').startswith('Surface selected') and not status.get('progress'):
            break
        time.sleep(.08)
    else:
        # Release a queued allocation when this independent acceptance deadline expires.
        browser.evaluate("Array.from(" + PAGE + ".querySelectorAll('button')).find(button=>button.textContent.trim()==='Cancel')?.click()")
        raise AssertionError('Actual cloud selection did not finish within the bounded 180-second acceptance deadline.')
    settled(browser)
    assert len(observer.jobs) == 1, 'Expected exactly one real /segment queue job.'
    assert observer.config and observer.info, 'Observe the actual Gradio config and named API metadata.'
    dependency = next((item for item in observer.config.get('dependencies', []) if str(item.get('api_name', '')).lstrip('/') == 'segment'), None)
    assert dependency and '/segment' in observer.info.get('named_endpoints', {}), 'Live Gradio metadata must publish the named /segment API.'
    job = observer.jobs[0]
    assert job.get('status') == 200 and job.get('finished') and job.get('event_id'), 'Real HTTPS queue join must return an assigned event ID.'
    payload = job['payload']
    assert payload.get('fn_index') == dependency['id'] and len(payload.get('data', [])) == 1, 'Submit must call the live named /segment dependency with one JSON request.'
    request = payload['data'][0]
    assert (request.get('width'), request.get('height')) == (1200, 800) and len(request.get('points', [])) == 1
    assert isinstance(request.get('image'), str) and request['image'].startswith('data:image/png;base64,'), 'Send the real working image as PNG through Gradio JSON.'
    png = base64.b64decode(request['image'].split(',', 1)[1], validate=True)
    assert png.startswith(b'\x89PNG\r\n\x1a\n') and int.from_bytes(png[16:20], 'big') == 1200 and int.from_bytes(png[20:24], 'big') == 800
    point = request['points'][0]
    assert point['label'] == 1 and abs(point['x'] - args.tap_x * 1200) < 1 and abs(point['y'] - args.tap_y * 800) < 1, 'Real cloud point must match displayed working-image tap coordinates.'
    completed = observer.completed.get(job['event_id'])
    assert completed and completed.get('success') is True, 'Observe real process_completed success for the assigned queue ID.'
    returned = completed.get('output', {}).get('data')
    assert isinstance(returned, list) and len(returned) == 1, 'Real Gradio stream must return one SAM JSON output.'
    response = returned[0]
    alpha, count = validate_actual_mask(response, 1200, 800, point)
    sam_mask = mask_summary(browser)
    assert (sam_mask['width'], sam_mask['height'], sam_mask['count'], sam_mask['sum']) == (1200, 800, count, count * 122), 'Rendered overlay dimensions, selected pixel count and alpha must match the actual cloud mask.'
    exact_mask = browser.evaluate("(() => {const c=" + OVERLAY + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let raw='';for(let i=3;i<d.length;i+=4)raw+=String.fromCharCode(d[i]?255:0);return btoa(raw);})()")
    assert base64.b64decode(exact_mask) == alpha, 'Every rendered selection pixel must match the real streamed mask.'
    browser.evaluate('void(window.__realSamOverlay=' + OVERLAY + ".getContext('2d').getImageData(0,0," + OVERLAY + '.width,' + OVERLAY + '.height).data.slice())')
    (output / 'actual-cloud-mask.png').write_bytes(grayscale_png(1200, 800, alpha))
    report['real_inference'] = True
    report['sam3'] = {'duration_seconds': round(time.monotonic() - started, 3), 'queue_http_status': job['status'], 'event_id': job['event_id'], 'named_api': '/segment',
                      'score': response['score'], 'mask_selected_pixels': count, 'mask_pixel_count': len(alpha), 'mask_sha256': hashlib.sha256(alpha).hexdigest(),
                      'working_png_sha256': hashlib.sha256(png).hexdigest(), 'point': point, 'overlay': sam_mask, 'progress_observed': progress,
                      'stream_messages': [event['msg'] for event in observer.events if event['event_id'] == job['event_id']]}
    report['checks'].append('Observed uncached official HTTPS Gradio named /segment queue job; actual binary mask dimensions, positive tap and every overlay pixel match.')
    report['screenshots'].append(capture(browser, output / 'actual-cloud-selection.png'))
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
    report['screenshots'].append(capture(browser, output / 'actual-cloud-preview.png'))
    report['checks'].append('Existing recolouring changes real selected photo pixels, with zero unselected-pixel or original-alpha changes.')
    click_text(browser, 'Edit Selection')
    click_text(browser, 'Brush')
    browser.fill('#visualize-brush-size', '12')
    background = background_point(alpha, 1200, 800)
    pointer(browser, background, (min(.999, background[0] + .02), background[1]), mobile=args.mobile)
    settled(browser)
    brush = mask_summary(browser)
    assert brush != sam_mask and brush['count'] > sam_mask['count'], 'Manual Brush must refine an actual cloud SAM mask.'
    click_text(browser, 'Undo')
    assert mask_summary(browser) == sam_mask and exact_sam_overlay_restored(browser), 'Manual Undo must restore every actual cloud overlay byte.'
    click_text(browser, 'Auto Select')
    browser.fill('#visualize-selection-engine', 'local')
    pointer(browser, background, mobile=args.mobile)
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Local region selected')", timeout=15)
    settled(browser)
    local = mask_summary(browser)
    assert local['count'] > 0 and local != sam_mask, 'On-device colour selection must operate after the real cloud mask.'
    click_text(browser, 'Undo')
    assert mask_summary(browser) == sam_mask and exact_sam_overlay_restored(browser), 'Local Undo must restore every actual cloud overlay byte.'
    assert len(observer.jobs) == 1 and observer.local_sam_calls == 0, 'Manual/local refinements must send no extra cloud photos or localhost SAM calls.'
    assert not observer.unexpected_segment_origins and observer.credential_headers == 0, 'Browser must use only the official public Space without an authorization token.'
    assert browser.evaluate("Object.keys(localStorage).every(key=>!key.startsWith('gradio:run-history'))"), 'No photo/mask Gradio run history may remain in browser storage.'
    assert browser.state()['library'] == library, 'Saved Library entries and metadata must remain unchanged.'
    assert browser.evaluate("document.querySelector('[data-testid=visualize-target]')?.textContent.includes(" + json.dumps(colour['hex']) + ')'), 'Target colour must survive real selection, preview and refinements.'
    assert browser.evaluate("(() => {const c=" + CANVAS + ",current=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return current.length===window.__realSamOriginal.length&&current.every((value,index)=>value===window.__realSamOriginal[index]);})()"), 'Returning to selection editing must preserve every original uploaded photo pixel.'
    assert not browser.errors, 'Unexpected browser error(s); see the sanitized failure report.'
    report['refinement'] = {'background_point': background, 'brush': brush, 'local': local, 'restored': sam_mask, 'byte_exact_undo_verified': True}
    report['checks'].append('Manual Brush and on-device colour selection work; both Undo paths restore the actual cloud mask byte for byte, and the original photo, target colour and Library metadata remain intact.')
    report['checks'].append('Exactly one real cloud segmentation job, zero local SAM calls, zero authorization headers and no browser Gradio photo/mask run history.')
    report.update(status='passed', submitted_jobs=len(observer.jobs), local_sam_requests=observer.local_sam_calls, original_library_preserved=True,
                  checks_passed=len(report['checks']))


def self_test():
    """Exercise capture and binary-mask validation without UI/network/model calls."""
    observer = CloudObservedSocket(None)
    observer.streams['stream'] = {'chunks': [], 'buffer': b'', 'bytes': 0, 'started': True}
    event = {'msg': 'process_completed', 'event_id': 'offline-contract-id', 'success': True,
             'output': {'data': [{'model': 'sam3', 'width': 2, 'height': 1, 'score': .9, 'mask_base64': 'AP8='}]}}
    raw = ('data: ' + json.dumps(event) + '\r\n\r\n').encode()
    for byte in raw:
        observer.feed_sse('stream', bytes([byte]))
    assert observer.completed['offline-contract-id'] == event
    observer.feed_sse('stream', b': heartbeat\n\ndata: {"msg":"estimation","event_id":"offline-contract-id"}\n\n')
    assert [entry['msg'] for entry in observer.events] == ['process_completed', 'estimation']
    alpha, count = validate_actual_mask(event['output']['data'][0], 2, 1, {'x': 1, 'y': 0})
    assert alpha == b'\0\xff' and count == 1
    for invalid in ({**event['output']['data'][0], 'width': 3}, {**event['output']['data'][0], 'mask_base64': 'Af8='}, {**event['output']['data'][0], 'score': float('nan')}):
        try:
            validate_actual_mask(invalid, 2, 1, {'x': 1, 'y': 0})
        except AssertionError:
            pass
        else:
            raise AssertionError('Offline contract must reject invalid mask geometry, alpha or score.')
    observer.observe({'method': 'Network.requestWillBeSent', 'params': {'requestId': 'local', 'request': {'url': 'http://localhost:8001/segment', 'method': 'POST'}}})
    assert observer.local_sam_calls == 1
    observer.observe({'method': 'Network.requestWillBeSent', 'params': {'requestId': 'join', 'timestamp': 1, 'request': {'url': SPACE_ORIGIN + '/gradio_api/queue/join?', 'method': 'POST', 'postData': '{"fn_index":1,"data":[{}]}'}}})
    assert len(observer.jobs) == 1 and observer.jobs[0]['payload']['fn_index'] == 1
    assert safe_url(SPACE_ORIGIN + '/gradio_api/queue/data?session_hash=private') == SPACE_ORIGIN + '/gradio_api/queue/data'

    metadata = CloudObservedSocket(None)

    def request(request_id, path, method='GET', status=200, resource_type='Fetch'):
        metadata.observe({'method': 'Network.requestWillBeSent', 'params': {'requestId': request_id, 'type': resource_type,
                          'request': {'url': SPACE_ORIGIN + path, 'method': method, 'postData': '{}' if method == 'POST' else None}}})
        metadata.observe({'method': 'Network.responseReceived', 'params': {'requestId': request_id,
                          'response': {'status': status, 'mimeType': 'application/json'}}})

    def finish(request_id, failed=False):
        metadata.observe({'method': 'Network.loadingFailed' if failed else 'Network.loadingFinished',
                          'params': {'requestId': request_id, 'timestamp': 2}})

    class OfflineBodyBrowser:
        def __init__(self):
            self.calls = []
            self.failures = {}
            self.bodies = {'config': {'dependencies': [{'id': 1, 'api_name': 'segment'}]},
                           'info': {'api': {'named_endpoints': {'/segment': {}}}},
                           'join': {'event_id': 'offline-metadata-id'}}

        def call(self, method, params):
            assert method == 'Network.getResponseBody'
            request_id = params['requestId']
            assert metadata.requests[request_id]['finished'], 'Never read a body before loadingFinished.'
            assert metadata.requests[request_id]['method'] != 'OPTIONS', 'Never read a CORS preflight body.'
            self.calls.append(request_id)
            if self.failures.get(request_id, 0):
                self.failures[request_id] -= 1
                raise RuntimeError("Network.getResponseBody: {'code': -32000, 'message': 'No resource with given identifier found'}")
            raw = json.dumps(self.bodies[request_id]).encode()
            return {'body': base64.b64encode(raw).decode(), 'base64Encoded': True}

    offline = OfflineBodyBrowser()
    request('config', '/config')
    metadata.service(offline)
    assert not offline.calls and metadata.config is None
    finish('config')
    finish('config')
    assert metadata.metadata_pending == ['config'], 'Duplicate completion must enqueue one body read.'
    metadata.service(offline)
    assert metadata.config == offline.bodies['config'] and offline.calls == ['config']
    request('preflight', '/gradio_api/queue/join', 'OPTIONS', resource_type='Preflight')
    finish('preflight')
    request('redirect', '/config', status=302)
    finish('redirect')
    request('failed', '/gradio_api/info')
    finish('failed', failed=True)
    metadata.service(offline)
    assert offline.calls == ['config'] and not metadata.jobs
    request('config-duplicate', '/config')
    finish('config-duplicate')
    metadata.service(offline)
    assert offline.calls == ['config'], 'A duplicate config request must preserve captured metadata.'
    request('info', '/gradio_api/info')
    finish('info')
    offline.failures['info'] = 2
    for _ in range(3):
        metadata.requests['info']['metadata_retry_at'] = 0
        metadata.service(offline)
    assert metadata.info == offline.bodies['info']['api'] and offline.calls.count('info') == 3
    request('join', '/gradio_api/queue/join', 'POST')
    finish('join')
    finish('join')
    metadata.service(offline)
    assert len(metadata.jobs) == 1 and metadata.jobs[0]['event_id'] == 'offline-metadata-id'
    assert offline.calls.count('join') == 1 and metadata.jobs[0]['finished']
    # A permanently missing body exhausts a bounded retry budget without
    # preventing later duplicate metadata requests from completing observation.
    metadata.info = None
    request('missing', '/gradio_api/info')
    finish('missing')
    offline.failures['missing'] = MAX_METADATA_BODY_ATTEMPTS + 1
    for _ in range(MAX_METADATA_BODY_ATTEMPTS + 1):
        metadata.requests['missing']['metadata_retry_at'] = 0
        metadata.service(offline)
    assert offline.calls.count('missing') == MAX_METADATA_BODY_ATTEMPTS
    assert metadata.requests['missing']['metadata_state'] == 'unavailable' and not metadata.metadata_pending
    request('info-replacement', '/gradio_api/info')
    finish('info-replacement')
    offline.bodies['info-replacement'] = offline.bodies['info']
    metadata.service(offline)
    assert metadata.info == offline.bodies['info']['api']

    def queue_stream(finished=False):
        captured = CloudObservedSocket(None)
        captured.observe({'method': 'Network.requestWillBeSent', 'params': {'requestId': 'sse',
                          'request': {'url': SPACE_ORIGIN + '/gradio_api/queue/data', 'method': 'GET'}}})
        captured.observe({'method': 'Network.responseReceived', 'params': {'requestId': 'sse',
                          'response': {'status': 200, 'mimeType': 'text/event-stream'}}})
        if finished:
            captured.observe({'method': 'Network.loadingFinished', 'params': {'requestId': 'sse'}})
        return captured

    class OfflineSseBrowser:
        def __init__(self, captured, race=False, failures=0, encoded=False):
            self.captured, self.race, self.failures, self.encoded = captured, race, failures, encoded
            self.calls = []

        def call(self, method, params):
            assert params == {'requestId': 'sse'}
            self.calls.append(method)
            if method == 'Network.streamResourceContent':
                if self.race:
                    self.captured.observe({'method': 'Network.loadingFinished', 'params': {'requestId': 'sse'}})
                    raise RuntimeError('Network.streamResourceContent: Request with the provided ID has already finished loading')
                return {'bufferedData': base64.b64encode(raw[:len(raw) // 2]).decode()}
            assert method == 'Network.getResponseBody' and self.captured.requests['sse']['finished']
            if self.failures:
                self.failures -= 1
                raise RuntimeError('Network.getResponseBody: No resource with given identifier found')
            return {'body': base64.b64encode(raw).decode() if self.encoded else raw.decode(), 'base64Encoded': self.encoded}

    already_finished = queue_stream(finished=True)
    completed_browser = OfflineSseBrowser(already_finished)
    already_finished.service(completed_browser)
    assert completed_browser.calls == ['Network.getResponseBody']
    assert already_finished.completed['offline-contract-id'] == event
    already_finished.observe({'method': 'Network.dataReceived', 'params': {'requestId': 'sse', 'data': base64.b64encode(raw).decode()}})
    already_finished.observe({'method': 'Network.loadingFinished', 'params': {'requestId': 'sse'}})
    already_finished.service(completed_browser)
    assert len(already_finished.events) == 1, 'Completed-body fallback must not parse replayed stream chunks twice.'
    raced = queue_stream()
    raced_browser = OfflineSseBrowser(raced, race=True, encoded=True)
    raced.service(raced_browser)
    assert raced.stream_pending == ['sse'] and not raced.completed
    raced.service(raced_browser)
    assert raced_browser.calls == ['Network.streamResourceContent', 'Network.getResponseBody']
    assert raced.completed['offline-contract-id'] == event and len(raced.events) == 1
    delayed = queue_stream(finished=True)
    delayed_browser = OfflineSseBrowser(delayed, failures=1)
    delayed.service(delayed_browser)
    assert delayed.stream_pending == ['sse']
    delayed.streams['sse']['body_retry_at'] = 0
    delayed.service(delayed_browser)
    assert delayed.completed['offline-contract-id'] == event and len(delayed_browser.calls) == 2
    live = queue_stream()
    live_browser = OfflineSseBrowser(live)
    live.service(live_browser)
    live.observe({'method': 'Network.dataReceived', 'params': {'requestId': 'sse', 'data': base64.b64encode(raw[len(raw) // 2:]).decode()}})
    live.observe({'method': 'Network.loadingFinished', 'params': {'requestId': 'sse'}})
    live.service(live_browser)
    assert live_browser.calls == ['Network.streamResourceContent'] and live.completed['offline-contract-id'] == event
    missing_stream = queue_stream(finished=True)
    missing_browser = OfflineSseBrowser(missing_stream, failures=MAX_STREAM_BODY_ATTEMPTS + 1)
    for attempt in range(MAX_STREAM_BODY_ATTEMPTS):
        missing_stream.streams['sse']['body_retry_at'] = 0
        try:
            missing_stream.service(missing_browser)
        except AssertionError as error:
            assert attempt == MAX_STREAM_BODY_ATTEMPTS - 1 and 'bounded CDP retries' in str(error)
            break
    else:
        raise AssertionError('Unavailable completed SSE body must exhaust its bounded retry budget.')
    assert len(missing_browser.calls) == MAX_STREAM_BODY_ATTEMPTS and not missing_stream.completed
    print('PASS: offline observer/parser/mask contracts; no browser, network or inference calls.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--photo', type=Path, default=ROOT / 'artifacts/sam3-runtime/truck.jpg')
    parser.add_argument('--tap-x', type=float, default=.611111)
    parser.add_argument('--tap-y', type=float, default=.4666667)
    parser.add_argument('--dist', type=Path, default=ROOT / 'dist')
    parser.add_argument('--url', help='An already-running loopback production preview; otherwise serve the real dist directly.')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/real-cloud-sam3-ui')
    parser.add_argument('--timeout', type=float, default=180, help='Acceptance deadline in seconds, maximum 180; production timers are unchanged.')
    parser.add_argument('--local-sam-port', type=int, default=8001)
    parser.add_argument('--port', type=int, default=9236)
    parser.add_argument('--mobile', action='store_true', help='Use a 390×844 emulated mobile viewport and real CDP touch input (not physical-device proof).')
    parser.add_argument('--chrome', default=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    args.photo, args.dist, args.output = args.photo.resolve(), args.dist.resolve(), args.output.resolve()
    if not args.photo.is_file() or hashlib.sha256(args.photo.read_bytes()).hexdigest() != TRUCK_SHA256:
        parser.error('Use the existing official Meta truck.jpg fixture; the expected content hash must match.')
    if not 0 < args.tap_x < 1 or not 0 < args.tap_y < 1 or not 0 < args.timeout <= 180:
        parser.error('Tap fractions must lie strictly inside the photo and timeout must be greater than zero and at most 180 seconds.')
    if args.url:
        parsed = urllib.parse.urlsplit(args.url)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password or parsed.query or parsed.fragment:
            parser.error('Preview URL must be loopback HTTP with no credentials, query or fragment.')
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'status': 'failed', 'real_inference': False, 'attempted_real_inference': False, 'mocked_transport': False,
              'space': SPACE, 'space_origin': SPACE_ORIGIN, 'mode': 'emulated-mobile' if args.mobile else 'desktop-browser',
              'physical_mobile_verified': False, 'checks': [], 'screenshots': []}
    server = process = browser = observer = None
    try:
        report['build'] = build_contract(args.dist)
        assert_local_sam_off(args.local_sam_port)
        report['local_sam_port_off'] = args.local_sam_port
        if args.url:
            url = args.url
            with urllib.request.urlopen(url, timeout=5) as response:
                assert response.status == 200 and b'/@vite/client' not in response.read(), 'Use a production preview, not the Vite development server.'
        else:
            server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), partial(http.server.SimpleHTTPRequestHandler, directory=str(args.dist)))
            server.daemon_threads = True
            threading.Thread(target=server.serve_forever, daemon=True).start()
            url = f'http://127.0.0.1:{server.server_port}'
        profile = Path(tempfile.mkdtemp(prefix='isolated-real-cloud-', dir=args.output))
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
        browser = ObservedBrowser(target['webSocketDebuggerUrl'])
        observer = CloudObservedSocket(browser.socket)
        browser.socket = observer
        verify(browser, observer, args, url, args.output, report)
    except Exception as error:
        # Do not serialize captured request bodies, SSE mask bytes or raw remote errors.
        message = str(error)
        report.update(status='failed', error=message[:500] if 'data:image/' not in message and 'hf_' not in message else 'Verification failed; sensitive payload omitted.',
                      last_command=browser.last_command if browser else 'production build/local-off/browser startup',
                      submitted_jobs=len(observer.jobs) if observer else 0, local_sam_requests=observer.local_sam_calls if observer else 0,
                      browser_error_count=len(browser.errors) if browser else 0)
        if browser:
            try:
                browser.evaluate("Array.from(" + PAGE + ".querySelectorAll('button')).find(button=>button.textContent.trim()==='Cancel')?.click()")
                shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
                (args.output / 'real-cloud-ui-failure.png').write_bytes(base64.b64decode(shot['data']))
            except Exception:
                pass
    finally:
        (args.output / 'real-cloud-ui-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
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
        if server:
            server.shutdown()
            server.server_close()
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
