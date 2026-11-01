import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.chroma.app',
  appName: 'CHROMA Studio',
  webDir: 'dist',
  // Bundled local assets only: no remote development server in the APK.
  // HTTP localhost keeps the existing local ws:// ESP32 prototype usable.
  server: { androidScheme: 'http', cleartext: true },
  android: { backgroundColor: '#0158FF' },
};

export default config;
