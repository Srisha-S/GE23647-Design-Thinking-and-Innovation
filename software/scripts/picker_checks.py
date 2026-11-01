"""Real themed-picker regressions in a disposable browser; no radios/GPU/data deletion."""
import json

from check_chroma import ARTIFACTS
from workflow_checks import set_theme

TOP = "Array.from(document.querySelectorAll('dialog[open]')).sort((a,b)=>Number(b.dataset.modalOrder||0)-Number(a.dataset.modalOrder||0))[0]"
ACTIVE = "document.querySelector('[data-page]:not([hidden])')"


def check_pickers(browser, url):
    browser.call('Page.enable')
    browser.call('Runtime.enable')
    browser.call('Log.enable')
    browser.call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
    browser.call('Page.navigate', {'url': url.split('#')[0] + '#home'})
    browser.wait("document.querySelector('.wireframe-home') && JSON.parse(localStorage.getItem('chroma-workspace-v2'))?.library?.length")
    original = browser.state()
    colour, project = original['library'][0], original['projects'][0]
    checks, screenshots = [], []
    (ARTIFACTS / 'pickers').mkdir(exist_ok=True)

    def close_top():
        order = browser.evaluate(TOP + '.dataset.modalOrder')
        browser.evaluate(TOP + '.querySelector(' + json.dumps('[aria-label="Close dialog"]') + ').click()')
        browser.wait('!Array.from(document.querySelectorAll("dialog[open]")).some(d=>d.dataset.modalOrder===' + json.dumps(order) + ')')

    def check_modal(label):
        detail = browser.evaluate('''(() => {const d=''' + TOP + ''';const r=d.getBoundingClientRect(),s=getComputedStyle(d),root=getComputedStyle(document.documentElement);
          return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,
            surface:s.backgroundColor,expected:root.getPropertyValue('--surface').trim(),text:s.color};})()''')
        assert detail['left'] >= 0 and detail['right'] <= detail['width'] + 1 and detail['top'] >= 0 and detail['bottom'] <= detail['height'] + 1, label + ': picker exceeds viewport: ' + str(detail)
        assert browser.evaluate('''(() => {const probe=document.createElement('div');probe.style.background='var(--surface)';document.body.append(probe);
          const same=getComputedStyle(probe).backgroundColor===getComputedStyle(''' + TOP + ''').backgroundColor;probe.remove();return same;})()'''), label + ': wrong theme surface'

    for mode in ['light', 'dark']:
        set_theme(browser, mode)
        browser.route('visualize')
        if not browser.evaluate("Boolean(document.querySelector('.visualize-colour-chooser'))"):
            browser.click_text('Change Colour')
        browser.click_text('Library')
        browser.click('#visualize-library-colour')
        browser.wait("document.querySelector('#visualize-library-colour-search')")
        check_modal(mode + ' saved Library')
        screenshots.append(browser.screenshot('pickers/library-' + mode + '.png', 390, 844, True))
        browser.fill('#visualize-library-colour-search', colour['hex'])
        browser.wait(TOP + '.querySelectorAll("[data-library-colour]").length > 0')
        browser.click('[data-library-colour=' + json.dumps(colour['id']) + ']')
        browser.wait("document.querySelector('[data-testid=visualize-target]')?.textContent.includes(" + json.dumps(colour['id']) + ')')
        assert browser.evaluate("document.querySelector('[data-testid=visualize-target]').textContent.includes('Source: Library')")

        browser.route('image')
        browser.click('[aria-label="Image Match actions"]')
        browser.click_text('Library', scope=TOP)
        browser.click('#match-library-colour')
        browser.wait("document.querySelectorAll('dialog[open]').length===2")
        browser.evaluate('window.chromaHandleBack()')
        browser.wait("document.querySelectorAll('dialog[open]').length===1 && document.querySelector('#match-library-colour')?.getAttribute('aria-expanded')==='false'")
        assert browser.evaluate("location.hash==='#image' && document.querySelector('dialog[open] h2').textContent==='Image Match actions'")
        browser.fill('#match-library-colour', colour['id'])
        browser.wait("!document.querySelector('dialog[open]') && document.querySelector('[data-testid=image-match-target]')?.textContent.includes(" + json.dumps(colour['hex']) + ')')

        browser.route('compare')
        browser.click('[data-action="compare-result"]')
        browser.wait("location.hash==='#compare/result'")
        browser.click('.project-select [data-picker-trigger]')
        browser.wait(TOP + '.querySelector("input[type=search]")')
        check_modal(mode + ' project')
        screenshots.append(browser.screenshot('pickers/projects-' + mode + '.png', 390, 844, True))
        search_id = browser.evaluate(TOP + '.querySelector("input[type=search]").id')
        browser.fill('[id=' + json.dumps(search_id) + ']', project['name'])
        browser.wait(TOP + '.querySelectorAll("[data-choice-value]").length===1')
        browser.click('[data-choice-value=' + json.dumps(project['id']) + ']')
        browser.wait("document.querySelector('.project-select [data-picker-trigger]').dataset.value===" + json.dumps(project['id']))
        browser.fill('.project-select [data-picker-trigger]', '')
        assert browser.evaluate("document.querySelector('.project-select [data-picker-trigger]').textContent.includes('Library only')")

        browser.route('projects')
        browser.click('[aria-label="New project"]')
        browser.fill('#project-name', 'Unsaved picker draft')
        browser.click('#project-folder')
        browser.wait("document.querySelectorAll('dialog[open]').length===2")
        browser.evaluate(TOP + '.querySelector("input[type=search]").focus()')
        browser.call('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13, 'text': '\r'})
        browser.call('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Enter', 'code': 'Enter', 'windowsVirtualKeyCode': 13})
        browser.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        assert browser.evaluate("document.querySelectorAll('dialog[open]').length===2 && document.querySelector('#project-name')?.value==='Unsaved picker draft'"), 'Search Enter must not submit the underlying project form'
        browser.evaluate('window.chromaHandleBack()')
        browser.wait("document.querySelectorAll('dialog[open]').length===1")
        assert browser.evaluate("document.querySelector('#project-name').value==='Unsaved picker draft' && location.hash==='#projects'")
        browser.fill('#project-folder', '')
        assert browser.evaluate("document.querySelector('#project-name').value==='Unsaved picker draft'")
        close_top()
        assert browser.state()['projects'] == original['projects'], 'Picker actions must not submit or change projects'
        assert browser.state()['library'] == original['library'], 'Picker actions must preserve every colour and its metadata'
        checks.append(mode + ': Visualize saved-colour search/source, Image Match nested Back/selection, project search/Library-only, search Enter cannot submit the parent form, folder cancellation retaining draft, metadata preserved, themed mobile dialogs')

    browser.route('convert')
    for format_name in ['HEX', 'RGB', 'HSL', 'LAB', 'CMYK']:
        browser.fill('#convert-format', format_name)
        browser.wait("document.querySelector('#convert-input').getAttribute('aria-label')===" + json.dumps(format_name + ' colour value'))
    browser.route('library')
    browser.click('[aria-label="Filter library"]')
    browser.fill('#library-project-filter', project['id'])
    browser.fill('#library-project-filter', 'unassigned')
    browser.fill('#library-project-filter', 'all')
    for sort in ['oldest', 'name', 'newest']:
        browser.fill('#library-sort', sort)
    assert not browser.evaluate("Boolean(document.querySelector('select'))"), 'No native dropdowns should remain'
    assert not browser.errors, 'Browser errors: ' + ' | '.join(browser.errors)
    checks.append('All five Convert formats and Library project/sort filters work through themed choices; no native dropdowns or runtime errors')
    return {'status': 'passed', 'checks': checks, 'screenshots': screenshots, 'browser_errors': browser.errors}
