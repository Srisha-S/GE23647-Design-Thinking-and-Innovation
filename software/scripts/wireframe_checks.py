"""Latest CHROMA wireframes exercised in the harness's disposable profile.

Uses the real React UI and web export path. Never reads or changes the user's
browser or Android storage. Run with check_chroma.py --wireframe-only.
"""
from __future__ import annotations

import json
import uuid

from check_chroma import ARTIFACTS
from react_checks import reload_app
from studio_checks import check_bottom_navigation, press_key

ACTIVE = "document.querySelector('[data-page]:not([hidden])')"
MODAL = "document.querySelector('dialog[open]')"
KEY = 'chroma-workspace-v2'
STATE = "JSON.parse(localStorage.getItem('chroma-workspace-v2'))"
MAIN_ROUTES = ['home', 'scan', 'compare', 'convert', 'image', 'library', 'projects', 'settings']
NAV_ROUTES = ['home', 'scan', 'compare', 'convert', 'image', 'library', 'projects', 'device', 'settings', 'about']


def route(browser, name):
    browser.route(name)
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    browser.wait(ACTIVE + '.querySelector("h1")')


def viewport(browser, width=390, height=844):
    browser.call('Emulation.setDeviceMetricsOverride', {
        'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': width < 650,
    })


def close_modal(browser):
    browser.click('dialog[open] [aria-label="Close dialog"]')
    browser.wait('!document.querySelector("dialog[open]")')


def assert_clean(browser, context):
    assert not browser.evaluate("Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Reload CHROMA')"), context + ': ErrorBoundary is visible'
    assert not browser.errors, context + ': browser errors: ' + ' | '.join(browser.errors)


def assert_layout(browser, context):
    layout = browser.evaluate('''(() => {
      const active=document.querySelector('[data-page]:not([hidden])');
      const header=document.querySelector('.studio-header');
      return {width:innerWidth,content:document.documentElement.scrollWidth,
        title:active.querySelector('h1')?.textContent,
        visibleHeadings:Array.from(active.querySelectorAll('h1')).filter(e=>e.getBoundingClientRect().width>2).length,
        actions:Array.from(header.querySelectorAll('button')).filter(e=>e.getClientRects().length).map(e=>e.getAttribute('aria-label'))};
    })()''')
    assert layout['content'] <= layout['width'] + 1, context + ': horizontal overflow: ' + str(layout)
    assert layout['title'], context + ': missing accessible route heading'
    assert len(layout['actions']) <= 3, context + ': hidden page actions leaked into the shared header: ' + str(layout)
    active_route = browser.evaluate(ACTIVE + '.dataset.page')
    for owner, label in [('convert', 'Colour actions'), ('image', 'Image Match actions')]:
        assert (label in layout['actions']) == (active_route == owner), context + ': persistent tool actions leaked across routes: ' + str(layout)
    assert_clean(browser, context)


def shared_theme(browser):
    return browser.evaluate('''(() => {
      const style=getComputedStyle(document.documentElement);
      return {theme:document.documentElement.dataset.theme,body:getComputedStyle(document.body).backgroundColor,
        yellow:style.getPropertyValue('--yellow').trim(),blue:style.getPropertyValue('--blue').trim()};
    })()''')


def assert_scroll_theme(browser, expected, context):
    before = browser.evaluate("document.querySelector('[data-bottom-nav]')?.closest('nav').getBoundingClientRect().top ?? null")
    browser.evaluate("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})")
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert shared_theme(browser) == expected, context + ': shared Home palette changed while scrolling'
    after = browser.evaluate("document.querySelector('[data-bottom-nav]')?.closest('nav').getBoundingClientRect().top ?? null")
    assert before is None and after is None or before is not None and after is not None and abs(before - after) <= 1, context + ': bottom navigation moves when scrolling'
    browser.evaluate("window.scrollTo({top:0,behavior:'instant'})")


def check_navigation(browser, name):
    if name in ['home', 'library', 'projects']:
        check_bottom_navigation(browser, name)
    else:
        assert not browser.evaluate("document.querySelector('[data-bottom-nav]')"), name + ': bottom dock must be absent as in the wireframe'


