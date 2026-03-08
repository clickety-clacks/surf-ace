const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { buildMainWindowOptions, shouldUseKioskMode } = require('../src/windowOptions');

const indexHtmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

test('STANDBY-E-01 standby UI includes screen name, status indicator, and fingerprint region', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');

  assert.match(html, /id="screen-name"/);
  assert.match(html, /id="screen-status"/);
  assert.match(html, /id="fingerprint"/);
});

test('STANDBY-E-02 standby markup has no clock/weather ambient widgets', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8').toLowerCase();

  assert.equal(html.includes('weather'), false);
  assert.equal(html.includes('clock'), false);
});

test('STANDBY-E-03 kiosk mode options are available on Electron', () => {
  assert.equal(shouldUseKioskMode({ argv: ['electron', 'src/main.js', '--kiosk'], env: {} }), true);
  assert.equal(shouldUseKioskMode({ argv: ['electron', 'src/main.js'], env: { SURF_ACE_KIOSK: '1' } }), true);

  const options = buildMainWindowOptions({
    kioskMode: true,
    preloadPath: '/tmp/preload.js'
  });

  assert.equal(options.kiosk, true);
  assert.equal(options.fullscreen, true);
  assert.equal(options.frame, false);
  assert.equal(options.autoHideMenuBar, true);
});
