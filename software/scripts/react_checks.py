"""End-to-end checks for the CHROMA React application using the CDP harness."""
import json
import time
from collection_checks import check_collections
from bluetooth_checks import check_bluetooth
from mobile_checks import check_mobile
from studio_checks import check_studio
from visualize_checks import check_visualize


ACTIVE = "document.querySelector('[data-page]:not([hidden])')"
MODAL = "document.querySelector('dialog[open]')"
STATE = "JSON.parse(localStorage.getItem('chroma-workspace-v2'))"


def reload_app(browser, ready):
    """Wait for a new document, not the previous React tree before unload."""
    previous_origin = browser.evaluate('performance.timeOrigin')
    browser.call('Page.reload', {'ignoreCache': True})
    expression = ('performance.timeOrigin !== ' + json.dumps(previous_origin)
                  + " && document.readyState === 'complete' && Boolean(" + ready + ')')
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            if browser.evaluate(expression):
                return
        except (AssertionError, RuntimeError) as error:
            # A reload may destroy the execution context between CDP polling
            # calls; genuine JavaScript errors must still fail the regression.
            if not any(message in str(error).lower() for message in [
                'execution context was destroyed', 'cannot find context',
                'inspected target navigated', 'cannot find default execution context',
            ]):
                raise
        time.sleep(0.08)
    raise AssertionError('Reloaded app did not become ready: ' + ready)