def set_theme(browser, value):
    route(browser, 'settings')
    browser.click('[data-settings-row="appearance"]')
    browser.wait(MODAL)
    browser.click('[data-theme-option="' + value + '"]')
    if value != 'system':
        browser.wait('document.documentElement.dataset.theme === ' + json.dumps(value))
    close_modal(browser)


def capture_export(browser, text, scope=MODAL):
    return browser.evaluate('''(async () => {
      const oldCreate=URL.createObjectURL,oldClick=HTMLAnchorElement.prototype.click;let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try {
        const button=Array.from(''' + scope + '''.querySelectorAll('button')).find(e=>e.textContent.trim()===''' + json.dumps(text) + ''');
        if(!button)throw Error('Missing export action');button.click();
        for(let i=0;i<20&&!blob;i++)await new Promise(resolve=>setTimeout(resolve,20));
        if(!blob)throw Error('No JSON blob was exported');
        return JSON.parse(await blob.text());
      } finally {URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick;}
    })()''')


def check_home(browser):
    route(browser, 'home')
    details = browser.evaluate('''(() => {
      const home=document.querySelector('[data-page=home]');
      return {compact:Boolean(home.querySelector('.wireframe-home')),
        pod:home.querySelectorAll('[data-testid=reference-device-card]').length,
        latest:home.querySelector('.wireframe-last-scan')?.textContent,
        saved:home.querySelector('.wireframe-saved-colours')?.textContent,
        actions:Array.from(home.querySelectorAll('.wireframe-quick-actions [data-feature]')).map(e=>e.dataset.feature),
        extras:Boolean(home.querySelector('.recent-scans,.reference-home-secondary,.reference-feature-grid,.deskbot-concept,.home-concept-details')),
        deskbot:home.textContent.toLowerCase().includes('deskbot')};
    })()''')
    assert details['compact'] and details['pod'] == 1, 'Compact Home must retain the live ChromaPod card: ' + str(details)
    assert browser.state()['latest']['hex'] in details['latest'], 'Home latest scan must show the real saved reading'
    assert details['saved'] is not None, 'Wireframe Saved Colours section is absent'
    assert details['actions'] == ['scan', 'compare', 'image', 'convert'], 'Quick actions must match the wireframe: ' + str(details)
    assert not details['extras'] and not details['deskbot'], 'Non-wireframe Home sections remain: ' + str(details)


def check_drawer(browser, width):
    route(browser, 'home')
    browser.click('[aria-label="Open navigation"]')
    browser.wait("document.querySelector('#navigation-drawer')?.open")
    browser.evaluate('new Promise(resolve=>setTimeout(resolve,200))')
    details = browser.evaluate('''(() => {
      const drawer=document.querySelector('#navigation-drawer');
      const links=Array.from(drawer.querySelectorAll('[data-nav]'));
      const home=drawer.querySelector('[data-nav=home]').getBoundingClientRect();
      const brand=drawer.querySelector('.studio-drawer-heading').getBoundingClientRect();
      return {routes:links.map(e=>e.dataset.nav),gap:home.top-brand.bottom,
        positions:Object.fromEntries(links.map(e=>[e.dataset.nav,e.getBoundingClientRect().top])),
        caption:Boolean(drawer.querySelector('.studio-drawer-caption'))};
    })()''')
    assert details['routes'] == NAV_ROUTES, 'Wireframe menu destinations/order changed: ' + str(details)
    assert -1 <= details['gap'] <= 20, 'Excess top gap before Home at ' + str(width) + 'px: ' + str(details)
    assert details['positions']['projects'] < details['positions']['device'] < details['positions']['settings'] < details['positions']['about'], 'ChromaPod card and Settings/About must follow main links'
    assert not details['caption'], 'Removed workspace caption must not reappear'
    screenshots = browser.screenshot('wireframe/menu-' + str(width) + '-' + browser.evaluate('document.documentElement.dataset.theme') + '.png', width, 844, width < 650)
    press_key(browser, 'Escape', 'Escape', 27)
    browser.wait("!document.querySelector('#navigation-drawer').open")
    return screenshots


