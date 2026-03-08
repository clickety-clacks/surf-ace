const { spawn, spawnSync } = require('node:child_process');

function commandExists(command, spawnSyncFn = spawnSync) {
  const result = spawnSyncFn('which', [command], { stdio: 'ignore' });
  return result.status === 0;
}

class MdnsAdvertiser {
  constructor({
    logger,
    port,
    serviceName,
    txtRecordsProvider,
    systemDeps
  }) {
    this.logger = logger;
    this.port = port;
    this.serviceName = serviceName;
    this.txtRecordsProvider = txtRecordsProvider;
    this.systemDeps = {
      spawn,
      spawnSync,
      ...systemDeps
    };

    this.child = null;
    this.command = null;
  }

  start() {
    if (this.command || this.child) {
      return;
    }

    if (commandExists('avahi-publish-service', this.systemDeps.spawnSync)) {
      this.command = 'avahi-publish-service';
      this.child = this.#spawnAvahi();
      return;
    }

    if (commandExists('dns-sd', this.systemDeps.spawnSync)) {
      this.command = 'dns-sd';
      this.child = this.#spawnDnsSd();
      return;
    }

    this.logger.warn('No mDNS publisher found (expected avahi-publish-service or dns-sd).');
  }

  refresh() {
    if (!this.command) {
      this.start();
      return;
    }

    this.stop();
    this.start();
  }

  stop() {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.command = null;
  }

  #spawnAvahi() {
    const txt = this.#txtEntries();
    const child = this.systemDeps.spawn(
      'avahi-publish-service',
      [this.serviceName, '_surf-ace._tcp', String(this.port), ...txt],
      {
        stdio: 'ignore'
      }
    );

    child.on('exit', (code) => {
      if (code !== 0) {
        this.logger.warn(`avahi-publish-service exited with code ${code}`);
      }
    });

    return child;
  }

  #spawnDnsSd() {
    const txt = this.#txtEntries();
    const child = this.systemDeps.spawn(
      'dns-sd',
      ['-R', this.serviceName, '_surf-ace._tcp', 'local', String(this.port), ...txt],
      {
        stdio: 'ignore'
      }
    );

    child.on('exit', (code) => {
      if (code !== 0) {
        this.logger.warn(`dns-sd exited with code ${code}`);
      }
    });

    return child;
  }

  #txtEntries() {
    const txtRecords = this.txtRecordsProvider();
    return Object.entries(txtRecords).map(([key, value]) => `${key}=${value}`);
  }
}

module.exports = {
  MdnsAdvertiser
};
