function shouldUseKioskMode({ argv = process.argv, env = process.env } = {}) {
  if (env.SURF_ACE_KIOSK === '1') {
    return true;
  }
  return Array.isArray(argv) && argv.includes('--kiosk');
}

function buildMainWindowOptions({ kioskMode, preloadPath }) {
  const base = {
    backgroundColor: '#f5f5f2',
    height: 900,
    webPreferences: {
      preload: preloadPath
    },
    width: 1440
  };

  if (!kioskMode) {
    return base;
  }

  return {
    ...base,
    autoHideMenuBar: true,
    frame: false,
    fullscreen: true,
    kiosk: true
  };
}

module.exports = {
  buildMainWindowOptions,
  shouldUseKioskMode
};
