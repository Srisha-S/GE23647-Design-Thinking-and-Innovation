"""Presentation regressions for CHROMA Studio's shared navigation and settings.

Uses real CDP keyboard/pointer events for drawer focus and dismissal checks.
Existing functional and transport suites remain separate and unchanged.
"""
import json


ACTIVE = "document.querySelector('[data-page]:not([hidden])')"
DRAWER = "document.querySelector('#navigation-drawer')"
STATE = "JSON.parse(localStorage.getItem('chroma-workspace-v2'))"
ROUTES = ['home', 'scan', 'compare', 'convert', 'image', 'library', 'projects', 'device', 'about', 'visualize']
BOTTOM_ROUTES = ['home', 'scan', 'library', 'projects']
GROUPS = {'home': 'home', 'scan': 'scan', 'compare': 'scan', 'convert': 'scan', 'image': 'scan',
          'library': 'library', 'projects': 'projects', 'device': None, 'settings': None, 'about': None, 'visualize': None}
FOCUSABLE = "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])"


def press_key(browser, key, code, key_code, shift=False):
    params = {'key': key, 'code': code, 'windowsVirtualKeyCode': key_code,
              'nativeVirtualKeyCode': key_code, 'modifiers': 8 if shift else 0}
    browser.call('Input.dispatchKeyEvent', dict(params, type='keyDown'))
    browser.call('Input.dispatchKeyEvent', dict(params, type='keyUp'))


def pointer_click(browser, x, y):
    browser.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})
    browser.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'clickCount': 1})


def open_drawer(browser):
    browser.evaluate("document.querySelector('[aria-label=\"Open navigation\"]').focus()")
    browser.click('[aria-label="Open navigation"]')
    browser.wait(DRAWER + '?.open')
    browser.wait(DRAWER + '.contains(document.activeElement)')


def check_compact_drawer(browser, width):
    browser.evaluate('new Promise(resolve=>setTimeout(resolve,250))')
    placement = browser.evaluate('''(() => {
      const drawer=document.querySelector('#navigation-drawer');
      const heading=drawer.querySelector('.studio-drawer-heading').getBoundingClientRect();
      const home=drawer.querySelector('[data-nav=home]').getBoundingClientRect();
      const links=Array.from(drawer.querySelectorAll('[data-nav]'));
      const last=links[links.length-1].getBoundingClientRect();
      const footer=drawer.querySelector('.studio-drawer-footer').getBoundingClientRect();
      return {headingBottom:heading.bottom,homeTop:home.top,lastBottom:last.bottom,footerTop:footer.top,
        destinations:links.map(link=>link.dataset.nav)};
    })()''')
    assert placement['headingBottom'] - 1 <= placement['homeTop'] <= placement['headingBottom'] + 20, f'Home must begin just below the drawer brand at {width}px: {placement}'
    assert placement['footerTop'] >= placement['lastBottom'] - 1, f'Device status must follow the menu links at {width}px: {placement}'
    assert 'settings' not in placement['destinations'] and 'about' in placement['destinations'], f'Drawer must replace Settings with About: {placement}'