def check_convert(browser):
    route(browser, 'convert')
    browser.fill('#convert-input', '#E0354D')
    browser.submit('#convert-form')
    browser.wait("document.querySelector('#convert-input').value === '#E0354D'")
    values = {}
    for name in ['HEX', 'RGB', 'HSL', 'LAB', 'CMYK']:
        browser.fill('#convert-format', name)
        values[name] = browser.evaluate("document.querySelector('#convert-input').value")
        assert values[name] and 'NaN' not in values[name], 'Missing/invalid ' + name + ' conversion'
        browser.submit('#convert-form')
        browser.wait("!document.querySelector('#convert-error').textContent")
        assert browser.evaluate("document.querySelector('#convert-format').dataset.value") == name
    assert values['HEX'] == '#E0354D' and values['RGB'] == '224, 53, 77', 'Convert must retain trusted RGB/HEX conversion: ' + str(values)
    browser.fill('#convert-format', 'RGB')
    browser.fill('#convert-input', '224 53 77')
    browser.submit('#convert-form')
    browser.fill('#convert-format', 'HEX')
    assert browser.evaluate("document.querySelector('#convert-input').value") == '#E0354D'
    browser.fill('#convert-input', '#GG0000')
    browser.submit('#convert-form')
    browser.wait("document.querySelector('#convert-input').getAttribute('aria-invalid') === 'true'")
    browser.fill('#convert-format', 'HEX')
    assert browser.evaluate("document.querySelector('#convert-input').value") == '#E0354D', 'Invalid editing must preserve the last valid colour'
    browser.click('[aria-label="Colour actions"]')
    browser.wait(MODAL)
    data = capture_export(browser, 'Share / export colour')
    assert data['colours'][0]['hex'] == '#E0354D' and set(data['colours'][0]['formats']) >= {'hex', 'rgb', 'hsl', 'cmyk', 'lab'}, 'Convert share lost app-computed formats'
    close_modal(browser)
    assert not browser.evaluate(ACTIVE + ".querySelector('.studio-convert-preview,.studio-convert-harmonies,.large-swatch')"), 'Convert retained removed permanent sections'


def check_scan_compare(browser):
    route(browser, 'scan')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.wireframe-similar button').length") == 5
    browser.click('[data-action="scan-details"]')
    browser.wait(MODAL + '?.open')
    assert browser.evaluate(MODAL + ".querySelectorAll('.colour-metrics .metric').length") == 5
    before = browser.state()['latest']['id']
    browser.click('dialog[open] [data-action="scan"]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(before))
    browser.wait("!document.querySelector('dialog[open] [data-action=scan]').disabled")
    data = capture_export(browser, 'Share')
    latest = browser.state()['latest']
    assert data['colours'][0]['hex'] == latest['hex'] and data['colours'][0]['source'] == latest['source'], 'Scan share lost reading metadata'
    assert set(data['colours'][0]['formats']) >= {'hex', 'rgb', 'hsl', 'cmyk', 'lab'}, 'Scan share lost formats'
    close_modal(browser)
    route(browser, 'compare')
    browser.click('[data-action="compare-edit-a"]')
    browser.wait("document.querySelector('#compare-edit').open")
    browser.fill('#compareA', '#E0354D')
    browser.fill('#compareB', '#E0354D')
    browser.submit('#compare-form')
    browser.wait("!document.querySelector('#compare-edit').open")
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]').textContent === '0.00'")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=compare-match-ring]').dataset.matchPercent") == '100'
    before = len(browser.state()['comparisons'])
    browser.click_text('Save')
    browser.wait(STATE + '.comparisons.length === ' + str(before + 1))
    assert browser.state()['comparisons'][-1]['a'] == '#E0354D' or any(c['a'] == '#E0354D' and c['b'] == '#E0354D' for c in browser.state()['comparisons'])


