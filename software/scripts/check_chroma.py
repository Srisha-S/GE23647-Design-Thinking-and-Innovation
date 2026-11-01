"""Exercise CHROMA in an isolated headless Chrome profile using the DevTools protocol.

Run Vite on http://127.0.0.1:8000, then run: python scripts/check_chroma.py
Requires the installed websocket-client Python package and Google Chrome.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
PORT = 9227


class Browser:
    def __init__(self, socket_url: str):
        self.socket = websocket.create_connection(
            socket_url, origin=f"http://localhost:{PORT}", timeout=15
        )
        self.sequence = 0
        self.errors: list[str] = []
        self.last_command = "WebSocket connected"

    def call(self, method: str, params: dict | None = None) -> dict:
        self.last_command = method + (": " + str(params.get("expression", ""))[:180] if params and "expression" in params else "")
        self.sequence += 1
        request_id = self.sequence
        self.socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            reply = json.loads(self.socket.recv())
            if reply.get("method") == "Runtime.exceptionThrown":
                detail = reply["params"]["exceptionDetails"]
                self.errors.append(detail.get("exception", {}).get("description", detail.get("text", "JS exception")))
            if reply.get("method") == "Log.entryAdded":
                entry = reply["params"]["entry"]
                if entry.get("level") == "error":
                    self.errors.append(entry.get("text", "Browser error"))
            if reply.get("id") == request_id:
                if "error" in reply:
                    raise RuntimeError(f"{method}: {reply['error']}")
                return reply.get("result", {})
        raise TimeoutError(f"DevTools command timed out: {method}")

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
            "timeout": 15000,
        })
        if "exceptionDetails" in result:
            detail = result["exceptionDetails"]
            raise AssertionError(detail.get("exception", {}).get("description", detail.get("text")))
        return result.get("result", {}).get("value")

    def wait(self, expression: str, timeout: float = 8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.evaluate("Boolean(" + expression + ")"):
                return
            time.sleep(0.08)
        raise AssertionError(f"Timed out waiting for: {expression}")

    def route(self, name: str):
        self.evaluate(f"location.hash = {json.dumps(name)}")
        self.wait(f"document.querySelector('[data-page=\"{name}\"]:not([hidden])')")

    def reveal_details(self, expression: str):
        self.evaluate("(() => {const element=" + expression + ";let parent=element.parentElement;const closed=[];while(parent){if(parent.matches('details:not([open])'))closed.push(parent);parent=parent.parentElement;}closed.reverse().forEach(detail=>detail.querySelector(':scope > summary').click());})()")

    def click(self, selector: str):
        self.wait(f"document.querySelector({json.dumps(selector)})")
        self.reveal_details(f"document.querySelector({json.dumps(selector)})")
        self.evaluate(f"document.querySelector({json.dumps(selector)}).click()")

    def fill(self, selector: str, value: str, event: str | None = None):
        self.wait(f"document.querySelector({json.dumps(selector)})")
        self.reveal_details(f"document.querySelector({json.dumps(selector)})")
        if self.evaluate(f"document.querySelector({json.dumps(selector)}).hasAttribute('data-picker-trigger')"):
            self.click(selector)
            choice = "Array.from(document.querySelectorAll('dialog[open] [data-choice-value],dialog[open] [data-library-colour]')).find(e=>e.dataset.choiceValue === " + json.dumps(value) + " || e.dataset.libraryColour === " + json.dumps(value) + ")"
            self.wait(choice)
            self.evaluate(choice + '.click()')
            self.wait(f"!document.querySelector({json.dumps(selector)}) || document.querySelector({json.dumps(selector)}).dataset.value === {json.dumps(value)}")
            return
        self.evaluate("(() => { const e = document.querySelector(" + json.dumps(selector) + "); const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, " + json.dumps(value) + "); e.dispatchEvent(new Event(" + (json.dumps(event) if event else "e instanceof HTMLSelectElement ? 'change' : 'input'") + ", {bubbles:true})); })()")

    def picker_values(self, selector: str):
        self.click(selector)
        self.wait("document.querySelector('dialog[open] > .themed-picker-options')")
        values = self.evaluate("Array.from(document.querySelectorAll('dialog[open] > .themed-picker-options [data-choice-value]'),e=>e.dataset.choiceValue)")
        self.evaluate("document.querySelector('dialog[open] > .themed-picker-options').closest('dialog').querySelector('[aria-label=\"Close dialog\"]').click()")
        self.wait("!document.querySelector('dialog[open] > .themed-picker-options')")
        return values

    def click_text(self, text: str, scope: str = "document.querySelector('[data-page]:not([hidden])')", exact: bool = True):
        comparison = f"e.textContent.trim() === {json.dumps(text)}" if exact else f"e.textContent.includes({json.dumps(text)})"
        expression = f"Array.from({scope}.querySelectorAll('button')).find(e => {comparison})"
        self.wait(expression)
        self.reveal_details(expression)
        self.evaluate(expression + '.click()')

    def state(self):
        return self.evaluate("JSON.parse(localStorage.getItem('chroma-workspace-v2'))")

    def upload_json(self, value, name='chroma-test-library.json'):
        self.evaluate("(() => { const transfer = new DataTransfer(); transfer.items.add(new File([" + json.dumps(json.dumps(value)) + "], " + json.dumps(name) + ", {type:'application/json'})); const input = document.querySelector('[aria-label=\"Import library JSON file\"]'); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()")

    def upload_image(self, paint: str, width: int = 2, height: int = 2):
        self.evaluate("""(async () => {
          const canvas=document.createElement('canvas');canvas.width=""" + str(width) + ";canvas.height=" + str(height) + ";const ctx=canvas.getContext('2d');" + paint + """
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          const transfer=new DataTransfer();transfer.items.add(new File([blob],'integration-image.png',{type:'image/png'}));
          const input=document.querySelector('#image-input');input.files=transfer.files;
          input.dispatchEvent(new Event('change',{bubbles:true}));
        })()""")
        self.wait(f"document.querySelector('#pixel-x')?.max === '{width - 1}'")

    def submit(self, selector):
        self.evaluate(f"document.querySelector({json.dumps(selector)}).requestSubmit()")

    def screenshot(self, name: str, width: int, height: int, mobile: bool = False):
        self.call("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": mobile,
        })
        self.evaluate("window.scrollTo(0,0)")
        self.evaluate("document.fonts.ready.then(() => new Promise(resolve => setTimeout(resolve, 550)))")
        shot = self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        path = ARTIFACTS / name
        path.write_bytes(base64.b64decode(shot["data"]))
        return str(path.relative_to(ROOT))


def run_checks(browser: Browser, url: str, visualize_only: bool = False, runtime_only: bool = False, colour_only: bool = False, colour_probe: bool = False, reference_only: bool = False, studio_only: bool = False, wireframe_only: bool = False, workflow_only: bool = False) -> dict:
    if workflow_only:
        from workflow_checks import check_workflows
        return check_workflows(browser, url)
    if wireframe_only:
        from wireframe_checks import check_wireframes
        return check_wireframes(browser, url)
    if studio_only:
        from studio_checks import check_studio
        browser.call("Page.enable")
        browser.call("Runtime.enable")
        browser.call("Log.enable")
        browser.call("Page.navigate", {"url": url})
        browser.wait("document.querySelector('[data-page=home]:not([hidden])') && JSON.parse(localStorage.getItem('chroma-workspace-v2'))?.projects?.length > 0")
        checks = check_studio(browser)
        assert not browser.errors, "Browser errors: " + " | ".join(browser.errors)
        return {"status": "passed", "checks": checks, "browser_errors": browser.errors}
    if reference_only:
        from reference_ui_checks import check_reference_ui
        return check_reference_ui(browser, url)
    if colour_only or colour_probe:
        from colour_compatibility_checks import check_colours, probe_colour_crash
        return probe_colour_crash(browser, url) if colour_probe else check_colours(browser, url)
    if runtime_only:
        from runtime_checks import check_runtime
        return check_runtime(browser, url)
    if visualize_only:
        from visualize_checks import check_visualize
        browser.call("Page.enable")
        browser.call("Runtime.enable")
        browser.call("Log.enable")
        browser.call("Page.navigate", {"url": url})
        browser.wait("document.querySelector('[data-page=home]:not([hidden])')")
        browser.route('visualize')
        browser.wait("document.querySelector('[data-page=visualize]:not([hidden])')")
        result = check_visualize(browser)
        assert not browser.errors, "Browser errors: " + " | ".join(browser.errors)
        return {"status": "passed", **result}
    from react_checks import run_react_checks
    return run_react_checks(browser, url)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--chrome", default=r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    parser.add_argument("--visualize-only", action="store_true", help="Run only the new Visualize Colour browser regressions")
    parser.add_argument("--runtime-only", action="store_true", help="Run isolated persisted-data startup diagnostics")
    parser.add_argument("--colour-only", action="store_true", help="Run saved-colour and Navy palette regressions")
    parser.add_argument("--colour-probe", action="store_true", help="Capture the original Navy crash against the previous production build")
    parser.add_argument("--reference-only", action="store_true", help="Check reference layouts, icons and light/dark themes")
    parser.add_argument("--studio-only", action="store_true", help="Check Settings, About, menu placement and shared navigation")
    parser.add_argument("--wireframe-only", action="store_true", help="Check the latest complete wireframes and preserved workflows")
    parser.add_argument("--workflow-only", action="store_true", help="Check ChromaPod tools, history backtracking, persistent navigation and project folders")
    parser.add_argument("--picker-only", action="store_true", help="Check themed Library/project pickers and nested Back in light/dark")
    args = parser.parse_args()
    result_name = "chroma-reference-ui-results.json" if args.reference_only else "chroma-colour-before-fix.json" if args.colour_probe else "chroma-colour-check-results.json" if args.colour_only else "chroma-runtime-check-results.json" if args.runtime_only else "chroma-visualize-check-results.json" if args.visualize_only else "chroma-check-results.json"
    if args.studio_only:
        result_name = "chroma-studio-check-results.json"
    if args.wireframe_only:
        result_name = "chroma-wireframe-check-results.json"
    if args.workflow_only:
        result_name = "chroma-workflow-check-results.json"
    if args.picker_only:
        result_name = "chroma-picker-check-results.json"
    ARTIFACTS.mkdir(exist_ok=True)
    profiles = ARTIFACTS / "temp-browser"
    profiles.mkdir(exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="chroma-check-", dir=profiles))
    command = [args.chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--disable-background-networking", f"--remote-debugging-port={PORT}",
               f"--remote-allow-origins=http://localhost:{PORT}", f"--user-data-dir={profile}", "about:blank"]
    process = None
    browser = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + 15
        target = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(f"Chrome exited with code {process.returncode}; browser execution may require sandbox approval.")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1) as response:
                    target = next((tab for tab in json.load(response) if tab.get("type") == "page"), None)
                if target:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        if not target:
            raise RuntimeError("Chrome debugging endpoint did not start within 15 seconds; browser execution may require sandbox approval.")
        browser = Browser(target["webSocketDebuggerUrl"])
        if args.picker_only:
            from picker_checks import check_pickers
            report = check_pickers(browser, args.url)
        else:
            report = run_checks(browser, args.url, args.visualize_only, args.runtime_only, args.colour_only, args.colour_probe, args.reference_only, args.studio_only, args.wireframe_only, args.workflow_only)
        (ARTIFACTS / result_name).write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        return 0
    except Exception as error:
        last_command = browser.last_command if browser else 'Chrome / WebSocket startup'
        if browser:
            try:
                shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
                (ARTIFACTS / 'chroma-check-failure.png').write_bytes(base64.b64decode(shot['data']))
            except Exception:
                pass
        failure = {"status": "failed", "error": str(error), "last_command": last_command, "browser_errors": browser.errors if browser else []}
        (ARTIFACTS / result_name).write_text(json.dumps(failure, indent=2), encoding='utf-8')
        print(json.dumps(failure, indent=2), file=sys.stderr)
        return 1
    finally:
        if browser:
            try:
                browser.call("Browser.close")
            except Exception:
                pass
            browser.socket.close()
        if process:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
