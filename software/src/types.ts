export type Route = 'home' | 'scan' | 'compare' | 'convert' | 'image' | 'library' | 'projects' | 'device' | 'settings' | 'about' | 'visualize';
export type ColourFormat = 'HEX' | 'RGB' | 'HSL' | 'LAB' | 'CMYK';
export interface RGB { r: number; g: number; b: number }
export interface MatchTargetMetadata {
  source: 'image' | 'library';
  name?: string;
  libraryItemId?: string;
  libraryProjectId?: string;
  imageName?: string;
}
export interface MatchTarget extends MatchTargetMetadata { hex: string; rgb: RGB }
export interface ColourRecord {
  id: string; hex: string; name: string; rgb: RGB; tags: string[];
  createdAt: string; source: string; projectId?: string; clear?: number;
}
export interface ComparisonRecord { id: string; a: string; b: string; name: string; createdAt: string; projectId?: string; deviceDeltaE?: number; sampleSource?: string; referenceSource?: string; matchTarget?: MatchTargetMetadata }
export interface Project { id: string; name: string; notes: string; createdAt: string; folderId?: string }
export interface ProjectFolder { id: string; name: string; createdAt: string }
export interface WorkspaceData { version: 2; latest: ColourRecord; history: ColourRecord[]; library: ColourRecord[]; comparisons: ComparisonRecord[]; projects: Project[]; folders: ProjectFolder[] }
export interface SaveColourInput { id?: string; hex: string; name?: string; tags?: string[]; projectId?: string; source?: string; captureId?: string }
export interface DeviceReading { hex: string; name?: string; source: string; timestamp: string; deviceMode?: string; clear?: number; data?: import('./types/deviceProtocol').ChromaScanMessage }
export interface DeviceStatus { mode: 'demo' | 'usb' | 'wifi' | 'bluetooth' | 'disconnected'; connected: boolean; label: string; battery: number | null; firmware: string | null }