def check_image(browser):
    route(browser, 'image')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.wireframe-pick-colour').length === 5 && " + ACTIVE + ".querySelectorAll('.wireframe-extracted-colours button').length === 5")
    assert not browser.evaluate(ACTIVE + ".querySelector('.reference-best-matches,.reference-saved-colours,.reference-workflow-heading')"), 'Image Match retained removed permanent extras'
    browser.click('[aria-label="Image Match actions"]')
    browser.wait(MODAL)
    browser.click_text('Explore with a sample image', scope=MODAL)
    browser.wait("document.querySelector('#image-canvas')?.width > 0")
    browser.wait("document.querySelector('.wireframe-extracted-colours button:not([disabled])')")
    browser.click('[aria-label="Image Match actions"]')
    browser.wait(MODAL)
    close_modal(browser)
    browser.evaluate('''(async () => {
      const canvas=document.createElement('canvas');canvas.width=12;canvas.height=12;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#E0354D';ctx.fillRect(0,0,12,12);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const transfer=new DataTransfer();transfer.items.add(new File([blob],'wireframe-test.png',{type:'image/png'}));
      const input=document.querySelector('#image-input');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()''')
    browser.wait("document.querySelector('#image-canvas')?.width === 12")
    browser.wait("document.querySelector('.wireframe-extracted-colours button[aria-label^=\"Select dominant colour #E0354D\"]:not([disabled])')")
    browser.click('.wireframe-extracted-colours button:not([disabled])')
    browser.wait(ACTIVE + ".querySelector('[data-testid=image-match-target]').textContent.includes('#E0354D')")
    browser.click('.wireframe-eyedropper')
    browser.wait(MODAL)
    browser.fill('#pixel-x', '0')
    browser.fill('#pixel-y', '0')
    browser.submit('#pixel-form')
    close_modal(browser)
    browser.wait(ACTIVE + ".querySelector('[data-testid=image-match-target]').textContent.includes('#E0354D')")
    assert browser.evaluate("!!document.querySelector('[data-testid=image-crosshair]')"), 'Original pixel sampling must remain available'
    before = browser.state()['latest']['id']
    browser.click('#image-scan')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(before))
    browser.wait("!document.querySelector('#image-scan').disabled")
    browser.wait(ACTIVE + ".querySelector('[data-testid=image-match-sample]').textContent.includes('Demo scan')")
    browser.wait(ACTIVE + ".querySelector('[data-testid=delta-e]')")
    browser.click('[aria-label="Image Match actions"]')
    browser.wait(MODAL)
    data = capture_export(browser, 'Share / export result')
    assert data['comparisons'][0]['a'] == '#E0354D' and data['comparisons'][0]['sampleSource'] == 'demo' and data['comparisons'][0]['matchTarget']['source'] == 'image', 'Image export must retain reference/sample provenance'
    close_modal(browser)


