"""Visualize UI integration checks; called by the isolated CHROMA CDP harness.

Exercises the real page/canvas, local surface selection and browser downloads.
Optional SAM 3 HTTP responses are mocked only to exercise the client protocol,
not model accuracy. No user profile, photo, device or external network is used.
"""
import base64
import json
from pathlib import Path


PAGE = "document.querySelector('[data-page=visualize]:not([hidden])')"
TARGET = "document.querySelector('[data-testid=visualize-target]')"
CANVAS = "document.querySelector('#visualize-canvas')"
OVERLAY = "document.querySelector('.visualize-mask-overlay')"
STATE = "JSON.parse(localStorage.getItem('chroma-workspace-v2'))"


def check_visualize(browser):
    checks, screenshots = [], []

    def check(expression, message):
        assert browser.evaluate("Boolean(" + expression + ")"), message

    def idle():
        browser.wait("!document.querySelector('.visualize-progress')", timeout=15)
        browser.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))")

    def button(label):
        return "Array.from(" + PAGE + ".querySelectorAll('button')).find(e=>e.textContent.trim()===" + json.dumps(label) + ")"

    def click(label):
        browser.click_text(label, scope=PAGE)
        idle()

    def mask_state():
        return browser.evaluate("""(() => {
          const c=document.querySelector('.visualize-mask-overlay');
          const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let count=0,sum=0,hash=0;
          for(let i=3;i<d.length;i+=4){if(d[i])count++;sum+=d[i];hash=(Math.imul(hash,31)+d[i])|0;}
          return {count,sum,hash,width:c.width,height:c.height};
        })()""")

    def capture_mask(name):
        browser.evaluate("void(window[" + json.dumps(name) + "]=" + OVERLAY + ".getContext('2d').getImageData(0,0," + OVERLAY + ".width," + OVERLAY + ".height).data.slice())")

    def capture_pixels(name):
        browser.evaluate("void(window[" + json.dumps(name) + "]=" + CANVAS + ".getContext('2d').getImageData(0,0," + CANVAS + ".width," + CANVAS + ".height).data.slice())")

    def upload(mime, width=1600, height=800, regions=False, input_selector='#visualize-photo-input'):
        extension = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'}[mime]
        name = 'visualize-browser-fixture.' + extension
        supported = browser.evaluate("""(async () => {
          const c=document.createElement('canvas');c.width=""" + str(width) + ";c.height=" + str(height) + """;
          const ctx=c.getContext('2d');const g=ctx.createLinearGradient(0,0,c.width,0);
          g.addColorStop(0,'#494949');g.addColorStop(.5,'#AAAAAA');g.addColorStop(1,'#E5E5E5');
          ctx.fillStyle=g;ctx.fillRect(0,0,c.width,c.height);
          for(let x=0;x<c.width;x+=32){ctx.fillStyle='rgba(0,0,0,.08)';ctx.fillRect(x,0,6,c.height);}
          """ + ("ctx.fillStyle='#000';ctx.fillRect(Math.floor(c.width/2)-8,0,16,c.height);" if regions else "") + """
          const blob=await new Promise(resolve=>c.toBlob(resolve,""" + json.dumps(mime) + """));
          if(!blob || blob.type!==""" + json.dumps(mime) + """)return false;
          const transfer=new DataTransfer();transfer.items.add(new File([blob],""" + json.dumps(name) + ",{type:" + json.dumps(mime) + """}));
          const input=document.querySelector(""" + json.dumps(input_selector) + """);input.files=transfer.files;
          input.dispatchEvent(new Event('change',{bubbles:true}));return true;
        })()""")
        if supported:
            browser.wait(PAGE + ".textContent.includes(" + json.dumps(name) + ")")
            idle()
            browser.wait(CANVAS + f"?.width === {min(1200, width)}")
        return supported

    def stroke(start=(.3, .5), end=(.7, .5)):
        browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
        rect = browser.evaluate("(() => {const r=" + CANVAS + ".getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()")
        points = [(rect['left'] + x * rect['width'], rect['top'] + y * rect['height']) for x, y in [start, end]]
        browser.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': points[0][0], 'y': points[0][1]})
        browser.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': points[0][0], 'y': points[0][1], 'button': 'left', 'buttons': 1, 'clickCount': 1})
        browser.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': points[1][0], 'y': points[1][1], 'button': 'left', 'buttons': 1})
        browser.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': points[1][0], 'y': points[1][1], 'button': 'left', 'buttons': 0, 'clickCount': 1})
        idle()

    def tap(position=(.25, .5), wait=True):
        browser.evaluate(CANVAS + ".scrollIntoView({block:'center',behavior:'instant'})")
        rect = browser.evaluate("(() => {const r=" + CANVAS + ".getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};})()")
        x, y = rect['left'] + position[0] * rect['width'], rect['top'] + position[1] * rect['height']
        browser.call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
        browser.call('Input.dispatchMouseEvent', {'type': 'mousePressed', 'x': x, 'y': y, 'button': 'left', 'buttons': 1, 'clickCount': 1})
        browser.call('Input.dispatchMouseEvent', {'type': 'mouseReleased', 'x': x, 'y': y, 'button': 'left', 'buttons': 0, 'clickCount': 1})
        if wait:
            idle()

    def theme(value):
        browser.route('settings')
        browser.click('[data-settings-row="appearance"]')
        browser.click('[data-theme-option="' + value + '"]')
        browser.wait('document.documentElement.dataset.theme === ' + json.dumps(value))
        browser.click('dialog[open] [aria-label="Close dialog"]')
        browser.route('visualize')
        idle()

    def pixel_hash():
        return browser.evaluate("(() => {const c=" + CANVAS + ";const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let hash=0;for(const v of d)hash=(Math.imul(hash,31)+v)|0;return hash;})()")

    def screenshot(name, width, height, mobile, workspace=False):
        browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile})
        browser.evaluate("document.fonts.ready.then(()=>new Promise(resolve=>setTimeout(resolve,120)))")
        browser.wait("!document.querySelector('.toast.visible')", timeout=8)
        browser.evaluate("document.querySelector('.visualize-workspace').scrollIntoView({block:'start',behavior:'instant'})" if workspace else "window.scrollTo({top:0,behavior:'instant'})")
        if workspace:
            browser.evaluate("window.scrollBy({top:-80,behavior:'instant'})")
        shot = browser.call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
        path = Path(__file__).resolve().parents[1] / 'artifacts' / name
        path.write_bytes(base64.b64decode(shot['data']))
        screenshots.append('artifacts/' + name)

    browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    browser.call('Emulation.setFocusEmulationEnabled', {'enabled': True})
    browser.route('device')
    if browser.evaluate("Array.from(document.querySelector('[data-page=device]').querySelectorAll('button')).some(e=>e.textContent.includes('Enable demo mode'))"):
        browser.click_text('Enable demo mode', exact=False)
    browser.route('scan')
    previous_id = browser.state()['latest']['id']
    browser.click('[data-action=scan]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(previous_id))
    latest = browser.state()['latest']
    library_before = browser.state()['library']
    assert library_before, 'Visualize regression requires the seeded Library fixtures'
    library_colour = next((item for item in library_before if item['hex'].upper() not in ['#000000', '#FFFFFF']), library_before[0])
    browser.route('visualize')
    browser.wait(PAGE)
    # The route may have been mounted by earlier responsive route checks.
    if not browser.evaluate("Boolean(document.querySelector('.visualize-colour-chooser'))"):
        click('Change Colour')
    click('Latest Scan')
    click('Use scan')
    browser.wait(TARGET)
    check(TARGET + '.textContent.includes(' + json.dumps(latest['hex']) + ") && " + TARGET + ".textContent.includes('Source: Latest Scan')", 'Latest Scan must use the real shared scan record with explicit source')
    latest_snapshot = browser.evaluate(TARGET + '.textContent')
    browser.route('scan')
    browser.click('[data-action=scan]')
    browser.wait(STATE + '.latest.id !== ' + json.dumps(latest['id']))
    browser.route('visualize')
    assert browser.evaluate(TARGET + '.textContent') == latest_snapshot, 'Incoming readings must not silently replace the selected Visualize snapshot'
    click('Change Colour')
    click('Library')
    browser.fill('#visualize-library-colour', library_colour['id'])
    browser.wait(TARGET + '.textContent.includes(' + json.dumps(library_colour['hex']) + ')')
    check(TARGET + ".textContent.includes('Source: Library') && " + TARGET + '.textContent.includes(' + json.dumps(library_colour['id']) + ')', 'Library target must expose original ID and source')
    checks.append('Latest Scan and Library targets use shared records; later scans do not replace the selected snapshot; Library ID/source retained')

    # Instrument browser object URLs and the actual anchor fallback; restore in finally.
    browser.evaluate("""(() => {
      const t=window.__visualizeCheck={create:URL.createObjectURL,revoke:URL.revokeObjectURL,click:HTMLAnchorElement.prototype.click,
        canShare:Object.getOwnPropertyDescriptor(navigator,'canShare'),fetch:window.fetch,blobs:new Map(),revoked:[],downloads:[],samCalls:[],samAborted:0,samMode:'valid',samResolve:null};
      URL.createObjectURL=function(blob){const url=t.create.call(URL,blob);t.blobs.set(url,blob);return url;};
      URL.revokeObjectURL=function(url){t.revoked.push(url);t.blobs.delete(url);return t.revoke.call(URL,url);};
      Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>false});
      HTMLAnchorElement.prototype.click=function(){
        if(this.download.startsWith('chroma-visualize-')){t.downloads.push({name:this.download,blob:t.blobs.get(this.href)});return;}
        return t.click.call(this);
      };
    })()""")
    try:
        assert upload('image/jpeg'), 'Browser must accept a real JPEG upload'
        first_url = browser.evaluate("document.querySelector('.visualize-photo-info img').src")
        assert mask_state()['count'] == 0
        click('Brush')
        stroke()
        assert mask_state()['count'] > 0, 'A mouse drag must paint a real blue selection overlay'
        assert upload('image/png'), 'Browser must accept a real PNG upload'
        check('window.__visualizeCheck.revoked.includes(' + json.dumps(first_url) + ')', 'Replacing a JPEG must revoke its previous object URL')
        assert mask_state()['count'] == 0, 'Replacing the photo must reset the mask'
        check('!' + button('Apply Colour') + ' || ' + button('Apply Colour') + '.disabled', 'A new photo needs a new selection before applying')
        png_url = browser.evaluate("document.querySelector('.visualize-photo-info img').src")
        webp_supported = upload('image/webp')
        if webp_supported:
            check('window.__visualizeCheck.revoked.includes(' + json.dumps(png_url) + ')', 'Replacing a PNG must release its URL')
        checks.append('JPEG and PNG decode locally at natural 1600×800 / working 1200×600; photo replacement resets selection and releases URLs' + ('; WEBP decode passed' if webp_supported else '; WEBP encoder unavailable in this browser'))
        check("document.querySelector('#visualize-camera-input').getAttribute('capture')==='environment'", 'Visualize must expose the existing mobile camera capture input')
        assert upload('image/png', 320, 160, regions=True, input_selector='#visualize-camera-input'), 'Camera input must use the same validated photo loading flow'
        check(PAGE + ".textContent.includes('Local tap selection') && " + PAGE + ".textContent.includes('connected colour region')", 'Local tap selection must describe its limits truthfully')
        tap()
        local_left = mask_state()
        assert 0 < local_left['count'] < 320 * 160 / 2, 'Local tap must stop at a strong connected-region boundary'
        check("(() => {const c=" + OVERLAY + ";return c.getContext('2d').getImageData(240,80,1,1).data[3]===0;})()", 'Local tap cannot leak into a disconnected similar region')
        browser.fill('#visualize-selection-mode', 'add')
        tap((.75, .5))
        local_both = mask_state()
        assert local_both['count'] > local_left['count'], 'Local Add must retain and extend the prior selection'
        browser.fill('#visualize-selection-mode', 'remove')
        tap((.75, .5))
        assert mask_state() == local_left, 'Local Remove must erase only the tapped region'
        click('Undo')
        assert mask_state() == local_both, 'Undo local Remove must restore both selected regions'
        browser.fill('#visualize-selection-mode', 'replace')
        tap((.75, .5))
        check("(() => {const c=" + OVERLAY + ";return c.getContext('2d').getImageData(80,80,1,1).data[3]===0;})()", 'Local Replace must replace rather than append to the previous mask')
        click('Undo')
        assert mask_state() == local_both, 'Undo local Replace restores the previous selection exactly'
        click('Clear Selection')
        check("getComputedStyle(" + CANVAS + ").touchAction==='pan-y'", 'Tap selection must allow vertical page scrolling')
        before_scroll = mask_state()
        stroke((.2, .5), (.8, .5))
        assert mask_state() == before_scroll, 'A dragged tap gesture must not select a surface accidentally'
        checks.append('Camera input loads validated photos; local tap respects connected boundaries; Replace/Add/Remove/Undo and scroll gestures preserve masks')

        # HTTP protocol fixtures only: no AI inference is claimed or external photo upload performed.
        browser.evaluate("""(() => {const t=window.__visualizeCheck;window.fetch=async function(url,options){
          if(!String(url).endsWith('/segment'))return t.fetch.call(window,url,options);
          const body=JSON.parse(options.body);t.samCalls.push(body);
          const bytes=new Uint8Array(body.width*body.height);
          for(let y=10;y<body.height/2;y++)for(let x=10;x<body.width/2;x++)bytes[y*body.width+x]=255;
          let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
          const value={width:body.width,height:body.height,model:'sam3',score:.94,mask_base64:btoa(binary)};
          const result=()=>new Response(t.samMode==='json'?'not JSON':JSON.stringify(t.samMode==='dimensions'?{...value,width:body.width+1}:value),{status:200});
          if(t.samMode==='stalled')return new Promise(resolve=>{t.samResolve=()=>resolve(new Response(JSON.stringify(value),{status:200}));options.signal.addEventListener('abort',()=>t.samAborted++,{once:true});});
          return result();
        };})()""")
        browser.fill('#visualize-selection-engine', 'sam3')
        browser.click_text('SAM 3 server', scope=PAGE)
        browser.fill('#visualize-server-url', 'file:///server')
        browser.click_text('Save server address', scope="document.querySelector('dialog[open]')")
        check("document.querySelector('dialog[open] [role=alert]')", 'Invalid SAM server addresses need inline validation')
        browser.fill('#visualize-server-url', 'http://127.0.0.1:8001')
        browser.click_text('Save server address', scope="document.querySelector('dialog[open]')")
        browser.wait("!document.querySelector('dialog[open]')")
        tap((.75, .5))
        sam_mask = mask_state()
        assert sam_mask['count'] > 0, 'A valid SAM protocol response must populate the existing mask provider'
        sent = browser.evaluate('window.__visualizeCheck.samCalls[0]')
        assert sent['width'] == 320 and sent['height'] == 160 and sent['image'].startswith('data:image/png;base64,')
        assert abs(sent['points'][0]['x'] - 240) < 1 and abs(sent['points'][0]['y'] - 80) < 1, 'SAM tap coordinates must refer to working pixels'
        for mode, expected in [('dimensions', 'match'), ('json', 'malformed JSON')]:
            browser.evaluate('window.__visualizeCheck.samMode=' + json.dumps(mode))
            tap()
            check(PAGE + ".querySelector('[role=alert]')?.textContent.includes(" + json.dumps(expected) + ')', 'Malformed SAM responses need actionable in-page errors')
            assert mask_state() == sam_mask, 'Invalid SAM responses cannot damage the existing selection'
        browser.evaluate("window.__visualizeCheck.samMode='stalled'")
        tap(wait=False)
        browser.wait("document.querySelector('.visualize-progress')?.textContent.includes('SAM 3')")
        browser.click_text('Cancel', scope=PAGE)
        idle()
        assert mask_state() == sam_mask
        browser.evaluate('window.__visualizeCheck.samResolve()')
        idle()
        assert mask_state() == sam_mask, 'A response arriving after Cancel cannot overwrite the kept mask'
        tap(wait=False)
        browser.wait("document.querySelector('.visualize-progress')?.textContent.includes('SAM 3')")
        browser.route('convert')
        browser.route('visualize')
        idle()
        browser.evaluate('window.__visualizeCheck.samResolve()')
        idle()
        assert mask_state() == sam_mask, 'Leaving Visualize cancels a pending response without changing the photo selection'
        check('window.__visualizeCheck.samAborted>=2', 'Cancel and route departure must abort SAM transports')
        browser.evaluate('void(window.fetch=window.__visualizeCheck.fetch)')
        browser.fill('#visualize-selection-engine', 'local')
        browser.fill('#visualize-selection-mode', 'replace')
        checks.append('Optional SAM server protocol uses exact working dimensions/coordinates; malformed results, Cancel, route departure and late responses preserve masks (inference not tested)')

        assert upload('image/jpeg'), 'Restore the full photo fixture for brush, material and export regressions'
        click('Brush')
        check(PAGE + ".textContent.includes('Manual selection')", 'Brush refinement must be labelled as manual')
        check("getComputedStyle(" + CANVAS + ").touchAction==='none'", 'Touch gestures over the editing canvas must not scroll the page')
        check(CANVAS + '.width===1200 && ' + CANVAS + '.height===600', 'Working preview dimensions must remain distinct from the display and natural photo')
        capture_pixels('__visualizeOriginal')
        browser.fill('#visualize-brush-size', '28')
        stroke((.45, .5), (.55, .5))
        small = mask_state()
        assert small['count'] > 0
        check("(() => {const c=" + OVERLAY + ";return c.getContext('2d').getImageData(600,300,1,1).data[3]>0;})()", 'CSS pointer coordinates must map to the centre of the working image')
        click('Undo')
        assert mask_state()['count'] == 0, 'Undo must remove the stroke'
        browser.fill('#visualize-brush-size', '72')
        stroke((.45, .5), (.55, .5))
        large = mask_state()
        assert large['count'] > small['count'], 'Larger brush size must paint a larger area'
        capture_mask('__visualizePaintedMask')
        click('Eraser')
        browser.fill('#visualize-brush-size', '24')
        stroke((.48, .5), (.52, .5))
        assert mask_state()['sum'] < large['sum'], 'Eraser must reduce the selected region'
        click('Undo')
        assert mask_state() == large, 'Undo must restore the exact erased selection'
        click('Clear Selection')
        assert mask_state()['count'] == 0, 'Clear Selection must remove the whole mask'
        click('Undo')
        assert mask_state() == large, 'Undo must restore a cleared selection'
        click('Brush')
        before_cancel = mask_state()
        browser.evaluate("""(() => {
          const c=document.querySelector('#visualize-canvas'),r=c.getBoundingClientRect();
          const options={pointerId:37,pointerType:'touch',isPrimary:true,bubbles:true,cancelable:true,clientX:r.left+r.width*.2,clientY:r.top+r.height*.2};
          c.dispatchEvent(new PointerEvent('pointerdown',options));
          c.dispatchEvent(new PointerEvent('pointermove',{...options,clientX:r.left+r.width*.3}));
          c.dispatchEvent(new PointerEvent('pointercancel',options));
        })()""")
        idle()
        assert mask_state() == before_cancel, 'Cancelled touch strokes must restore the mask without committing'
        stroke((.001, .05), (.001, .95))
        check("(() => {const c=" + OVERLAY + ";return c.getContext('2d').getImageData(0,300,1,1).data[3]>0;})()", 'Painting must clip at the image boundary without losing its edge')
        click('Undo')
        checks.append('Actual CDP pointer strokes paint mapped coordinates; brush size, eraser, clear, undo, boundary clipping and touch cancellation pass')

        for mode in ['light', 'dark']:
            theme(mode)
            home_canvas = browser.evaluate('getComputedStyle(document.body).backgroundColor')
            for width, height, mobile in [(320, 844, True), (390, 844, True), (820, 1180, False), (1440, 1100, False)]:
                browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile})
                idle()
                check('document.documentElement.scrollWidth <= innerWidth+1', f'Visualize editing must not overflow at {width}px in {mode}')
                assert mask_state() == before_cancel, 'Viewport resizing must preserve mask pixels and dimensions'
                check("Array.from(" + PAGE + ".querySelectorAll('button,input[type=range],select')).filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().height>=43.5)", f'Visible Visualize controls need 44px touch targets at {width}px')
                if mobile:
                    stroke((.15, .3), (.2, .3))
                    check("(() => {const c=" + OVERLAY + ";return c.getContext('2d').getImageData(210,180,1,1).data[3]>0;})()", f'Brush coordinate mapping must remain correct at {width}px')
                    click('Undo')
                screenshot(f'chroma-visualize-edit-{mode}-{width}.png', width, height, mobile, workspace=True)
                assert browser.evaluate('getComputedStyle(document.body).backgroundColor') == home_canvas
                check("Array.from(document.querySelectorAll('[data-bottom-nav]')).map(e=>e.dataset.bottomNav).join(',')==='home,scan,library,projects'", 'The existing four-item bottom dock stays available in Visualize')
        checks.append('Light/dark editing layout and 44px controls pass at 320/390/820/1440px; mobile strokes keep image coordinates and the four-item bottom dock stays available')

        capture_mask('__visualizeFinalMask')
        click('Apply Colour')
        browser.wait("document.querySelector('#visualize-intensity')")
        idle()
        check("document.querySelector('#visualize-comparison-canvas') && document.querySelector('#visualize-wipe').value==='50'", 'A new preview must default to a genuine before/after canvas slider')
        browser.fill('#visualize-wipe', '25')
        check("document.querySelector('#visualize-comparison-canvas').style.clipPath.includes('25%') && document.querySelector('.visualize-comparison-divider').style.left==='25%'", 'Moving the slider must alter the displayed clipping boundary')
        browser.fill('#visualize-wipe', '75')
        check("document.querySelector('#visualize-comparison-canvas').style.clipPath.includes('75%') && document.querySelector('.visualize-comparison-divider').style.left==='75%'", 'The slider must track positions on both sides of the image')
        check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.every((v,i)=>v===window.__visualizeOriginal[i]);})()", 'Slider mode must retain the actual original beneath its transformed overlay')
        click('After')
        capture_pixels('__visualizeTransformed')
        check("(() => {const a=window.__visualizeOriginal,b=window.__visualizeTransformed,m=window.__visualizeFinalMask;let changed=0;for(let i=0;i<a.length;i+=4){const different=a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2];if(different){changed++;if(!m[i+3])return false;}if(a[i+3]!==b[i+3])return false;}return changed>100;})()", 'Applying must change selected image pixels, preserve every outside pixel, and keep alpha')
        click('Before')
        check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.every((v,i)=>v===window.__visualizeOriginal[i]);})()", 'Before must show the exact original working pixels')
        click('After')
        browser.fill('#visualize-intensity', '0')
        idle()
        check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.every((v,i)=>v===window.__visualizeOriginal[i]);})()", '0% intensity must display the original image exactly')
        browser.fill('#visualize-intensity', '50')
        idle()
        check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,a=window.__visualizeOriginal,b=window.__visualizeTransformed;return d.every((v,i)=>Math.abs(v-Math.round((a[i]+b[i])/2))<=1);})()", '50% intensity must display an intermediate blend')
        browser.fill('#visualize-intensity', '100')
        idle()
        check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return d.every((v,i)=>v===window.__visualizeTransformed[i]);})()", '100% intensity must restore the complete cached transformation')
        checks.append('Apply changes only selected pixels and retains alpha; actual clipped before/after slider and Before/After/0/50/100% intensity display verified canvas pixels')

        material_hashes = []
        for material in ['fabric', 'paint', 'wood', 'plastic', 'metal', 'ceramic']:
            browser.click('[data-material="' + material + '"]')
            idle()
            check('document.querySelector("[data-material=' + material + ']").getAttribute("aria-pressed")==="true"', 'Each material button must apply its own profile')
            check("!document.querySelector('.visualize-mask-toolbar') && document.querySelector('#visualize-intensity')", 'Changing material must recalculate the existing result instead of discarding selection')
            assert mask_state() == before_cancel
            material_hashes.append(pixel_hash())
            check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,a=window.__visualizeOriginal,m=window.__visualizeFinalMask;for(let i=0;i<d.length;i+=4){if(d[i+3]!==a[i+3])return false;if(!m[i+3]&&(d[i]!==a[i]||d[i+1]!==a[i+1]||d[i+2]!==a[i+2]))return false;}return true;})()", 'Every material must preserve original alpha and every unselected pixel')
        assert len(set(material_hashes)) >= 3, 'Material profiles must produce distinct visible image results'
        lighting_hashes = []
        for lighting, kelvin in [('daylight', 6500), ('neutral', 4000), ('warm', 2700), ('cool', 8000)]:
            browser.click('[data-lighting="' + lighting + '"]')
            idle()
            check('document.querySelector("[data-lighting=' + lighting + ']").getAttribute("aria-pressed")==="true"', 'Each LightShift preset must be selectable')
            check('document.querySelector("[data-lighting=' + lighting + ']").textContent.includes("' + str(kelvin) + 'K")', 'Lighting presets must show their indicative colour temperature')
            assert mask_state() == before_cancel
            lighting_hashes.append(pixel_hash())
            check("(() => {const c=" + CANVAS + ",d=c.getContext('2d').getImageData(0,0,c.width,c.height).data,a=window.__visualizeOriginal,m=window.__visualizeFinalMask;for(let i=0;i<d.length;i+=4){if(d[i+3]!==a[i+3])return false;if(!m[i+3]&&(d[i]!==a[i]||d[i+1]!==a[i+1]||d[i+2]!==a[i+2]))return false;}return true;})()", 'LightShift must affect only selected pixels while preserving alpha')
        assert len(set(lighting_hashes)) == 4, 'Lighting presets must actually change the selected appearance'
        browser.click('[data-material="wood"]')
        idle()
        browser.click('[data-lighting="warm"]')
        idle()
        check(TARGET + '.textContent.includes(' + json.dumps(library_colour['hex']) + ')', 'Material and lighting preview must not alter the scanned/saved colour identity')
        checks.append('All six material profiles and four indicative LightShift presets recalculate the preview, preserve exact outside pixels/alpha/mask, and retain the target colour identity')

        active_url = browser.evaluate("document.querySelector('.visualize-photo-info img').src")
        stable_mask = mask_state()
        browser.route('convert')
        check("document.querySelector('[data-page=convert]:not([hidden]) h1')", 'Convert must remain reachable from Visualize')
        browser.route('image')
        check("document.querySelector('[data-page=image]:not([hidden]) h1')", 'Image Match must remain reachable from Visualize')
        browser.route('visualize')
        idle()
        check("document.querySelector('.visualize-photo-info img').src===" + json.dumps(active_url) + " && document.querySelector('#visualize-intensity').value==='100'", 'Visualize photo and result must survive navigation')
        assert mask_state() == stable_mask
        click('Change Colour')
        click('Latest Scan')
        click('Use scan')
        assert mask_state() == stable_mask, 'Changing target colour must preserve the selected object mask'
        # Restore the Library target through its independent route parameter.
        browser.route('library')
        hash_target = '#visualize/library/' + library_colour['id']
        browser.fill('[aria-label="Search library"]', library_colour['name'])
        browser.click('[aria-label=' + json.dumps('View ' + library_colour['name']) + ']')
        browser.click_text('Visualize this colour', scope="document.querySelector('dialog[open]')")
        browser.wait("location.hash===" + json.dumps(hash_target) + " && document.querySelector('[data-page=visualize]:not([hidden])')")
        browser.wait(TARGET + ".textContent.includes('Source: Library')")
        assert mask_state() == stable_mask, 'Library deep linking must preserve the current photo mask'
        assert browser.state()['library'] == library_before, 'Visualize targets, strokes and deep links must not mutate Library records or metadata'
        click('Apply Colour')
        idle()
        checks.append('Photo/mask/result survive Convert and Image Match navigation; target changes and Library deep links preserve the mask and Library records')

        click('Save Preview')
        browser.wait('window.__visualizeCheck.downloads.length===1', timeout=15)
        idle()
        export = browser.evaluate("""(async () => {
          const download=window.__visualizeCheck.downloads[0];if(!download.blob)throw Error('No PNG blob reached the browser download');
          const bytes=new Uint8Array(await download.blob.arrayBuffer()),view=new DataView(bytes.buffer);let metadata=null;
          for(let offset=8;offset+12<=bytes.length;){const size=view.getUint32(offset);const type=new TextDecoder().decode(bytes.slice(offset+4,offset+8));
            if(type==='iTXt'){const text=new TextDecoder().decode(bytes.slice(offset+8,offset+8+size));if(text.startsWith('CHROMA\\0'))metadata=JSON.parse(text.slice(11));}
            offset+=size+12;
          }
          const bitmap=await createImageBitmap(download.blob);const result={name:download.name,type:download.blob.type,width:bitmap.width,height:bitmap.height,metadata};bitmap.close();return result;
        })()""")
        assert export['type'] == 'image/png' and export['width'] == 1600 and export['height'] == 800, f'Export must encode natural resolution rather than the 1200px working canvas: {export}'
        metadata = export['metadata']
        assert metadata and metadata['colourSource'] == 'Library' and metadata['libraryItemId'] == library_colour['id'] and metadata['libraryItemName'] == library_colour['name'], 'PNG must embed Library identity and provenance'
        assert metadata['targetHex'] == library_colour['hex'].upper() and metadata['intensity'] == 100 and metadata['targetRgb'] and metadata['targetLab'], 'PNG must retain target formats and intensity'
        assert metadata['material'] == 'wood' and metadata['lighting'] == 'warm' and metadata['lightingKelvin'] == 2700, 'PNG must record the material and indicative lighting used for its actual rendering'
        click('Share')
        browser.wait('window.__visualizeCheck.downloads.length===2', timeout=15)
        idle()
        checks.append('Save Preview exports a decodable natural 1600×800 PNG with embedded CHROMA target/Library/intensity metadata; browser Share download fallback passes')
        for mode in ['light', 'dark']:
            theme(mode)
            for width, height, mobile in [(320, 844, True), (390, 844, True), (820, 1180, False), (1440, 1100, False)]:
                browser.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile})
                idle()
                check('document.documentElement.scrollWidth<=innerWidth+1', f'Visualize result must not overflow at {width}px in {mode}')
                screenshot(f'chroma-visualize-result-{mode}-{width}.png', width, height, mobile, workspace=True)
        browser.click('[aria-label="Remove Visualize photo"]')
        idle()
        check('window.__visualizeCheck.revoked.includes(' + json.dumps(active_url) + ')', 'Removing the active image must revoke its object URL')
        check('!' + CANVAS, 'Removing the image must dispose of the editor canvas')
        assert browser.state()['library'] == library_before, 'Export/share must leave saved colours and their metadata intact'
        checks.append('Light/dark result layout passes at 320/390/820/1440px; remove photo releases its URL/canvas; sixteen filled editing/result screenshots captured')
    except Exception as error:
        raise AssertionError(f"{error}; Visualize step: {browser.last_command}") from error
    finally:
        browser.evaluate("""(() => {
          const t=window.__visualizeCheck;if(!t)return;
          URL.createObjectURL=t.create;URL.revokeObjectURL=t.revoke;HTMLAnchorElement.prototype.click=t.click;window.fetch=t.fetch;
          if(t.canShare)Object.defineProperty(navigator,'canShare',t.canShare);else delete navigator.canShare;
          t.blobs.clear();delete window.__visualizeCheck;
          for(const key of ['__visualizeOriginal','__visualizeTransformed','__visualizePaintedMask','__visualizeFinalMask'])delete window[key];
        })()""")
        browser.call('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1100, 'deviceScaleFactor': 1, 'mobile': False})
    return {'checks': checks, 'screenshots': screenshots}
