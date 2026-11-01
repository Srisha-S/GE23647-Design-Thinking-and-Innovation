"""Exercise production Visualize with the real Gradio JS client and local mocks.

Build an isolated production copy with VITE_CHROMA_SAM_SPACE set to
https://chroma-ui-fixture.hf.space, then run this script. CDP rewrites every
fixture request to a loopback Gradio-protocol mock and blocks other remote
requests. No Hugging Face account, Space, checkpoint or GPU is contacted.
This establishes browser behavior only, never real cloud inference.
"""
from __future__ import annotations

import argparse
import base64
from functools import partial
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import check_chroma
from check_chroma import Browser
from verify_real_sam3_ui import canvas_pointer, mask_summary, screenshot

ROOT = Path(__file__).resolve().parents[1]
SPACE = "https://chroma-ui-fixture.hf.space"
PAGE = "document.querySelector('[data-page=visualize]:not([hidden])')"
CANVAS = "document.querySelector('#visualize-canvas')"
OVERLAY = "document.querySelector('.visualize-mask-overlay')"


def fixture_config():
    return {
        "version": "6.29.1", "mode": "blocks", "app_id": "chroma-browser-mock",
        "root": SPACE, "api_prefix": "/gradio_api", "protocol": "sse_v3",
        "enable_queue": True, "auth_required": False, "analytics_enabled": False,
        "run_history": False, "connect_heartbeat": False, "space_id": None,
        "components": [
            {"id": 1, "type": "json", "props": {"label": "Model status"}, "skip_api": False},
            {"id": 2, "type": "json", "props": {"label": "request"}, "skip_api": False},
            {"id": 3, "type": "json", "props": {"label": "Selection result"}, "skip_api": False},
        ],
        "dependencies": [
            {"id": 0, "api_name": "health", "api_visibility": "public", "inputs": [], "outputs": [1], "queue": False, "backend_fn": True, "types": {"generator": False, "continuous": False}},
            {"id": 1, "api_name": "segment", "api_visibility": "public", "inputs": [2], "outputs": [3], "queue": True, "backend_fn": True, "types": {"generator": False, "continuous": False}},
        ],
    }


def fixture_info():
    output = {"label": "Selection result", "type": {"type": {}, "description": "any valid json"}, "python_type": {"type": "dict", "description": ""}, "component": "Json"}
    return {"named_endpoints": {
        "/health": {"parameters": [], "returns": [output], "api_visibility": "public"},
        "/segment": {"parameters": [{"label": "request", "parameter_name": "request", "parameter_has_default": False, "parameter_default": None, "type": {"type": {}, "description": "any valid json"}, "python_type": {"type": "dict", "description": ""}, "component": "Json"}], "returns": [output], "api_visibility": "public"},
    }, "unnamed_endpoints": {}}


class FixtureJob:
    def __init__(self, identifier, payload, mode, session):
        self.identifier, self.payload, self.mode, self.session = identifier, payload, mode, session
        self.start = threading.Event()
        self.complete = threading.Event()
        self.cancelled = threading.Event()
        self.stream_open = threading.Event()


class FixtureState:
    def __init__(self):
        self.jobs = []
        self.cancelled_ids = []
        self.mode = "success"
        self.lock = threading.Lock()

    def new_job(self, body):
        with self.lock:
            data = body.get("data", [])
            assert len(data) == 1 and isinstance(data[0], dict), "The named API must carry one JSON request."
            job = FixtureJob("mock-job-" + str(len(self.jobs) + 1), data[0], self.mode, body.get("session_hash"))
            self.jobs.append(job)
            return job

    def job_for_session(self, session):
        return next((job for job in reversed(self.jobs) if job.session == session), None)


class MockHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # Never write submitted photo JSON, paths or payloads to a log.

    @property
    def state(self):
        return self.server.fixture

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def json_response(self, body, status=200):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self):
        self.json_response({})

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path.removeprefix("/__mock")
        if not url.path.startswith("/__mock"):
            return super().do_GET()
        if path == "/config":
            return self.json_response(fixture_config())
        if path == "/gradio_api/info":
            return self.json_response(fixture_info())
        if path == "/gradio_api/app_id":
            return self.json_response({"app_id": "chroma-browser-mock"})
        if path == "/gradio_api/queue/data":
            session = urllib.parse.parse_qs(url.query).get("session_hash", [None])[0]
            job = self.state.job_for_session(session)
            if job is None:
                return self.json_response({"error": "Unknown synthetic session."}, 400)
            return self.sse_job(job)
        return self.json_response({"error": "Unexpected synthetic API path."}, 404)

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        path = url.path.removeprefix("/__mock")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        if path == "/gradio_api/queue/join":
            job = self.state.new_job(body)
            return self.json_response({"event_id": job.identifier})
        if path in ("/gradio_api/cancel", "/cancel"):
            identifier = body.get("event_id")
            self.state.cancelled_ids.append(identifier)
            for job in self.state.jobs:
                if job.identifier == identifier:
                    job.cancelled.set()
            return self.json_response({})
        if path in ("/gradio_api/reset", "/reset"):
            return self.json_response({})
        if path == "/gradio_api/run/health":
            return self.json_response({"data": [{"ready": True, "provider": "huggingface-zerogpu", "model": "sam3", "version": "unit-fixture", "message": "Synthetic browser test only."}]})
        return self.json_response({"error": "Unexpected synthetic API path."}, 404)

    def sse_job(self, job):
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def send(message):
            self.wfile.write(("data: " + json.dumps(message) + "\n\n").encode())
            self.wfile.flush()

        try:
            send({"msg": "estimation", "event_id": job.identifier, "rank": 2, "queue_size": 3, "rank_eta": 5})
            job.stream_open.set()
            if not job.start.wait(30):
                return
            # The actual non-generative Gradio protocol emits process_starts,
            # whose SDK status is pending + original_msg=process_starts.
            send({"msg": "process_starts", "event_id": job.identifier, "eta": 1})
            if not job.complete.wait(30):
                return
            output = self.result(job)
            send({"msg": "process_completed", "event_id": job.identifier, "success": True, "output": {"data": [output]}})
            send({"msg": "close_stream"})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def result(self, job):
        if job.mode in ("quota", "unavailable", "no_object"):
            return {"error": {"code": job.mode, "message": "private-photo secret-placeholder /private/runtime must stay hidden", "retryable": job.mode != "quota"}}
        width, height = job.payload["width"], job.payload["height"]
        mask = bytearray(width * height)
        point = job.payload["points"][0]
        x, y = int(point["x"]), int(point["y"])
        for row in range(max(0, y - 20), min(height, y + 21)):
            for column in range(max(0, x - 20), min(width, x + 21)):
                mask[row * width + column] = 255
        if job.mode == "invalid_mask":
            mask = mask[:-1]
        return {"width": width, "height": height, "model": "sam3", "score": .9, "mask_base64": base64.b64encode(mask).decode()}


