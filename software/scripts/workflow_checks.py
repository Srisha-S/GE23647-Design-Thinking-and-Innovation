"""Exercise actual CHROMA workflows in the CDP harness's disposable profile.

No access to the user's browser profile or Android storage. These regressions
follow buttons, native Back, reload and JSON export/import in the real React app.
Run check_chroma.py --workflow-only after the source and build are ready.
"""
from __future__ import annotations

import json
import uuid

from check_chroma import ARTIFACTS
from react_checks import reload_app

ACTIVE = "document.querySelector('[data-page]:not([hidden])')"
MODAL = "document.querySelector('dialog[open]')"
STATE = "JSON.parse(localStorage.getItem('chroma-workspace-v2'))"
KEY = 'chroma-workspace-v2'
ROUTES = ['home', 'scan', 'compare', 'image', 'convert', 'library', 'projects', 'settings', 'device', 'about', 'visualize']
TOOLS = ['scan', 'compare', 'image', 'convert']
TOOL_LABELS = ['Scan', 'Compare', 'Image Match', 'Convert']
HOME_TOOLS = ['scan', 'compare', 'image', 'convert']


def route(browser, name):
    browser.route(name)
    browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def click(browser, selector):
    browser.wait('document.querySelector(' + json.dumps(selector) + ')')
    assert browser.evaluate('''(() => {const e=document.querySelector(''' + json.dumps(selector) + ''');
      return e.getClientRects().length>0&&!e.disabled&&!e.closest('[hidden]');})()'''), 'Inactive action: ' + selector
    browser.click(selector)


def text(browser, label, scope=ACTIVE):
    expression = "Array.from(" + scope + ".querySelectorAll('button')).find(e=>e.textContent.trim()===" + json.dumps(label) + ")"
    browser.wait(expression)
    assert browser.evaluate(expression + '.getClientRects().length>0 && !' + expression + '.disabled'), 'Inactive action: ' + label
    browser.click_text(label, scope=scope)


def close_modal(browser):
    click(browser, 'dialog[open] [aria-label="Close dialog"]')
    browser.wait('!document.querySelector("dialog[open]")')


def back(browser, expected, label='Back'):
    click(browser, '#page-header-back [aria-label=' + json.dumps(label) + ']')
    browser.wait('location.hash === ' + json.dumps(expected))
    browser.wait(ACTIVE + '.dataset.page === ' + json.dumps(expected[1:].split('/')[0]))


def native_back(browser, expected):
    browser.wait("typeof window.chromaHandleBack === 'function'")
    browser.evaluate('window.chromaHandleBack()')
    browser.wait('location.hash === ' + json.dumps(expected))


def export_action(browser, selector=None, label=None, scope=ACTIVE):
    expression = 'document.querySelector(' + json.dumps(selector) + ')' if selector else "Array.from(" + scope + ".querySelectorAll('button')).find(e=>e.textContent.trim()===" + json.dumps(label) + ")"
    return browser.evaluate('''(async()=>{
      const oldCreate=URL.createObjectURL,oldClick=HTMLAnchorElement.prototype.click;let blob;
      URL.createObjectURL=function(value){blob=value;return oldCreate.call(URL,value)};
      HTMLAnchorElement.prototype.click=function(){};
      try{const button=''' + expression + ''';if(!button||button.disabled||!button.getClientRects().length)throw Error('Export action is unavailable');
        button.click();for(let i=0;i<30&&!blob;i++)await new Promise(resolve=>setTimeout(resolve,20));
        if(!blob)throw Error('No JSON file was produced');return JSON.parse(await blob.text());
      }finally{URL.createObjectURL=oldCreate;HTMLAnchorElement.prototype.click=oldClick;}
    })()''')


def viewport(browser, width=390):
    browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 844 if width < 650 else 1100, 'deviceScaleFactor': 1, 'mobile': width < 650})


def clean(browser, context):
    assert not browser.evaluate("Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim()==='Reload CHROMA')"), context + ': ErrorBoundary appeared'
    assert not browser.errors, context + ': browser errors: ' + ' | '.join(browser.errors)


def dock(browser, page):
    detail = browser.evaluate('''(() => {
      const items=Array.from(document.querySelectorAll('[data-bottom-nav]'));
      const rect=items[0]?.closest('nav').getBoundingClientRect();
      return {order:items.map(e=>e.dataset.bottomNav),active:items.filter(e=>e.getAttribute('aria-current')==='page').map(e=>e.dataset.bottomNav),
        visible:items.every(e=>e.getClientRects().length),position:items[0]?getComputedStyle(items[0].closest('nav')).position:null,
        bottom:rect?.bottom,viewport:innerHeight};})()''')
    expected = ['scan'] if page in TOOLS else [page] if page in ['home', 'library', 'projects'] else []
    assert detail['order'] == ['home', 'scan', 'library', 'projects'] and detail['visible'], page + ': dock missing or wrong order: ' + str(detail)
    assert detail['active'] == expected, page + ': wrong dock selection: ' + str(detail)
    assert detail['position'] == 'fixed' and abs(detail['bottom'] - detail['viewport']) <= 28, page + ': dock is not fixed to the viewport: ' + str(detail)


def layout(browser, context):
    report = browser.evaluate('''(() => {
      const active=document.querySelector('[data-page]:not([hidden])');
      const items=Array.from(document.querySelectorAll('[aria-label="ChromaPod tools"] [data-tool]'));
      const nav=items[0]?.closest('nav'),navLeft=nav?.scrollLeft,top=scrollY,left=scrollX;
      const toolScrollable=!nav||nav.scrollWidth<=nav.clientWidth+1||['auto','scroll'].includes(getComputedStyle(nav).overflowX);
      const toolAccessible=items.map(button=>{
        button.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
        const rect=button.getBoundingClientRect(),bounds=nav.getBoundingClientRect(),style=getComputedStyle(button);
        return !button.disabled&&button.getClientRects().length>0&&style.visibility!=='hidden'&&style.pointerEvents!=='none'
          &&rect.width>0&&rect.left>=Math.max(0,bounds.left)-1&&rect.right<=Math.min(innerWidth,bounds.right)+1;
      });
      if(nav)nav.scrollLeft=navLeft;
      window.scrollTo({top,left,behavior:'instant'});
      return {width:innerWidth,content:document.documentElement.scrollWidth,route:active.dataset.page,
        title:active.querySelector('h1')?.textContent,theme:document.documentElement.dataset.theme,
        tools:items.map(e=>e.dataset.tool),toolLabels:items.map(e=>e.textContent.trim()),
        activeTools:items.filter(e=>e.getAttribute('aria-current')==='page').map(e=>e.dataset.tool),toolAccessible,toolScrollable,
        result:location.hash.endsWith('/result')};})()''')
    assert report['content'] <= report['width'] + 1, context + ': horizontal overflow: ' + str(report)
    assert report['title'], context + ': missing accessible heading'
    if report['route'] in TOOLS and not report['result']:
        assert report['tools'] == TOOLS and report['toolLabels'] == TOOL_LABELS, context + ': all four ChromaPod tools must appear in the requested order: ' + str(report)
        assert report['activeTools'] == [report['route']], context + ': the active tool tab must follow its route: ' + str(report)
        assert report['toolScrollable'] and all(report['toolAccessible']), context + ': every tool tab must be reachable within the mobile tab strip: ' + str(report)
    else:
        assert report['tools'] == [], context + ': tool tabs leaked into another page/result'
    dock(browser, report['route'])
    clean(browser, context)


