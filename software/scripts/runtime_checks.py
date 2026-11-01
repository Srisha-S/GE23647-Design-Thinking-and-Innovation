"""Cold-start persisted-data checks in the harness's disposable Chrome profile."""
import json
import uuid
from pathlib import Path

KEY = 'chroma-workspace-v2'
LEGACY_KEY = 'chroma-workspace-v1'
STAMP = '2025-07-08T10:11:12.000Z'
LEGACY = {
    'latest': {'id': 'scan-old', 'hex': '#c76b4a', 'source': 'bluetooth', 'timestamp': STAMP, 'clear': 630},
    'library': [
        {'id': 'old-blue', 'hex': '#abc', 'name': 'Pre-redesign blue', 'timestamp': STAMP, 'project': 'Legacy textiles', 'tags': ['favourite', 'linen']},
        {'id': 'old-ink', 'hex': '#274c77', 'name': 'Pre-redesign ink', 'timestamp': STAMP, 'project': 'Legacy textiles'},
    ],
    'comparisons': [{'id': 'old-proof', 'a': '#c76b4a', 'b': '#c86a4b', 'timestamp': STAMP, 'project': 'Legacy textiles', 'deviceDeltaE': 2.4}],
}


def initialize(browser, url, storage, blocked=False, extra_script=""):
    # Only the isolated test profile is seeded; never read or change a real user's profile.
    script = r"""
      window.__runtimeErrors=[];
      const originalError=console.error;
      console.error=(...args)=>{window.__runtimeErrors.push(args.map(a=>a && typeof a === 'object' ? (a.stack || (a.name + ': ' + a.message)) : String(a)).join('\n')); originalError(...args);};
    """
    script += extra_script
    if blocked:
        script += "Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Storage access blocked for regression test','SecurityError');}});"
    else:
        script += "for(const key of ['chroma-workspace-v2','chroma-workspace-v1'])localStorage.removeItem(key);"
        script += "for(const [key,value] of Object.entries(" + json.dumps(storage) + "))localStorage.setItem(key,value);"
    token = uuid.uuid4().hex
    script += "window.__runtimeStartupToken=" + json.dumps(token) + ";"
    browser.call("Page.navigate", {"url": "about:blank"})
    browser.wait("location.href === 'about:blank'")
    identifier = browser.call('Page.addScriptToEvaluateOnNewDocument', {'source': script})['identifier']
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait("window.__runtimeStartupToken === " + json.dumps(token))
    browser.wait("document.querySelector('[data-page=home]') || document.querySelector('.empty-state h1')")
    browser.evaluate('new Promise(resolve=>setTimeout(resolve,300))')
    browser.call('Page.removeScriptToEvaluateOnNewDocument', {'identifier': identifier})


def probe_runtime(browser, url):
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    reports=[]
    for label, key, data in [('pre-redesign-v1', LEGACY_KEY, LEGACY), ('old-v2-missing-fields', KEY, {**LEGACY, 'version': 2, 'projects': [ {'id': 'p', 'name': 'Missing notes'} ], 'history': None})]:
        initialize(browser,url,{key:json.dumps(data)})
        for route in ['home','library','projects','scan','compare','convert','image']:
            browser.route(route)
        reports.append({'case':label,'errors':browser.evaluate('window.__runtimeErrors'),'snapshot':browser.state()})
    initialize(browser,url,{},blocked=True)
    reports.append({'case':'blocked-localStorage-getter','fallback':browser.evaluate("!!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Reload CHROMA')"),'errors':browser.evaluate('window.__runtimeErrors')})
    path=Path(__file__).resolve().parents[1]/'artifacts/runtime-stability/before-fix-reproduction.json'
    path.write_text(json.dumps(reports,indent=2),encoding='utf-8')
    return {'status':'diagnosed','cases':[{'case':r['case'],'errors':r['errors'],'fallback':r.get('fallback',False)} for r in reports]}


