"""Exercise Bluetooth through the React UI, with no real chooser or hardware."""
ACTIVE = "document.querySelector('[data-page]:not([hidden])')"
STATE = "JSON.parse(localStorage.getItem('chroma-workspace-v2'))"
CHOICE = "document.querySelector('[aria-describedby=\"device-bluetooth-help\"]')"


def check_bluetooth(browser):
    transport = browser.evaluate("import('/tests/test-bluetooth.mjs').then(module=>module.runBluetoothTests())")
    browser.evaluate(r"""(async () => {
      const {CHROMA_BLE_CONFIG,CHROMA_DEVICE_NAME,CHROMA_SERVICE_UUID,CHROMA_DATA_CHARACTERISTIC_UUID,CHROMA_COMMAND_CHARACTERISTIC_UUID}=await import('/src/config/ble.ts');
      const originalBluetooth=Object.getOwnPropertyDescriptor(navigator,'bluetooth');
      const originalSecure=Object.getOwnPropertyDescriptor(window,'isSecureContext');
      const encoder=new TextEncoder(), decoder=new TextDecoder();
      const fixture=()=>{
        const state={commands:[],chunks:[],starts:0,stops:0,disconnects:0,connects:0,characteristics:[]};
        const notify=new EventTarget();
        notify.properties={notify:true};
        notify.startNotifications=async()=>{state.starts++;await new Promise(resolve=>state.ready=resolve);return notify};
        notify.stopNotifications=async()=>{state.stops++;return notify};
        notify.feed=text=>{
          const bytes=encoder.encode(text),backing=new Uint8Array(bytes.length+4);backing.set(bytes,2);
          notify.value=new DataView(backing.buffer,2,bytes.length);
          notify.dispatchEvent(new Event('characteristicvaluechanged'));
        };
        let buffer='';
        const write={properties:{write:true},async writeValueWithResponse(bytes){
          state.chunks.push(bytes.byteLength);buffer+=decoder.decode(bytes);
          let newline;while((newline=buffer.indexOf('\n'))>=0){state.commands.push(JSON.parse(buffer.slice(0,newline)));buffer=buffer.slice(newline+1)}
        }};
        const service={async getCharacteristic(uuid){state.characteristics.push(uuid);if(uuid===CHROMA_COMMAND_CHARACTERISTIC_UUID)return write;if(uuid===CHROMA_DATA_CHARACTERISTIC_UUID)return notify;throw new Error('Unexpected characteristic')}};
        const device=new EventTarget();device.name=CHROMA_DEVICE_NAME;
        device.gatt={connected:false,async connect(){state.connects++;await new Promise(resolve=>state.ready=resolve);this.connected=true;return this},async getPrimaryService(uuid){if(uuid!==CHROMA_SERVICE_UUID)throw new Error('Unexpected service');return service},disconnect(){state.disconnects++;this.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'))}};
        return {state,notify,device};
      };
      const test={fixture,current:fixture(),requested:[],behaviour:'select',config:CHROMA_BLE_CONFIG,setApi(value){Object.defineProperty(navigator,'bluetooth',{configurable:true,value})},setSecure(value){Object.defineProperty(window,'isSecureContext',{configurable:true,value})}};
      test.api={requestDevice(options){test.requested.push(options);if(test.behaviour==='cancel')return Promise.reject(new DOMException('Chooser cancelled','NotFoundError'));if(test.behaviour==='pending')return new Promise(resolve=>test.resolveChooser=resolve);return Promise.resolve(test.current.device)}};
      test.restore=()=>{if(originalBluetooth)Object.defineProperty(navigator,'bluetooth',originalBluetooth);else delete navigator.bluetooth;if(originalSecure)Object.defineProperty(window,'isSecureContext',originalSecure);else delete window.isSecureContext;delete window.__bleUi};
      window.__bleUi=test;test.setApi(test.api);test.setSecure(true);
    })()""")
    try:
        browser.route('home')
        browser.route('device')
        browser.wait(CHOICE + " && !" + CHOICE + ".disabled")
        browser.click('[aria-describedby="device-bluetooth-help"]')
        browser.wait('window.__bleUi.current.state.connects === 1')
        assert browser.evaluate(ACTIVE + ".textContent.includes('Waiting for the connection')")
        assert not browser.evaluate(ACTIVE + ".textContent.includes('Connected by Bluetooth')"), 'BLE must wait for GATT connection before claiming connected'
        assert browser.evaluate("window.__bleUi.requested[0].filters[0].name === window.__bleUi.config.deviceName && window.__bleUi.requested[0].optionalServices[0] === window.__bleUi.config.serviceUUID")
        browser.evaluate('window.__bleUi.current.state.ready()')
        browser.wait(CHOICE + ".textContent.includes('Connected by Bluetooth')")
        assert browser.evaluate(ACTIVE + ".querySelector('.device-status-badge').textContent.includes('Bluetooth')")
        assert browser.evaluate("Array.from(" + ACTIVE + ".querySelectorAll('.device-specs dd')).filter(e=>e.textContent.trim()==='Not reported').length") == 2

        before = browser.state()['latest']['id']
        browser.evaluate("window.__bleUi.current.notify.feed('{\"hex\":\"#12AB34\"}\\n')")
        assert browser.state()['latest']['id'] == before, 'No colour protocol is subscribed or parsed during connection-only preparation'
        assert browser.evaluate('window.__bleUi.current.state.starts === 0 && window.__bleUi.current.state.characteristics.length === 0')

        browser.route('compare')
        browser.route('scan')
        assert browser.evaluate('window.__bleUi.current.state.commands.length === 0'), 'Navigation must not send colour commands before the protocol is implemented'
        browser.click('[data-action="scan"]')
        browser.wait(ACTIVE + ".querySelector('[role=alert]')?.textContent.includes('Colour transfer is not enabled yet')")
        browser.wait("!document.querySelector('[data-action=scan]').disabled")
        assert browser.evaluate('window.__bleUi.current.state.commands.length === 0 && window.__bleUi.current.device.gatt.connected')
        assert browser.state()['latest']['id'] == before, 'A deferred BLE scan must not substitute a demo colour'
        browser.route('image')
        assert browser.evaluate(ACTIVE + ".textContent.includes('Scan physical sample')"), 'Image Match should recognise Bluetooth as physical hardware'

        browser.route('device')
        browser.click_text('Disconnect')
        browser.wait(ACTIVE + ".querySelector('.oled-content strong')?.textContent === 'OFFLINE'")
        browser.wait('window.__bleUi.current.state.stops === 0 && window.__bleUi.current.state.disconnects === 1')
        before = browser.state()['latest']['id']
        browser.evaluate("window.__bleUi.current.notify.feed('{\"hex\":\"#AABBCC\"}\\n')")
        assert browser.state()['latest']['id'] == before, 'Disconnected notification must not mutate the workspace'

        browser.evaluate("window.__bleUi.behaviour='cancel'")
        browser.click('[aria-describedby="device-bluetooth-help"]')
        browser.wait('window.__bleUi.requested.length === 2 && !' + CHOICE + '.disabled')
        assert not browser.evaluate("Boolean(" + ACTIVE + ".querySelector('[role=alert]'))"), 'Dismissing the browser chooser should remain quiet'

        browser.evaluate("window.__bleUi.behaviour='pending';window.__bleUi.current=window.__bleUi.fixture()")
        browser.click('[aria-describedby="device-bluetooth-help"]')
        browser.wait(ACTIVE + ".textContent.includes('Waiting for the connection')")
        browser.click_text('Cancel')
        browser.wait('!' + CHOICE + '.disabled')
        browser.evaluate('window.__bleUi.resolveChooser(window.__bleUi.current.device)')
        browser.evaluate('new Promise(resolve=>setTimeout(resolve,30))')
        assert browser.evaluate('window.__bleUi.current.state.connects') == 0
        assert not browser.evaluate(ACTIVE + ".textContent.includes('Connected by Bluetooth')")

        browser.evaluate("window.__bleUi.behaviour='select'")
        browser.click('[aria-describedby="device-bluetooth-help"]')
        browser.wait('window.__bleUi.current.state.connects === 1')
        browser.evaluate('window.__bleUi.current.state.ready()')
        browser.wait(CHOICE + ".textContent.includes('Connected by Bluetooth')")
        browser.route('scan')
        browser.evaluate('window.__bleUi.current.device.gatt.disconnect()')
        browser.wait(ACTIVE + ".querySelector('.scan-stage p').textContent.includes('CONNECT YOUR DEVICE')")
        browser.wait(ACTIVE + ".querySelector('[role=alert]')?.textContent.includes('disconnected from Bluetooth')")
        assert not browser.evaluate(ACTIVE + ".querySelector('.oled-screen').classList.contains('is-scanning')")

        browser.evaluate('window.__bleUi.setApi(undefined)')
        browser.route('device')
        browser.wait(CHOICE + ".disabled && " + CHOICE + ".textContent.includes('Bluetooth unavailable')")
        assert browser.evaluate("document.querySelector('#device-bluetooth-help').textContent.includes('unavailable in this browser')")
        browser.evaluate('window.__bleUi.setApi(window.__bleUi.api);window.__bleUi.setSecure(false)')
        browser.route('home')
        browser.route('device')
        browser.wait(CHOICE + '.disabled')
        assert browser.evaluate("document.querySelector('#device-bluetooth-help').textContent.includes('HTTPS or localhost')")
    finally:
        browser.evaluate('window.__bleUi?.restore()')
        browser.call('Page.reload', {'ignoreCache': True})
        browser.wait("document.querySelector('[data-nav=device]')")
        browser.route('device')
        browser.wait(ACTIVE + ".textContent.includes('Demo mode active')")
    return {'bluetooth_transport': transport, 'bluetooth_ui': 'Passed: exact-name pairing with shared UUIDs, GATT-ready connection status, physical metadata, deferred colour subscriptions/commands, image match physical-device label, disconnect cleanup, chooser and pending cancellation, link loss, unsupported browser and insecure context; all BLE hardware mocked'}
