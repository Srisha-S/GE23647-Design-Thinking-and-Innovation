import { Capacitor } from '@capacitor/core';

/** Android WebViews need a native file/share path instead of a download anchor. */
export async function exportLibraryFile(contents: string, kind: 'library' | 'colour' | 'image-match' = 'library'): Promise<string> {
  const filename = `chroma-${kind}-${new Date().toISOString().slice(0, 10)}.json`;
  if (Capacitor.isNativePlatform()) {
    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import('@capacitor/filesystem'), import('@capacitor/share'),
    ]);
    const { uri } = await Filesystem.writeFile({
      path: filename, data: contents, directory: Directory.Cache, encoding: Encoding.UTF8,
    });
    await Share.share({ title: `CHROMA ${kind.replace('-', ' ')}`, files: [uri], dialogTitle: 'Save or share your CHROMA file' });
    return 'Backup ready. Choose where to save it in the share menu.';
  }
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return kind === 'library' ? 'Library and projects exported.' : 'Your CHROMA result was exported.';
}