def check_runtime(browser, url):
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    checks=[]
    cases = [
        ('pre-redesign-v1', {LEGACY_KEY: json.dumps(LEGACY)}),
        ('old-v2-missing-fields', {KEY: json.dumps({**LEGACY, 'version': 2, 'projects': [{'id': 'p', 'name': 'Missing notes'}], 'history': None})}),
        ('partial-containers-rgb-favourite', {KEY: json.dumps({'version': 2, 'library': None, 'colours': [{'id': 'rgb-old', 'name': 'Old RGB', 'rgb': {'r':18,'g':52,'b':86}, 'favorite': True, 'projectId':'p'}], 'history': {}, 'comparisons': None, 'projects': [None, {'id':'p','name':'Old project','notes':None}]})}),
        ('malformed-v2-valid-v1', {KEY: '{original broken json', LEGACY_KEY: json.dumps(LEGACY)}),
        ('malformed-only', {KEY: '{original broken json'}),
        ('old-null-json', {KEY: 'null'}),
        ('future-schema', {KEY: json.dumps({**LEGACY, 'version': 3, 'futureMetadata': {'keep': True}})}),
    ]
    for label, raw in cases:
        initialize(browser,url,raw)
        assert not browser.evaluate('window.__runtimeErrors'), label
        for route in ['home','library','projects','scan','compare','convert','image','visualize']:
            browser.route(route)
            assert browser.evaluate(f"!!document.querySelector('[data-page={route}]:not([hidden])')"), (label,route)
        # Neither hydration nor navigating tools is a request to replace saved data.
        actual=browser.evaluate("Object.fromEntries(['chroma-workspace-v2','chroma-workspace-v1'].map(k=>[k,localStorage.getItem(k)]))")
        assert all(actual[key] == raw.get(key) for key in [KEY, LEGACY_KEY]), (label,actual)
        browser.call('Page.reload')
        browser.wait("document.querySelector('[data-page=visualize]:not([hidden])')")
        browser.route('library')
        if label in ['pre-redesign-v1','old-v2-missing-fields','malformed-v2-valid-v1','future-schema']:
            assert browser.evaluate("document.querySelector('[data-page=library]').textContent.includes('Pre-redesign blue')")
            browser.click_text('Favourites')
            assert browser.evaluate("document.querySelectorAll('.library-card').length === 1")
            browser.route('projects')
            assert browser.evaluate("document.querySelector('[data-page=projects]').textContent.includes('Legacy textiles')")
            browser.click('[aria-label="Open Legacy textiles"]')
            assert browser.evaluate("document.querySelector('#project-notes')?.value === ''")
        elif label == 'partial-containers-rgb-favourite':
            browser.click_text('Favourites')
            assert browser.evaluate("document.querySelector('.library-card')?.textContent.includes('#123456')")
        assert not browser.evaluate('window.__runtimeErrors'), label
        checks.append(label + ': cold load, reload, Library/Projects and tool routes pass; exact original storage preserved')

    # Exercise an actual UI edit after hydration, then reload the resulting migration.
    original=json.dumps({**LEGACY,'version':2,'extraMetadata':{'retained':'exactly'}})
    initialize(browser,url,{KEY:original})
    browser.route('library')
    browser.click('[aria-label="Add Pre-redesign ink to favourites"]')
    browser.wait("JSON.parse(localStorage.getItem('chroma-workspace-v2')).library.find(c=>c.id==='old-ink').tags.includes('favourite')")
    backups=browser.evaluate("Object.keys(localStorage).filter(k=>k.includes(':recovery:')).map(k=>localStorage.getItem(k))")
    assert original in backups, 'Exact original must precede saving the migrated favourite'
    saved=browser.state()
    assert saved['library'][0]['id']=='old-blue'
    assert saved['library'][0]['createdAt']==STAMP
    assert saved['comparisons'][0]['deviceDeltaE']==2.4
    assert saved['latest']['clear']==630
    browser.call('Page.reload')
    browser.wait("document.querySelector('[data-page=library]')")
    browser.click_text('Favourites')
    assert browser.evaluate("document.querySelectorAll('.library-card').length === 2")
    checks.append('Real favourite edit safely migrates v2; verified raw backup retains unknown metadata; IDs, timestamps, clear, Delta E and project links survive reload')

    # Storage acquisition itself can throw before getItem is reached (original crash).
    initialize(browser,url,{},blocked=True)
    assert browser.evaluate("!!document.querySelector('[data-page=home]')"), 'Storage getter must not crash WorkspaceProvider'
    for route in ['library','projects','scan','compare','convert','image']:
        browser.route(route)
    assert not browser.evaluate('window.__runtimeErrors')
    checks.append('Throwing localStorage getter no longer triggers ErrorBoundary; memory-only routes remain usable')

    # Quota exhaustion during the mandatory backup cannot overwrite the existing snapshot.
    failure_script="const originalSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.includes(':recovery:'))throw new DOMException('Full','QuotaExceededError');return originalSet.call(this,k,v);};"
    quota_original=json.dumps({**LEGACY, "version":2, "quotaProbe":True})
    initialize(browser,url,{KEY:quota_original},extra_script=failure_script)
    browser.route('library')
    browser.click('[aria-label="Add Pre-redesign ink to favourites"]')
    browser.wait("document.querySelector('.toast')?.textContent.includes('could not be saved safely')")
    assert browser.evaluate(f'localStorage.getItem({json.dumps(KEY)})') == quota_original
    checks.append('Quota failure blocks save and displays warning; the existing snapshot is untouched')

    # Intentionally throw in a render to verify the actual boundary diagnostics, not a fake replacement.
    initialize(browser,url,{KEY:original},extra_script="Date.prototype.toLocaleTimeString=function(){throw new Error('Runtime diagnostic probe');};")
    browser.wait("window.__runtimeErrors.some(item=>item.includes('[CHROMA runtime]') && item.includes('Runtime diagnostic probe'))")
    debug_details=browser.evaluate("!!document.querySelector('script[src*=\"/src/main.tsx\"]')")
    assert browser.evaluate("!!document.querySelector('.empty-state details')") == debug_details
    errors=browser.evaluate('window.__runtimeErrors')
    assert any('[CHROMA runtime]' in item and 'Component stack:' in item and ('HomePage' in item or '/assets/' in item) and 'Runtime diagnostic probe' in item for item in errors)
    assert browser.evaluate(f'localStorage.getItem({json.dumps(KEY)})') == original
    checks.append('ErrorBoundary retains reload UI, logs underlying error plus component stack as text, shows details only in development and never rewrites storage')
    initialize(browser,url,{KEY:original},extra_script="Date.prototype.toLocaleTimeString=function(){throw new DOMException('DOMException diagnostic probe','SecurityError');};")
    browser.wait("window.__runtimeErrors.some(item=>item.includes('[CHROMA runtime] SecurityError: DOMException diagnostic probe'))")
    assert browser.evaluate("!!document.querySelector('.empty-state details')") == debug_details
    dom_errors=browser.evaluate('window.__runtimeErrors')
    assert any('[CHROMA runtime] SecurityError: DOMException diagnostic probe' in item and 'Component stack:' in item and ('HomePage' in item or '/assets/' in item) for item in dom_errors)
    assert browser.evaluate(f'localStorage.getItem({json.dumps(KEY)})') == original
    checks.append('DOMException without a JavaScript stack still logs its actual name/message and React component stack')
    return {'status':'passed','checks':checks,'physical_android':'Not tested: no connected ADB device','expected_diagnostic_probe':errors+dom_errors}
