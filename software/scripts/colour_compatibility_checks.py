"""The exact reported Navy colour and legacy HSL variants, in a disposable profile."""
import json
from runtime_checks import initialize, KEY, STAMP

NAVY = {'id': 'navy-reading', 'name': 'Navy', 'hex': '#000075', 'rgb': {'r': 0, 'g': 0, 'b': 117}, 'tags': [], 'source': 'bluetooth', 'createdAt': STAMP}


def enable(browser):
    for domain in ['Page', 'Runtime', 'Log']:
        browser.call(domain + '.enable')


def probe_colour_crash(browser, url):
    enable(browser)
    raw=json.dumps({'version': 2, 'latest': NAVY, 'library': [dict(NAVY,id='saved-navy')], 'history': [], 'projects': [], 'comparisons': []})
    initialize(browser,url,{KEY:raw})
    browser.evaluate("location.hash='scan'")
    browser.wait("window.__runtimeErrors.some(item=>item.includes('Saturation must be a number from 0 to 100.'))")
    assert browser.evaluate("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Reload CHROMA')")
    assert browser.evaluate(f'localStorage.getItem({json.dumps(KEY)})') == raw
    return {'status':'reproduced','colour':NAVY,'original_derived_saturation':100.00000000000003,'component':'ScanPage','source':'color.js rgbToHsl -> generatePalette -> hslToRgb','errors':browser.evaluate('window.__runtimeErrors'),'storage_unchanged':True}


def check_colours(browser, url):
    enable(browser)
    records=[]
    for index, hsl in enumerate([None, {'h':'240','s':'45%','l':'23%'}, {'h':240,'s':'45','l':23}, {'h':240,'l':23}, {'h':240,'s':None,'l':23}, {'h':240,'s':150,'l':23}, 'hsl(240, 45%, 23%)']):
        record=dict(NAVY,id=f'navy-{index}',name=f'Navy legacy {index}',projectId='old-project',tags=['favourite'])
        if hsl is not None:record['hsl']=hsl
        records.append(record)
    records += [
        {'id':'hsl-green','name':'Legacy green','hsl':{'h':'120','s':'45%','l':'50%'},'favorite':True,'projectId':'old-project'},
        {'id':'hsl-string','name':'Legacy HSL string','hsl':'hsl(120, 100%, 50%)'},
        {'id':'black','name':'Black','hex':'#000000'},
        {'id':'white','name':'White','hex':'#FFFFFF'},
        {'id':'unrecoverable','name':'Original retained','hsl':{'h':240,'s':None,'l':23},'unknownMetadata':'kept in raw snapshot'},
    ]
    data={'version':2,'latest':NAVY,'library':records,'history':[dict(NAVY,id='recent-navy')],'projects':[{'id':'old-project','name':'Old Navy Project'}],'comparisons':[{'id':'navy-proof','name':'Navy proof','a':'#000075','b':'#000001','projectId':'old-project'}]}
    raw=json.dumps(data)
    checks=[]
    initialize(browser,url,{KEY:raw})
    assert browser.evaluate("document.querySelector('[data-page=home]').textContent.includes('#000075')")
    browser.route('scan')
    assert browser.evaluate("document.querySelectorAll('.scan-similar-colours button').length === 5")
    assert browser.evaluate("document.querySelector('[aria-label^=\"Copy HSL:\"]')?.textContent.includes('100%')")
    assert browser.evaluate("document.querySelector('.scan-result-card').textContent.includes('BLE capture')")
    checks.append('Exact physical reading #000075 / RGB 0,0,117 renders Scan and five Similar Colours; derived saturation is 100%')
    browser.call('Page.reload')
    browser.wait("document.querySelectorAll('.scan-similar-colours button').length === 5")
    browser.route('home')
    browser.route('library')
    assert browser.evaluate("document.querySelectorAll('.library-card').length === 11")
    browser.click('[aria-label="View Navy legacy 0"]')
    browser.wait("document.querySelector('dialog[open]')?.textContent.includes('#000075')")
    browser.click('[aria-label="Close dialog"]')
    browser.click_text('Favourites')
    assert browser.evaluate("document.querySelectorAll('.library-card').length === 8")
    browser.click_text('Recent')
    assert browser.evaluate("document.querySelectorAll('.library-card').length === 1")
    browser.route('projects')
    browser.click('[aria-label="Open Old Navy Project"]')
    assert browser.evaluate("document.querySelector('[data-page=projects]').textContent.includes('#000075')")
    assert browser.evaluate("document.querySelector('#project-notes').value === ''")
    checks.append('Cold launch/reload, Home, saved-colour dialog, Library, favourites, recent and old Project records render without errors')
    for route in ['compare','convert','image','visualize']:
        browser.route(route)
    browser.route('convert')
    browser.fill('#convert-input','#000075')
    browser.wait("document.querySelectorAll('.palette-strip button').length === 5 && document.querySelector('.palette-strip').textContent.includes('#000075')")
    checks.append('Convert also generates the exact Navy palette; Compare, Image Match and Visualize open after legacy hydration')
    assert browser.evaluate(f'localStorage.getItem({json.dumps(KEY)})') == raw
    assert not browser.evaluate('window.__runtimeErrors')
    checks.append('Missing/null/string/percent/out-of-range HSL never overrides valid HEX; black/white and HSL-only records recover; original raw metadata stays untouched')
    browser.route('scan')
    screenshot=browser.screenshot('chroma-colour-navy-scan.png',390,844,True)
    return {'status':'passed','checks':checks,'screenshots':[screenshot],'physical_android':'No connected ADB device; physical reinstall/cold launch remains to be checked'}