def check_bottom_navigation(browser, route):
    """Check live destinations, visible labels and the raised selected highlight."""
    browser.evaluate('''(async () => {
      const nav=document.querySelector('[data-bottom-nav]').closest('nav');
      await Promise.all(nav.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>undefined)));
    })()''')
    nav = browser.evaluate('''(() => {
      const links=Array.from(document.querySelectorAll('[data-bottom-nav]'));
      return links.map(link=>{
        const label=link.querySelector('.reference-nav-label'), icon=link.querySelector('.reference-nav-icon');
        const rect=icon.getBoundingClientRect(), style=getComputedStyle(icon);
        return {route:link.dataset.bottomNav,current:link.getAttribute('aria-current'),
          label:label?.textContent.trim(),visible:Boolean(label?.getClientRects().length && getComputedStyle(label).display!=='none'),
          accessible:link.getAttribute('aria-label'),svg:icon.querySelectorAll('svg').length,
          icon:{top:rect.top,width:rect.width,height:rect.height,radius:parseFloat(style.borderTopLeftRadius),background:style.backgroundColor}};
      });
    })()''')
    assert [item['route'] for item in nav] == BOTTOM_ROUTES, f'Bottom tabs must be Home, Scan, Library, Projects: {nav}'
    assert [item['label'] for item in nav] == ['Home', 'Scan', 'Library', 'Projects'], f'Visible bottom labels must identify the four destinations: {nav}'
    assert all(item['visible'] and item['accessible'] == item['label'] and item['svg'] for item in nav), f'All four tabs must have visible labels and accessible icons: {nav}'
    active = [item for item in nav if item['current'] == 'page']
    expected = [GROUPS[route]] if GROUPS[route] else []
    assert [item['route'] for item in active] == expected, f'Bottom group is incorrect for {route}: {nav}'
    if active:
        icon = active[0]['icon']
        inactive = [item['icon'] for item in nav if item['current'] != 'page']
        assert abs(icon['width'] - icon['height']) <= 1 and icon['radius'] >= icon['width'] / 2 - 1, f'Selection highlight must be circular: {icon}'
        assert icon['width'] >= 44 and icon['top'] < min(item['top'] for item in inactive) - 8, f'Selected tab must rise above other icons: {nav}'
        assert icon['background'] not in ('transparent', 'rgba(0, 0, 0, 0)'), f'Selection needs a visible colour highlight: {icon}'
    return nav