def run_react_checks(browser, url):
    checks, screenshots = [], []
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    browser.call('Page.navigate', {'url': url})
    browser.wait("document.querySelector('#main h1') && document.querySelector('[data-nav=home]')")
    browser.wait(STATE + '?.projects?.length > 0')
    assert browser.evaluate("(() => {const heading=document.querySelector('#main h1').textContent.toUpperCase();return heading.includes('CHROMA') && heading.includes('STUDIO') && document.querySelector('[data-page=home]').textContent.includes('Turn colours into possibilities.');})()")
    assert browser.evaluate(STATE + ".projects.some(project=>project.name==='Summer Packaging')")
    checks.append('React workspace loads with the requested Home copy, realistic colours, and Summer Packaging project')
    checks.append(browser.evaluate("import('/tests/test-color.mjs').then(module=>module.testResult)"))
    checks.append(browser.evaluate("import('/tests/test-device.mjs').then(module=>module.runDeviceTests())"))
    checks.append(check_bluetooth(browser))
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
    try:
        checks.append(browser.evaluate("import('/tests/test-ble-data-ui.tsx').then(module=>module.runRawBleUiTests())"))
    finally:
        # Restore the main React tree after the isolated native-BLE fixture.
        reload_app(browser, "document.querySelector('#main h1') && document.querySelector('[data-nav=home]')")

    routes = ['home', 'scan', 'compare', 'convert', 'image', 'library', 'projects', 'device', 'settings', 'visualize']
    for label, width, height, mobile in [('desktop', 1440, 1100, False), ('tablet', 820, 1180, False), ('mobile', 390, 844, True)]:
        browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile})
        for route in routes:
            browser.route(route)
            result = browser.evaluate("(() => {const active=" + ACTIVE + "; return {heading:active?.querySelector('h1')?.textContent, content:active?.textContent.length, viewport:innerWidth, width:document.documentElement.scrollWidth};})()")
            assert result['heading'] and result['content'] > 100, f'Empty {route} route: {result}'
            assert result['width'] <= result['viewport'] + 1, f'Horizontal overflow at {width}px in {route}: {result}'
            screenshots.append(browser.screenshot(f'chroma-{route}-{label}.png', width, height, mobile))
            if route == 'compare' and mobile:
                paired = browser.evaluate("(() => {const pair=" + ACTIVE + ".querySelector('.compare-pair'); if(!pair || pair.children.length<2)return false; const a=pair.children[0].getBoundingClientRect(), b=pair.children[1].getBoundingClientRect(); return b.left>=a.right-2 && Math.abs(a.top-b.top)<2;})()")
                assert paired, 'Reference and sample must remain side by side at 390px, matching the Studio reference'
    checks.append('All ten routes render at 1440px, 820px, and 390px without overflow; reference/sample panels pair at 390px; 30 screenshots captured')
    checks.append(check_mobile(browser))
    checks.extend(check_studio(browser))
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})

    browser.route('device')
    browser.wait(ACTIVE + ".textContent.includes('78%')")
    assert browser.evaluate(ACTIVE + ".textContent.includes('demo')")
    assert browser.evaluate(ACTIVE + ".textContent.includes('v1.0')")
    assert browser.evaluate(ACTIVE + ".textContent.includes('CHROMA DESKBOT') && " + ACTIVE + ".textContent.toLowerCase().includes('future')")
    oled_before_id = browser.state()['latest']['id']
    browser.click_text('Try OLED demo')
    browser.wait(ACTIVE + ".querySelector('.oled-screen')?.classList.contains('is-scanning')")
    browser.wait(ACTIVE + ".querySelector('.oled-result-chip') && !" + ACTIVE + ".querySelector('.oled-screen').classList.contains('is-scanning')")
    browser.wait(STATE + ".latest.id !== " + json.dumps(oled_before_id))
    latest = browser.state()['latest']['hex']
    assert browser.evaluate(ACTIVE + ".querySelector('.oled-content strong').textContent") == latest
    browser.click_text('Calibrate')
    browser.wait("document.querySelector('.calibration-modal')?.open")
    browser.click_text('Start Calibration', MODAL)
    browser.wait("document.querySelector('.calibration-complete')?.textContent.includes('Calibration Complete')")
    browser.click_text('Done', MODAL)
    browser.click_text('Disconnect')
    browser.wait(ACTIVE + ".textContent.includes('Enable demo mode')")
    browser.wait(ACTIVE + ".querySelector('.oled-content strong')?.textContent === 'OFFLINE'")
    assert browser.evaluate("Array.from(" + ACTIVE + ".querySelectorAll('button')).find(e=>e.textContent.trim()==='Calibrate').disabled")
    browser.click_text('Enable demo mode', exact=False)
    browser.wait(ACTIVE + ".textContent.includes('Demo mode active')")
    checks.append('Device shows demo battery/firmware; OLED scans and synchronises with workspace; calibration completes; disconnect and reconnect work; Deskbot is labelled future')

    browser.route('scan')
    before_id = browser.state()['latest']['id']
    browser.click('[data-action="scan"]')
    browser.wait("document.querySelector('[data-action=scan]').disabled")
    browser.wait(STATE + ".latest.id !== '" + before_id + "'")
    browser.wait("!document.querySelector('[data-action=scan]').disabled")
    captured = browser.state()['latest']
    assert captured['source'] == 'demo'
    formats = browser.evaluate("Array.from(" + ACTIVE + ".querySelectorAll('.metric small')).map(e=>e.textContent)")
    assert set(['HEX', 'RGB', 'LAB', 'CMYK']).issubset(set(formats))
    checks.append('Scan shows a scanning state, persists a fresh demo capture, and exposes HEX/RGB/LAB/CMYK')

    browser.route('convert')
    for fmt, value, expected in [('HEX', '#E0354D', '#E0354D'), ('HEX', 'e0354d', '#E0354D'), ('HEX', '#000000', '#000000'), ('HEX', '#FFFFFF', '#FFFFFF'), ('HEX', '#FF0000', '#FF0000'), ('HEX', '#00FF00', '#00FF00'), ('HEX', '#0000FF', '#0000FF'), ('RGB', '224,53,77', '#E0354D'), ('RGB', '224 53 77', '#E0354D'), ('RGB', '0,0,0', '#000000'), ('RGB', '255,255,255', '#FFFFFF'), ('RGB', '255,0,0', '#FF0000')]:
        browser.click_text(fmt, ACTIVE + ".querySelector('.format-tabs')")
        browser.fill('#convert-input', value)
        browser.wait(ACTIVE + ".querySelector('.colour-hex')?.textContent === '" + expected + "'")
        assert browser.evaluate("document.querySelector('#convert-error').textContent") == ''
    for fmt, value in [('HEX', '#GG0000'), ('HEX', '#FFF'), ('HEX', '#1234567'), ('RGB', '-1,2,3'), ('RGB', '256,2,3'), ('RGB', '1,2'), ('RGB', '1,blue,3')]:
        browser.click_text(fmt, ACTIVE + ".querySelector('.format-tabs')")
        before_hex = browser.evaluate(ACTIVE + ".querySelector('.colour-hex').textContent")
        browser.fill('#convert-input', value)
        browser.wait("document.querySelector('#convert-error').textContent.length > 0")
        assert browser.evaluate(ACTIVE + ".querySelector('.colour-hex').textContent") == before_hex
        assert browser.evaluate("document.querySelector('#convert-input').getAttribute('aria-invalid')") == 'true'
    browser.click_text('HEX', ACTIVE + ".querySelector('.format-tabs')")
    browser.fill('#convert-input', 'e0354d')
    browser.submit('#convert-form')
    browser.wait("document.querySelector('#convert-input').value === '#E0354D'")
    browser.fill('#convert-picker', '#123456')
    browser.wait("document.querySelector('#convert-input').value === '#123456' && " + ACTIVE + ".querySelector('.colour-hex').textContent === '#123456'")
    browser.fill('#convert-input', '#E0354D')
    browser.wait(ACTIVE + ".querySelector('.colour-hex').textContent === '#E0354D'")
    browser.evaluate("Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async value=>{window.__copied=value}}})")
    values = browser.evaluate("import('/src/components/ui.tsx').then(m=>m.colourValues('#E0354D'))")
    for fmt in ['HEX', 'RGB', 'HSL', 'CMYK', 'LAB']:
        browser.click('[data-page="convert"] [aria-label^="Copy ' + fmt + ':"]')
        browser.wait('window.__copied === ' + json.dumps(values[fmt]))
    assert browser.evaluate(ACTIVE + ".textContent.toLowerCase().includes('approximation')")
    for fmt, value, expected in [('RGB', '0, 128, 255', '#0080FF'), ('HSL', '120, 100, 50', '#00FF00')]:
        browser.click_text(fmt, ACTIVE + ".querySelector('.format-tabs')")
        browser.fill('#convert-input', value)
        browser.submit('#convert-form')
        browser.wait(ACTIVE + ".querySelector('.colour-hex')?.textContent === '" + expected + "'")
    browser.fill('#convert-input', '120, 101, 50')
    browser.submit('#convert-form')
    browser.wait("document.querySelector('#convert-error').textContent.length > 0")
    assert browser.evaluate(ACTIVE + ".querySelector('.colour-hex').textContent") == '#00FF00'
    colour_export = browser.evaluate("""(async () => {
      const oldCreate=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click;let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try{Array.from(document.querySelector('[data-page=convert]').querySelectorAll('button')).find(e=>e.textContent.trim()==='Share / export colour').click();return JSON.parse(await blob.text())}
      finally{URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick}
    })()""")
    assert colour_export['product'] == 'CHROMA' and colour_export['version'] == 2
    assert colour_export['colours'][0]['hex'] == '#00FF00'
    assert all(fmt in colour_export['colours'][0]['formats'] for fmt in ['hex', 'rgb', 'hsl', 'cmyk', 'lab'])
    checks.append('Convert updates live for strict six-digit HEX with/without # and comma/space RGB; validates malformed/range errors without losing the last valid result; picker stays synchronized; all five values copy; existing HSL input remains supported')
    checks.append('Convert shares a standard CHROMA JSON colour export with all five app-calculated formats')

    browser.click_text('Save colour')
    browser.wait(MODAL + '?.open')
    browser.fill('#save-name', 'Browser test green')
    browser.fill('#save-tags', 'packaging, test-tag')
    browser.submit('#save-form')
    browser.wait('!' + MODAL)
    browser.route('library')
    browser.fill('[aria-label="Search library"]', 'test-tag')
    browser.wait("document.querySelectorAll('.collection-colour').length === 1")
    assert browser.evaluate("document.querySelector('.collection-colour').textContent.includes('RGB 0 / 255 / 0')")
    assert browser.evaluate("document.querySelector('.collection-colour time')?.dateTime.length > 0")
    browser.click_text('Rename / edit')
    browser.fill('#save-name', 'Renamed browser green')
    browser.fill('#save-tags', 'packaging, test-tag, approved')
    browser.submit('#save-form')
    browser.wait("document.querySelector('[aria-label=\"View Renamed browser green\"]')")
    browser.click('[aria-label="View Renamed browser green"]')
    browser.wait(MODAL + ".querySelector('h2')?.textContent === 'Renamed browser green'")
    browser.click('dialog[open] [aria-label="Close dialog"]')
    browser.fill('[aria-label="Search library"]', '')

    backup = browser.evaluate("""(async () => {
      const oldCreate=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click;let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try{Array.from(document.querySelector('[data-page=library]').querySelectorAll('button')).find(e=>e.textContent.trim()==='Export').click();return JSON.parse(await blob.text())}
      finally{URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick}
    })()""")
    assert backup['product'] == 'CHROMA' and backup['version'] == 2
    assert any(colour['name'] == 'Renamed browser green' and 'approved' in colour['tags'] for colour in backup['colours'])
    before_import = len(browser.state()['library'])
    browser.upload_json(backup)
    browser.wait("!Array.from(" + ACTIVE + ".querySelectorAll('button')).some(e=>e.textContent.includes('Importing'))")
    assert len(browser.state()['library']) == before_import, 'Reimporting an export should not duplicate records'
    incoming = {'product': 'CHROMA', 'version': 2, 'colours': [{'id': 'browser-import-colour', 'hex': '#123456', 'name': 'Imported proof blue', 'tags': ['imported'], 'projectId': 'browser-import-project'}], 'projects': [{'id': 'browser-import-project', 'name': 'Imported proof project', 'notes': 'Local import preserved'}], 'comparisons': []}
    browser.upload_json(incoming)
    browser.wait(STATE + ".library.some(c=>c.name==='Imported proof blue')")
    state = browser.state()
    imported_colour = next(c for c in state['library'] if c['name'] == 'Imported proof blue')
    assert any(p['id'] == imported_colour['projectId'] and p['name'] == 'Imported proof project' for p in state['projects'])
    before_invalid = len(state['library'])
    browser.upload_json({'colours': [{'hex': '#NOTHEX', 'name': 'Invalid import'}]})
    browser.wait("document.querySelector('.toast')?.textContent.includes('invalid')")
    assert len(browser.state()['library']) == before_invalid
    reload_app(browser, "document.querySelector('[aria-label=\"View Renamed browser green\"]')")
    checks.append('Library saves, renames, edits tags, displays RGB/date, searches tags, preserves custom detail titles, exports/imports projects without duplication, and survives reload')

    # Refresh intentionally clears session-only Match state. Receive a fresh
    # ordinary scan before selecting a target; persisted latest is not a scan.
    browser.route('scan')
    before_library_scan = browser.state()['latest']['id']
    browser.click('[data-action="scan"]')
    browser.wait(STATE + ".latest.id !== " + json.dumps(before_library_scan))
    browser.wait("!document.querySelector('[data-action=scan]').disabled")
    browser.route('library')

    # Imported older colours have no Match metadata (or serialized RGB). They
    # should become references without changing the saved item or its project.
    library_before_match = browser.state()['library']
    projects_before_match = browser.state()['projects']
    legacy_target = next(c for c in library_before_match if c['name'] == 'Imported proof blue')
    green_target = next(c for c in library_before_match if c['name'] == 'Renamed browser green')
    browser.click('[aria-label="Use Imported proof blue as Match Target"]')
    browser.wait("location.hash === '#image' && " + ACTIVE + ".querySelector('[data-testid=match-target-source]')?.textContent.includes('Library')")
    browser.wait(ACTIVE + ".querySelector('[data-testid=image-match-target]')?.textContent.includes('#123456')")
    assert browser.evaluate("document.querySelector('#match-library-colour').dataset.value") == legacy_target['id']
    assert browser.evaluate("!document.querySelector('#image-canvas')"), 'A Library target must not require an uploaded image'
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')")
    expected_delta = browser.evaluate("import('/src/lib/color.ts').then(m=>m.deltaE('#123456'," + json.dumps(browser.state()['latest']['hex']) + ").toFixed(2))")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=delta-e]').childNodes[0].textContent") == expected_delta
    imported_values = browser.evaluate("import('/src/components/ui.tsx').then(m=>m.colourValues('#123456'))")
    assert browser.evaluate(ACTIVE + ".querySelector('[aria-label=" + json.dumps('Copy RGB: ' + imported_values['RGB']) + "]') !== null")
    browser.fill('#match-library-colour', green_target['id'])
    browser.wait(ACTIVE + ".querySelector('[data-testid=image-match-target]')?.textContent.includes('#00FF00')")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=delta-e]') !== null"), 'Replacing a Library target must preserve a scan-first sample'
    browser.click('#match-clear-target')
    browser.wait("!" + ACTIVE + ".querySelector('[data-testid=delta-e]')")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=image-match-sample] .colour-hex') !== null"), 'Clear target must retain the sample'
    browser.fill('#match-library-colour', legacy_target['id'])
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')")
    browser.click('#match-clear-sample')
    browser.wait("!" + ACTIVE + ".querySelector('[data-testid=delta-e]')")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=image-match-target]').textContent.includes('#123456')")
    before_match_scan = browser.state()['latest']['id']
    browser.click('#image-scan')
    browser.wait(STATE + ".latest.id !== " + json.dumps(before_match_scan))
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')")
    browser.fill('[data-page="image"] .project-select [data-picker-trigger]', legacy_target['projectId'])
    browser.click_text('Save comparison')
    browser.wait(STATE + ".comparisons.some(c=>c.matchTarget?.libraryItemId === " + json.dumps(legacy_target['id']) + ")")
    saved_library_match = next(c for c in browser.state()['comparisons'] if c.get('matchTarget', {}).get('libraryItemId') == legacy_target['id'])
    assert saved_library_match['projectId'] == legacy_target['projectId']
    assert saved_library_match['matchTarget']['source'] == 'library' and saved_library_match['matchTarget']['name'] == legacy_target['name']
    assert saved_library_match['sampleSource'] == 'demo' and 'deviceDeltaE' not in saved_library_match
    library_result_export = browser.evaluate("""(async () => {
      const oldCreate=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click;let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try{Array.from(document.querySelector('[data-page=image]').querySelectorAll('button')).find(e=>e.textContent.trim()==='Share / export result').click();return JSON.parse(await blob.text())}
      finally{URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick}
    })()""")
    assert library_result_export['version'] == 2 and library_result_export['product'] == 'CHROMA'
    shared_library_match = library_result_export['comparisons'][0]
    assert shared_library_match['matchTarget']['source'] == 'library' and shared_library_match['matchTarget']['libraryItemId'] == legacy_target['id']
    assert shared_library_match['reference']['hex'] == '#123456' and shared_library_match['method'] == 'CIEDE2000'
    assert browser.state()['library'] == library_before_match and browser.state()['projects'] == projects_before_match, 'Using, replacing, clearing, scanning and exporting Library targets must not change saved colours or projects'
    for width in [320, 390]:
        browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 844, 'deviceScaleFactor': 3, 'mobile': True})
        assert browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Populated Library Match overflows at {width}px'
    screenshots.append(browser.screenshot('chroma-library-match-mobile.png', 390, 844, True))
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    screenshots.append(browser.screenshot('chroma-library-match-desktop.png', 1440, 1100, False))
    reload_app(browser, ACTIVE + "?.querySelector('#image-match-heading')")
    assert browser.state()['library'] == library_before_match
    assert browser.evaluate("!" + ACTIVE + "?.querySelector('[data-testid=delta-e]')"), 'Refresh should safely start the existing session-only Match state empty'
    checks.append('Library actions navigate to the shared Match page; older imported colours retain HEX/RGB/source/id/name/project metadata; scan-first and target-first demo matching, replacement, independent resets and app CIEDE2000 work without altering Library records')
    checks.append('Library-target comparisons save to Projects and share through the existing JSON envelope; populated 320px/390px layouts, desktop/mobile screenshots and refresh are verified')

    browser.route('compare')
    browser.fill('#compareA', '#FF0000')
    browser.fill('#compareB', '#FF0000')
    browser.submit('#compare-form')
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')?.childNodes[0].textContent === '0.00'")
    assert browser.evaluate(ACTIVE + ".querySelector('.match-result h3').textContent") == 'Match'
    before_comparisons = len(browser.state()['comparisons'])
    browser.click_text('Save comparison')
    browser.wait(STATE + '.comparisons.length > ' + str(before_comparisons))
    assert any(c['a'] == '#FF0000' and c['b'] == '#FF0000' for c in browser.state()['comparisons'])
    browser.fill('#compareB', '#0000FF')
    browser.submit('#compare-form')
    browser.wait(ACTIVE + ".querySelector('.match-result h3')?.textContent === 'Difference detected'")
    browser.route('library')
    browser.click_text('Comparisons', ACTIVE + ".querySelector('.collection-tabs')", exact=False)
    browser.click_text('Edit details')
    browser.fill('#comparison-name', 'Browser comparison proof')
    browser.fill('dialog[open] .project-select [data-picker-trigger]', 'summer-packaging')
    browser.click_text('Save changes', MODAL)
    browser.wait(STATE + ".comparisons.some(c=>c.name==='Browser comparison proof' && c.projectId==='summer-packaging')")
    checks.append('Identical colours give ΔE 0.00/Match, distinct colours show Difference detected; comparisons save, rename, and attach to a project')

    browser.route('image')
    browser.click_text('Explore with a sample image', exact=False)
    browser.wait("document.querySelector('#image-canvas')?.width > 0")
    browser.evaluate("(() => {const c=document.querySelector('#image-canvas'),r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));})()")
    browser.wait(ACTIVE + ".querySelector('.colour-hex')?.textContent.match(/^#[0-9A-F]{6}$/)")
    browser.click_text('Use latest capture')
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')")
    browser.upload_image("ctx.fillStyle='#12AB34';ctx.fillRect(0,0,2,2);")
    browser.fill('#pixel-x', '1')
    browser.fill('#pixel-y', '1')
    browser.submit('#pixel-form')
    browser.wait(ACTIVE + ".querySelector('.colour-hex')?.textContent === '#12AB34'")
    formats = browser.evaluate("Array.from(" + ACTIVE + ".querySelectorAll('.metric small')).map(e=>e.textContent)")
    assert set(['HEX', 'RGB', 'LAB', 'CMYK']).issubset(set(formats))
    browser.click_text('Extract Palette')
    browser.wait("document.querySelector('[aria-label=\"Extracted dominant palette\"] button')")
    assert browser.evaluate("document.querySelector('[aria-label=\"Extracted dominant palette\"] button').getAttribute('aria-label')").startswith('Select dominant colour #12AB34')
    browser.click_text('Save palette')
    browser.wait(STATE + ".library.some(c=>c.hex==='#12AB34' && c.tags.includes('image'))")

    browser.upload_image("ctx.fillStyle='#FF0000';ctx.fillRect(0,0,2400,10);ctx.fillStyle='#0012EF';ctx.fillRect(1800,1,3,3);", 2400, 10)
    assert browser.evaluate("document.querySelector('#image-canvas').width") == 1600
    browser.fill('#pixel-x', '1801')
    browser.fill('#pixel-y', '2')
    browser.submit('#pixel-form')
    browser.wait(ACTIVE + ".querySelector('.colour-hex')?.textContent === '#0012EF'")
    before_image_rescan = browser.state()['latest']['id']
    browser.click('#image-scan')
    browser.wait(STATE + ".latest.id !== " + json.dumps(before_image_rescan))
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')")
    browser.click_text('Save comparison')
    browser.wait(STATE + ".comparisons.some(c=>c.a==='#0012EF')")
    image_export = browser.evaluate("""(async () => {
      const oldCreate=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click;let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try{Array.from(document.querySelector('[data-page=image]').querySelectorAll('button')).find(e=>e.textContent.trim()==='Share / export result').click();return JSON.parse(await blob.text())}
      finally{URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick}
    })()""")
    result = image_export['comparisons'][0]
    assert image_export['product'] == 'CHROMA' and image_export['version'] == 2
    assert result['a'] == '#0012EF' and result['sampleSource'] == 'demo'
    assert result['method'] == 'CIEDE2000' and result['deltaE'] >= 0
    assert result['reference']['hex'] == result['a'] and result['sample']['hex'] == result['b']
    assert 'deviceDeltaE' not in result
    for width in [320, 390]:
        browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 844, 'deviceScaleFactor': 3, 'mobile': True})
        assert browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), f'Populated Image Match overflows at {width}px'
    screenshots.append(browser.screenshot('chroma-image-result-mobile.png', 390, 844, True))
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    screenshots.append(browser.screenshot('chroma-image-result-desktop.png', 1440, 1100, False))
    browser.route('convert')
    browser.route('image')
    assert browser.evaluate("document.querySelector('#image-canvas').width") == 1600
    assert browser.evaluate(ACTIVE + ".querySelector('.colour-hex').textContent") == '#0012EF'
    checks.append('Sample and local images load; original 3x3 sampling stays exact beyond preview size; pixel conversions, palettes, image-to-demo comparison/save/share, populated mobile layouts and navigation persistence work')

    checks.append(check_collections(browser))
    browser.route('library')
    browser.fill('[aria-label="Search library"]', 'Renamed browser green')
    browser.wait("document.querySelectorAll('.collection-colour').length === 1")
    browser.click('[aria-label="Delete Renamed browser green"]')
    browser.wait(MODAL + '?.open')
    browser.click_text('Keep it', MODAL)
    assert any(c['name'] == 'Renamed browser green' for c in browser.state()['library'])
    browser.click('[aria-label="Delete Renamed browser green"]')
    browser.click_text('Delete colour', MODAL)
    browser.wait('!' + STATE + ".library.some(c=>c.name==='Renamed browser green')")
    checks.append('Colour deletion supports cancellation, then removes only the selected record after confirmation')

    visualize = check_visualize(browser)
    checks.extend(visualize['checks'])
    screenshots.extend(visualize['screenshots'])
    browser.route('home')
    browser.evaluate('document.readyState')
    assert not browser.errors, 'Browser errors: ' + ' | '.join(browser.errors)
    checks.append('No uncaught JavaScript exceptions or browser console errors')
    return {'status': 'passed', 'checks': checks, 'screenshots': screenshots}
