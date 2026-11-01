import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react';
import type { WorkingImage } from './imageUtils';
import { displayToImagePoint } from './imageUtils';
import type { ManualMaskProvider } from './maskProvider';
import type { BrushMode, Point } from './mask';
import type { ImagePixels } from './recolor';

interface Props {
  image: WorkingImage;
  provider: ManualMaskProvider;
  maskVersion: number;
  pixels: ImagePixels | null;
  editing: boolean;
  active: boolean;
  disabled: boolean;
  tool: BrushMode | 'tap';
  brushSize: number;
  onChange: () => void;
  onPaintingChange: (painting: boolean) => void;
  onSurfaceTap?: (point: Point) => void;
  comparison?: { pixels: ImagePixels; position: number };
}

/** The photo, editable mask and brush cursor are separate layers. No recolouring during strokes. */
export function VisualizeCanvas({ image, provider, maskVersion, pixels, editing, active, disabled, tool, brushSize, onChange, onPaintingChange, onSurfaceTap, comparison }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const comparisonCanvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const overlayFrame = useRef<ImageData | null>(null);
  const paintFrame = useRef(0);
  const stroke = useRef<{ id: number; last: Point } | null>(null);
  const tap = useRef<{ id: number; point: Point; clientX: number; clientY: number } | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const callbacks = useRef({ onChange, onPaintingChange, onSurfaceTap });
  callbacks.current = { onChange, onPaintingChange, onSurfaceTap };

  const drawMask = useCallback(() => {
    paintFrame.current = 0;
    const context = overlay.current?.getContext('2d');
    if (!context) return;
    let frame = overlayFrame.current;
    const { mask } = provider;
    if (!frame || frame.width !== mask.width || frame.height !== mask.height) {
      frame = context.createImageData(mask.width, mask.height);
      for (let i = 0; i < mask.data.length; i++) {
        frame.data[i * 4] = 35; frame.data[i * 4 + 1] = 135; frame.data[i * 4 + 2] = 245;
      }
      overlayFrame.current = frame;
    }
    for (let i = 0; i < mask.data.length; i++) frame.data[i * 4 + 3] = (mask.data[i] ? Math.max(1, Math.round(mask.data[i] * .48)) : 0);
    context.putImageData(frame, 0, 0);
  }, [provider]);
  const scheduleMask = () => { if (!paintFrame.current) paintFrame.current = requestAnimationFrame(drawMask); };

  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const source = pixels || image.pixels;
    const frame = context.createImageData(source.width, source.height);
    frame.data.set(source.data);
    context.putImageData(frame, 0, 0);
  }, [image, pixels]);
  useEffect(() => {
    const context = comparisonCanvas.current?.getContext('2d');
    if (!context || !comparison) return;
    const frame = context.createImageData(comparison.pixels.width, comparison.pixels.height);
    frame.data.set(comparison.pixels.data); context.putImageData(frame, 0, 0);
  }, [comparison?.pixels]);
  useEffect(() => { drawMask(); }, [drawMask, maskVersion]);
  useEffect(() => {
    if (!active || !editing || disabled) {
      tap.current = null;
      if (stroke.current) { provider.cancelStroke(); stroke.current = null; callbacks.current.onPaintingChange(false); drawMask(); }
      setCursor(null);
    }
  }, [active, editing, disabled, provider, drawMask]);
  useEffect(() => () => {
    cancelAnimationFrame(paintFrame.current);
    if (stroke.current) provider.cancelStroke();
    stroke.current = null;
    tap.current = null;
    overlayFrame.current = null;
  }, [provider]);

  function point(event: ReactPointerEvent<HTMLCanvasElement>, clamp = false): Point | null {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = clamp ? Math.min(rect.right, Math.max(rect.left, event.clientX)) : event.clientX;
    const y = clamp ? Math.min(rect.bottom, Math.max(rect.top, event.clientY)) : event.clientY;
    return displayToImagePoint(x, y, rect, image.width, image.height);
  }
  function radius() { return brushSize / 2 * image.width / (canvas.current?.getBoundingClientRect().width || image.width); }
  function start(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!editing || disabled || !active) return;
    if (stroke.current || !event.isPrimary) {
      if (stroke.current) { provider.cancelStroke(); stroke.current = null; callbacks.current.onPaintingChange(false); drawMask(); }
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const p = point(event);
    if (!p) return;
    if (tool === 'tap') {
      tap.current = { id: event.pointerId, point: p, clientX: event.clientX, clientY: event.clientY };
      event.currentTarget.focus({ preventScroll: true }); setCursor(p);
      return;
    }
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* A cancelled pointer no longer has capture. */ }
    provider.beginStroke(); provider.stroke(p, p, radius(), tool);
    stroke.current = { id: event.pointerId, last: p };
    setCursor(p); callbacks.current.onPaintingChange(true); scheduleMask();
  }
  function move(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!editing || disabled || !active) return;
    const current = stroke.current;
    const p = point(event, !!current);
    setCursor(p);
    if (tool === 'tap' || !current || current.id !== event.pointerId || !p) return;
    event.preventDefault();
    provider.stroke(current.last, p, radius(), tool); current.last = p; scheduleMask();
  }
  function finish(event: ReactPointerEvent<HTMLCanvasElement>, cancelled = false) {
    if (tap.current?.id === event.pointerId) {
      const pending = tap.current; tap.current = null;
      if (!cancelled && active && editing && !disabled && Math.hypot(event.clientX - pending.clientX, event.clientY - pending.clientY) <= 8) callbacks.current.onSurfaceTap?.(pending.point);
      return;
    }
    if (stroke.current?.id !== event.pointerId) return;
    const changed = cancelled ? (provider.cancelStroke(), false) : provider.endStroke();
    stroke.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    callbacks.current.onPaintingChange(false); drawMask();
    if (changed) callbacks.current.onChange();
  }
  function keyboard(event: KeyboardEvent<HTMLCanvasElement>) {
    if (!editing || disabled || !active) return;
    const step = (event.shiftKey ? 10 : 1) * image.width / (canvas.current?.getBoundingClientRect().width || image.width);
    const current = cursor || { x: image.width / 2, y: image.height / 2 };
    const offsets: Record<string, Point> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
    if (offsets[event.key]) { event.preventDefault(); setCursor({ x: Math.max(0, Math.min(image.width - 1, current.x + offsets[event.key].x)), y: Math.max(0, Math.min(image.height - 1, current.y + offsets[event.key].y)) }); }
    else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (tool === 'tap') callbacks.current.onSurfaceTap?.(current);
      else { provider.beginStroke(); provider.stroke(current, current, radius(), tool); const changed = provider.endStroke(); drawMask(); if (changed) callbacks.current.onChange(); }
      setCursor(current);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); const changed = provider.undo(); drawMask(); if (changed) callbacks.current.onChange(); }
  }
  return <div className="visualize-photo-stage">
    <div className={`visualize-canvas-frame ${editing ? 'is-editing' : ''}`} style={{ maxWidth: `min(100%, ${image.width / image.height * 65}vh)` }}>
      <canvas ref={canvas} id="visualize-canvas" width={image.width} height={image.height} tabIndex={editing ? 0 : -1} aria-label={editing ? tool === 'tap' ? 'Tap a surface to select it. Arrow keys move the point; Enter selects; Control Z undoes.' : 'Photo selection. Drag to paint. Arrow keys move the brush; Space paints; Control Z undoes.' : 'Photo preview'} onPointerDown={start} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} onPointerLeave={() => { if (!stroke.current) setCursor(null); }} onKeyDown={keyboard} style={{ touchAction: editing && tool !== 'tap' ? 'none' : 'pan-y' }} />
      {!editing && comparison && <><canvas ref={comparisonCanvas} id="visualize-comparison-canvas" width={image.width} height={image.height} className="visualize-comparison-overlay" style={{ clipPath: `inset(0 0 0 ${comparison.position}%)` }} aria-hidden="true" /><span className="visualize-comparison-divider" style={{ left: `${comparison.position}%` }} aria-hidden="true"><span>↔</span></span><span className="visualize-photo-label before">Original</span><span className="visualize-photo-label after">Preview</span></>}
      <canvas ref={overlay} width={image.width} height={image.height} className="visualize-mask-overlay" hidden={!editing} aria-hidden="true" />
      {editing && cursor && <span className={`visualize-brush-cursor ${tool}`} aria-hidden="true" style={{ left: `${cursor.x / image.width * 100}%`, top: `${cursor.y / image.height * 100}%`, width: brushSize, height: brushSize }} />}
    </div>
  </div>;
}
