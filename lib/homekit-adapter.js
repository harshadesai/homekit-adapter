/**
 * HomeKit adapter for Mozilla WebThings Gateway.
 */
'use strict';

const {Adapter} = require('gateway-addon');
const {BLEDiscovery, IPDiscovery} = require('hap-controller');
const HomeKitDatabase = require('./homekit-database');
const HomeKitDevice = require('./homekit-device');
const manifest = require('../manifest.json');
const noble = require('@abandonware/noble');

/**
 * Adapter for HomeKit devices.
 */
class HomeKitAdapter extends Adapter {
  /**
   * Initialize the object.
   *
   * @param {Object} addonManager - AddonManagerProxy object
   */
  constructor(addonManager) {
    super(addonManager, manifest.id, manifest.id);
    addonManager.addAdapter(this);

    this.currentBLEOperation = Promise.resolve();
    this.queuedOperations = 0;
    this.knownDevices = new Set();

    this.db = new HomeKitDatabase(this.packageName);
    this.db.open().then(() => {
      return this.db.loadConfig();
    }).then((config) => {
      this.config = config;

      this.startIPDiscovery();

      // previous default was enable, so keep it
      if (!this.config.hasOwnProperty('enableBluetooth') ||
          this.config.enableBluetooth) {
        this.startBLEDiscovery();
        noble.on('warning', (e) => console.warn('noble warning:', e));
      }
    }).catch(console.error);
  }

  /**
   * Queue a BLE operation. noble apparently doesn't like operating on more
   * than one device at a time, so we have to queue them up.
   *
   * @param {function} op - Function to add to the queue
   * @returns {Promise} Promise which resolves when the function is called.
   */
  queueBLEOperation(op) {
    this.queuedOperations++;

    const ret = new Promise((resolve, reject) => {
      this.currentBLEOperation.then(() => {
        if (this.bleDiscovery) {
          this.bleDiscovery.stop();
        }

        op().then(() => {
          if (--this.queuedOperations === 0) {
            if (this.bleDiscovery) {
              this.bleDiscovery.start(true);
            }
          }

          resolve.call(arguments);
        }, () => {
          if (--this.queuedOperations === 0) {
            if (this.bleDiscovery) {
              this.bleDiscovery.start(true);
            }
          }

          reject.call(arguments);
        });
      });
    });

    this.currentBLEOperation = ret.catch(() => {});
    return ret;
  }

  /**
   * Set the PIN for the given device.
   *
   * @param {string} deviceId - ID of device
   * @param {string} pin - PIN to set
   * @returns {Promise} Promise which resolves when the PIN has been set.
   */
  setPin(deviceId, pin) {
    const device = this.getDevice(deviceId);
    if (!device) {
      return Promise.reject('Device not found');
    }

    if (device.paired) {
      return Promise.reject('Device already paired');
    }

    if (/^\d{8}$/.test(pin)) {
      pin = `${pin.substr(0, 3)}-${pin.substr(3, 2)}-${pin.substr(5, 3)}`;
    }

    const invalidCodes = [
      // '000-00-000' is also invalid, be we use that for split-pairing
      '111-11-111',
      '222-22-222',
      '333-33-333',
      '444-44-444',
      '555-55-555',
      '666-66-666',
      '777-77-777',
      '888-88-888',
      '999-99-999',
      '123-45-678',
      '876-54-321',
    ];

    if (invalidCodes.includes(pin)) {
      return Promise.reject('Invalid PIN');
    }

    return device.pair(pin);
  }

  /**
   * Unpair a device with the adapter.
   *
   * @param {Object} device - Device to unpair
   * @returns {Promise} Promise which resolves to the device removed.
   */
  removeThing(device) {
    let promise;

    if (device.paired) {
      if (device.bridge) {
        device.bridge.removeDevice(device);
        promise = Promise.resolve();
      } else {
        promise = device.unpair().then(() => {
          return this.db.removePairingData(device.deviceID);
        });
      }
    } else {
      promise = Promise.resolve();
    }

    return promise.then(() => {
      this.knownDevices.delete(device.deviceID);
      this.handleDeviceRemoved(device);
    });
  }

  /**
   * Add a discovered IP device.
   *
   * @param {Object} service - The mDNS service record
   */
  addIPDevice(service) {
    const id = HomeKitDevice.getIdFromService(service, 'ip');

    if (!this.knownDevices.has(id)) {
      console.debug('Found IP device:', service);
      if (service.pv && service.pv.split('.')[0] !== '1') {
        console.info(`Not adding device. PV=${service.pv}`);
        return;
      }

      this.knownDevices.add(id);

      const device = new HomeKitDevice(this, 'ip', service);
      device.promise.then(() => {
        this.handleDeviceAdded(device);
      });
    }
  }

  /**
   * Add a discovered BLE device.
   *
   * @param {Object} service - The BLE advertisement data
   */
  addBLEDevice(service) {
    const id = HomeKitDevice.getIdFromService(service, 'ble');

    if (!this.knownDevices.has(id)) {
      const partial = {
        CoID: service.CoID,
        TY: service.TY,
        AIL: service.AIL,
        SF: service.SF,
        DeviceID: service.DeviceID,
        ACID: service.ACID,
        GSN: service.GSN,
        CN: service.CN,
        CV: service.CV,
      };

      console.debug('Found BLE device:', partial);
      if (service.CV !== 2) {
        console.info(`Not adding device. CV=${service.CV}`);
        return;
      }

      this.knownDevices.add(id);

      const device = new HomeKitDevice(this, 'ble', service);
      device.promise.then(() => {
        this.handleDeviceAdded(device);
      });
    } else {
      // There is a period of time where the device object is being built but
      // is not yet in the devices map.
      const device = this.devices[`homekit-${id}`];
      if (device && device.paired && device.gsn !== service.GSN) {
        device.triggerBLEUpdate(service.GSN);
      }
    }
  }

  /**
   * Start searching for IP devices.
   */
  startIPDiscovery() {
    this.ipDiscovery = new IPDiscovery();
    this.ipDiscovery.on('serviceUp', (service) => {
      this.addIPDevice(service);
    });
    this.ipDiscovery.start();
  }

  /**
   * Start searching for BLE devices.
   */
  startBLEDiscovery() {
    this.bleDiscovery = new BLEDiscovery();
    this.bleDiscovery.on('serviceUp', (service) => {
      this.addBLEDevice(service);
    });
    this.bleDiscovery.start(true);
  }

  /**
   * Clean up before shutting down this adapter.
   *
   * @returns {Promise} Promise which resolves when finished unloading.
   */
  unload() {
    if (this.ipDiscovery) {
      this.ipDiscovery.stop();
    }

    if (this.bleDiscovery) {
      this.bleDiscovery.stop();
    }

    return super.unload();
  }
}

module.exports = HomeKitAdapter;