class RedirectedSocket:
    """CDP interception; fixture network always terminates on loopback."""
    def __init__(self, socket, mock_origin):
        self.socket, self.mock_origin = socket, mock_origin
        self.sequence = -1000
        self.intercepted = []
        self.blocked = []
        self.local_sam_calls = 0

    def __getattr__(self, name):
        return getattr(self.socket, name)

    def recv(self):
        while True:
            raw = self.socket.recv()
            message = json.loads(raw)
            if isinstance(message.get("id"), int) and message["id"] < 0:
                if "error" in message:
                    raise RuntimeError("Synthetic network interception failed: " + message["error"]["message"])
                continue
            if message.get("method") == "Fetch.requestPaused":
                params = message["params"]
                request = params["request"]
                url = urllib.parse.urlparse(request["url"])
                payload = {"requestId": params["requestId"]}
                if request["url"].startswith(SPACE + "/"):
                    self.intercepted.append({"url": request["url"], "method": request["method"]})
                    payload["url"] = self.mock_origin + "/__mock" + url.path + ("?" + url.query if url.query else "")
                    method = "Fetch.continueRequest"
                elif url.hostname in ("127.0.0.1", "localhost"):
                    self.local_sam_calls += int(url.port == 8001)
                    method = "Fetch.continueRequest"
                elif url.hostname == "fonts.googleapis.com":
                    # Fonts are unrelated to this test. Supply empty CSS so the
                    # isolated browser uses local fallbacks without external I/O.
                    self.blocked.append(request["url"])
                    method = "Fetch.fulfillRequest"
                    payload.update(responseCode=200, responseHeaders=[{"name": "Content-Type", "value": "text/css"}], body="")
                else:
                    self.blocked.append(request["url"])
                    method = "Fetch.failRequest"
                    payload["errorReason"] = "BlockedByClient"
                self.sequence -= 1
                self.socket.send(json.dumps({"id": self.sequence, "method": method, "params": payload}))
                continue
            return raw


def settled(browser):
    browser.evaluate("new Promise(resolve=>setTimeout(resolve,100))")


def snapshot(browser):
    return browser.evaluate("""(() => {
      const c=document.querySelector('#visualize-canvas'),o=document.querySelector('.visualize-mask-overlay');
      function digest(canvas){const d=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let h=0;for(const v of d)h=(Math.imul(h,31)+v)|0;return {width:canvas.width,height:canvas.height,hash:h};}
      return {photo:document.querySelector('.visualize-photo-info img')?.src,target:document.querySelector('[data-testid=visualize-target]')?.textContent,canvas:digest(c),mask:digest(o)};
    })()""")


def assert_preserved(browser, before):
    after = snapshot(browser)
    assert after == before, "Photo, target, pixels and mask must survive cloud failure/cancellation."


def click_text(browser, label):
    browser.click_text(label, scope=PAGE)
    settled(browser)


def tap_and_queue(browser, state, mode="success"):
    state.mode = mode
    before = len(state.jobs)
    canvas_pointer(browser, (.25, .5))
    browser.wait("document.querySelector('.visualize-progress')?.textContent.includes('Queued')", timeout=15)
    deadline = time.monotonic() + 10
    while len(state.jobs) == before and time.monotonic() < deadline:
        settled(browser)
    assert len(state.jobs) == before + 1, "Exactly one synthetic segmentation job should be submitted."
    return state.jobs[-1]