def set_theme(browser, theme):
    route(browser, 'settings')
    click(browser, '[data-settings-row="appearance"]')
    click(browser, '[data-theme-option="' + theme + '"]')
    browser.wait('document.documentElement.dataset.theme === ' + json.dumps(theme))
    close_modal(browser)


def home_and_settings(browser, checks):
    route(browser, 'home')
    home = browser.evaluate('''(() => {const page=document.querySelector('[data-page=home]');return {
      pod:page.querySelectorAll('[data-testid=reference-device-card]').length,
      latest:!!page.querySelector('.wireframe-last-scan'),saved:!!page.querySelector('.wireframe-saved-colours'),
      actions:Array.from(page.querySelectorAll('.wireframe-quick-actions [data-feature]')).map(e=>e.dataset.feature),
      extras:!!page.querySelector('.reference-feature-grid,.reference-home-secondary,.deskbot-concept,.recent-scans')};})()''')
    assert home == {'pod': 1, 'latest': True, 'saved': True, 'actions': HOME_TOOLS, 'extras': False}, 'Home was changed from the accepted layout: ' + str(home)
    click(browser, '[aria-label="Open Settings"]')
    browser.wait(ACTIVE + '.dataset.page === "settings"')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('[data-settings-row]').length") == 6
    click(browser, '[data-settings-row="device"]')
    browser.wait(ACTIVE + '.dataset.page === "device"')
    headings = browser.evaluate("Array.from(document.querySelectorAll('.chroma-device-section h2')).map(e=>e.textContent)")
    assert headings == ['Device Information', 'Connection Method'], 'Device page must contain only the two requested sections'
    assert not browser.evaluate('Boolean(' + ACTIVE + ".querySelector('img,.oled-preview,.device-product-banner')) || /deskbot|same colour|meet chroma/i.test(" + ACTIVE + '.textContent)')
    back(browser, '#settings')
    back(browser, '#home')
    click(browser, '[aria-label="Open Settings"]')
    click(browser, '[data-settings-row="device"]')
    native_back(browser, '#settings')
    native_back(browser, '#home')
    click(browser, '[aria-label="Open navigation"]')
    browser.wait("document.querySelector('#navigation-drawer')?.open")
    menu = browser.evaluate('''(() => {const d=document.querySelector('#navigation-drawer'),p=d.querySelector('[data-nav=projects]').getBoundingClientRect(),c=d.querySelector('[data-nav=device]').getBoundingClientRect(),a=d.querySelector('[data-nav=about]').getBoundingClientRect();return {
      routes:Array.from(d.querySelectorAll('[data-nav]')).map(e=>e.dataset.nav),gap:c.top-p.bottom,bottomGap:d.getBoundingClientRect().bottom-a.bottom};})()''')
    assert menu['routes'] == ['home', 'scan', 'compare', 'convert', 'image', 'visualize', 'library', 'projects', 'device', 'about'], 'Drawer contains a duplicate Settings link or misses a destination: ' + str(menu)
    assert menu['gap'] >= 18 and 0 <= menu['bottomGap'] <= 70, 'ChromaPod/About should sit near the bottom with spacing after Projects: ' + str(menu)
    native_back(browser, '#home')
    browser.wait("!document.querySelector('#navigation-drawer').open")
    route(browser, 'device')
    reload_app(browser, ACTIVE + '?.dataset.page === "device"')
    native_back(browser, '#settings')
    native_back(browser, '#home')
    checks.append('Accepted Home retained; Settings > Device > Back Settings > Back Home works with arrows and native Back, including cold Device deep links; two Device sections; drawer spacing and bottom ChromaPod/About without Settings')


