var path = require('path');
var Promise = require('promise');
var fs = require('co-fs');
var mkdirp = require('mkdirp');
var rmrf = require('rimraf');
var uuid = require('uuid');

var KEY_DELIMITER = '::';

function removeDir(directory) {
  return new Promise(function(accept, reject) {
    rmrf(directory, function (error) {
      if (error) return reject(error);
      accept(error);
    });
  });
}

function makeDir(directory) {
  return new Promise(function(accept, reject) {
    mkdirp(directory, function (error) {
      if (error) return reject(error);
      accept(error);
    });
  });
}

function sortInstanceIds(cache) {
  var instanceIds = Object.keys(cache);
  var sorted = instanceIds.sort(function (a, b) {
    if (cache[a].lastUsed < cache[b].lastUsed) return 1;
    if (cache[a].lastUsed > cache[b].lastUsed) return -1;

    return 0;
  });

  return sorted;
}

/**
Cache manager for volumes that can be reused between containers. Cached volumes
will be indexed based on timestamps and reused in the order of most recently used.

@constructor
@param {Object} configuration settings for the volume cache manager
*/
function VolumeCache(config) {
  this.rootCachePath = config.rootCachePath;
  this.log = config.log;
  this.cache = {};
  this.stats = config.stats;
}

VolumeCache.prototype = {
  /**
  Add a cached volume along with an optional instancePath.  Cached volume will
  be marked as not mounted until otherwise specified.

  @param {String} Name of the cached volume.
  @param {String} Option path for the cached volume.
  @return {Object} Cached volume instance that is not mounted.
  */
  add: function* (cacheName, instancePath) {
    var instanceId = uuid.v4()

    if (!instancePath) {
      var cachePath = path.join(this.rootCachePath, cacheName);
      instancePath = path.join(cachePath, instanceId);
    }

    if (!(yield fs.exists(instancePath))) {
      yield makeDir(instancePath);
    }

    var lastUsed = Date.now();

    this.cache[cacheName][instanceId] = {
      path: instancePath,
      mounted: false,
      lastUsed: lastUsed
    };

    // Create a cache key that can be used by consumers of the cache in the
    // forma of <cache name>::<instance id>
    var instance = {key: cacheName + KEY_DELIMITER + instanceId,
      path: instancePath,
      lastUsed: lastUsed
    };
    return instance;
  },

  /**
  Remove any unmounted volumes when diskspace threshold is reached. This will
  be called at each garbage collection interval.

  @param {Boolean} Disksapce threshold reached
  */
  clear: function* (exceedsDiskspaceThreshold) {
    if (!exceedsDiskspaceThreshold) {
      return;
    }
    for (var cacheName in this.cache) {
      for (var instance in this.cache[cacheName]) {
        if (this.cache[cacheName][instance].mounted) {
          continue;
        } else {
          var cacheKey = cacheName + KEY_DELIMITER + instance;
          var instancePath = this.cache[cacheName][instance].path;
          var statName = 'cache.volume.' + cacheName + '.instance_removed';
          yield this.stats.timeGen(statName, removeDir(instancePath));
          delete this.cache[cacheName][instance];
          this.log('cache volume removed',
            {key: cacheKey, path: instancePath});
        }
      }
    }
  },

  /**
  Begin tracking the particular volume cache and create the necessary
  local directories.

  @param {String} Name of the cached volume.
  */
  createCacheVolume: function* (cacheName) {
    var cachePath = path.join(this.rootCachePath, cacheName);
    this.cache[cacheName] = {};

    if(!(yield fs.exists(cachePath))) {
      yield makeDir(cachePath);
      var cacheDetails = {cacheName: cacheName, cachPath: cachePath};
      var statName = 'cache.volume.' + cacheName + '.created';
      this.stats.increment(statName);
      this.log('cache volume created', cacheDetails);
    }
  },

  /**
  Get the instance for the particular cached volume.  If no instance that is not
  mounted exists, a new one will be created.

  @param {String} Name of the cached volume.
  @return {Object} Cached volume instance.
  */
  get: function* (cacheName) {
    if (cacheName.indexOf(KEY_DELIMITER) !== -1) {
      throw new Error('Invalid key name was provided.  Ensure that the cache ' +
        'name does not contain "' + KEY_DELIMITER + '".');
    }

    var instanceId;

    if (!this.cache[cacheName]) {
      yield this.createCacheVolume(cacheName);
    } else {
      var instanceIds = sortInstanceIds(this.cache[cacheName]);
      for (var i = 0; i < instanceIds.length; i++) {
        var id = instanceIds[i];
        if (!this.cache[cacheName][id].mounted) {
          instanceId = id;
          this.cache[cacheName][id].mounted = true;
          this.cache[cacheName][id].lastUsed = Date.now();
          break;
        }
      }
    }

    var instance;
    var logMessage = '';

    if (!instanceId) {
      logMessage = 'cache volume miss';
      instance = yield this.add(cacheName);
      this.set(instance.key, {mounted: true});
      var statName = 'cache.volume.' + cacheName + '.miss';
      this.stats.increment(statName);
    } else {
      logMessage = 'cache volume hit';
      instance = {key: cacheName + KEY_DELIMITER + instanceId,
        path: this.cache[cacheName][instanceId].path,
        lastUsed: this.cache[cacheName][instanceId].lastUsed
      };
      var statName = 'cache.volume.' + cacheName + '.hit';
      this.stats.increment(statName);
    }
    this.log(logMessage, instance);
    return instance;
  },

  /**
  Release the claim on a cached volume.  Cached volume should only be released
  once a container has been completed removed. Local cached volume will remain
  on the filesystem to be used by the next container/task.

  @param {String} Cache key int he format of <cache name>::<instance id>
  */
  release: function* (cacheKey) {
    this.set(cacheKey, {mounted: false, lastUsed: Date.now()})
    this.log("cache volume release", {key: cacheKey});
  },

  /**
  Set a property for a cached volume.

  @param {String} Cache key int he format of <cache name>::<instance id>
  @param {Object} Key name and value for the property to be set.
  */
  set: function (cacheKey, value) {
    var cacheName = cacheKey.split(KEY_DELIMITER)[0];
    var instanceId = cacheKey.split(KEY_DELIMITER)[1];
    for (var key in value) {
      this.cache[cacheName][instanceId][key] = value[key];
    }
  }
};

module.exports = VolumeCache;
