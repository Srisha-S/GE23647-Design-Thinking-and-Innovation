import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { colorInfo, hslToRgb, normalizeHex, rgbToHex } from '../lib/color';
import './colour-tools.css';

interface ColourPickerProps { value: string; onChange: (hex: string) => void; id?: string; name?: string; hexId?: string }
export function ColourPicker({ value, onChange, id, name = 'Colour wheel', hexId }: ColourPickerProps) {
  const generated = useId();
  const identifier = id || generated;
  const [hsl, setHsl] = useState(() => colorInfo(value).hsl);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const lastEmitted = useRef<string | null>(null);
  useLayoutEffect(() => {
    setDraft(value);
    if (value !== lastEmitted.current) setHsl(colorInfo(value).hsl);
  }, [value]);
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const pixels = context.createImageData(element.width, element.height);
    for (let y = 0; y < element.height; y++) for (let x = 0; x < element.width; x++) {
      const rgb = hslToRgb({ h: hsl.h, s: x / (element.width - 1) * 100, l: 100 - y / (element.height - 1) * 100 });
      const index = (y * element.width + x) * 4;
      pixels.data[index] = rgb.r; pixels.data[index + 1] = rgb.g; pixels.data[index + 2] = rgb.b; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
  }, [hsl.h]);
  function update(next: { h: number; s: number; l: number }) {
    const normalized = { h: Math.max(0, Math.min(359, next.h)), s: Math.max(0, Math.min(100, next.s)), l: Math.max(0, Math.min(100, next.l)) };
    setHsl(normalized); setError('');
    const rgb = hslToRgb(normalized);
    const hex = rgbToHex(rgb.r, rgb.g, rgb.b);
    lastEmitted.current = hex; setDraft(hex); onChange(hex);
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    update({ ...hsl, s: (event.clientX - bounds.left) / bounds.width * 100, l: 100 - (event.clientY - bounds.top) / bounds.height * 100 });
  }
  function applyHex() {
    try { const hex = normalizeHex(draft); lastEmitted.current = hex; setHsl(colorInfo(hex).hsl); setDraft(hex); setError(''); if (hex !== value) onChange(hex); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Enter a valid HEX colour.'); }
  }
  return <section className="colour-picker" data-testid={id || 'colour-picker'} aria-label={name}>
    <div className="colour-picker-heading"><strong>{name}</strong><i style={{ background: value }} aria-label={value} /></div>
    <div className="colour-picker-plane">
      <canvas ref={canvas} width={180} height={140} role="slider" tabIndex={0} aria-label="Saturation and lightness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsl.s)} aria-valuetext={'Saturation ' + Math.round(hsl.s) + ' percent, lightness ' + Math.round(hsl.l) + ' percent'} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); point(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); }} onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onKeyDown={event => {
        const amount = event.shiftKey ? 10 : 1;
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); update({ ...hsl, s: hsl.s + (event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0), l: hsl.l + (event.key === 'ArrowUp' ? amount : event.key === 'ArrowDown' ? -amount : 0) });
      }} />
      <span className="colour-picker-marker" style={{ left: hsl.s + '%', top: (100 - hsl.l) + '%', background: value }} aria-hidden="true" />
    </div>
    <label className="colour-picker-hue" htmlFor={identifier + '-hue'}><span>Hue <small>{Math.round(hsl.h)} degrees</small></span><input id={identifier + '-hue'} type="range" min={0} max={359} step={1} value={hsl.h} onChange={event => update({ ...hsl, h: Number(event.target.value) })} /></label>
    <div className="colour-picker-controls"><label htmlFor={identifier + '-saturation'}>Saturation<input id={identifier + '-saturation'} type="range" min={0} max={100} step={1} value={hsl.s} onChange={event => update({ ...hsl, s: Number(event.target.value) })} /><small>{Math.round(hsl.s)}%</small></label><label htmlFor={identifier + '-lightness'}>Lightness<input id={identifier + '-lightness'} type="range" min={0} max={100} step={1} value={hsl.l} onChange={event => update({ ...hsl, l: Number(event.target.value) })} /><small>{Math.round(hsl.l)}%</small></label></div>
    <label className="label" htmlFor={hexId || identifier + '-hex'}>HEX</label><input className="input" id={hexId || identifier + '-hex'} value={draft} maxLength={7} spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={applyHex} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyHex(); } }} aria-invalid={Boolean(error)} aria-describedby={error ? identifier + '-error' : undefined} />
    {error && <p className="error-message" id={identifier + '-error'} role="alert">{error}</p>}
  </section>;
}