def scan_and_compare(browser, checks):
    click(browser, '[data-bottom-nav="scan"]')
    browser.wait(ACTIVE + '.dataset.page === "scan"')
    layout(browser, 'Scan four-tool navigation')
    assert not browser.evaluate("Boolean(document.querySelector('[data-tool=visualize]'))"), 'Visualize must no longer appear in Scan tabs'
    back(browser, '#home')
    click(browser, '[aria-label="Open navigation"]')
    browser.wait("document.querySelector('#navigation-drawer').open")
    click(browser, '[data-nav="visualize"]')
    browser.wait('location.hash === "#visualize" && ' + ACTIVE + '.dataset.page === "visualize"')
    assert browser.evaluate(ACTIVE + '.querySelector("h1").textContent') == 'Visualize' and browser.evaluate('Boolean(' + ACTIVE + '.querySelector("#visualize-photo-input"))'), 'The Visualize sidebar link must open the existing photo recolouring workflow'
    layout(browser, 'Visualize opened from sidebar')
    back(browser, '#home')
    click(browser, '[data-bottom-nav="scan"]')
    browser.wait(ACTIVE + '.dataset.page === "scan"')
    layout(browser, 'Back from Visualize to Home, then Scan')
    checks.append('Scan exposes only Scan/Compare/Image Match/Convert; Visualize appears below Image Match in the sidebar, opens with its renamed heading and no Scan tabs or Scan dock selection; Back returns to Home')
    assert browser.evaluate("Boolean(document.querySelector('[aria-label=\"No captured colour\"]'))"), 'Sample seed colours must not be presented as real captures'
    before = browser.state()['latest']['id']
    click(browser, '[data-action="scan"]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(before))
    browser.wait("document.querySelector('[data-testid=colour-result]')")
    latest = browser.state()['latest']
    assert latest['source'] == 'demo' and browser.evaluate(ACTIVE + ".textContent.includes('Demo scan')"), 'Demo reading provenance must be visible'
    assert browser.evaluate("document.querySelector('.colour-result-formats').querySelectorAll('.metric').length") == 5, 'All Scan formats must remain visible'
    exported = export_action(browser, label='Share')
    assert exported['colours'][0]['hex'] == latest['hex'] and exported['colours'][0]['source'] == 'demo'
    assert set(exported['colours'][0]['formats']) >= {'hex', 'rgb', 'hsl', 'lab', 'cmyk'}
    text(browser, 'Save')
    browser.fill('#save-name', 'Workflow capture')
    browser.fill('#save-tags', 'workflow, favourite')
    browser.submit('#save-form')
    browser.wait(STATE + ".library.some(c=>c.name==='Workflow capture')")
    saved_capture = next(c for c in browser.state()['library'] if c['name'] == 'Workflow capture')
    assert saved_capture['hex'] == latest['hex'] and saved_capture['source'] == 'demo'
    first_capture = latest
    click(browser, '[data-action="scan"]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(first_capture['id']))
    second_capture = browser.state()['latest']
    click(browser, '.capture-history [aria-label=' + json.dumps('View captured colour ' + first_capture['name'] + ', ' + first_capture['hex']) + ']')
    browser.wait('location.hash === ' + json.dumps('#scan/reading/' + first_capture['id']))
    assert browser.evaluate(ACTIVE + '.querySelector(".colour-result").textContent.includes(' + json.dumps(first_capture['hex']) + ')')
    back(browser, '#scan', 'Back to latest scan')
    assert browser.evaluate(ACTIVE + '.querySelector(".colour-result").textContent.includes(' + json.dumps(second_capture['hex']) + ')')
    native_back(browser, '#home')
    click(browser, '[data-bottom-nav="scan"]')
    browser.wait("location.hash === '#scan'")
    click(browser, '[data-tool="compare"]')
    browser.wait(ACTIVE + '.dataset.page === "compare"')
    assert not browser.evaluate('Array.from(' + ACTIVE + ".querySelectorAll('button')).some(e=>['Digital','Physical','Digital + Scan'].includes(e.textContent.trim()))"), 'Compare must expose one unified workflow without mode buttons'
    assert browser.evaluate('Boolean(' + ACTIVE + '.querySelector("[data-action=compare-scan]"))'), 'The unified Compare page must always offer a new sample scan'
    for side in ['a', 'b']:
        click(browser, '[data-action="compare-edit-' + side + '"]')
        browser.wait("document.querySelector('#compare-edit').open")
        assert browser.evaluate("document.querySelector('#compare-picker-" + side + "-hue')?.getClientRects().length > 0"), 'Each colour square must open its own colour wheel'
        assert browser.evaluate("document.querySelector('#compare-edit [data-action=compare-library-" + side + "]')?.getClientRects().length > 0"), 'Each colour editor must expose the shared saved-library chooser'
        assert browser.evaluate("document.querySelector('#compare-edit [data-action=compare-scan-" + side + "]')?.getClientRects().length > 0"), 'Each colour editor must offer a new scan'
        assert browser.evaluate("document.querySelectorAll('#compare-form > div:not([hidden]) .compare-capture-choice').length >= 2 && document.querySelector('#compare-form > div:not([hidden]) .compare-capture-options summary')?.getClientRects().length > 0"), 'Each colour editor must expose existing captures alongside the colour wheel'
        browser.fill('#compare' + side.upper(), '#E0354D')
        browser.submit('#compare-form')
        browser.wait("!document.querySelector('#compare-edit').open")
    click(browser, '[data-action="compare-result"]')
    browser.wait("location.hash === '#compare/result'")
    assert browser.evaluate("document.querySelector('[data-testid=compare-match-ring]').dataset.matchPercent") == '100'
    assert browser.evaluate("document.querySelector('[data-testid=delta-e]').textContent") == '0.00'
    assert browser.evaluate("document.querySelector('[role=meter]').getAttribute('aria-valuetext')") == 'Delta E 0.00'
    before_count = len(browser.state()['comparisons'])
    text(browser, 'Save')
    browser.wait(STATE + '.comparisons.length === ' + str(before_count + 1))
    exported = export_action(browser, label='Share')
    assert exported['comparisons'][0]['a'] == '#E0354D' and exported['comparisons'][0]['b'] == '#E0354D' and exported['comparisons'][0]['deltaE'] == 0
    back(browser, '#compare', 'Back to Compare')
    pair = {'a': '#E0354D', 'b': '#E0354D'}
    for side in ['a', 'b']:
        before = browser.state()['latest']['id']
        click(browser, '[data-action="compare-edit-' + side + '"]')
        click(browser, '#compare-edit [data-action="compare-scan-' + side + '"]')
        browser.wait("!document.querySelector('#compare-edit').open")
        browser.wait(STATE + '.latest.id !== ' + json.dumps(before))
        pair[side] = browser.state()['latest']['hex']
        browser.wait('Array.from(' + ACTIVE + ".querySelectorAll('.wireframe-compare-card strong')).map(e=>e.textContent).join(',') === " + json.dumps(pair['a'] + ',' + pair['b']))
        assert browser.evaluate("location.hash === '#compare'"), 'Scanning from a colour editor must retain the Compare page and the opposite colour'
    click(browser, '[data-action="compare-edit-b"]')
    click(browser, '[data-action="compare-library-b"]')
    browser.wait("document.querySelector('dialog[open] #compare-library-search')")
    browser.fill('#compare-library-search', saved_capture['hex'])
    click(browser, '[data-library-colour="' + saved_capture['id'] + '"]')
    browser.wait("document.querySelector('#compare-edit').open")
    browser.submit('#compare-form')
    browser.wait("!document.querySelector('#compare-edit').open")
    assert browser.evaluate(ACTIVE + ".querySelector('[data-action=compare-edit-b]').textContent.includes('Library')"), 'The sample colour must also accept the shared Library chooser'
    click(browser, '[data-action="compare-edit-a"]')
    click(browser, '[data-action="compare-library-a"]')
    browser.wait("document.querySelector('dialog[open] #compare-library-search')")
    browser.fill('#compare-library-search', saved_capture['hex'])
    click(browser, '[data-library-colour="' + saved_capture['id'] + '"]')
    browser.wait("document.querySelector('#compare-edit').open")
    browser.submit('#compare-form')
    browser.wait("!document.querySelector('#compare-edit').open")
    browser.wait(ACTIVE + '.textContent.includes(' + json.dumps(saved_capture['hex']) + ')')
    before = browser.state()['latest']['id']
    click(browser, '[data-action="compare-scan"]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(before))
    browser.wait("location.hash === '#compare/result'")
    assert browser.evaluate(ACTIVE + ".textContent.includes('Demo scan')"), 'A scanned comparison must identify its simulated sample'
    text(browser, 'Save')
    browser.wait(STATE + ".comparisons.some(c=>c.sampleSource==='demo' && c.matchTarget?.libraryItemId===" + json.dumps(saved_capture['id']) + ')')
    exported = export_action(browser, label='Share')['comparisons'][0]
    assert exported['a'] == saved_capture['hex'] and exported['referenceSource'] == 'library' and exported['sampleSource'] == 'demo' and exported['matchTarget']['libraryItemId'] == saved_capture['id'], 'Sharing a library-to-scan comparison must preserve its reference and sample sources'
    back(browser, '#compare', 'Back to Compare')
    # A saved library + scan result is deliberately not a two-physical history
    # entry. Select two existing captures and save that physical pair first.
    for side, captured in [('a', first_capture), ('b', second_capture)]:
        click(browser, '[data-action="compare-edit-' + side + '"]')
        choice = "Array.from(document.querySelectorAll('#compare-form > div:not([hidden]) .compare-capture-choice')).find(e=>e.textContent.includes(" + json.dumps(captured['hex']) + "))"
        browser.wait(choice)
        browser.reveal_details(choice)
        browser.evaluate(choice + '.click()')
        browser.wait("!document.querySelector('#compare-edit').open")
    click(browser, '[data-action="compare-result"]')
    browser.wait("location.hash === '#compare/result'")
    text(browser, 'Save')
    browser.wait(STATE + '.comparisons.some(c=>c.a===' + json.dumps(first_capture['hex']) + '&&c.b===' + json.dumps(second_capture['hex']) + '&&!c.matchTarget)')
    back(browser, '#compare', 'Back to Compare')
    reload_app(browser, ACTIVE + '?.dataset.page === "compare"')
    assert browser.evaluate('Boolean(' + ACTIVE + ".querySelector('.comparison-history button'))"), 'Physical comparison history should expose the saved capture proof'
    click(browser, '[data-page="compare"] .comparison-history button')
    browser.wait("location.hash === '#compare/result'")
    exported = export_action(browser, label='Share')['comparisons'][0]
    assert exported['a'] == first_capture['hex'] and exported['b'] == second_capture['hex'] and exported['referenceSource'] == 'demo' and exported['sampleSource'] == 'demo' and not exported.get('matchTarget'), 'A previous captured pair must retain its colours and both physical sources after reload and sharing'
    dock(browser, 'compare')
    back(browser, '#compare', 'Back to Compare')
    checks.append('Scan excludes sample seeds and captures demo readings with all five formats/details/save/share; unified Compare has no mode buttons and both editors offer wheels, Library, recent captures and new scans; editor scans retain the opposite colour and Compare page; digital pair gives 100%/Delta E 0; Library + scan save/share preserves reference metadata; captured pairs save, reopen from history and share')


def convert_values(browser, hex_value, context):
    exported = export_action(browser, label='Share')['colours'][0]
    assert exported['hex'] == hex_value, context + ': exported colour disagrees with the selected colour'
    report = browser.evaluate(r'''(() => {
      const info=''' + json.dumps(exported['formats']) + r''';
      const page=document.querySelector('[data-page=convert]');
      const format=page.querySelector('#convert-format').dataset.value,input=page.querySelector('#convert-input');
      const values=(object,precision=0)=>Object.values(object).map(value=>Number(value.toFixed(precision))).join(', ');
      const expected={HEX:info.hex,RGB:values(info.rgb),LAB:values(info.lab,2),
        CMYK:Object.values(info.cmyk).map(value=>`${Number(value.toFixed(2))}%`).join(', '),
        HSL:`${Number(info.hsl.h.toFixed(2))}\u00b0, ${Number(info.hsl.s.toFixed(2))}%, ${Number(info.hsl.l.toFixed(2))}%`};
      const numbers=input.value.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number)||[];
      const components=format==='HEX'?[]:Object.values(info[format.toLowerCase()]);
      const inputMatches=format==='HEX'?('#'+input.value.trim().replace(/^#/,'').toUpperCase()===info.hex):
        numbers.length===components.length&&numbers.every((value,index)=>Math.abs(value-components[index])<=0.000001);
      return {swatch:page.querySelector('.convert-large-preview').getAttribute('aria-label'),inputMatches,
        invalid:input.getAttribute('aria-invalid'),
        values:Object.fromEntries(Array.from(page.querySelectorAll('.convert-colour-details .metric')).map(e=>[e.querySelector('small').textContent,e.querySelector('strong').textContent])),expected};
    })()''')
    assert hex_value in report['swatch'] and report['inputMatches'] and report['invalid'] != 'true', context + ': swatch and current-format input disagree: ' + str(report)
    assert report['values'] == report['expected'], context + ': every displayed format must agree with its exported values: ' + str(report)


def convert(browser, checks):
    route(browser, 'convert')
    samples = {'HEX': '#E0354D', 'RGB': '224, 53, 77', 'HSL': '351.58, 73.39%, 54.31%', 'LAB': '50, 10, -20', 'CMYK': '0%, 76.34%, 65.625%, 12.157%'}
    for name, value in samples.items():
        browser.fill('#convert-format', name)
        browser.fill('#convert-input', value)
        browser.submit('#convert-form')
        browser.wait("!document.querySelector('#convert-error').textContent")
        assert browser.evaluate("document.querySelector('.convert-large-preview')?.getClientRects().length > 0"), 'Convert must show a large current-colour swatch'
        assert browser.evaluate("document.querySelector('.convert-large-preview').getBoundingClientRect().height >= 150"), 'Convert colour preview must have a real rectangle, not an empty zero-height element'
        assert browser.evaluate("document.querySelector('.convert-large-preview').getBoundingClientRect().top < document.querySelector('[aria-label=\"Primary navigation\"]').getBoundingClientRect().top"), 'Convert must show its swatch on the initial viewport without obsolete blank form spacing'
        assert browser.evaluate("document.querySelector('.convert-colour-details').querySelectorAll('.metric').length") == 5, 'Convert must show all format values below the swatch'
    browser.fill('#convert-format', 'HEX')
    browser.fill('#convert-input', '#000075')
    browser.submit('#convert-form')
    browser.wait("document.querySelector('.convert-large-preview').getAttribute('aria-label').includes('#000075')")
    browser.fill('#convert-input', '#GG0000')
    browser.submit('#convert-form')
    browser.wait("document.querySelector('#convert-input').getAttribute('aria-invalid') === 'true'")
    assert browser.evaluate("document.querySelector('.convert-large-preview').getAttribute('aria-label').includes('#000075')"), 'Invalid search must retain the last valid colour'
    click(browser, '[data-action="convert-picker"]')
    browser.fill('#convert-picker-hue', '120')
    browser.fill('#convert-picker-saturation', '100')
    browser.fill('#convert-picker-lightness', '50')
    browser.wait("document.querySelector('.convert-large-preview').getAttribute('aria-label').includes('#00FF00')")
    text(browser, 'Use colour', MODAL)
    browser.wait('!document.querySelector("dialog[open]")')
    exported = export_action(browser, label='Share')
    assert exported['colours'][0]['hex'] == '#00FF00' and set(exported['colours'][0]['formats']) >= {'hex', 'rgb', 'lab', 'hsl', 'cmyk'}
    saved = next(c for c in browser.state()['library'] if c['name'] == 'Workflow capture')
    library_before = json.dumps(browser.state()['library'], sort_keys=True)
    latest_before = browser.state()['latest']['id']
    browser.fill('#convert-format', 'RGB')
    click(browser, '[data-action="convert-library"]')
    browser.wait("document.querySelector('dialog[open] #convert-library-search')")
    browser.fill('#convert-library-search', 'no-workflow-library-colour-with-this-name')
    browser.wait("document.querySelector('dialog[open]').querySelectorAll('[data-convert-colour]').length === 0")
    browser.fill('#convert-library-search', 'workflow')
    click(browser, '[data-convert-colour="' + saved['id'] + '"]')
    browser.wait('!document.querySelector("dialog[open]")')
    browser.wait("document.querySelector('.convert-large-preview').getAttribute('aria-label').includes(" + json.dumps(saved['hex']) + ')')
    convert_values(browser, saved['hex'], 'Saved Library selection')
    assert browser.evaluate("document.querySelector('#convert-format').dataset.value") == 'RGB', 'Library selection must retain the current input format'
    assert browser.evaluate("document.querySelector('[data-testid=convert-colour-source]').textContent.includes('Library') && document.querySelector('[data-testid=convert-colour-source]').textContent.includes(" + json.dumps(saved['name']) + ')'), 'Convert should label the selected saved Library colour'
    assert browser.state()['latest']['id'] == latest_before and json.dumps(browser.state()['library'], sort_keys=True) == library_before, 'Convert Library selection must preserve the original saved metadata and capture history'
    hash_before = browser.evaluate('location.hash')
    click(browser, '[data-action="convert-scan"]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(latest_before))
    scanned = browser.state()['latest']
    browser.wait("document.querySelector('.convert-large-preview').getAttribute('aria-label').includes(" + json.dumps(scanned['hex']) + ')')
    convert_values(browser, scanned['hex'], 'Convert demo scan')
    assert browser.evaluate('location.hash') == hash_before and browser.evaluate(ACTIVE + '.dataset.page') == 'convert', 'Convert scan must update in place without navigating'
    assert browser.evaluate("document.querySelector('#convert-format').dataset.value") == 'RGB', 'Convert scan must retain the current input format'
    assert scanned['source'] == 'demo' and browser.evaluate("document.querySelector('[data-testid=convert-colour-source]').textContent.includes('Demo')"), 'Convert must identify a demo capture as simulated'
    assert json.dumps(browser.state()['library'], sort_keys=True) == library_before, 'Scanning in Convert must leave every original Library record unchanged'
    dock(browser, 'convert')
    checks.append('Convert accepts HEX/RGB/HSL/LAB/CMYK input, recovers safely from invalid input and Navy, wheel updates the large swatch/all five values, JSON share includes app-computed formats; searchable saved Library selection preserves its metadata/current format; demo scan updates swatch/input/all formats in place with visible source')


def upload_image(browser, input_id='image-input', hex_value='#E0354D'):
    browser.evaluate('''(async()=>{const canvas=document.createElement('canvas');canvas.width=12;canvas.height=12;
      const ctx=canvas.getContext('2d');ctx.fillStyle=''' + json.dumps(hex_value) + ''';ctx.fillRect(0,0,12,12);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),transfer=new DataTransfer();
      transfer.items.add(new File([blob],'workflow-photo.png',{type:'image/png'}));const input=document.querySelector('#''' + input_id + '''');
      input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()''')
    browser.wait("document.querySelector('#image-canvas')?.width === 12")
    browser.wait("document.querySelector('.wireframe-extracted-colours button:not([disabled])')")


def image_match(browser, checks):
    route(browser, 'image')
    assert browser.evaluate("document.querySelector('#image-camera-input')?.getAttribute('capture')") == 'environment', 'Image Match must allow camera capture as well as upload'
    upload_image(browser)
    click(browser, '.wireframe-extracted-colours button:not([disabled])')
    browser.wait(ACTIVE + ".querySelector('[data-testid=match-target-source]').textContent.includes('#E0354D')")
    click(browser, '.wireframe-eyedropper')
    browser.fill('#pixel-x', '0')
    browser.fill('#pixel-y', '0')
    browser.submit('#pixel-form')
    close_modal(browser)
    assert browser.evaluate("Boolean(document.querySelector('[data-testid=image-crosshair]'))"), 'Exact original-pixel sampling must remain visible'
    before = browser.state()['latest']['id']
    click(browser, '#image-scan')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(before))
    browser.wait("location.hash === '#image/result'")
    assert browser.evaluate('Boolean(' + ACTIVE + '.querySelector("[data-testid=colour-result] [data-testid=compare-match-ring]"))'), 'Image result must use the same comparison dial layout'
    assert browser.evaluate('Boolean(' + ACTIVE + '.querySelector("[role=meter]"))'), 'Image result must show the same Delta E range map'
    exported = export_action(browser, label='Share')
    assert exported['comparisons'][0]['a'] == '#E0354D' and exported['comparisons'][0]['sampleSource'] == 'demo' and exported['comparisons'][0]['matchTarget']['source'] == 'image'
    text(browser, 'Save')
    browser.wait(STATE + ".comparisons.some(c=>c.a==='#E0354D' && c.matchTarget?.source==='image')")
    back(browser, '#image', 'Back to Image Match')
    assert browser.evaluate("document.querySelector('#image-canvas')?.width") == 12, 'Back from result must return to the current image editor'
    click(browser, '[data-tool="convert"]')
    browser.wait(ACTIVE + '.dataset.page === "convert"')
    click(browser, '[data-tool="image"]')
    browser.wait(ACTIVE + '.dataset.page === "image"')
    assert not browser.evaluate("Boolean(document.querySelector('#image-canvas'))"), 'Leaving Image Match must release the image and request another attachment'
    upload_image(browser, 'image-camera-input', '#123456')
    browser.wait("document.querySelector('.wireframe-extracted-colours button[aria-label^=\"Select dominant colour #123456\"]')")
    click(browser, '[data-bottom-nav="library"]')
    browser.wait(ACTIVE + '.dataset.page === "library"')
    native_back(browser, '#image')
    assert not browser.evaluate("Boolean(document.querySelector('#image-canvas'))"), 'Hardware Back after the Library dock link must return to Image Match with an empty attachment'
    upload_image(browser)
    click(browser, '.wireframe-extracted-colours button:not([disabled])')
    click(browser, '.image-open-result')
    browser.wait("location.hash === '#image/result'")
    click(browser, '[data-bottom-nav="library"]')
    browser.wait(ACTIVE + '.dataset.page === "library"')
    browser.evaluate('window.chromaHandleBack()')
    browser.wait("location.hash === '#image' && document.querySelector('[aria-label=\"ChromaPod tools\"]')")
    assert not browser.evaluate("Boolean(document.querySelector('#image-canvas'))"), 'Re-entering an expired image result must replace it with the empty editor and its tool tabs'
    click(browser, '[data-bottom-nav="library"]')
    browser.wait(ACTIVE + '.dataset.page === "library"')
    checks.append('Image upload and camera-input delivery, original pixel eyedropper/palette/scan work; result shares Compare dial/range/save/share; result Back keeps the editor image, leaving the page releases it and requires a new attachment')


def projects_and_library(browser, checks):
    route(browser, 'library')
    assert browser.evaluate(ACTIVE + ".querySelectorAll('.wf-collection-chips button').length") == 3
    record = browser.state()['library'][0]
    previous_favourite = any(tag.lower() in ['favourite', 'favorite'] for tag in record['tags'])
    click(browser, '.wf-favourite')
    browser.wait(STATE + '.library.find(c=>c.id===' + json.dumps(record['id']) + ').tags.some(t=>/^(favourite|favorite)$/i.test(t)) === ' + ('false' if previous_favourite else 'true'))
    changed = next(item for item in browser.state()['library'] if item['id'] == record['id'])
    assert {k: v for k, v in changed.items() if k != 'tags'} == {k: v for k, v in record.items() if k != 'tags'}, 'Favourite must preserve the complete saved colour'
    for label in ['Favourites', 'Recent', 'All']:
        text(browser, label)
        data = browser.state()
        expected = len(data['history']) if label == 'Recent' else len(data['library']) if label == 'All' else sum(any(tag.lower() in ['favourite', 'favorite'] for tag in item.get('tags', [])) for item in data['library'])
        browser.wait(ACTIVE + '.querySelectorAll(".library-card").length === ' + str(expected))
    browser.fill('[aria-label="Search library"]', 'Workflow capture')
    browser.wait(ACTIVE + '.querySelectorAll(".library-card").length === 1')
    click(browser, '[aria-label="View Workflow capture"]')
    text(browser, 'Colour values', MODAL)
    browser.wait("document.querySelector('dialog[open] .colour-metrics')")
    close_modal(browser)
    route(browser, 'projects')
    assert not browser.evaluate('Boolean(' + ACTIVE + '.querySelector(".wf-project-chips"))'), 'Old project category chips must be removed'
    original_project = browser.state()['projects'][0]
    text(browser, 'New folder')
    browser.fill('#folder-name', 'Workflow folder')
    text(browser, 'Create folder', MODAL)
    browser.wait(STATE + ".folders.some(f=>f.name==='Workflow folder')")
    folder = next(item for item in browser.state()['folders'] if item['name'] == 'Workflow folder')
    folder_hash = '#projects/folder/' + folder['id']
    browser.wait('location.hash === ' + json.dumps(folder_hash))
    click(browser, '[aria-label="New project"]')
    browser.fill('#project-name', 'Folded palette')
    browser.fill('#new-project-notes', 'Keep folder notes')
    assert browser.evaluate("document.querySelector('#project-folder').dataset.value") == folder['id']
    text(browser, 'Create project', MODAL)
    browser.wait("document.querySelector('#project-notes')?.value === 'Keep folder notes'")
    project = next(item for item in browser.state()['projects'] if item['name'] == 'Folded palette')
    click(browser, '[aria-label="Add colour to project"]')
    palette_colour = next(item for item in browser.state()['library'] if item['name'] == 'Workflow capture')
    browser.fill('#project-item', palette_colour['id'])
    text(browser, 'Add to project', MODAL)
    browser.wait(STATE + '.library.some(c=>c.id===' + json.dumps(palette_colour['id']) + '&&c.projectId===' + json.dumps(project['id']) + ')')
    browser.fill('#project-notes', 'Notes kept when navigating back')
    exported = export_action(browser, selector='[aria-label="Share project"]')
    assert exported['projects'][0]['notes'] == 'Notes kept when navigating back' and exported['folders'][0]['id'] == folder['id']
    back(browser, folder_hash, 'Back to folder')
    back(browser, '#projects', 'Back to projects')
    click(browser, '[aria-label="New project"]')
    browser.fill('#project-name', 'Loose palette')
    text(browser, 'Create project', MODAL)
    browser.wait("document.querySelector('#project-notes')")
    back(browser, '#projects', 'Back to projects')
    text(browser, 'Select projects')
    click(browser, '.wf-project-checkbox[aria-label=' + json.dumps('Select ' + original_project['name']) + ']')
    click(browser, '.wf-project-checkbox[aria-label="Select Loose palette"]')
    text(browser, 'Move')
    browser.fill('#move-project-folder', folder['id'])
    text(browser, 'Move projects', MODAL)
    browser.wait(STATE + '.projects.filter(p=>p.folderId===' + json.dumps(folder['id']) + ').length === 3')
    click(browser, '[aria-label="Open folder Workflow folder"]')
    text(browser, 'Add projects')
    assert browser.evaluate(MODAL + ".textContent.includes('All existing projects')"), 'An empty add-project list must offer a working New project action'
    close_modal(browser)
    click(browser, '[aria-label="Actions for Loose palette"]')
    text(browser, 'Move to folder', MODAL)
    browser.fill('#move-project-folder', '')
    text(browser, 'Move projects', MODAL)
    browser.wait(STATE + ".projects.some(p=>p.name==='Loose palette'&&!p.folderId)")
    text(browser, 'Add projects')
    click(browser, 'dialog[open] .wf-folder-project-choices input')
    text(browser, 'Add projects', MODAL)
    browser.wait(STATE + ".projects.some(p=>p.name==='Loose palette'&&p.folderId===" + json.dumps(folder['id']) + ')')
    click(browser, '[aria-label="Folder actions"]')
    text(browser, 'Rename folder', MODAL)
    browser.fill('#folder-name', 'Renamed workflow')
    text(browser, 'Save name', MODAL)
    browser.wait(STATE + ".folders.some(f=>f.name==='Renamed workflow')")
    click(browser, '[aria-label="New project"]')
    browser.fill('#project-name', 'Delete flow check')
    text(browser, 'Create project', MODAL)
    browser.wait("document.querySelector('#project-notes')")
    keep_colours = browser.state()['library']
    keep_proofs = browser.state()['comparisons']
    click(browser, '[aria-label="Project actions"]')
    text(browser, 'Delete project', MODAL)
    text(browser, 'Delete project', MODAL)
    browser.wait('location.hash === ' + json.dumps(folder_hash) + ' && !document.querySelector("dialog[open]")')
    browser.wait(STATE + ".projects.every(p=>p.name!=='Delete flow check')")
    assert browser.state()['library'] == keep_colours and browser.state()['comparisons'] == keep_proofs, 'Deleting an open project must return to the folder without deleting colours or proofs'
    before_reload = browser.state()
    reload_app(browser, ACTIVE + '?.dataset.page === "projects"')
    assert browser.state() == before_reload, 'Cold reload must preserve folders/projects/notes/palette and comparisons'
    route(browser, 'library')
    click(browser, '[aria-label="Library actions"]')
    exported = export_action(browser, label='Export library')
    assert exported['folders'] == browser.state()['folders'] and exported['projects'] == browser.state()['projects'], 'Full library backup must retain folder metadata and membership'
    backup = {'product': 'CHROMA', 'version': 2, 'folders': [{'id': 'import-folder', 'name': 'Imported group', 'createdAt': '2025-07-08T10:11:12.000Z'}], 'projects': [{'id': 'import-project', 'name': 'Imported project', 'notes': 'Imported notes', 'folderId': 'import-folder', 'createdAt': '2025-07-08T10:11:12.000Z'}], 'colours': [{'id': 'import-colour', 'hex': '#F0ABCD', 'name': 'Imported colour', 'tags': ['favourite'], 'source': 'image', 'projectId': 'import-project', 'createdAt': '2025-07-08T10:11:12.000Z'}], 'comparisons': []}
    before_import = browser.state()
    click(browser, '[aria-label="Library actions"]')
    browser.upload_json(backup)
    browser.wait(STATE + ".projects.some(p=>p.name==='Imported project')")
    imported = browser.state()
    assert all(project in imported['projects'] for project in before_import['projects']), 'Import must preserve all existing grouped projects'
    added = next(p for p in imported['projects'] if p['name'] == 'Imported project')
    assert added['folderId'] == next(f['id'] for f in imported['folders'] if f['name'] == 'Imported group') and added['notes'] == 'Imported notes'
    browser.evaluate('location.hash=' + json.dumps('#projects/detail/' + added['id']))
    browser.wait(ACTIVE + '.dataset.page === "projects" && document.querySelector("#project-notes")')
    reload_app(browser, ACTIVE + '?.dataset.page === "projects" && document.querySelector("#project-notes")?.value === "Imported notes"')
    back(browser, '#projects/folder/' + added['folderId'], 'Back to folder')
    native_back(browser, '#projects')
    browser.evaluate('location.hash=' + json.dumps('#projects/folder/' + added['folderId']))
    browser.wait(ACTIVE + '.dataset.page === "projects"')
    reload_app(browser, ACTIVE + '?.dataset.page === "projects" && !document.querySelector("#project-notes")')
    native_back(browser, '#projects')
    route(browser, 'projects')
    click(browser, '[aria-label="Open folder Renamed workflow"]')
    click(browser, '[aria-label="Folder actions"]')
    text(browser, 'Delete folder', MODAL)
    assert browser.evaluate(MODAL + ".textContent.includes('No projects, notes, colours or comparisons will be deleted')")
    keep_projects = browser.state()['projects']
    keep_library = browser.state()['library']
    keep_comparisons = browser.state()['comparisons']
    text(browser, 'Delete folder', MODAL)
    browser.wait(STATE + '.folders.every(f=>f.id!==' + json.dumps(folder['id']) + ')')
    browser.wait("location.hash === '#projects' && !document.querySelector('dialog[open]')")
    after = browser.state()
    assert [{k: v for k, v in p.items() if k != 'folderId'} for p in after['projects']] == [{k: v for k, v in p.items() if k != 'folderId'} for p in keep_projects], 'Folder deletion must keep every project and its notes'
    assert after['library'] == keep_library and after['comparisons'] == keep_comparisons, 'Folder deletion must not alter colours or comparison proofs'
    assert next(p for p in after['projects'] if p['id'] == project['id'])['notes'] == 'Notes kept when navigating back'
    checks.append('Library filters/details/favourites preserve saved metadata; projects create/group/bulk-move/add/move-out/rename with reverse folder-detail hierarchy; notes/palette survive Back/reload; project and full JSON exports include folders; import merges without loss; confirmed folder deletion unassigns projects and preserves all data')


def screenshots_and_theme(browser, checks):
    screenshots = []
    for theme in ['light', 'dark']:
        set_theme(browser, theme)
        route(browser, 'home')
        canvas = browser.evaluate('getComputedStyle(document.body).backgroundColor')
        for width in [320, 390, 820, 1440]:
            viewport(browser, width)
            for name in ROUTES:
                route(browser, name)
                layout(browser, theme + ' ' + name + ' ' + str(width))
                assert browser.evaluate('getComputedStyle(document.body).backgroundColor') == canvas, name + ': shared Home theme was lost'
                top = browser.evaluate("document.querySelector('[data-bottom-nav]').closest('nav').getBoundingClientRect().top")
                browser.evaluate("window.scrollTo({top:document.documentElement.scrollHeight,behavior:'instant'})")
                assert abs(browser.evaluate("document.querySelector('[data-bottom-nav]').closest('nav').getBoundingClientRect().top") - top) <= 1
                assert browser.evaluate('getComputedStyle(document.body).backgroundColor') == canvas, name + ': theme changed while scrolling'
                browser.evaluate('window.scrollTo(0,0)')
                if width == 390 or name == 'home':
                    screenshots.append(browser.screenshot('workflow/' + name + '-' + theme + '-' + str(width) + '.png', width, 844 if width < 650 else 1100, width < 650))
        viewport(browser)
        route(browser, 'compare')
        click(browser, '[data-action="compare-result"]')
        browser.wait("location.hash === '#compare/result'")
        layout(browser, theme + ' compare result')
        screenshots.append(browser.screenshot('workflow/compare-result-' + theme + '.png', 390, 844, True))
        back(browser, '#compare', 'Back to Compare')
        route(browser, 'home')
        click(browser, '[aria-label="Open navigation"]')
        browser.wait("document.querySelector('#navigation-drawer').open")
        screenshots.append(browser.screenshot('workflow/menu-' + theme + '.png', 390, 844, True))
        click(browser, '[aria-label="Close navigation"]')
    checks.append('All routes retain Home theme and a fixed Home/Scan/Library/Projects dock through scrolling at 320/390/820/1440 in light/dark; all four ChromaPod tabs stay reachable on tool workspaces with the correct active tool; result layouts and drawer captured')
    return screenshots


def legacy_navy(browser, url, checks):
    navy = {'id': 'legacy-reading', 'name': 'Navy', 'hex': '#000075', 'rgb': {'r': 0, 'g': 0, 'b': 117}, 'source': 'bluetooth', 'timestamp': '2025-07-08T10:11:12.000Z'}
    variants = [None, {'h': '240', 's': '45%', 'l': '23%'}, {'h': 240, 's': None, 'l': 23}, {'h': 240, 's': 150, 'l': 23}, 'hsl(240,45%,23%)']
    colours = []
    for index, hsl in enumerate(variants):
        record = dict(navy, id='legacy-colour-' + str(index), name='Legacy Navy ' + str(index), favourite=True, projectId='legacy-project')
        if hsl is not None:
            record['hsl'] = hsl
        colours.append(record)
    raw = json.dumps({'version': 2, 'latest': navy, 'library': colours, 'history': [dict(navy, id='legacy-history')], 'projects': [{'id': 'legacy-project', 'name': 'Legacy project', 'notes': 'Keep legacy notes'}], 'comparisons': [{'id': 'legacy-proof', 'a': '#000075', 'b': '#000001', 'projectId': 'legacy-project'}]})
    token = uuid.uuid4().hex
    script = 'localStorage.setItem(' + json.dumps(KEY) + ',' + json.dumps(raw) + ');window.__workflowLegacy=' + json.dumps(token) + ';'
    browser.call('Page.navigate', {'url': 'about:blank'})
    browser.wait("location.href === 'about:blank'")
    identifier = browser.call('Page.addScriptToEvaluateOnNewDocument', {'source': script})['identifier']
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait('window.__workflowLegacy === ' + json.dumps(token) + " && document.querySelector('.wireframe-last-scan')")
    browser.call('Page.removeScriptToEvaluateOnNewDocument', {'identifier': identifier})
    for name in ['home', 'scan', 'compare', 'image', 'convert', 'library', 'projects']:
        route(browser, name)
        clean(browser, 'Legacy Navy ' + name)
    route(browser, 'scan')
    assert browser.evaluate(ACTIVE + ".textContent.includes('#000075')")
    assert browser.evaluate("document.querySelector('.colour-result-formats [aria-label^=\"Copy HSL:\"]').textContent.includes('100%')"), 'Navy HSL must be reconstructed from canonical HEX/RGB'
    route(browser, 'library')
    assert browser.evaluate(ACTIVE + '.querySelectorAll(".library-card").length') == 5
    text(browser, 'Favourites')
    assert browser.evaluate(ACTIVE + '.querySelectorAll(".library-card").length') == 5
    text(browser, 'Recent')
    assert browser.evaluate(ACTIVE + '.querySelectorAll(".library-card").length') == 1
    text(browser, 'All')
    click(browser, '[aria-label="View Legacy Navy 0"]')
    close_modal(browser)
    route(browser, 'projects')
    click(browser, '[aria-label="Open Legacy project"]')
    assert browser.evaluate("document.querySelector('#project-notes').value") == 'Keep legacy notes'
    back(browser, '#projects', 'Back to projects')
    reload_app(browser, ACTIVE + '?.dataset.page === "projects"')
    assert browser.evaluate('localStorage.getItem(' + json.dumps(KEY) + ')') == raw, 'Viewing/reloading legacy data must not clear or rewrite the raw saved workspace'
    clean(browser, 'Legacy Navy reload')
    checks.append('Legacy Navy #000075 and old/missing/string/invalid HSL render Home/Scan/Library/favourites/recent/projects/tools after cold reload; original storage remains byte-for-byte untouched')


def check_workflows(browser, url):
    for domain in ['Page', 'Runtime', 'Log']:
        browser.call(domain + '.enable')
    browser.call('Emulation.setFocusEmulationEnabled', {'enabled': True})
    viewport(browser)
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait("document.querySelector('.wireframe-home') && " + STATE + '?.projects?.length > 0')
    (ARTIFACTS / 'workflow').mkdir(exist_ok=True)
    checks = []
    home_and_settings(browser, checks)
    scan_and_compare(browser, checks)
    convert(browser, checks)
    image_match(browser, checks)
    projects_and_library(browser, checks)
    screenshots = screenshots_and_theme(browser, checks)
    legacy_navy(browser, url, checks)
    clean(browser, 'Completed workflows')
    return {'status': 'passed', 'checks': checks, 'screenshots': screenshots, 'browser_errors': browser.errors, 'profile': 'disposable CDP profile; no user browser/Android data accessed'}