def check_studio(browser):
    checks = []
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    browser.route('home')
    # Let App's route-heading focus complete before establishing the drawer trigger focus.
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    assert not browser.evaluate(DRAWER + '?.open'), 'Navigation must not remain a permanent sidebar'
    open_drawer(browser)
    destinations = browser.evaluate('Array.from(' + DRAWER + ".querySelectorAll('[data-nav]')).map(link=>link.dataset.nav)")
    assert sorted(destinations) == sorted(ROUTES), f'Drawer must retain every route: {destinations}'
    assert browser.evaluate(DRAWER + ".getAttribute('aria-label') || " + DRAWER + ".getAttribute('aria-labelledby')"), 'Drawer requires an accessible name'

    # Focus the final and first genuine controls, then let the browser dispatch
    # Tab/Shift+Tab normally. Synthetic DOM KeyboardEvents would not prove this.
    collect = 'Array.from(' + DRAWER + '.querySelectorAll(' + json.dumps(FOCUSABLE) + ')).filter(e=>e.getClientRects().length)'
    browser.evaluate('(() => {const controls=' + collect + ';controls[controls.length-1].focus();})()')
    press_key(browser, 'Tab', 'Tab', 9)
    assert browser.evaluate('document.activeElement === (' + collect + ')[0]'), 'Tab must wrap inside the drawer'
    press_key(browser, 'Tab', 'Tab', 9, shift=True)
    assert browser.evaluate('(() => {const controls=' + collect + ';return document.activeElement===controls[controls.length-1];})()'), 'Shift+Tab must wrap inside the drawer'
    press_key(browser, 'Escape', 'Escape', 27)
    browser.wait('!' + DRAWER + '.open')
    browser.wait("document.activeElement === document.querySelector('[aria-label=\"Open navigation\"]')")

    for width, height, mobile in [(320, 844, True), (390, 844, True), (820, 1180, False), (1440, 1100, False)]:
        browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile})
        open_drawer(browser)
        check_compact_drawer(browser, width)
        bounds = browser.evaluate('(() => {const r=' + DRAWER + '.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()')
        assert bounds['left'] >= -1 and bounds['right'] <= width + 1, f'Drawer escapes viewport at {width}px: {bounds}'
        assert browser.evaluate(DRAWER + '.scrollWidth <= ' + DRAWER + '.clientWidth + 1'), f'Drawer content overflows at {width}px'
        assert bounds['right'] < width - 1, f'Drawer must leave a tappable outside backdrop at {width}px'
        pointer_click(browser, width - 1, height / 2)
        browser.wait('!' + DRAWER + '.open')

        for route in ROUTES:
            open_drawer(browser)
            browser.click('#navigation-drawer [data-nav="' + route + '"]')
            browser.wait('!' + DRAWER + '.open')
            browser.wait(ACTIVE + '.dataset.page === ' + json.dumps(route))
            active_drawer = browser.evaluate("Array.from(document.querySelectorAll('#navigation-drawer [data-nav][aria-current=page]')).map(e=>e.dataset.nav)")
            assert active_drawer == [route], f'Drawer active route is incorrect: {route}, {active_drawer}'
            check_bottom_navigation(browser, route)
            layout = browser.evaluate("""(() => {
              const nav=document.querySelector('[data-bottom-nav]').closest('nav'), r=nav.getBoundingClientRect();
              return {position:getComputedStyle(nav).position,top:r.top,bottom:r.bottom,left:r.left,right:r.right,
                viewport:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1};
            })()""")
            assert layout['position'] == 'fixed', f'Bottom nav must persist on {route} at {width}px: {layout}'
            assert 0 <= layout['top'] < layout['height'] and layout['bottom'] <= layout['height'] + 1, f'Bottom navigation is outside viewport: {layout}'
            assert layout['left'] >= -1 and layout['right'] <= width + 1 and not layout['overflow'], f'Studio layout overflows on {route}: {layout}'
            if mobile:
                browser.evaluate("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})")
                browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve()))')
                clearance = browser.evaluate("""(() => {
                  const page=document.querySelector('[data-page]:not([hidden])');
                  const controls=Array.from(page.querySelectorAll('button,input,select,textarea,p,h1,h2,h3,a,small,summary')).filter(e=>{const closed=e.closest('details:not([open])'); return e.getClientRects().length && (!closed || closed.querySelector(':scope > summary')?.contains(e));});
                  const contentBottom=Math.max(...controls.map(e=>e.getBoundingClientRect().bottom));
                  const navTop=document.querySelector('[data-bottom-nav]').closest('nav').getBoundingClientRect().top;
                  return {contentBottom,navTop};
                })()""")
                assert clearance['contentBottom'] <= clearance['navTop'] + 1, f'Bottom navigation covers final {route} content at {width}px: {clearance}'
                browser.evaluate("window.scrollTo({top:0,behavior:'instant'})")
        for route in BOTTOM_ROUTES:
            browser.click('[data-bottom-nav="' + route + '"]')
            browser.wait(ACTIVE + '.dataset.page === ' + json.dumps(route))
            assert browser.evaluate('document.querySelector(' + json.dumps('[data-bottom-nav="' + route + '"]') + ').getAttribute("aria-current")') == 'page'
    checks.append('Studio drawer retains all ten routes, closes on navigation, Escape and outside pointer clicks; real Tab/Shift+Tab wrap focus and Escape restores the trigger')
    checks.append('Home/Scan/Library/Projects bottom links have visible accessible labels and raised circular selection at 320/390/820/1440px; Device/Settings/About remain reachable without a false active tab; fixed navigation leaves final mobile content reachable')
    checks.append('Drawer Home starts directly below the brand at 320/390/820/1440px; device status follows the links; About replaces Settings')

    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    checks.extend(check_settings_and_favourites(browser))
    browser.route('home')
    return checks


def capture_export(browser, button_text):
    return browser.evaluate("""(async () => {
      const oldCreate=URL.createObjectURL, oldClick=HTMLAnchorElement.prototype.click; let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try {
        Array.from(document.querySelector('[data-page]:not([hidden])').querySelectorAll('button')).find(e=>e.textContent.trim()===""" + json.dumps(button_text) + """).click();
        return JSON.parse(await blob.text());
      } finally { URL.createObjectURL=oldCreate; HTMLAnchorElement.prototype.click=oldClick; }
    })()""")