def check_collections(browser):
    route(browser, 'library')
    original = len(browser.state()['library'])
    browser.click('.wf-favourite')
    browser.click_text('Favourites')
    browser.wait(ACTIVE + ".querySelectorAll('.library-card').length > 0")
    browser.click_text('Recent')
    browser.wait(ACTIVE + ".querySelectorAll('.library-card').length > 0")
    browser.click_text('All')
    browser.click('.wf-library-swatch')
    browser.wait(MODAL)
    assert browser.evaluate(MODAL + ".textContent.includes('#')"), 'Saved colour details must open'
    close_modal(browser)
    browser.click('[aria-label="Library actions"]')
    browser.click_text('Add colour')
    browser.wait("document.querySelector('#save-form')")
    browser.fill('#save-name', 'Wireframe saved colour')
    browser.fill('#save-hex', '#123456')
    browser.fill('#save-tags', 'favourite, wireframe')
    browser.submit('#save-form')
    browser.wait(STATE + '.library.length === ' + str(original + 1))
    browser.fill('[aria-label="Search library"]', 'wireframe')
    browser.wait(ACTIVE + ".querySelectorAll('.library-card').length === 1")
    browser.fill('[aria-label="Search library"]', '')
    browser.click('[aria-label="View Wireframe saved colour"]')
    browser.wait(MODAL)
    browser.click_text('Use as Match Target', scope=MODAL)
    browser.wait(ACTIVE + ".dataset.page === 'image'")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=match-target-source]').textContent.includes('Library: Wireframe saved colour')"), 'Saved Library target metadata must survive navigation'
    route(browser, 'projects')
    browser.click('[aria-label="New project"]')
    browser.wait("document.querySelector('#project-name')")
    browser.fill('#project-name', 'Wireframe Design')
    browser.fill('#new-project-notes', 'Wireframe notes before edit')
    browser.click_text('Create project', scope=MODAL)
    browser.wait("document.querySelector('#project-notes')?.value === 'Wireframe notes before edit'")
    browser.wait("!document.querySelector('dialog[open]')")
    browser.fill('#project-notes', 'Updated wireframe project notes')
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    notes_debug = browser.evaluate('''(() => {
      const input=document.querySelector('#project-notes'), events=[];
      input.addEventListener('focus',()=>events.push('focus'),{once:true});
      input.addEventListener('blur',()=>events.push('blur'),{once:true});
      input.addEventListener('focusout',()=>events.push('focusout'),{once:true});
      const before={value:input.value,active:document.activeElement?.id,dialogs:Array.from(document.querySelectorAll('dialog[open]')).map(e=>e.textContent.slice(0,150))};
      input.focus();const focused=document.activeElement===input;input.blur();
      return {before,focused,afterActive:document.activeElement?.id,events};
    })()''')
    try:
        browser.wait(STATE + ".projects.some(project=>project.name==='Wireframe Design' && project.notes==='Updated wireframe project notes')")
    except AssertionError as error:
        notes_debug['stored'] = next(item for item in browser.state()['projects'] if item['name'] == 'Wireframe Design')
        raise AssertionError(str(error) + '; notes context: ' + json.dumps(notes_debug)) from error
    browser.click('[aria-label="Add colour to project"]')
    browser.wait("document.querySelector('#project-item')")
    colour_id = next(item['id'] for item in browser.state()['library'] if item['name'] == 'Wireframe saved colour')
    browser.fill('#project-item', colour_id)
    browser.click_text('Add to project', scope=MODAL)
    browser.wait("!document.querySelector('dialog[open]')")
    browser.wait(ACTIVE + ".querySelector('.wf-project-palette button[title^=\"Wireframe saved colour\"]')")
    project = next(item for item in browser.state()['projects'] if item['name'] == 'Wireframe Design')
    assert project['notes'] == 'Updated wireframe project notes', 'Project notes must save non-destructively: ' + str(project)
    browser.click('[aria-label="Share project"]')
    # Verify notes persist after leaving the detail, without relying on downloads.
    browser.click('[aria-label="Back to projects"]')
    browser.wait("!document.querySelector('#project-notes')")
    browser.click('[aria-label="Open Wireframe Design"]')
    browser.wait("document.querySelector('#project-notes')?.value === 'Updated wireframe project notes'")
    browser.click('[aria-label="Project actions"]')
    browser.wait(MODAL + ".textContent.includes('Save notes')")
    close_modal(browser)
    browser.click('[aria-label="Back to projects"]')
    route(browser, 'image')
    browser.click('[aria-label="Image Match actions"]')
    browser.wait(MODAL)
    browser.click_text('Visualize', scope=MODAL)
    browser.wait(ACTIVE + ".dataset.page === 'visualize' && !document.querySelector('dialog[open]')")


