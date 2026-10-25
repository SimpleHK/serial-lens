import * as path from 'node:path';

import Mocha from 'mocha';

/**
 * Entry point handed to @vscode/test-electron via --extensionTestsPath.
 * Sets up the tdd-UI mocha runner and loads the compiled suite next to it.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  mocha.addFile(path.join(__dirname, 'suite.js'));
  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} integration test(s) failed`));
        } else {
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