def verify(browser, observer, state, url, output):
    checks = []
    browser.call("Page.enable")
    browser.call("Runtime.enable")
    browser.call("Log.enable")
    browser.call("Network.enable")
    browser.call("Fetch.enable", {"patterns": [{"urlPattern": "http://*/*", "requestStage": "Request"}, {"urlPattern": "https://*/*", "requestStage": "Request"}]})
    browser.call("Emulation.setDeviceMetricsOverride", {"width": 1440, "height": 1100, "deviceScaleFactor": 1, "mobile": False})
    browser.call("Emulation.setFocusEmulationEnabled", {"enabled": True})
    browser.call("Page.navigate", {"url": url})
    browser.wait("document.querySelector('[data-page=home]:not([hidden])')")
    browser.route("visualize")
    click_text(browser, "Library")
    library = browser.state()["library"]
    colour = next(item for item in library if item["hex"].upper() not in ("#FFFFFF", "#000000"))
    browser.fill("#visualize-library-colour", colour["id"])
    browser.wait("document.querySelector('[data-testid=visualize-target]')")
    browser.evaluate("""(async()=>{
      const c=document.createElement('canvas');c.width=3000;c.height=1800;
      const x=c.getContext('2d');x.fillStyle='#b4aaa0';x.fillRect(0,0,1500,1800);x.fillStyle='#607080';x.fillRect(1500,0,1500,1800);
      const blob=await new Promise(resolve=>c.toBlob(resolve,'image/png'));
      const d=new DataTransfer();d.items.add(new File([blob],'synthetic-cloud-ui.png',{type:'image/png'}));
      const i=document.querySelector('#visualize-photo-input');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));
    })()""")
    browser.wait(CANVAS + "?.width===1200", timeout=15)
    settled(browser)
    assert browser.evaluate("document.querySelector('#visualize-selection-engine').dataset.value") == "cloud"
    assert 'sam3' not in browser.picker_values('#visualize-selection-engine')
    checks.append("Production starts with cloud Auto Select and hides local SAM server configuration.")

    # Seed a real manual selection so preservation checks cover an existing mask.
    click_text(browser, "Brush")
    canvas_pointer(browser, (.75, .35), (.78, .38))
    settled(browser)
    assert mask_summary(browser)["count"] > 0
    manual = snapshot(browser)
    click_text(browser, "Auto Select")
    job = tap_and_queue(browser, state, "quota")
    count = len(state.jobs)
    canvas_pointer(browser, (.3, .4))
    canvas_pointer(browser, (.35, .4))
    settled(browser)
    assert len(state.jobs) == count, "Repeated taps must not submit duplicate queue jobs."
    assert browser.evaluate("document.querySelector('#visualize-selection-engine').disabled")
    assert_preserved(browser, manual)
    job.start.set(); job.complete.set()
    browser.wait("document.querySelector('.visualize-error')?.textContent.includes('allowance')")
    browser.wait("!document.querySelector('.visualize-progress')")
    assert_preserved(browser, manual)
    assert browser.evaluate("Array.from(" + PAGE + ".querySelectorAll('button')).some(b=>b.textContent.trim()==='Select manually'&&!b.disabled)")
    assert not browser.evaluate("document.body.textContent.includes('secret-placeholder') || document.body.textContent.includes('private-photo') || document.body.textContent.includes('/private/runtime')")
    screenshot(browser, output / "cloud-quota-fallback.png")
    checks.append("Queued request guards repeated taps; quota failure ends progress and preserves exact photo/target/mask while offering Select manually.")

    click_text(browser, "Select manually")
    canvas_pointer(browser, (.6, .6), (.63, .63))
    settled(browser)
    assert snapshot(browser)["mask"] != manual["mask"]
    click_text(browser, "Undo")
    assert_preserved(browser, manual)
    click_text(browser, "Auto Select")
    browser.fill("#visualize-selection-engine", "local")
    browser.fill("#visualize-selection-mode", "add")
    canvas_pointer(browser, (.75, .6))
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Local region selected')")
    assert snapshot(browser)["mask"] != manual["mask"]
    click_text(browser, "Undo")
    assert_preserved(browser, manual)
    checks.append("Manual Brush and on-device colour region still work after cloud failure; Undo restores every original overlay byte.")

    browser.fill("#visualize-selection-engine", "cloud")
    browser.fill("#visualize-selection-mode", "replace")
    job = tap_and_queue(browser, state)
    assert (job.payload["width"], job.payload["height"]) == (1200, 720)
    point = job.payload["points"][0]
    assert abs(point["x"] - 300) < 1 and abs(point["y"] - 360) < 1
    assert job.payload["image"].startswith("data:image/png;base64,")
    job.start.set()
    browser.wait("document.querySelector('.visualize-progress')?.textContent.includes('Selecting surface')")
    screenshot(browser, output / "cloud-selecting.png")
    job.complete.set()
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Surface selected')")
    browser.wait("!document.querySelector('.visualize-progress')")
    success = snapshot(browser)
    summary = mask_summary(browser)
    assert summary["count"] == 41 * 41
    assert browser.evaluate("document.querySelector('.visualize-mask-overlay').getContext('2d').getImageData(300,360,1,1).data[3]>0")
    checks.append("Actual Gradio JS protocol renders Queued and Selecting states, decodes raw-alpha success and aligns a resized 3000×1800 image/tap with its 1200×720 mask.")

    browser.evaluate("window.__cloudUiOriginal=" + CANVAS + ".getContext('2d').getImageData(0,0,1200,720).data.slice();window.__cloudUiMask=" + OVERLAY + ".getContext('2d').getImageData(0,0,1200,720).data.slice()")
    click_text(browser, "Apply Colour")
    browser.wait("Array.from(" + PAGE + ".querySelectorAll('button')).some(b=>b.textContent.trim()==='Edit Selection')")
    browser.wait("!document.querySelector('.visualize-progress')")
    click_text(browser, "After")
    preview = browser.evaluate("""(()=>{const c=document.querySelector('#visualize-canvas'),current=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let selected=0,outside=0;for(let i=0;i<current.length;i+=4){const changed=current[i]!==window.__cloudUiOriginal[i]||current[i+1]!==window.__cloudUiOriginal[i+1]||current[i+2]!==window.__cloudUiOriginal[i+2];if(changed){if(window.__cloudUiMask[i+3])selected++;else outside++;}}return{selectedChanged:selected,outsideChanged:outside};})()""")
    assert preview["selectedChanged"] > 0 and preview["outsideChanged"] == 0
    click_text(browser, "Edit Selection")
    assert_preserved(browser, success)
    checks.append("Existing recolouring consumes the mocked cloud mask and changes zero unselected pixels.")

    for mode, expected in [("unavailable", "temporarily unavailable"), ("no_object", "No suitable object"), ("invalid_mask", "unusable selection")]:
        job = tap_and_queue(browser, state, mode)
        job.start.set(); job.complete.set()
        browser.wait("document.querySelector('.visualize-error')?.textContent.includes(" + json.dumps(expected) + ")")
        browser.wait("!document.querySelector('.visualize-progress')")
        assert_preserved(browser, success)
    checks.append("Server unavailable, no object and wrong mask byte count errors preserve the complete Visualize editing state.")

    # Speed up only the cloud timeout timer inside this isolated test profile.
    # Production retains its real 180-second timeout; no source or build changes.
    browser.evaluate("window.__cloudUiTimer=window.setTimeout;window.setTimeout=function(fn,ms,...args){return window.__cloudUiTimer(fn,ms===180000?1500:ms,...args)}")
    job = tap_and_queue(browser, state)
    browser.wait("document.querySelector('.visualize-error')?.textContent.includes('timed out')")
    browser.evaluate("window.setTimeout=window.__cloudUiTimer")
    browser.wait("!document.querySelector('.visualize-progress')")
    assert_preserved(browser, success)
    browser.wait("Array.from(" + PAGE + ".querySelectorAll('button')).some(b=>b.textContent.trim()==='Retry Auto Select'&&!b.disabled)")
    job.start.set(); job.complete.set()
    checks.append("An accelerated production timeout ends the spinner, offers retry and preserves photo, target and existing mask.")

    job = tap_and_queue(browser, state)
    click_text(browser, "Cancel")
    browser.wait("!document.querySelector('.visualize-progress')")
    assert_preserved(browser, success)
    job.start.set(); job.complete.set()
    settled(browser)
    assert_preserved(browser, success)
    checks.append("Cancel releases the editor immediately and ignores late queue completion.")

    job = tap_and_queue(browser, state)
    browser.route("home")
    job.start.set(); job.complete.set()
    settled(browser)
    browser.route("visualize")
    browser.wait("!document.querySelector('.visualize-progress')")
    assert_preserved(browser, success)
    checks.append("Back/navigation cancels the request, ignores late completion and restores the uploaded photo, colour and mask on return.")

    browser.call("Network.emulateNetworkConditions", {"offline": True, "latency": 0, "downloadThroughput": 0, "uploadThroughput": 0})
    canvas_pointer(browser, (.25, .5))
    browser.wait("document.querySelector('.visualize-error')?.textContent.includes('offline')", timeout=15)
    browser.wait("!document.querySelector('.visualize-progress')")
    browser.call("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})
    assert_preserved(browser, success)
    click_text(browser, "Use on-device selection")
    canvas_pointer(browser, (.75, .6))
    browser.wait("document.querySelector('[data-testid=visualize-selection-status]')?.textContent.startsWith('Local region selected')")
    click_text(browser, "Undo")
    assert_preserved(browser, success)
    checks.append("Browser offline failure preserves state and on-device selection works without a cloud job.")

    assert browser.state()["library"] == library
    assert observer.local_sam_calls == 0, "Mocked cloud browser checks must never use the running localhost SAM server."
    assert browser.evaluate("Object.keys(localStorage).every(key=>!key.startsWith('gradio:run-history'))")
    assert len([entry for entry in observer.intercepted if entry["url"].split("?")[0].endswith("/queue/join") and entry["method"] == "POST"]) == len(state.jobs)
    checks.append("Real SDK uses named Gradio queue routes, sends no localhost SAM calls and stores no photo/mask run history; Library metadata is unchanged.")
    screenshot(browser, output / "cloud-final-preserved.png")
    return {
        "status": "passed", "real_inference": False, "mocked_gradio_network": True,
        "build": "isolated production", "fixture_space_origin": SPACE,
        "external_space_requests": 0, "local_sam_requests": observer.local_sam_calls,
        "checks": checks, "checks_passed": len(checks), "submitted_jobs": len(state.jobs),
        "cancelled_job_ids": state.cancelled_ids, "request_geometry": {"width": 1200, "height": 720, "point": point},
        "preview": preview, "original_library_preserved": True,
        "browser_errors": browser.errors,
        "screenshots": [str((output / name).relative_to(ROOT)) for name in ("cloud-quota-fallback.png", "cloud-selecting.png", "cloud-final-preserved.png")],
        "note": "Synthetic photos/masks and loopback Gradio API responses; no actual Hugging Face deployment or model inference is established.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "artifacts/cloud-ui-dist")
    parser.add_argument("--chrome", default=r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/cloud-sam3-ui")
    args = parser.parse_args()
    assert (args.dist / "index.html").is_file(), "Build the isolated cloud fixture production app first."
    args.output.mkdir(parents=True, exist_ok=True)
    state = FixtureState()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(MockHandler, directory=str(args.dist.resolve())))
    server.fixture = state
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    check_chroma.PORT = 9234
    profile = Path(tempfile.mkdtemp(prefix="cloud-sam3-ui-", dir=args.output))
    process = subprocess.Popen([
        args.chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--remote-debugging-port=9234",
        "--remote-allow-origins=http://localhost:9234", "--user-data-dir=" + str(profile), "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    browser = None
    try:
        deadline, target = time.monotonic() + 15, None
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:9234/json/list", timeout=1) as response:
                    target = next((tab for tab in json.load(response) if tab.get("type") == "page"), None)
                if target:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        assert target, "Isolated headless Chrome did not start."
        browser = Browser(target["webSocketDebuggerUrl"])
        observer = RedirectedSocket(browser.socket, origin)
        browser.socket = observer
        report = verify(browser, observer, state, origin, args.output)
        (args.output / "browser-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        return 0
    except Exception as error:
        report = {"status": "failed", "real_inference": False, "mocked_gradio_network": True, "error": str(error), "last_command": browser.last_command if browser else "Chrome startup", "submitted_jobs": len(state.jobs), "browser_errors": browser.errors if browser else [], "blocked_urls": observer.blocked if browser else [], "intercepted_requests": observer.intercepted if browser else []}
        if browser:
            try:
                shot = browser.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
                (args.output / "failure.png").write_bytes(base64.b64decode(shot["data"]))
            except Exception:
                pass
        (args.output / "browser-verification.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2), file=sys.stderr)
        return 1
    finally:
        for job in state.jobs:
            job.start.set(); job.complete.set()
        if browser:
            try:
                browser.call("Browser.close")
            except Exception:
                pass
            browser.socket.close()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate(); process.wait(timeout=5)
        server.shutdown(); server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
