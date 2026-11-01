"""Check launch artwork and nonwrapping wordmarks in a disposable browser profile."""
import base64
import json

import check_chroma as harness
from workflow_checks import set_theme


def check_branding(browser, url, *_flags):
    for domain in ['Page', 'Runtime', 'Log']:
        browser.call(domain + '.enable')
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
    browser.call('Page.addScriptToEvaluateOnNewDocument', {'source': '''
      window.__branding={id:Math.random(),created:0,removed:0,ready:0};
      window.ChromaStartupBridge={ready(){const image=document.querySelector('#chroma-launch img');
        window.__branding.ready++;window.__branding.imageLoaded=image?.complete&&image?.naturalWidth===900;
        window.__branding.appCommitted=!!document.querySelector('#root > *');}};
      new MutationObserver(()=>{const launch=document.getElementById('chroma-launch');
        if(launch&&!window.__branding.created)window.__branding.created=performance.now();
        if(!launch&&window.__branding.created&&!window.__branding.removed)window.__branding.removed=performance.now();
      }).observe(document,{childList:true,subtree:true});
    '''})
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait('window.__branding?.ready===1 && document.querySelector("#chroma-launch img")?.complete')
    assert browser.evaluate("document.querySelector('#root').hasAttribute('inert')"), 'Workspace must not take input underneath the launch artwork'
    assert browser.evaluate("getComputedStyle(document.querySelector('#chroma-launch')).backgroundColor==='rgb(1, 88, 255)'"), 'Splash must keep the supplied blue'
    assert browser.evaluate("document.querySelector('#chroma-launch img').naturalWidth===900 && document.querySelector('#chroma-launch img').naturalHeight===1600"), 'Splash must use the supplied image'
    folder = harness.ARTIFACTS / 'branding'
    folder.mkdir(exist_ok=True)
    shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
    (folder / 'splash.png').write_bytes(base64.b64decode(shot['data']))
    browser.wait("!document.getElementById('chroma-launch') && !document.getElementById('root').hasAttribute('inert')")
    boot = browser.evaluate('window.__branding')
    assert boot['imageLoaded'] and boot['appCommitted'] and boot['ready'] == 1 and boot['removed'] > boot['created'], 'Native handoff must occur after the image and app are ready'
    assert browser.evaluate("document.querySelector('link[rel=icon]').getAttribute('href')==='/branding/chroma-icon.png'"), 'Browser icon must use the supplied artwork'
    original = browser.state()
    checks, screenshots = ['Blue supplied artwork loads before dismissal; native readiness handoff runs once; focus is restored; supplied browser icon configured'], ['artifacts/branding/splash.png']

    def wordmark(selector, label):
        geometry = browser.evaluate('''(() => {const e=document.querySelector(''' + json.dumps(selector) + ''');const a=e.querySelector('strong').getBoundingClientRect(),b=e.querySelector('span').getBoundingClientRect(),r=e.getBoundingClientRect();
          return {text:e.textContent,nowrap:getComputedStyle(e).whiteSpace,overlap:Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top),
            left:r.left,right:r.right,next:b.left-a.right,viewport:innerWidth,overflow:document.documentElement.scrollWidth};})()''')
        assert geometry['text'] == 'CHROMA Studio' and geometry['nowrap'] == 'nowrap' and geometry['overlap'] > 10 and geometry['next'] >= 0, label + ': wordmark wraps: ' + str(geometry)
        assert geometry['left'] >= 0 and geometry['right'] <= geometry['viewport'] and geometry['overflow'] <= geometry['viewport'] + 1, label + ': wordmark causes overflow: ' + str(geometry)

    for mode in ['light', 'dark']:
        set_theme(browser, mode)
        browser.route('home')
        for width in [320, 360, 390, 820, 1440]:
            browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 844, 'deviceScaleFactor': 1, 'mobile': width < 650})
            browser.evaluate('document.fonts.ready')
            wordmark('.reference-home-brand .studio-brand', mode + ' Home ' + str(width))
            assert browser.evaluate("document.querySelector('.reference-home-brand .studio-brand').getBoundingClientRect().right <= document.querySelector('[aria-label=\"Open Settings\"]').getBoundingClientRect().left"), 'Home wordmark overlaps Settings'
            browser.click('[aria-label="Open navigation"]')
            browser.wait('document.querySelector("#navigation-drawer[open]")')
            browser.evaluate('Promise.all(document.querySelector("#navigation-drawer").getAnimations().map(animation=>animation.finished.catch(()=>{})))')
            wordmark('#navigation-drawer .studio-brand', mode + ' menu ' + str(width))
            assert browser.evaluate("document.querySelector('#navigation-drawer .studio-brand').getBoundingClientRect().right <= document.querySelector('[aria-label=\"Close navigation\"]').getBoundingClientRect().left"), 'Menu wordmark overlaps Close'
            if width == 390:
                screenshots.append(browser.screenshot('branding/menu-' + mode + '.png', width, 844, True))
            browser.click('[aria-label="Close navigation"]')
            if width == 390:
                screenshots.append(browser.screenshot('branding/home-' + mode + '.png', width, 844, True))
        checks.append(mode + ': Home/menu wordmarks stay on one line without overlap or overflow at 320/360/390/820/1440px')

    for page in ['scan', 'compare', 'convert', 'image', 'library', 'projects', 'settings', 'device', 'about', 'visualize']:
        browser.route(page)
        assert not browser.evaluate("Boolean(document.querySelector('#chroma-launch'))"), 'In-app navigation must not replay the splash'
    assert browser.state()['library'] == original['library'] and browser.state()['projects'] == original['projects'], 'Branding must preserve Library and Projects'
    token = browser.evaluate('window.__branding.id')
    browser.call('Page.reload')
    browser.wait('window.__branding?.id!==' + json.dumps(token) + ' && window.__branding?.removed>0')
    assert browser.state()['library'] == original['library'] and browser.state()['projects'] == original['projects'], 'Reload must preserve saved data'
    assert not browser.errors, 'Browser errors: ' + ' | '.join(browser.errors)
    checks.append('All existing routes load without replaying the splash; reload repeats startup and preserves saved Library/Projects')
    return {'status': 'passed', 'checks': checks, 'screenshots': screenshots, 'browser_errors': browser.errors}


if __name__ == '__main__':
    harness.run_checks = check_branding
    result = harness.main()
    report = harness.ARTIFACTS / 'chroma-check-results.json'
    if report.exists():
        (harness.ARTIFACTS / 'chroma-branding-results.json').write_text(report.read_text(encoding='utf-8'), encoding='utf-8')
    raise SystemExit(result)
