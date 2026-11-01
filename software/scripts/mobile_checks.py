"""Check the existing web UI at phone sizes, without Android hardware."""


def check_mobile(browser):
    routes = ['home', 'scan', 'compare', 'convert', 'image', 'library', 'projects', 'device', 'settings', 'visualize']
    assert browser.evaluate("document.querySelector('meta[name=viewport]').content.includes('viewport-fit=cover')"), 'Phone safe-area viewport must be enabled'
    for width in (320, 390):
        browser.call('Emulation.setDeviceMetricsOverride', {
            'width': width, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True,
        })
        for route in routes:
            browser.route(route)
            overflow = browser.evaluate("""(() => {
              if (document.documentElement.scrollWidth <= innerWidth + 1) return [];
              return Array.from(document.querySelectorAll('body *')).filter(element => {
                const rect = element.getBoundingClientRect();
                return rect.width && (rect.right > innerWidth + 1 || rect.left < -1);
              }).slice(0, 12).map(element => ({tag:element.tagName, class:element.className, text:element.textContent.slice(0,60)}));
            })()""")
            assert not overflow, f'Horizontal overflow on {route} at {width}px: {overflow}'
            if route == 'compare' and width == 320:
                assert browser.evaluate("(() => {const pair=document.querySelector('[data-page=compare] .compare-pair'),a=pair.children[0].getBoundingClientRect(),b=pair.children[1].getBoundingClientRect();return b.left>=a.right-2 && Math.abs(a.top-b.top)<2;})()"), 'At 320px reference and sample must retain the reference layout without overflow'
            short_controls = browser.evaluate("""Array.from(document.querySelectorAll('button,input:not([type=file]),select,textarea')).filter(element => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && rect.height < 43.5;
            }).map(element => ({tag:element.tagName, class:element.className, text:element.textContent.slice(0,60), height:element.getBoundingClientRect().height}))""")
            assert not short_controls, f'Touch controls shorter than 44px on {route} at {width}px: {short_controls}'
        browser.click('[aria-label="Open navigation"]')
        browser.wait("document.querySelector('#navigation-drawer')?.open")
        assert browser.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), f'Mobile menu overflow at {width}px'
        browser.click('[aria-label="Close navigation"]')
        browser.route('device')
        browser.click_text('Calibrate')
        browser.wait("document.querySelector('.calibration-modal')?.open")
        assert browser.evaluate("(() => {const dialog=document.querySelector('dialog[open]'),rect=dialog.getBoundingClientRect();return rect.left>=0 && rect.right<=innerWidth && dialog.scrollWidth<=dialog.clientWidth+1;})()"), f'Calibration dialog overflow at {width}px'
        browser.click('[aria-label="Close calibration"]')
    browser.call('Emulation.setDeviceMetricsOverride', {
        'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False,
    })
    browser.route('home')
    return 'All ten routes at 320px and 390px have no horizontal overflow; visible buttons/fields are at least 44px tall; mobile navigation and calibration dialog fit; safe-area viewport enabled'