def legacy_navy(browser, url):
    stamp = '2025-07-08T10:11:12.000Z'
    navy = {'id': 'navy-reading', 'name': 'Navy', 'hex': '#000075', 'rgb': {'r': 0, 'g': 0, 'b': 117}, 'source': 'bluetooth', 'timestamp': stamp}
    variants = [None, {'h': '240', 's': '45%', 'l': '23%'}, {'h': 240, 's': None, 'l': 23}, {'h': 240, 's': 150, 'l': 23}, 'hsl(240, 45%, 23%)']
    colours = []
    for index, hsl in enumerate(variants):
        item = dict(navy, id='legacy-navy-' + str(index), name='Legacy Navy ' + str(index), favourite=True, projectId='old-project')
        if hsl is not None:
            item['hsl'] = hsl
        colours.append(item)
    raw = json.dumps({'version': 2, 'latest': navy, 'library': colours, 'history': [dict(navy, id='recent-navy')], 'projects': [{'id': 'old-project', 'name': 'Old Navy Project'}], 'comparisons': [{'id': 'old-proof', 'a': '#000075', 'b': '#000001'}]})
    token = uuid.uuid4().hex
    script = 'localStorage.setItem(' + json.dumps(KEY) + ',' + json.dumps(raw) + ');window.__wireframeLegacyToken=' + json.dumps(token) + ';'
    browser.call('Page.navigate', {'url': 'about:blank'})
    browser.wait("location.href === 'about:blank'")
    identifier = browser.call('Page.addScriptToEvaluateOnNewDocument', {'source': script})['identifier']
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait("window.__wireframeLegacyToken === " + json.dumps(token) + " && document.querySelector('.wireframe-last-scan')")
    browser.call('Page.removeScriptToEvaluateOnNewDocument', {'identifier': identifier})
    assert browser.evaluate("document.querySelector('.wireframe-last-scan').textContent.includes('#000075')")
    route(browser, 'scan')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.wireframe-similar button').length") == 5
    browser.click('[data-action="scan-details"]')
    browser.wait(MODAL)
    assert browser.evaluate(MODAL + ".querySelector('[aria-label^=\"Copy HSL:\"]').textContent.includes('100%')")
    close_modal(browser)
    route(browser, 'library')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.library-card').length") == 5
    browser.click_text('Favourites')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.library-card').length") == 5
    browser.click_text('Recent')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.library-card').length") == 1
    browser.click_text('All')
    browser.click('[aria-label="View Legacy Navy 0"]')
    browser.wait(MODAL)
    close_modal(browser)
    route(browser, 'projects')
    browser.click('[aria-label="Open Old Navy Project"]')
    assert browser.evaluate("document.querySelector('#project-notes').value") == ''
    assert browser.evaluate(ACTIVE + ".textContent.includes('#000075') || " + ACTIVE + ".querySelector('[title*=\"#000075\"]') != null")
    browser.click('[aria-label="Back to projects"]')
    for name in ['home', 'scan', 'compare', 'convert', 'image']:
        route(browser, name)
        assert_clean(browser, 'Legacy Navy ' + name)
    reload_app(browser, ACTIVE + '.dataset.page === "image"')
    route(browser, 'home')
    assert browser.evaluate('localStorage.getItem(' + json.dumps(KEY) + ')') == raw, 'Legacy raw data must remain preserved across rendering/reload'
    assert_clean(browser, 'Legacy Navy reload')


