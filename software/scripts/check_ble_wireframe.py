"""Exercise real BLE-driven React flows with a mocked radio in a disposable profile."""
import json

import check_chroma as harness


def check_ble(browser, url, *_flags):
    for domain in ['Page', 'Runtime', 'Log']:
        browser.call(domain + '.enable')
    browser.call('Page.navigate', {'url': url})
    browser.wait("document.querySelector('.wireframe-home')")
    browser.call('Emulation.setDeviceMetricsOverride', {
        'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True,
    })
    result = browser.evaluate("import('/tests/test-ble-data-ui.tsx').then(module=>module.runRawBleUiTests())")
    assert not browser.errors, 'Browser errors: ' + json.dumps(browser.errors)
    return {'status': 'passed', 'checks': result, 'browser_errors': browser.errors,
            'hardware': 'Mocked native BLE client; no physical radio/device actions'}


if __name__ == '__main__':
    harness.run_checks = check_ble
    status = harness.main()
    original = harness.ARTIFACTS / 'chroma-check-results.json'
    if original.exists():
        (harness.ARTIFACTS / 'chroma-ble-wireframe-results.json').write_text(
            original.read_text(encoding='utf-8'), encoding='utf-8')
    raise SystemExit(status)
