import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { Bookmark, Camera, Check, Copy, Image as ImageIcon, LoaderCircle, MoreHorizontal, Palette, Pipette, ScanLine, Share2, Upload, X } from 'lucide-react';
import { colorInfo, deltaE, rgbToHex } from '../lib/color';
import { indicativeMatchPercent } from '../lib/matchPresentation';
import { extractDominantColours, type PaletteColour } from '../lib/imagePalette';
import { averageImagePixels, displayToImagePixel, imageSampleBounds } from '../lib/imageSampling';
import { useWorkspace } from '../state/WorkspaceContext';
import { useDevice } from '../state/DeviceContext';
import { ColourMetrics, Modal, ProjectSelect } from '../components/ui';
import { SavedLibrarySelect } from '../components/SavedLibraryPicker';
import { PageHeaderSlots } from '../components/PageHeaderSlots';
import { ColourResult } from '../components/ColourResult';
import sampleScene from '../../assets/sample-scene.svg';
import './convert-image-wireframe.css';



interface LoadedImage { element: HTMLImageElement; name: string; url: string; isBlob: boolean; width: number; height: number }

export function ImagePage() {
  const { workspace, view, toast, copy, navigate, goBack, openColourEditor, saveColour, saveComparison, exportComparison, imageMatch, setImageMatchTarget, setImageMatchSample, useLibraryMatchTarget } = useWorkspace();
  const { scanning, scanColour, sendImageMatchResult, status, isNative, error: deviceError } = useDevice();
  const { target, sample } = imageMatch;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [targetSource, setTargetSource] = useState<'image' | 'library'>(target?.source || 'image');
  const nativeBle = isNative && status.mode === 'bluetooth';
  const [loadedImage, setLoadedImage] = useState<LoadedImage | null>(null);
  const [loading, setLoading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [targetPixel, setTargetPixel] = useState<{ x: number; y: number } | null>(null);
  const [x, setX] = useState('0'), [y, setY] = useState('0');
  const [palette, setPalette] = useState<PaletteColour[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [paletteSaved, setPaletteSaved] = useState(false);
  const [comparisonSaved, setComparisonSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const currentImage = useRef<LoadedImage | null>(null);
  const loadVersion = useRef(0);
  const pendingUrls = useRef(new Set<string>());
  const targetRef = useRef(target);
  const mounted = useRef(true);
  const awaitingResult = useRef(false);
  targetRef.current = target;
  const resultName = `${target?.source === 'library' ? 'Library' : 'Image'} match · ${target?.name || (target ? colorInfo(target.hex).name : '')}`;

  useEffect(() => { setComparisonSaved(false); }, [target, sample]);
  useEffect(() => {
    if (view === 'result' && (!target || !sample)) navigate('image', '', true);
  }, [view, target, sample, navigate]);
  useEffect(() => {
    if (target) setTargetSource(target.source);
    if (target?.source !== 'image') setTargetPixel(null);
  }, [target]);

  useEffect(() => {
    if (projectId && !workspace.projects.some(project => project.id === projectId)) {
      setProjectId(''); setPaletteSaved(false); setComparisonSaved(false);
    }
  }, [workspace.projects, projectId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadVersion.current++;
      if (currentImage.current?.isBlob) URL.revokeObjectURL(currentImage.current.url);
      pendingUrls.current.forEach(url => URL.revokeObjectURL(url));
      pendingUrls.current.clear();
    };
  }, []);
  useEffect(() => {
    if (!loadedImage || !preview.current) return;
    const scale = Math.min(1, 1600 / Math.max(loadedImage.width, loadedImage.height));
    const canvas = preview.current;
    canvas.width = Math.max(1, Math.round(loadedImage.width * scale));
    canvas.height = Math.max(1, Math.round(loadedImage.height * scale));
    const context = canvas.getContext('2d');
    if (!context) { setError('Your browser could not create an image preview.'); return; }
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(loadedImage.element, 0, 0, canvas.width, canvas.height);
  }, [loadedImage, view]);

  useEffect(() => { if (loadedImage) void extractPalette(); }, [loadedImage]);

  function resetImage() {
    if (currentImage.current?.isBlob) URL.revokeObjectURL(currentImage.current.url);
    currentImage.current = null;
    pendingUrls.current.forEach(url => URL.revokeObjectURL(url));
    pendingUrls.current.clear();
    setLoadedImage(null);
    if (targetRef.current?.source === 'image') setImageMatchTarget(null);
    setTargetPixel(null);
    setPalette([]); setExtracting(false); setX('0'); setY('0');
    setPaletteSaved(false); setComparisonSaved(false); setError('');
  }

  function clearImage() {
    loadVersion.current++;
    resetImage(); setLoading(false);
  }

  async function loadImage(url: string, name: string, isBlob = false) {
    const version = ++loadVersion.current;
    pendingUrls.current.forEach(pending => URL.revokeObjectURL(pending));
    pendingUrls.current.clear();
    setExtracting(false);
    if (isBlob) pendingUrls.current.add(url);
    setLoading(true);
    setError('');
    try {
      const element = new window.Image();
      element.src = url;
      await element.decode();
      if (!element.naturalWidth || !element.naturalHeight) throw new Error('This image has no readable pixels.');
      if (element.naturalWidth * element.naturalHeight > 40_000_000) throw new Error('Choose an image smaller than 40 megapixels.');
      if (version !== loadVersion.current) { if (isBlob) URL.revokeObjectURL(url); return; }
      pendingUrls.current.delete(url);
      // Keep the previous image and target until the replacement is readable.
      resetImage();
      const next = { element, name, url, isBlob, width: element.naturalWidth, height: element.naturalHeight };
      currentImage.current = next;
      setLoadedImage(next);
      navigate('image');
      toast('Image ready. Pick a colour that catches your eye.');
    } catch (err) {
      if (isBlob) URL.revokeObjectURL(url);
      if (version === loadVersion.current) setError(err instanceof Error && err.message.includes('megapixels') ? err.message : 'We could not read that image. Please try another file.');
    } finally { pendingUrls.current.delete(url); if (version === loadVersion.current) setLoading(false); }
  }

  function upload(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(file.type)) { setError('Choose a JPG, PNG, WEBP, AVIF or GIF image.'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('This image is too big. Choose one up to 20 MB.'); return; }
    void loadImage(URL.createObjectURL(file), file.name, true);
  }

  function pickPixel(pixelX: number, pixelY: number) {
    const bounds = loadedImage && imageSampleBounds({ x: pixelX, y: pixelY }, loadedImage);
    if (!loadedImage || loading || !bounds) {
      setError('Choose whole-number pixel coordinates inside this image.'); return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bounds.width; canvas.height = bounds.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas unavailable.');
      // Read original pixels without resizing. The white composite and 3 × 3
      // average happen in the same deterministic helper used by the tests.
      context.imageSmoothingEnabled = false;
      context.drawImage(loadedImage.element, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
      const rgb = averageImagePixels(context.getImageData(0, 0, bounds.width, bounds.height).data);
      if (!rgb) throw new Error('Unreadable pixels.');
      setImageMatchTarget(rgbToHex(rgb.r, rgb.g, rgb.b), loadedImage.name);
      setTargetPixel({ x: pixelX, y: pixelY });
      setX(String(pixelX)); setY(String(pixelY));
      setComparisonSaved(false); setError('');
    } catch { setError('This image could not be sampled. Try another local image.'); }
  }

  function clickPixel(event: MouseEvent<HTMLCanvasElement>) {
    if (!loadedImage) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const pixel = displayToImagePixel({ x: event.clientX, y: event.clientY }, bounds, loadedImage);
    if (pixel) pickPixel(pixel.x, pixel.y);
  }

  function submitPixel(event: FormEvent) {
    event.preventDefault();
    if (!x.trim() || !y.trim()) { setError('Enter both X and Y coordinates.'); return; }
    pickPixel(Number(x), Number(y));
  }

  async function extractPalette() {
    if (!loadedImage) return;
    const source = loadedImage;
    const version = loadVersion.current;
    setExtracting(true); setError('');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (version !== loadVersion.current || currentImage.current !== source) return;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 360 / Math.max(source.width, source.height));
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas unavailable.');
      context.drawImage(source.element, 0, 0, canvas.width, canvas.height);
      const colours = extractDominantColours(context.getImageData(0, 0, canvas.width, canvas.height).data);
      if (currentImage.current !== source) return;
      if (!colours.length) { setError('This image is fully transparent. Choose an image with visible colours.'); return; }
      setPalette(colours); setPaletteSaved(false);
      toast(`Extracted ${colours.length} dominant ${colours.length === 1 ? 'colour' : 'colours'}.`);
    } catch { if (version === loadVersion.current) setError('We could not extract a palette from this image. Try another image.'); }
    finally { if (version === loadVersion.current) setExtracting(false); }
  }

  function savePalette() {
    let added = 0;
    palette.forEach(colour => {
      if (workspace.library.some(item => item.hex === colour.hex && (item.projectId || '') === projectId)) return;
      saveColour({ hex: colour.hex, tags: ['image', 'palette'], source: 'image', projectId: projectId || undefined });
      added++;
    });
    setPaletteSaved(true);
    toast(added ? `Saved ${added} colours${projectId ? ' to your project' : ' to your library'}.` : 'These palette colours are already saved.');
  }

  async function scanAndMatch() {
    awaitingResult.current = true;
    try {
      const reading = await scanColour();
      if (!mounted.current) return;
      if (!reading) { awaitingResult.current = false; return; }
      setImageMatchSample(reading);
      if (targetRef.current && awaitingResult.current) {
        awaitingResult.current = false;
        setToolsOpen(false);
        navigate('image', 'result');
      }
      awaitingResult.current = false;
    } catch (reason) {
      awaitingResult.current = false;
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'The scan could not be completed.');
    }
  }
  function backToEditor() {
    awaitingResult.current = false;
    setToolsOpen(false);
    goBack('image');
  }
  function saveMatch() {
    if (!target || !sample) return;
    saveComparison(target.hex, sample.hex, projectId || undefined, resultName, undefined, sample.source, target);
    setComparisonSaved(true);
    toast('Image comparison saved.');
  }

  const pickColours = palette.length ? palette.slice(0, 5).map(colour => colour.hex) : target ? [target.hex] : [];
  const difference = target && sample ? deltaE(target.hex, sample.hex) : null;
  useEffect(() => {
    if (!scanning && target && sample && difference !== null) void sendImageMatchResult(target, sample, difference);
  }, [scanning, target, sample, difference, sendImageMatchResult]);
  const sampleLabel = sample?.source === 'demo' ? 'Demo scan' : sample?.source === 'bluetooth' ? 'Bluetooth scan' : sample?.source === 'usb' ? 'USB scan' : sample?.source === 'wifi' ? 'Wi-Fi scan' : 'Saved sample';
  const resultView = view === 'result' && Boolean(target && sample);

  return <div className={`wireframe-page wireframe-image ${resultView ? 'image-result-view' : ''}`}>
    <PageHeaderSlots actions={<button className="reference-header-button" type="button" aria-label="Image Match actions" onClick={() => setToolsOpen(true)}><MoreHorizontal size={23} /></button>} />
    <input ref={fileInput} type="file" id="image-input" className="file-input" accept="image/png,image/jpeg,image/webp,image/avif,image/gif" aria-label="Upload an image" onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} />
    <input ref={cameraInput} type="file" id="image-camera-input" className="file-input" accept="image/*" capture="environment" aria-label="Take a photo for Image Match" onChange={event => { upload(event.target.files?.[0]); event.target.value = ''; }} />
    {resultView && target && sample ? <ColourResult title="Image Match Result" reference={target.hex} sample={sample.hex} source={sample.source} referenceSource={target.source} onBack={backToEditor} backLabel="Back to Image Match" onSave={saveMatch} saved={comparisonSaved} onShare={() => void exportComparison(target.hex, sample.hex, resultName, sample.source, target)} onScan={() => void scanAndMatch()} scanning={scanning} scanDisabled={status.mode === 'disconnected'} details={<dl><div><dt>Target</dt><dd data-testid="match-target-source">{target.source === 'library' ? `Library: ${target.name || colorInfo(target.hex).name}` : `Image: ${target.imageName || loadedImage?.name || 'Selected colour'}`}</dd></div>{sample.clear !== undefined && <div><dt>Sensor clear</dt><dd>{sample.clear}</dd></div>}{projectId && <div><dt>Project</dt><dd>{workspace.projects.find(project => project.id === projectId)?.name || 'Library'}</dd></div>}</dl>} /> : <>
    <h1 className="wireframe-title" tabIndex={-1}>Image Match</h1>
    <h2 className="image-page-title">Image Match</h2>
    <div className={`wireframe-image-area ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files[0]); }}>
      {loadedImage ? <div className="wireframe-canvas-wrap" aria-busy={loading}>
        <canvas ref={preview} id="image-canvas" onClick={clickPixel} aria-label="Image preview. Click or tap to pick a colour. Use the eyedropper button for precise pixel coordinates." />
        {target?.source === 'image' && targetPixel && <span className="wireframe-image-crosshair" data-testid="image-crosshair" aria-hidden="true" style={{ left: `${(targetPixel.x + 0.5) / loadedImage.width * 100}%`, top: `${(targetPixel.y + 0.5) / loadedImage.height * 100}%`, background: target.hex }} />}
      </div> : <button type="button" id="dropzone" className="wireframe-upload" aria-label="Upload an image or drop an image file" disabled={loading} onClick={() => fileInput.current?.click()}>
        {loading ? <LoaderCircle size={35} className="animate-spin" /> : <ImageIcon size={35} strokeWidth={1.5} />}<strong>{loading ? 'Opening image…' : 'Choose Image'}</strong><span>Tap to upload</span>
      </button>}
    </div>
    <div className="image-upload-actions"><button className="btn secondary" disabled={loading} onClick={() => fileInput.current?.click()}><Upload size={17} />{loadedImage ? 'Change photo' : 'Upload photo'}</button><button className="btn secondary" disabled={loading} onClick={() => cameraInput.current?.click()}><Camera size={18} />Take photo</button></div>
    <p className="error-message" id="image-error" role="alert">{error}</p>
    <section className="wireframe-pick-section" aria-labelledby="wireframe-pick-heading">
      <h2 id="wireframe-pick-heading">Pick Colour</h2>
      <div className="wireframe-pick-row">
        {Array.from({ length: 5 }, (_, index) => {
          const hex = pickColours[index];
          return <button type="button" key={index} className={`wireframe-pick-colour ${hex && target?.hex === hex ? 'selected' : ''}`} style={hex ? { background: hex } : undefined} disabled={!hex} aria-label={hex ? `Select colour ${hex}` : 'Colour available after image upload'} aria-pressed={Boolean(hex && target?.hex === hex)} onClick={() => { if (hex && palette.length) { setImageMatchTarget(hex, loadedImage?.name); setTargetPixel(null); setComparisonSaved(false); } }} />;
        })}
        <button className="wireframe-eyedropper" type="button" aria-label="Pick an exact pixel or a Library colour" onClick={() => setToolsOpen(true)}><Pipette size={24} /></button>
      </div>
      {target && <span className="wireframe-target-caption" data-testid="match-target-source">{target.hex} · {target.source === 'library' ? `Library: ${target.name || 'Saved colour'}` : 'Image colour'}</span>}
    </section>
    <section className="wireframe-extracted-panel" aria-labelledby="wireframe-palette-heading">
      <h2 id="wireframe-palette-heading">Extracted Palette</h2>
      <div className="wireframe-extracted-colours" aria-label="Extracted dominant palette" aria-busy={extracting}>
        {Array.from({ length: 5 }, (_, index) => {
          const colour = palette[index];
          return <button type="button" key={index} style={colour ? { background: colour.hex } : undefined} disabled={!colour || extracting} aria-label={colour ? `Select dominant colour ${colour.hex}, about ${Math.round(colour.proportion * 100)} percent` : 'Palette colour available after image upload'} onClick={() => { if (colour) { setImageMatchTarget(colour.hex, loadedImage?.name); setTargetPixel(null); setComparisonSaved(false); } }} />;
        })}
      </div>
    </section>
    <button id="image-scan" className="btn primary wireframe-primary wireframe-bottom-action" disabled={scanning || status.mode === 'disconnected' || loading} onClick={() => void scanAndMatch()}>{scanning ? <LoaderCircle size={18} className="animate-spin" /> : <ScanLine size={18} />}{scanning ? nativeBle ? 'Waiting for CHROMA…' : 'Scanning…' : 'Scan'}</button>
    {deviceError && <p className="error-message" role="alert">{deviceError}</p>}
    {status.mode === 'disconnected' && <p className="wireframe-context-message">Connect CHROMAPOD or enable demo mode in <a href="#device">Device</a> to scan.</p>}
    {(target || sample) && <section className="wireframe-image-result" data-testid="image-match-panel" aria-label="Image Match result" aria-live="polite">
      <div className="wireframe-image-result-pair">
        <div data-testid="image-match-target">{target ? <><i style={{ background: target.hex }} /><span>{target.hex}<small>{target.source === 'library' ? 'Library target' : 'Image target'}</small></span></> : <span>Choose a target</span>}</div>
        <div data-testid="image-match-sample">{sample ? <><i style={{ background: sample.hex }} /><span>{sample.hex}<small>{sampleLabel}</small></span></> : <span>Ready to scan</span>}</div>
      </div>
      {difference !== null ? <button className="image-open-result" onClick={() => navigate('image', 'result')}><strong>View Match Result</strong><span>ΔE {difference.toFixed(2)} · {indicativeMatchPercent(difference)}%</span></button> : <p className="wireframe-context-message">{sample ? 'Pick a colour to compare with your scan.' : 'Scan your physical sample to see the match.'}</p>}
    </section>}
    </>}
    {toolsOpen && <Modal title="Image Match actions" onClose={() => setToolsOpen(false)}><div className="wireframe-tool-actions">
      <div className="wireframe-tool-tabs" role="group" aria-label="Target source"><button className={targetSource === 'image' ? 'active' : ''} aria-pressed={targetSource === 'image'} onClick={() => setTargetSource('image')}>Image</button><button className={targetSource === 'library' ? 'active' : ''} aria-pressed={targetSource === 'library'} onClick={() => setTargetSource('library')}>Library</button></div>
      {targetSource === 'library' ? <><label className="label" htmlFor="match-library-colour">Library colour</label><SavedLibrarySelect id="match-library-colour" value={target?.source === 'library' ? target.libraryItemId : ''} onChoose={colour => { useLibraryMatchTarget(colour.id); setToolsOpen(false); }} onOpenLibrary={() => { setToolsOpen(false); navigate('library'); }} /><button className="btn secondary" onClick={() => { setToolsOpen(false); navigate('library'); }}>Open Library</button></> : <>
        <button className="btn secondary" disabled={loading} onClick={() => { setToolsOpen(false); fileInput.current?.click(); }}><Upload size={17} />{loadedImage ? 'Change image' : 'Choose Image'}</button>
        <button className="btn secondary" disabled={loading} onClick={() => { setToolsOpen(false); cameraInput.current?.click(); }}><Camera size={17} />Take photo</button>
        {!loadedImage && <button className="btn secondary" disabled={loading} onClick={() => { setToolsOpen(false); void loadImage(sampleScene, 'A quiet place · sample image'); }}>Explore with a sample image</button>}
        {(loadedImage || loading) && <button id="image-clear" className="btn secondary" onClick={() => { clearImage(); setToolsOpen(false); }}><X size={17} />Clear image</button>}
        {loadedImage && <><form id="pixel-form" className="wireframe-pixel-form" onSubmit={event => { submitPixel(event); }}><label htmlFor="pixel-x">Pixel X<input id="pixel-x" className="input" type="number" min="0" max={loadedImage.width - 1} step="1" value={x} onChange={event => setX(event.target.value)} required /></label><label htmlFor="pixel-y">Pixel Y<input id="pixel-y" className="input" type="number" min="0" max={loadedImage.height - 1} step="1" value={y} onChange={event => setY(event.target.value)} required /></label><button className="btn secondary" type="submit">Pick pixel</button></form><p className="helper">A 3 × 3 area of original pixels is averaged and clipped at image edges. Transparency appears on white.</p><button className="btn secondary" disabled={extracting || loading} onClick={() => void extractPalette()}><Palette size={17} />{extracting ? 'Extracting…' : 'Extract Palette'}</button></>}
      </>}
      {target && <><button className="btn secondary" onClick={() => { setToolsOpen(false); openColourEditor(target.hex, target.source === 'library' ? target.libraryItemId : undefined, target.source); }}><Bookmark size={17} />Save target</button><button id="match-clear-target" className="btn secondary" onClick={() => { setImageMatchTarget(null); setTargetPixel(null); }}><X size={17} />Clear target</button></>}
      <button className="btn secondary" onClick={() => { setImageMatchSample({ hex: workspace.latest.hex, source: workspace.latest.source, timestamp: workspace.latest.createdAt, clear: workspace.latest.clear }); setComparisonSaved(false); }}>Use latest capture</button>
      {sample && <button id="match-clear-sample" className="btn secondary" onClick={() => setImageMatchSample(null)}><X size={17} />Clear sample</button>}
      {(palette.length > 0 || (target && sample)) && <ProjectSelect value={projectId} onChange={value => { setProjectId(value); setPaletteSaved(false); setComparisonSaved(false); }} label="Save palette or comparison to" />}
      {palette.length > 0 && <><button className="btn secondary" onClick={savePalette}>{paletteSaved ? <Check size={17} /> : <Bookmark size={17} />}{paletteSaved ? 'Palette saved' : 'Save palette'}</button><button className="btn secondary" onClick={() => void copy(palette.map(colour => colour.hex).join(', '))}><Copy size={17} />Copy palette</button></>}
      {target && sample && <><button className="btn secondary" onClick={saveMatch} disabled={comparisonSaved}>{comparisonSaved ? <Check size={17} /> : <Bookmark size={17} />}{comparisonSaved ? 'Comparison saved' : 'Save comparison'}</button><button className="btn secondary" onClick={() => void exportComparison(target.hex, sample.hex, resultName, sample.source, target)}><Share2 size={17} />Share / export result</button></>}
      {target && <details><summary>Target colour values</summary><ColourMetrics hex={target.hex} formats={['HEX', 'RGB', 'HSL', 'CMYK', 'LAB']} /></details>}
      {sample && <details><summary>{sampleLabel} values</summary><ColourMetrics hex={sample.hex} formats={['HEX', 'RGB', 'HSL', 'CMYK', 'LAB']} />{sample.clear !== undefined && <p className="helper">Sensor clear channel: {sample.clear}</p>}</details>}
      <button className="btn secondary" onClick={() => { setToolsOpen(false); navigate('visualize'); }}>Visualize</button>
    </div></Modal>}
  </div>;
}

export default ImagePage;