def check_wireframes(browser, url):
    for domain in ['Page', 'Runtime', 'Log']:
        browser.call(domain + '.enable')
    # Headless Chrome otherwise changes activeElement without dispatching native
    # focus/blur events when its page is not the focused browser surface.
    browser.call('Emulation.setFocusEmulationEnabled', {'enabled': True})
    viewport(browser)
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait("document.querySelector('.wireframe-home') && " + STATE + '?.projects?.length > 0')
    (ARTIFACTS / 'wireframe').mkdir(exist_ok=True)
    checks, screenshots = [], []
    check_home(browser)
    check_scan_compare(browser)
    check_convert(browser)
    check_image(browser)
    check_collections(browser)
    browser.wait("!document.querySelector('.toast')?.textContent")
    checks.append('Scan demo and all five values/JSON, Compare editing/match/save, all Convert formats and invalid-input recovery, sample/custom image upload/palette/pixel/scan/JSON, saved Library targets, favourites/recent/search, project creation/notes/add-colour pass through the real UI')
    for theme in ['light', 'dark']:
        set_theme(browser, theme)
        route(browser, 'home')
        expected = shared_theme(browser)
        for name in MAIN_ROUTES + ['about', 'device']:
            route(browser, name)
            assert_layout(browser, theme + ' ' + name)
            assert shared_theme(browser) == expected, name + ': chrome differs from Home theme'
            check_navigation(browser, name)
            assert_scroll_theme(browser, expected, theme + ' ' + name)
            screenshots.append(browser.screenshot('wireframe/' + name + '-' + theme + '.png', 390, 844, True))
        route(browser, 'projects')
        browser.click('[aria-label="Open Wireframe Design"]')
        assert_layout(browser, theme + ' project detail')
        screenshots.append(browser.screenshot('wireframe/project-detail-' + theme + '.png', 390, 844, True))
        browser.click('[aria-label="Back to projects"]')
        screenshots.append(check_drawer(browser, 390))
    checks.append('Every wireframe plus Device/About and project detail shares Home colours in light/dark, including scrolling; 24 mobile screenshots and raised Home/Scan/Library/Projects dock verified on Home/Library/Projects; dock is absent on tool pages as in the wireframe')
    for width in [320, 820, 1440]:
        viewport(browser, width, 844 if width < 650 else 1100)
        for name in MAIN_ROUTES:
            route(browser, name)
            assert_layout(browser, name + ' at ' + str(width))
        screenshots.append(check_drawer(browser, width))
    checks.append('Home, Scan, Compare, Convert, Image Match, Library, Projects and Settings have no horizontal overflow at 320/390/820/1440px; drawer has exact wireframe destinations without the old top gap')
    viewport(browser)
    route(browser, 'settings')
    rows = browser.evaluate(ACTIVE + ".querySelectorAll('[data-settings-row]').length")
    assert rows == 6 and not browser.evaluate(ACTIVE + ".querySelector('.studio-settings-tabs')"), 'Settings must show six wireframe rows and no old tabs'
    assert 'Your workspace stays local' not in browser.evaluate(ACTIVE + '.textContent')
    browser.click('[data-settings-row="colour"]')
    browser.wait(MODAL)
    assert browser.evaluate(MODAL + ".querySelectorAll('[data-accent-option]').length") == 6
    browser.click('[data-accent-option="blue"]')
    browser.wait("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#3366FF'")
    assert browser.evaluate("localStorage.getItem('chroma-accent-v1')") == 'blue'
    browser.click('[data-accent-option="yellow"]')
    browser.wait("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#FFD12E'")
    close_modal(browser)
    browser.click('[data-settings-row="notifications"]')
    browser.wait(MODAL)
    close_modal(browser)
    browser.click('[data-settings-row="help"]')
    browser.wait(MODAL)
    close_modal(browser)
    browser.click('[data-settings-row="about"]')
    browser.wait(ACTIVE + '.dataset.page === "about"')
    set_theme(browser, 'system')
    browser.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]})
    browser.wait("document.documentElement.dataset.theme === 'dark'")
    browser.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'light'}]})
    browser.wait("document.documentElement.dataset.theme === 'light'")
    set_theme(browser, 'dark')
    reload_app(browser, ACTIVE + '.dataset.page === "settings"')
    browser.wait("document.documentElement.dataset.theme === 'dark'")
    checks.append('Settings contains only Appearance/Theme Colour/Device/Notifications/Help/About rows; all six accent choices are present, changing accent applies/persists; light/dark/system appearance works and dark persists through reload; removed local-workspace prompt stays absent')
    legacy_navy(browser, url)
    route(browser, 'scan')
    screenshots.append(browser.screenshot('wireframe/legacy-navy-scan.png', 390, 844, True))
    checks.append('Exact legacy Navy #000075 with missing/null/string/percent/out-of-range HSL renders cold Home/Scan/Library/favourites/recent/Projects and all tools, reloads, and preserves the original stored JSON')
    assert_clean(browser, 'Wireframe suite complete')
    return {'status': 'passed', 'checks': checks, 'screenshots': screenshots, 'browser_errors': browser.errors,
            'physical_android': 'No physical phone actions performed by this disposable-browser suite'}

