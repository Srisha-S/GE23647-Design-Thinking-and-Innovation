import { runBluetoothTests } from './test-bluetooth.mjs';

const result = await runBluetoothTests();
console.log(`${result.passed} Bluetooth transport checks passed (mocked hardware).`);