def check_settings_and_favourites(browser):
    from react_checks import reload_app
    checks = []
    browser.route('home')
    browser.click('[aria-label="Open Settings"]')
    browser.wait(ACTIVE + ".dataset.page === 'settings'")
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    tabs = browser.evaluate("Array.from(document.querySelectorAll('[data-page=settings] [role=tab]')).map(tab=>({id:tab.id,label:tab.textContent.trim()}))")
    assert tabs == [{'id':'settings-tab-general','label':'General'}, {'id':'settings-tab-data','label':'Export / Import'}, {'id':'settings-tab-app','label':'App'}], f'Settings should have exactly its three functional sections: {tabs}'
    assert not browser.evaluate("document.querySelector('#settings-tab-about')"), 'About must be a menu page, not a Settings tab'
    assert browser.evaluate("document.querySelector('#settings-tab-general').getAttribute('aria-selected')") == 'true'
    assert browser.evaluate(ACTIVE + ".querySelector('.studio-settings-badge').textContent") == 'Light'
    # Standard keyboard tab navigation activates and focuses each section.
    browser.evaluate("document.querySelector('#settings-tab-general').focus()")
    press_key(browser, 'ArrowRight', 'ArrowRight', 39)
    browser.wait("document.querySelector('#settings-tab-data').getAttribute('aria-selected') === 'true'")
    assert browser.evaluate("document.activeElement.id") == 'settings-tab-data'
    before = browser.state()
    backup = capture_export(browser, 'Export')
    assert backup['product'] == 'CHROMA' and backup['version'] == 2
    assert len(backup['colours']) == len(before['library'])
    assert len(backup['projects']) == len(before['projects'])
    assert len(backup['comparisons']) == len(before['comparisons'])
    browser.evaluate("""(() => {const dt=new DataTransfer();dt.items.add(new File([""" + json.dumps(json.dumps(backup)) + """], 'studio-backup.json', {type:'application/json'})); const input=document.querySelector('[aria-label="Import data JSON file"]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()""")
    browser.wait("document.querySelector('.toast').textContent.includes('Imported')")
    assert len(browser.state()['library']) == len(before['library']), 'Settings reimport must not duplicate saved records'
    assert browser.state()['history'] == before['history'], 'Settings backup reimport must preserve capture history'
    # Imported metadata need not use a physical source label. Favouriting it
    # must change tags only, even when a clear-channel field is present.
    fixture = {'product':'CHROMA','version':2,'colours':[{'id':'studio-metadata-proof','hex':'#314159','name':'Studio imported metadata proof','source':'imported','clear':630,'tags':['keep-source'],'projectId':before['projects'][0]['id']}], 'comparisons':[], 'projects':[]}
    browser.evaluate("""(() => {const dt=new DataTransfer();dt.items.add(new File([""" + json.dumps(json.dumps(fixture)) + """], 'metadata-proof.json', {type:'application/json'})); const input=document.querySelector('[aria-label="Import data JSON file"]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()""")
    browser.wait(STATE + ".library.some(c=>c.id==='studio-metadata-proof' && c.clear===630)")
    browser.click('#settings-tab-app')
    assert browser.evaluate(ACTIVE + ".textContent.includes('Web browser') && " + ACTIVE + ".textContent.includes('Saved comparisons')")
    assert not browser.evaluate(ACTIVE + ".textContent.includes('Your workspace stays local')"), 'The removed local-workspace prompt must not remain on Settings'
    browser.route('about')
    assert browser.evaluate(ACTIVE + ".textContent.includes('CIEDE2000')")
    reload_app(browser, "document.querySelector('[data-page=about]:not([hidden])')")
    assert browser.evaluate("location.hash") == '#about', 'Standalone About must survive hash reload'
    assert browser.evaluate(ACTIVE + ".textContent.includes('CIEDE2000')"), 'About information must remain after reload'
    browser.click_text('Open Device')
    browser.wait(ACTIVE + ".dataset.page === 'device'")
    checks.append('Header gear opens Settings with exactly General/Export-Import/App tabs and no local-workspace prompt; separate About retains colour-result information and Device link; JSON reimport preserves history and avoids duplicates')

    browser.route('library')
    original = browser.state()
    card = 'Studio imported metadata proof'
    record = next(c for c in original['library'] if c['name'] == card)
    assert not any(t.lower() in ('favourite', 'favorite') for t in record['tags']), 'Fixture colour must start unfavourited'
    browser.click('[aria-label="Add Studio imported metadata proof to favourites"]')
    browser.wait(STATE + '.library.find(c=>c.id===' + json.dumps(record['id']) + ').tags.includes("favourite")')
    updated = next(c for c in browser.state()['library'] if c['id'] == record['id'])
    assert {k:v for k,v in updated.items() if k != 'tags'} == {k:v for k,v in record.items() if k != 'tags'}, 'Favouriting must preserve identity, source, date, clear channel and project'
    assert updated['tags'] == record['tags'] + ['favourite']
    assert browser.state()['history'] == original['history']
    browser.click_text('Favourites')
    assert browser.evaluate("document.querySelectorAll('.collection-colour').length") == 1
    reload_app(browser, "document.querySelector('.studio-favourite[aria-pressed=true]')")
    browser.click_text('Favourites')
    browser.click('.studio-favourite[aria-pressed=true]')
    browser.wait(ACTIVE + ".textContent.includes('No matches yet')")
    restored = next(c for c in browser.state()['library'] if c['id'] == record['id'])
    assert restored == record, 'Removing favourite must restore original tags without changing metadata'
    browser.click_text('Recent')
    assert browser.evaluate("document.querySelectorAll('.collection-colour').length") == len(original['history'])
    assert not browser.evaluate("document.querySelector('.studio-favourite')"), 'History must not be silently edited as saved Library entries'
    browser.click_text('Projects', ACTIVE + ".querySelector('.studio-collection-chips')")
    expected = len([c for c in original['library'] if c.get('projectId')])
    assert browser.evaluate("document.querySelectorAll('.collection-colour').length") == expected
    browser.click_text('All', ACTIVE + ".querySelector('.studio-collection-chips')")
    browser.click_text('Filter')
    assert browser.evaluate("!document.querySelector('#library-filters').hidden")
    browser.fill('[aria-label="Sort library"]', 'name')
    names = browser.evaluate("Array.from(document.querySelectorAll('.collection-colour h3')).map(e=>e.textContent)")
    assert names == sorted(names), 'Existing name sorting remains available through Filter'
    checks.append('Favourite hearts persist through reload and preserve IDs/source/date/clear/project/tags/history; Recent and Projects chips expose the existing data; Filter retains sorting')

    browser.route('scan')
    reading = browser.state()['latest']
    scan_export = capture_export(browser, 'Share')
    exported = scan_export['colours'][0]
    assert all(exported.get(k) == v for k,v in reading.items()), 'Scan share must preserve every reading field'
    assert all(fmt in exported['formats'] for fmt in ['hex', 'rgb', 'hsl', 'cmyk', 'lab'])
    checks.append('Scan Share exports the original reading metadata and all five app-calculated colour formats')
    browser.route('compare')
    browser.click_text('New comparison')
    browser.wait("document.activeElement.id === 'compareA'")
    assert browser.evaluate("document.querySelector('#compareA').value") == reading['hex']
    assert browser.evaluate("document.querySelector('#compareB').value") == reading['hex']
    assert browser.evaluate(ACTIVE + ".querySelector('[data-testid=delta-e]').childNodes[0].textContent") == '0.00'
    browser.fill('#compareA', '#BAD')
    browser.evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.__studioCopied=value}}})")
    browser.click('[data-page="compare"] .studio-compare-colour [aria-label^="Copy HEX:"]')
    browser.wait('window.__studioCopied === ' + json.dumps(reading['hex']))
    assert browser.evaluate("document.querySelector('#compare-form .error-message').textContent") == '', 'Copying a value must not submit invalid manual comparison inputs'
    checks.append('New comparison resets the manual pair through existing state, reveals/focuses its editor; copying an expanded format does not accidentally submit the comparison form')

    return checks
