"""Verify the official public CHROMA SAM 3 Space anonymously, without SDK/auth.

Default: real config, /info, OpenAPI, no-GPU /run/health, and Android-origin
CORS preflights. Real GPU inference requires --segment; --repeat 2 adds one
subsequent request. --self-test exercises only offline parser contracts.

  python scripts/verify_real_cloud_sam3_api.py --self-test
  python scripts/verify_real_cloud_sam3_api.py
  python scripts/verify_real_cloud_sam3_api.py --segment --repeat 2

Positional Gradio call/SSE protocol:
https://www.gradio.app/guides/querying-gradio-apps-with-curl
OpenAPI and legacy/v2 call routes in the pinned runtime:
https://github.com/gradio-app/gradio/blob/gradio%406.29.1/gradio/routes.py

No token, cookies, account configuration, environment credentials, browser,
deployment mutation, model substitution or automatic retry is used.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import io
import json
import math
from pathlib import Path
import re
import socket
import time
import urllib.error
import urllib.request

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SPACE = 'Vizhodhan/chroma-sam3'
BASE = 'https://vizhodhan-chroma-sam3.hf.space'
SOURCE_COMMIT = '0570b3a5be9c4e694f23d85232fb55f4a6f1f7fc'
TRUCK_SHA256 = '941715e721c8864324a1425b445ea4dde0498b995c45ddce0141a58971c6ff99'
TRUCK_SOURCE = f'https://raw.githubusercontent.com/facebookresearch/sam3/{SOURCE_COMMIT}/assets/images/truck.jpg'
WIDTH, HEIGHT = 1200, 800
POINT = {'x': 733, 'y': 373, 'label': 1}
MAX_BODY_BYTES = 12 * 1024 * 1024
MAX_STREAM_BYTES = 20 * 1024 * 1024
ANDROID_ORIGINS = ('http://localhost', 'https://localhost')


class VerificationFailure(Exception):
    """Only fixed safe codes are printed; never arbitrary remote diagnostics."""
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def require(condition, code):
    if not condition:
        raise VerificationFailure(code)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class AnonymousHttp:
    def __init__(self):
        # A fresh opener has no cookies/auth; disable environment proxy lookup.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.calls = []

    def open(self, path, *, body=None, method=None, timeout=20, headers=None):
        require(path.startswith('/') and '?' not in path and '#' not in path, 'invalid_public_api_path')
        request_headers = {'User-Agent': 'CHROMA-public-SAM3-verification/1', 'Accept': 'application/json'}
        request_headers.update(headers or {})
        require(not any(key.lower() in ('authorization', 'cookie', 'proxy-authorization') for key in request_headers), 'credential_header_rejected')
        encoded = None if body is None else json.dumps(body, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if encoded is not None:
            require(len(encoded) <= MAX_BODY_BYTES, 'request_body_limit_exceeded')
            request_headers['Content-Type'] = 'application/json'
        verb = method or ('POST' if body is not None else 'GET')
        request = urllib.request.Request(BASE + path, data=encoded, headers=request_headers, method=verb)
        started = time.monotonic()
        response = self.opener.open(request, timeout=max(.001, timeout))
        require(response.geturl() == BASE + path, 'unexpected_api_redirect')
        self.calls.append({'method': verb, 'path': path, 'status': response.status,
                           'header_seconds': round(time.monotonic() - started, 3)})
        return response

    def json(self, path, *, body=None, timeout=20, headers=None):
        started = time.monotonic()
        with self.open(path, body=body, timeout=timeout, headers=headers) as response:
            require(response.status == 200, 'json_api_http_status')
            require('application/json' in response.headers.get('Content-Type', ''), 'json_api_content_type')
            raw = response.read(MAX_BODY_BYTES + 1)
            require(len(raw) <= MAX_BODY_BYTES, 'json_response_limit_exceeded')
            value = json.loads(raw)
            evidence = {'status': response.status, 'seconds': round(time.monotonic() - started, 3),
                        'cache_control': response.headers.get('Cache-Control', ''), 'response_bytes': len(raw)}
        return value, evidence


def published_contract(config, info, openapi):
    require(isinstance(config, dict) and not config.get('auth_required'), 'public_config_requires_auth')
    require(config.get('run_history') is False, 'public_run_history_not_disabled')
    require(config.get('api_prefix') == '/gradio_api', 'unexpected_gradio_api_prefix')
    dependencies = {str(dep.get('api_name', '')).lstrip('/'): dep for dep in config.get('dependencies', [])}
    require('health' in dependencies and 'segment' in dependencies, 'named_config_endpoints_missing')
    health, segment = dependencies['health'], dependencies['segment']
    require(health.get('inputs') == [] and health.get('queue') is False, 'health_must_have_no_inputs_and_no_queue')
    require(segment.get('queue') is True and len(segment.get('inputs', [])) == 1, 'segment_must_queue_one_json_input')
    require(health.get('api_visibility', 'public') != 'private' and segment.get('api_visibility', 'public') != 'private', 'required_named_endpoint_is_private')
    components = {item['id']: item for item in config.get('components', [])}
    component = components.get(segment['inputs'][0], {})
    require(str(component.get('type', '')).lower() == 'json' and component.get('props', {}).get('label') == 'request', 'segment_input_must_be_request_json')
    for dependency in (health, segment):
        outputs = dependency.get('outputs', [])
        require(len(outputs) == 1 and str(components.get(outputs[0], {}).get('type', '')).lower() == 'json', 'named_endpoint_output_must_be_one_json')
    info = info.get('api', info)
    named = info.get('named_endpoints', {})
    require('/health' in named and '/segment' in named, 'named_info_endpoints_missing')
    require(named['/health'].get('parameters') == [], 'health_info_inputs_must_be_empty')
    parameters = named['/segment'].get('parameters', [])
    require(len(parameters) == 1 and parameters[0].get('parameter_name') == 'request'
            and str(parameters[0].get('component', '')).lower() == 'json'
            and parameters[0].get('parameter_has_default') is False, 'segment_info_required_request_json_missing')
    require(len(named['/health'].get('returns', [])) == 1 and len(named['/segment'].get('returns', [])) == 1, 'named_info_must_return_one_output')
    require(str(openapi.get('openapi', '')).startswith('3.'), 'openapi_3_contract_missing')
    paths = openapi.get('paths', {})
    # Gradio 6.29 documents named request properties under call/v2; legacy
    # positional call remains available and uses the same SSE result route.
    post_path = '/gradio_api/call/v2/segment'
    post = paths.get(post_path, {}).get('post', {})
    schema = post.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema', {})
    require(schema.get('type') == 'object' and set(schema.get('properties', {})) == {'request'}, 'openapi_named_segment_request_property_missing')
    require('post' in paths.get('/gradio_api/call/v2/health', {}), 'openapi_named_health_missing')
    for name in ('health', 'segment'):
        result = paths.get(f'/gradio_api/call/{name}/{{event_id}}', {}).get('get', {})
        require('text/event-stream' in result.get('responses', {}).get('200', {}).get('content', {}), 'openapi_named_sse_result_missing')
    return {'gradio_version': config.get('version'), 'health_fn_index': health['id'], 'segment_fn_index': segment['id'],
            'segment_parameter': 'request', 'segment_component': 'JSON', 'openapi_post': post_path,
            'inference_post': '/gradio_api/call/segment', 'inference_get': '/gradio_api/call/segment/{event_id}',
            'health_queue': False, 'run_history': False, 'anonymous': True}


def health_summary(response):
    require(isinstance(response, dict) and len(response.get('data', [])) == 1, 'health_requires_single_gradio_output')
    value = response['data'][0]
    require(isinstance(value, dict) and isinstance(value.get('ready'), bool), 'health_readiness_boolean_missing')
    require(value.get('provider') == 'huggingface-zerogpu' and value.get('model') == 'sam3', 'health_provider_or_model_mismatch')
    require(value.get('version') == SOURCE_COMMIT and isinstance(value.get('message'), str), 'health_official_source_pin_mismatch')
    message = value['message']
    reason = 'weights_loaded' if value['ready'] else 'not_ready'
    if not value['ready']:
        if message.startswith('Model access is not configured.'):
            reason = 'model_access_not_configured'
        elif message.startswith('SAM 3 could not initialize.'):
            reason = 'model_initialization_failed'
    return {'ready': value['ready'], 'provider': value['provider'], 'model': value['model'],
            'version': value['version'], 'reason': reason, 'gpu_requested': False}


def check_cors(headers, status, origin):
    require(status in (200, 204), 'android_cors_preflight_http_status')
    allowed_origin = headers.get('Access-Control-Allow-Origin', '')
    require(allowed_origin in (origin, '*'), 'android_cors_origin_not_allowed')
    methods = {part.strip().upper() for part in headers.get('Access-Control-Allow-Methods', '').split(',')}
    require('POST' in methods or '*' in methods, 'android_cors_post_not_allowed')
    fields = {part.strip().lower() for part in headers.get('Access-Control-Allow-Headers', '').split(',')}
    require('content-type' in fields or '*' in fields, 'android_cors_json_header_not_allowed')
    return {'origin': origin, 'status': status, 'allow_origin': allowed_origin, 'post_allowed': True, 'json_content_type_allowed': True}


def cors_preflights(http):
    evidence = []
    for origin in ANDROID_ORIGINS:
        for path in ('/gradio_api/run/health', '/gradio_api/queue/join', '/gradio_api/call/segment'):
            with http.open(path, method='OPTIONS', headers={'Origin': origin, 'Access-Control-Request-Method': 'POST',
                           'Access-Control-Request-Headers': 'content-type'}) as response:
                result = check_cors(response.headers, response.status, origin)
                result['path'] = path
                evidence.append(result)
    return evidence


def sse_events(response, deadline):
    """Bound line/body bytes and remaining socket time; never print SSE data."""
    event, lines, total = 'message', [], 0
    while True:
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'segment_deadline_exceeded')
        network_socket = getattr(getattr(getattr(response, 'fp', None), 'raw', None), '_sock', None)
        if network_socket is not None:
            network_socket.settimeout(remaining)
        raw = response.readline(MAX_BODY_BYTES + 1)
        total += len(raw)
        require(len(raw) <= MAX_BODY_BYTES and total <= MAX_STREAM_BYTES, 'segment_stream_size_exceeded')
        if not raw:
            if lines:
                yield event, json.loads('\n'.join(lines))
            return
        line = raw.decode('utf-8').rstrip('\r\n')
        if not line:
            if lines:
                yield event, json.loads('\n'.join(lines))
            event, lines = 'message', []
        elif line.startswith('event:'):
            event = line[6:].lstrip(' ')
        elif line.startswith('data:'):
            lines.append(line[5:].lstrip(' '))


def output_mask(data, width=WIDTH, height=HEIGHT, point=POINT):
    require(isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict), 'segment_requires_single_json_output')
    value = data[0]
    if 'error' in value:
        code = value['error'].get('code') if isinstance(value['error'], dict) else None
        safe = code if code in ('no_object', 'quota', 'timeout', 'unavailable', 'invalid_request') else 'unavailable'
        raise VerificationFailure('segment_remote_' + safe)
    require(value.get('model') == 'sam3', 'segment_model_mismatch')
    require((value.get('width'), value.get('height')) == (width, height), 'segment_mask_dimensions_mismatch')
    score = value.get('score')
    require(isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score) and 0 <= score <= 1, 'segment_score_invalid')
    require(isinstance(value.get('mask_base64'), str), 'segment_mask_encoding_missing')
    alpha = base64.b64decode(value['mask_base64'], validate=True)
    require(len(alpha) == width * height, 'segment_mask_byte_count_mismatch')
    require(set(alpha).issubset({0, 255}), 'segment_mask_not_binary')
    count = alpha.count(255)
    require(0 < count < len(alpha), 'segment_mask_empty_or_all_selected')
    require(alpha[int(point['y']) * width + int(point['x'])] == 255, 'segment_positive_tap_not_selected')
    return alpha, {'model': 'sam3', 'width': width, 'height': height, 'score': score, 'mask_byte_count': len(alpha),
                   'selected_pixels': count, 'coverage_percent': round(count / len(alpha) * 100, 4),
                   'tap_selected': True, 'mask_sha256': hashlib.sha256(alpha).hexdigest()}


def working_photo(path):
    require(path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == TRUCK_SHA256, 'official_truck_fixture_hash_mismatch')
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert('RGB')
    image.thumbnail((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    require(image.size == (WIDTH, HEIGHT), 'official_truck_working_geometry_mismatch')
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    raw = stream.getvalue()
    payload = {'image': 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii'),
               'width': WIDTH, 'height': HEIGHT, 'points': [dict(POINT)]}
    evidence = {'name': path.name, 'source': TRUCK_SOURCE, 'sha256': TRUCK_SHA256,
                'working_png_sha256': hashlib.sha256(raw).hexdigest(), 'width': WIDTH, 'height': HEIGHT,
                'points': [dict(POINT)]}
    return image, payload, evidence


def segment_once(http, payload, contract, timeout):
    started, event_id, succeeded = time.monotonic(), None, False
    deadline = started + timeout
    try:
        submitted, post = http.json('/gradio_api/call/segment', body={'data': [payload]}, timeout=timeout)
        event_id = submitted.get('event_id') if isinstance(submitted, dict) else None
        require(isinstance(event_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', event_id), 'segment_queue_event_id_invalid')
        require(time.monotonic() < deadline, 'segment_deadline_exceeded')
        path = '/gradio_api/call/segment/' + event_id
        event_types = []
        with http.open(path, timeout=deadline - time.monotonic(), headers={'Accept': 'text/event-stream'}) as response:
            require(response.status == 200 and 'text/event-stream' in response.headers.get('Content-Type', ''), 'segment_sse_response_invalid')
            for event, data in sse_events(response, deadline):
                event_types.append(event if event in ('complete', 'generating', 'heartbeat', 'error') else 'other')
                if event == 'error':
                    raise VerificationFailure('segment_gradio_sse_error')
                if event == 'complete':
                    alpha, result = output_mask(data)
                    succeeded = True
                    return alpha, {**result, 'event_id': event_id, 'post_status': post['status'], 'sse_status': response.status,
                                   'queue_submit_seconds': post['seconds'], 'wall_seconds': round(time.monotonic() - started, 3),
                                   'sse_events': event_types, 'cache_control': response.headers.get('Cache-Control', '')}
        raise VerificationFailure('segment_sse_complete_event_missing')
    finally:
        if event_id and not succeeded:
            # In positional simple-format requests Gradio uses event_id as the
            # session hash. Best effort release; never retry the segmentation.
            try:
                http.json('/gradio_api/cancel', body={'event_id': event_id, 'session_hash': event_id,
                          'fn_index': contract['segment_fn_index']}, timeout=5)
            except Exception:
                pass


def save_mask_overlay(image, alpha, output, index):
    mask_path, overlay_path = output / f'actual-mask-{index}.png', output / f'actual-overlay-{index}.png'
    mask = Image.frombytes('L', (WIDTH, HEIGHT), alpha)
    mask.save(mask_path)
    tint = Image.new('RGBA', (WIDTH, HEIGHT), (67, 123, 242, 0))
    tint.putalpha(mask.point(lambda value: 122 if value else 0))
    Image.alpha_composite(image.convert('RGBA'), tint).save(overlay_path)
    return {'mask': str(mask_path), 'overlay': str(overlay_path)}


def self_test():
    config = {'version': '6.29.1', 'api_prefix': '/gradio_api', 'run_history': False, 'auth_required': False,
              'components': [{'id': 1, 'type': 'json', 'props': {'label': 'request'}}, {'id': 2, 'type': 'json'}],
              'dependencies': [{'id': 0, 'api_name': 'health', 'inputs': [], 'outputs': [2], 'queue': False},
                               {'id': 1, 'api_name': 'segment', 'inputs': [1], 'outputs': [2], 'queue': True}]}
    info = {'named_endpoints': {'/health': {'parameters': [], 'returns': [{}]},
            '/segment': {'parameters': [{'parameter_name': 'request', 'component': 'Json', 'parameter_has_default': False}], 'returns': [{}]}}}
    stream = {'get': {'responses': {'200': {'content': {'text/event-stream': {}}}}}}
    openapi = {'openapi': '3.0.2', 'paths': {
        '/gradio_api/call/v2/segment': {'post': {'requestBody': {'content': {'application/json': {'schema': {'type': 'object', 'properties': {'request': {}}}}}}}},
        '/gradio_api/call/v2/health': {'post': {}}, '/gradio_api/call/segment/{event_id}': stream, '/gradio_api/call/health/{event_id}': stream}}
    assert published_contract(config, info, openapi)['segment_fn_index'] == 1
    assert published_contract(config, {'api': info}, openapi)['segment_parameter'] == 'request'
    for mutation, code in ((lambda c: c.update(run_history=True), 'public_run_history_not_disabled'),
                           (lambda c: c['components'][0]['props'].update(label='other'), 'segment_input_must_be_request_json')):
        invalid = copy.deepcopy(config)
        mutation(invalid)
        try:
            published_contract(invalid, info, openapi)
        except VerificationFailure as error:
            assert error.code == code
        else:
            raise AssertionError('Invalid published contract accepted.')
    health = health_summary({'data': [{'ready': False, 'provider': 'huggingface-zerogpu', 'model': 'sam3',
                           'version': SOURCE_COMMIT, 'message': 'SAM 3 could not initialize. A private remote message is not copied.'}]})
    assert health['reason'] == 'model_initialization_failed' and 'message' not in health
    good = {'model': 'sam3', 'width': 2, 'height': 1, 'score': .9, 'mask_base64': 'AP8='}
    raw = ('event: heartbeat\r\ndata: null\r\n\r\nevent: complete\ndata: ' + json.dumps([good]) + '\n\n').encode()
    events = list(sse_events(io.BytesIO(raw), time.monotonic() + 5))
    assert events[0] == ('heartbeat', None) and events[1][0] == 'complete'
    alpha, result = output_mask(events[1][1], 2, 1, {'x': 1, 'y': 0})
    assert alpha == b'\0\xff' and result['mask_byte_count'] == 2 and 'mask_base64' not in result
    for field, value in (('width', 3), ('mask_base64', 'Af8='), ('score', float('nan'))):
        try:
            output_mask([{**good, field: value}], 2, 1, {'x': 1, 'y': 0})
        except VerificationFailure:
            pass
        else:
            raise AssertionError('Invalid model response accepted.')
    headers = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type'}
    assert all(check_cors(headers, 200, origin)['post_allowed'] for origin in ANDROID_ORIGINS)
    try:
        check_cors({**headers, 'Access-Control-Allow-Origin': 'https://wrong.example'}, 200, ANDROID_ORIGINS[0])
    except VerificationFailure as error:
        assert error.code == 'android_cors_origin_not_allowed'
    else:
        raise AssertionError('Invalid Android CORS origin accepted.')
    print('PASS: offline config/OpenAPI/health/SSE/mask/CORS contracts; no HTTP requests or inference.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--segment', action='store_true', help='Explicitly submit real ZeroGPU inference; default checks use no GPU.')
    parser.add_argument('--repeat', type=int, choices=(1, 2), default=1, help='One or two sequential real jobs, only with --segment.')
    parser.add_argument('--timeout', type=float, default=180, help='Per-job deadline, at most 180 seconds.')
    parser.add_argument('--photo', type=Path, default=ROOT / 'artifacts/sam3-runtime/truck.jpg')
    parser.add_argument('--output', type=Path, default=ROOT / 'artifacts/real-cloud-sam3-api')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not 0 < args.timeout <= 180 or (not args.segment and args.repeat != 1):
        parser.error('Timeout must be greater than zero and at most 180 seconds; --repeat 2 requires --segment.')
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    report = {'status': 'failed', 'space': SPACE, 'base_url': BASE, 'anonymous': True, 'auth_headers_sent': False,
              'mocked_transport': False, 'real_inference': False, 'inference_requested': args.segment,
              'requested_jobs': args.repeat if args.segment else 0, 'completed_jobs': [], 'checks': []}
    http = AnonymousHttp()
    started = time.monotonic()
    try:
        config, config_http = http.json('/config')
        info, info_http = http.json('/gradio_api/info')
        openapi, openapi_http = http.json('/gradio_api/openapi.json')
        report['contract'] = published_contract(config, info, openapi)
        report['metadata_http'] = {'config': config_http, 'info': info_http, 'openapi': openapi_http}
        report['checks'].append('Public config, named health/segment JSON contract and OpenAPI request parameter verified without authorization.')
        response, health_http = http.json('/gradio_api/run/health', body={'data': []})
        report['health'] = health_summary(response)
        report['health_http'] = health_http
        report['cors'] = cors_preflights(http)
        report['checks'].append('Android http://localhost and https://localhost JSON POST preflights pass for health, Gradio queue and positional call routes.')
        if args.segment:
            require(report['health']['ready'], 'model_not_ready_no_segment_submitted')
            image, payload, photo = working_photo(args.photo.resolve())
            report['photo'] = photo
            for index in range(1, args.repeat + 1):
                alpha, result = segment_once(http, payload, report['contract'], args.timeout)
                result.update(index=index, measurement='first request in this harness' if index == 1 else 'subsequent request to the same public Space',
                              artifacts=save_mask_overlay(image, alpha, args.output, index))
                report['completed_jobs'].append(result)
                report['real_inference'] = True
            report['checks'].append('Real public Gradio positional call/SSE masks have exact working geometry, binary bytes, nonempty object/background, positive tap and finite score.')
        report['status'] = 'passed' if report['health']['ready'] else 'not_ready'
        report['checks'].append('Health status uses no GPU allocation; inference runs only when explicitly requested.')
    except VerificationFailure as error:
        report['error_code'] = error.code
    except urllib.error.HTTPError as error:
        report['error_code'] = f'public_api_http_{error.code}'
    except (TimeoutError, socket.timeout):
        report['error_code'] = 'public_api_timeout'
    except urllib.error.URLError:
        report['error_code'] = 'public_api_network_error'
    except (ValueError, TypeError, KeyError):
        report['error_code'] = 'public_api_invalid_payload_or_encoding'
    except Exception:
        report['error_code'] = 'public_api_verification_failed'
    finally:
        report['wall_seconds'] = round(time.monotonic() - started, 3)
        report['http_calls'] = http.calls
        report['note'] = 'Wall timings include public queue/network and inference. First-in-harness is not proof of a cold worker. CORS headers are not physical Android acceptance.'
        (args.output / 'real-cloud-api-verification.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
