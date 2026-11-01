import { cloneMask, createMask, paintStroke, validateMask, type BrushMode, type MaskData, type Point } from './mask';

export type SelectionMode = 'replace' | 'add' | 'remove';
export type SelectionMethod = 'manual' | 'local-region' | 'sam3';
export interface SelectionProvenance {
  readonly selectionMethod: SelectionMethod;
  readonly selectionRefined: boolean;
}
interface MaskSnapshot { mask: MaskData; provenance: SelectionProvenance }
const MANUAL_PROVENANCE: SelectionProvenance = Object.freeze({ selectionMethod: 'manual', selectionRefined: false });

/** Manual refinement and automatic selections share the same bounded undo history. */
export interface MaskProvider {
  readonly mask: MaskData;
  readonly provenance: SelectionProvenance;
  readonly canUndo: boolean;
  beginStroke(): void;
  stroke(from: Point, to: Point, radius: number, mode: BrushMode): void;
  endStroke(): boolean;
  cancelStroke(): void;
  undo(): boolean;
  clear(): boolean;
  replace(mask: MaskData, method?: SelectionMethod): void;
  applySelection(mask: MaskData, mode?: SelectionMode, method?: SelectionMethod): boolean;
}

function sameMask(a: MaskData, b: MaskData): boolean {
  return a.width === b.width && a.height === b.height && a.data.every((value, index) => value === b.data[index]);
}

export class ManualMaskProvider implements MaskProvider {
  private current: MaskData;
  private currentProvenance: SelectionProvenance = MANUAL_PROVENANCE;
  private history: MaskSnapshot[] = [];
  private strokeStart: MaskSnapshot | null = null;

  constructor(width: number, height: number) { this.current = createMask(width, height); }
  get mask(): MaskData { return this.current; }
  get provenance(): SelectionProvenance { return this.currentProvenance; }
  get canUndo(): boolean { return this.history.length > 0; }

  beginStroke(): void { this.strokeStart ??= this.snapshot(); }
  stroke(from: Point, to: Point, radius: number, mode: BrushMode): void {
    this.beginStroke();
    paintStroke(this.current, from, to, radius, mode);
  }
  endStroke(): boolean {
    const previous = this.strokeStart;
    this.strokeStart = null;
    if (!previous || sameMask(previous.mask, this.current)) return false;
    this.remember(previous);
    this.currentProvenance = Object.freeze({ ...previous.provenance, selectionRefined: true });
    return true;
  }
  cancelStroke(): void {
    if (this.strokeStart) this.restore(this.strokeStart);
    this.strokeStart = null;
  }
  undo(): boolean {
    this.cancelStroke();
    const previous = this.history.pop();
    if (!previous) return false;
    this.restore(previous);
    return true;
  }
  clear(): boolean {
    this.endStroke();
    if (!this.current.data.some(value => value > 0)) return false;
    this.remember(this.snapshot());
    this.current = createMask(this.current.width, this.current.height);
    this.currentProvenance = MANUAL_PROVENANCE;
    return true;
  }
  replace(mask: MaskData, method: SelectionMethod = 'manual'): void {
    this.applySelection(mask, 'replace', method);
  }
  applySelection(mask: MaskData, mode: SelectionMode = 'replace', method: SelectionMethod = 'manual'): boolean {
    validateMask(mask);
    if (mask.width !== this.current.width || mask.height !== this.current.height) throw new RangeError('Replacement mask must match the image dimensions.');
    if (!['replace', 'add', 'remove'].includes(mode)) throw new RangeError('Selection mode must be replace, add or remove.');
    if (!['manual', 'local-region', 'sam3'].includes(method)) throw new RangeError('Selection method must be manual, local-region or sam3.');
    const next = cloneMask(mask);
    if (mode !== 'replace') {
      for (let index = 0; index < next.data.length; index++) {
        next.data[index] = mode === 'add'
          ? Math.max(this.current.data[index], mask.data[index])
          : Math.round(this.current.data[index] * (1 - mask.data[index] / 255));
      }
    }
    this.endStroke();
    if (sameMask(this.current, next)) return false;
    this.remember(this.snapshot());
    this.current = next;
    this.currentProvenance = Object.freeze({ selectionMethod: method, selectionRefined: mode !== 'replace' });
    return true;
  }
  private snapshot(): MaskSnapshot {
    return { mask: cloneMask(this.current), provenance: this.currentProvenance };
  }
  private restore(snapshot: MaskSnapshot): void {
    this.current = snapshot.mask;
    this.currentProvenance = snapshot.provenance;
  }
  private remember(snapshot: MaskSnapshot): void {
    this.history.push(snapshot);
    if (this.history.length > 8) this.history.shift();
  }
}
