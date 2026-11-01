"""Reference presentation checks in an isolated CHROMA browser profile.

Exercises the October light/dark references while retaining the existing
colour, transport, storage, and accessibility test suites. Run the app first,
then use: python scripts/reference_ui_checks.py --url http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

from check_chroma import ARTIFACTS, Browser, PORT
from react_checks import reload_app
from studio_checks import BOTTOM_ROUTES, check_bottom_navigation, check_compact_drawer, open_drawer


ACTIVE = "document.querySelector('[data-page]:not([hidden])')"
APPEARANCE_KEY = "chroma-appearance-v1"
WORKSPACE_KEY = "chroma-workspace-v2"
FEATURES = ["scan", "compare", "convert", "image", "library", "projects"]


def viewport(browser, width=390, height=844, mobile=True):
    browser.call("Emulation.setDeviceMetricsOverride", {
        "width": width, "height": height, "deviceScaleFactor": 1, "mobile": mobile,
    })


def settle_route(browser, destination):
    browser.route(destination)
    # App moves focus to the route heading on its next animation frame.
    # Complete that scheduled work before interacting with this page.
    browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")


def visible(browser, selector):
    return browser.evaluate("(() => {const e=document.querySelector(" + json.dumps(selector)
                            + ");return Boolean(e && e.getClientRects().length && getComputedStyle(e).visibility!=='hidden')})()")


def no_overflow(browser, context):
    layout = browser.evaluate("({width:innerWidth,content:document.documentElement.scrollWidth})")
    assert layout["content"] <= layout["width"] + 1, f"{context} has horizontal overflow: {layout}"


def chrome_colours(browser):
    """Read shared canvas, header and dock colours without reading page-specific swatches."""
    return browser.evaluate('''(() => {
      const nav=document.querySelector('[data-bottom-nav]').closest('nav');
      const header=document.querySelector('.studio-header');
      const style=getComputedStyle(nav);
      return {theme:document.documentElement.dataset.theme,body:getComputedStyle(document.body).backgroundColor,
        header:getComputedStyle(header).backgroundColor,dock:style.backgroundColor,dockImage:style.backgroundImage};
    })()''')


def check_home_content(browser):
    details = browser.evaluate('''(() => {
      const home=document.querySelector('[data-page=home]');
      const secondary=home.querySelector('.reference-home-secondary');
      return {headings:Array.from(secondary.querySelectorAll('h2')).map(e=>e.textContent.trim()),
        latest:secondary.querySelector('.reference-latest-open')?.textContent,
        recent:secondary.querySelectorAll('.scan-history-item').length,
        extra:Boolean(home.querySelector('.reference-saved-strip,.reference-visualize-action,.home-concept-details,.deskbot-concept')),
        deskbot:home.textContent.toLowerCase().includes('deskbot')};
    })()''')
    assert details['headings'] == ['Your latest colour', 'Recent scans'], f'Home secondary content must contain only latest colour and recent scans: {details}'
    assert not details['extra'] and not details['deskbot'], f'Removed saved-strip/Visualize/Deskbot sections must not remain on Home: {details}'
    latest = browser.state()['latest']
    assert latest['name'] in details['latest'] and latest['hex'] in details['latest'], f'Latest card must show the live saved reading: {details}'
    assert details['recent'] == min(5, len(browser.state()['history'])), f'Recent scan preview must still show stored history: {details}'


def check_scroll_theme(browser, route, expected_chrome):
    before = browser.evaluate('''(() => {
      const nav=document.querySelector('[data-bottom-nav]').closest('nav').getBoundingClientRect();
      const active=document.querySelector('[data-bottom-nav][aria-current=page] .reference-nav-icon')?.getBoundingClientRect();
      return {top:nav.top,bottom:nav.bottom,activeTop:active?.top ?? null};
    })()''')
    browser.evaluate("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})")
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert chrome_colours(browser) == expected_chrome, f'Canvas/header/dock theme must remain consistent while scrolling {route}'
    after = browser.evaluate('''(() => {
      const nav=document.querySelector('[data-bottom-nav]').closest('nav').getBoundingClientRect();
      const active=document.querySelector('[data-bottom-nav][aria-current=page] .reference-nav-icon')?.getBoundingClientRect();
      return {top:nav.top,bottom:nav.bottom,activeTop:active?.top ?? null};
    })()''')
    assert all(before[key] is None and after[key] is None or before[key] is not None and after[key] is not None and abs(before[key]-after[key]) <= 1 for key in before), f'Floating dock and selected circle must stay in place while scrolling {route}: {before}, {after}'
    check_bottom_navigation(browser, route)
    browser.evaluate("window.scrollTo({top:0,behavior:'instant'})")
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def set_theme(browser, theme):
    settle_route(browser, "settings")
    browser.click('[data-theme-option="' + theme + '"]')
    browser.wait('document.querySelector(' + json.dumps('[data-theme-option="' + theme + '"]')
                 + ')?.getAttribute("aria-pressed") === "true"')
    if theme != "system":
        browser.wait("document.documentElement.dataset.theme === " + json.dumps(theme))
    browser.wait("localStorage.getItem(" + json.dumps(APPEARANCE_KEY) + ") !== null")


def check_reference_ui(browser, url):
    checks, screenshots = [], []
    browser.call("Page.enable")
    browser.call("Runtime.enable")
    browser.call("Log.enable")
    viewport(browser)
    browser.call("Page.navigate", {"url": url})
    browser.wait("document.querySelector('[data-nav=home]') && document.querySelector('[data-page=home] h1')")
    browser.wait("JSON.parse(localStorage.getItem(" + json.dumps(WORKSPACE_KEY) + "))?.library?.length > 0")
    original_workspace = browser.evaluate("localStorage.getItem(" + json.dumps(WORKSPACE_KEY) + ")")

    settle_route(browser, "home")
    cards = browser.evaluate("Array.from(document.querySelectorAll('[data-page=home] .reference-feature-card')).map(e=>e.dataset.feature)")
    assert cards == FEATURES, f"Home cards must follow the six reference placements: {cards}"
    assert visible(browser, '[data-testid="reference-device-card"]'), "Home needs the device card above the feature grid"
    assert visible(browser, '[aria-label="Open Settings"]'), "Home header settings gear must remain directly reachable"
    placement = browser.evaluate("""(() => {
      const features=Array.from(document.querySelectorAll('[data-page=home] .reference-feature-card'));
      const device=document.querySelector('[data-testid=reference-device-card]').getBoundingClientRect();
      const cards=features.map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,svg:e.querySelectorAll('svg').length}});
      const gear=document.querySelector('[aria-label="Open Settings"]').getBoundingClientRect();
      return {device:{left:device.left,right:device.right,top:device.top,bottom:device.bottom},cards,gear:{left:gear.left,right:gear.right,top:gear.top},width:innerWidth};
    })()""")
    assert placement["device"]["bottom"] <= placement["cards"][0]["top"] + 1, "Device card must precede the features"
    for start in (0, 2, 4):
        left, right = placement["cards"][start:start + 2]
        assert abs(left["top"] - right["top"]) <= 2 and right["left"] >= left["right"] - 2, "Phone feature cards must form the reference two-column rows"
        assert left["height"] >= 44 and right["height"] >= 44, "Home feature cards need usable touch targets"
    assert placement["gear"]["left"] > placement["width"] / 2, "Settings gear should sit on the right of the brand"
    check_home_content(browser)
    checks.append("Home device card, six functional feature cards, reference two-column placement, and header settings gear")
    checks.append("Home keeps the live latest colour and five most recent scans; saved-strip, Visualize shortcut and Deskbot preview are removed without altering stored data")

    for destination in FEATURES:
        settle_route(browser, "home")
        browser.click('.reference-feature-card[data-feature="' + destination + '"]')
        browser.wait(ACTIVE + ".dataset.page === " + json.dumps(destination))
    settle_route(browser, "home")
    check_bottom_navigation(browser, 'home')
    for destination in BOTTOM_ROUTES:
        browser.click('[data-bottom-nav="' + destination + '"]')
        browser.wait(ACTIVE + ".dataset.page === " + json.dumps(destination))
        browser.wait('document.querySelector(' + json.dumps('[data-bottom-nav="' + destination + '"]') + ')?.getAttribute("aria-current") === "page"')
        check_bottom_navigation(browser, destination)
    checks.append("Home/Scan/Library/Projects icon bar navigates to live pages with visible labels and a raised circular selected highlight")

    theme_backgrounds = {}
    for theme in ("light", "dark"):
        set_theme(browser, theme)
        theme_backgrounds[theme] = browser.evaluate("getComputedStyle(document.body).backgroundColor")
        saved_preference = browser.evaluate("localStorage.getItem(" + json.dumps(APPEARANCE_KEY) + ")")
        reload_app(browser, "document.querySelector('[data-theme-option=" + theme + "]')?.getAttribute('aria-pressed') === 'true'")
        assert browser.evaluate("document.documentElement.dataset.theme") == theme, f"{theme} theme must survive reload"
        assert browser.evaluate("localStorage.getItem(" + json.dumps(APPEARANCE_KEY) + ")") == saved_preference
        assert browser.evaluate("localStorage.getItem(" + json.dumps(WORKSPACE_KEY) + ")") == original_workspace, "Appearance updates must preserve the saved workspace"
        settle_route(browser, 'home')
        expected_chrome = chrome_colours(browser)
        for destination in BOTTOM_ROUTES:
            browser.click('[data-bottom-nav="' + destination + '"]')
            browser.wait(ACTIVE + ".dataset.page === " + json.dumps(destination))
            browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            assert chrome_colours(browser) == expected_chrome, f'{theme} theme must stay consistent when switching to the {destination} tab'
            check_bottom_navigation(browser, destination)
        for route in ("home", "compare", "image", "library", "projects", "settings", "about", "device", "scan", "convert", "visualize"):
            browser.route(route)
            browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
            no_overflow(browser, f"{theme} {route} at 390px")
            assert chrome_colours(browser) == expected_chrome, f'{theme} shared canvas/header/dock must retain the Home theme on {route}'
            check_bottom_navigation(browser, route)
            check_scroll_theme(browser, route, expected_chrome)
            if route == 'home':
                check_home_content(browser)
            if route in ("home", "compare", "image", "settings", "about"):
                screenshots.append(browser.screenshot(f"chroma-reference-{route}-{theme}-mobile.png", 390, 844, True))
            if route == "settings":
                browser.click('#settings-tab-app')
                assert not browser.evaluate(ACTIVE + ".textContent.includes('Your workspace stays local')")
                assert browser.evaluate("document.querySelectorAll('[data-page=settings] [role=tab]').length") == 3
                assert not browser.evaluate("document.querySelector('#settings-tab-about')")
                screenshots.append(browser.screenshot(f"chroma-reference-settings-app-{theme}-mobile.png", 390, 844, True))
        settle_route(browser, "home")
        open_drawer(browser)
        check_compact_drawer(browser, 390)
        screenshots.append(browser.screenshot(f"chroma-reference-menu-{theme}-mobile.png", 390, 844, True))
        browser.click('[aria-label="Close navigation"]')
        browser.wait("!document.querySelector('#navigation-drawer').open")
        viewport(browser, 1440, 1100, False)
        for route in ("home", "compare", "image"):
            browser.route(route)
            browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
            no_overflow(browser, f"{theme} {route} at 1440px")
            screenshots.append(browser.screenshot(f"chroma-reference-{route}-{theme}-desktop.png", 1440, 1100))
        viewport(browser)
    assert theme_backgrounds["light"] != theme_backgrounds["dark"], f"Dark/light appearance must visibly change the page surface: {theme_backgrounds}"

    browser.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark"}]})
    set_theme(browser, "system")
    browser.wait("document.documentElement.dataset.theme === 'dark'")
    reload_app(browser, "document.querySelector('[data-theme-option=system]')?.getAttribute('aria-pressed') === 'true'")
    assert browser.evaluate("document.documentElement.dataset.theme") == "dark"
    browser.call("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "light"}]})
    browser.wait("document.documentElement.dataset.theme === 'light'")
    set_theme(browser, "light")
    checks.append("Light/dark theme persists through reload and every tab/route/scroll; the floating dock and raised selected circle remain fixed; System follows OS changes; saved workspace JSON stays untouched; eleven pages fit 390px")

    browser.route("compare")
    browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    browser.fill("#compareA", "#000075")
    browser.fill("#compareB", "#000075")
    browser.submit("#compare-form")
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')?.childNodes[0].textContent === '0.00'")
    ring = "document.querySelector('[data-page=compare] [data-testid=compare-match-ring]')"
    browser.wait(ring)
    equal_score = browser.evaluate("Number(" + ring + ".dataset.matchPercent)")
    assert equal_score == 100, f"Identical Navy colours must produce a 100% match, not fixed example values: {equal_score}"
    browser.fill("#compareA", "#FFFFFF")
    browser.fill("#compareB", "#000000")
    browser.submit("#compare-form")
    browser.wait("Number(" + ACTIVE + ".querySelector('[data-testid=delta-e]')?.childNodes[0].textContent) > 0")
    different_score = browser.evaluate("Number(" + ring + ".dataset.matchPercent)")
    assert 0 <= different_score < equal_score, f"Comparison ring must update from the actual selected pair: {different_score}"
    assert browser.evaluate("Array.from(document.querySelectorAll('[data-page=compare] .compare-pair .compare-card-hex')).map(e=>e.textContent)") == ["#FFFFFF", "#000000"]
    checks.append("Compare reference/sample editing recalculates Delta E and the visual match ring; identical Navy returns 100%, black/white returns a lower score")

    browser.route("image")
    browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    browser.click_text("Explore with a sample image", exact=False)
    browser.wait("document.querySelector('#image-canvas')")
    browser.click_text("Extract Palette", exact=False)
    browser.wait("document.querySelector('[aria-label=\"Extracted dominant palette\"] button')")
    browser.click('[aria-label="Extracted dominant palette"] button')
    browser.wait("document.querySelector('[data-page=image] [data-testid=image-match-target] .colour-hex')")
    browser.click_text("Use latest capture")
    browser.wait("document.querySelector('[data-page=image] [data-testid=delta-e]')")
    assert visible(browser, '[data-testid="image-best-matches"]'), "Image Match needs a real best-matches section"
    assert visible(browser, '[data-testid="image-saved-colours"]'), "Image Match needs the saved-colours preview"
    headings = browser.evaluate("Array.from(document.querySelectorAll('[data-page=image] h2')).map(e=>e.textContent.toLowerCase())")
    assert any("best match" in heading for heading in headings)
    assert any("saved colo" in heading for heading in headings)
    assert browser.evaluate("document.querySelector('[data-testid=image-best-matches]').textContent.length") > 20
    no_overflow(browser, "Image Match with a real extracted palette at 390px")
    screenshots.append(browser.screenshot("chroma-reference-image-loaded-light-mobile.png", 390, 844, True))
    set_theme(browser, "dark")
    browser.route("image")
    browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
    screenshots.append(browser.screenshot("chroma-reference-image-loaded-dark-mobile.png", 390, 844, True))
    checks.append("Image Match extracts a real image palette, picks a target, compares the latest sample, and displays best-match/saved-colour sections")

    for theme in ("light", "dark"):
        set_theme(browser, theme)
        viewport(browser, 320, 844, True)
        for route in FEATURES + ["device", "settings", "about", "visualize"]:
            browser.route(route)
            browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")
            no_overflow(browser, f"{theme} {route} at 320px")
    viewport(browser)
    set_theme(browser, "light")
    browser.route("home")
    assert not browser.errors, "Browser errors: " + " | ".join(browser.errors)
    return {"status": "passed", "checks": checks, "screenshots": screenshots, "browser_errors": browser.errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--chrome", default=r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    args = parser.parse_args()
    ARTIFACTS.mkdir(exist_ok=True)
    profiles = ARTIFACTS / "temp-browser"
    profiles.mkdir(exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="chroma-reference-", dir=profiles))
    command = [args.chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
               "--disable-background-networking", f"--remote-debugging-port={PORT}",
               f"--remote-allow-origins=http://localhost:{PORT}", f"--user-data-dir={profile}", "about:blank"]
    process = browser = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        deadline = time.monotonic() + 15
        target = None
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Chrome exited; isolated-browser execution may require sandbox approval.")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=1) as response:
                    target = next((tab for tab in json.load(response) if tab.get("type") == "page"), None)
                if target:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        if not target:
            raise RuntimeError("Chrome debugging endpoint did not start.")
        browser = Browser(target["webSocketDebuggerUrl"])
        report = check_reference_ui(browser, args.url)
        (ARTIFACTS / "chroma-reference-ui-results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
        return 0
    except Exception as error:
        if browser:
            try:
                shot = browser.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
                (ARTIFACTS / "chroma-reference-ui-failure.png").write_bytes(base64.b64decode(shot["data"]))
            except Exception:
                pass
        report = {"status": "failed", "error": str(error), "last_command": browser.last_command if browser else "Chrome startup", "browser_errors": browser.errors if browser else []}
        (ARTIFACTS / "chroma-reference-ui-results.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(json.dumps(report, indent=2))
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
