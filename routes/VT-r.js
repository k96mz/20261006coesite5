const express = require('express');
const router = express.Router();
const axios = require('axios');
const NodeCache = require('node-cache');

const config = require('config');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { PMTiles } = require('pmtiles');

const gzip = promisify(zlib.gzip);

// config constants
const defaultZ = config.get('defaultZ');
const pmtilesDir = config.get('pmtilesDir');
const generateTokenUrl = config.get('generateTokenUrl');
const serverUrl = config.get('serverUrl');
const whiteList = config.get('whiteList');

// global variables
const pmtilesPool = {};
const tz = config.get('tz');
const sTileName = config.get('sTileName');
const projectRoot = path.resolve(__dirname, '..');

class LocalPMTilesSource {
  constructor(archivePath) {
    this.archivePath = archivePath;
    this.handlePromise = fs.promises.open(archivePath, 'r');
  }

  getKey() {
    return this.archivePath;
  }

  async getBytes(offset, length, signal) {
    if (signal?.aborted) {
      throw new Error('Tile request aborted.');
    }

    const handle = await this.handlePromise;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);

    return {
      data: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + bytesRead,
      ),
    };
  }
}

// Get tile functions
const getPMTiles = async (t, z, x, y) => {
  // ex. t = UniteStreetMapVector
  let pmtilesPathSmall = '';
  let pmtilesPath1 = '';
  let pmtilesPath2 = '';
  let pmtilesPath3 = '';

  if (!tz[t]) tz[t] = defaultZ;

  const tz2 = tz[t] - 1;
  const tz3 = tz[t] - 2;
  const tilesetDir = path.resolve(projectRoot, pmtilesDir, t);

  // if contour, there is no sTileName[t]
  if (sTileName[t]) {
    pmtilesPathSmall = path.join(tilesetDir, `${sTileName[t]}.pmtiles`);
  }

  if (z < tz[t]) {
    pmtilesPath1 = pmtilesPathSmall;
    pmtilesPath2 = pmtilesPathSmall;
    pmtilesPath3 = pmtilesPathSmall;
  } else {
    pmtilesPath1 = path.join(
      tilesetDir,
      `${tz[t]}-${x >> (z - tz[t])}-${y >> (z - tz[t])}.pmtiles`,
    );
    pmtilesPath2 = path.join(
      tilesetDir,
      `${tz2}-${x >> (z - tz2)}-${y >> (z - tz2)}.pmtiles`,
    );
    pmtilesPath3 = path.join(
      tilesetDir,
      `${tz3}-${x >> (z - tz3)}-${y >> (z - tz3)}.pmtiles`,
    );
  }

  const candidates = [
    ...new Set([pmtilesPath1, pmtilesPath2, pmtilesPath3].filter(Boolean)),
  ];
  // ex, pmtilesPath1 = /home/20260413coesite4PmtilesLocaltest/pmtiles/UniteStreetMapVector/6-35-31.pmtiles
  // pmtilesPath2 = /home/20260413coesite4PmtilesLocaltest/pmtiles/UniteStreetMapVector/5-17-15.pmtiles
  // pmtilesPath3 = /home/20260413coesite4PmtilesLocaltest/pmtiles/UniteStreetMapVector/4-8-7.pmtiles

  const cachedPath = candidates.find(candidate => pmtilesPool[candidate]);

  if (cachedPath) {
    return pmtilesPool[cachedPath];
  }

  const existingPath = candidates.find(candidate => fs.existsSync(candidate));

  if (existingPath) {
    pmtilesPool[existingPath] = {
      pmtiles: new PMTiles(new LocalPMTilesSource(existingPath)),
      // mtime of the .pmtiles file, used for the Last-Modified header
      lastModified: fs.statSync(existingPath).mtime.toUTCString(),
    };
    return pmtilesPool[existingPath];
  }

  throw new Error(`${candidates[0] || tilesetDir} was not found.`);
};

const getTile = async (pmtiles, z, x, y) => {
  try {
    const r = await pmtiles.getZxyAttempt(z, x, y);
    if (!r) return null;
    return {
      tile: Buffer.from(r.data),
    };
  } catch (err) {
    throw err;
  }
};

// Creating a token cache.
// stdTTL is the cache expiration time (in seconds).
// Expired data is cleaned up every 120 seconds.
const tokenCache = new NodeCache({ stdTTL: 30, checkperiod: 120 });
const tokenIPSet = new Set(); // To record IP
const ipTimeoutMap = new Map(); // IP -> Timeout ID

function addOrRefreshIP(ip, ttlMs = 60 * 1000) {
  if (!ip) return;

  // If the IP is registered, remove it.
  if (ipTimeoutMap.has(ip)) {
    clearTimeout(ipTimeoutMap.get(ip));
  }

  // Adding IP to Set
  tokenIPSet.add(ip);

  const timeoutId = setTimeout(() => {
    tokenIPSet.delete(ip);
    ipTimeoutMap.delete(ip);
  }, ttlMs);

  // Save in Map for future updates.
  ipTimeoutMap.set(ip, timeoutId);
}

function getClientIP(req) {
  const rawIP = req.socket?.remoteAddress;

  if (typeof rawIP === 'string' && rawIP.startsWith('::ffff:')) {
    return rawIP.replace(/^::ffff:/, '');
  }

  return rawIP;
}

async function validateToken(token, clientIP) {
  let isTokenValid = false;

  // Only if a token exists, the following code checks its validity.
  if (!token) return isTokenValid;

  // 1. First, check if there is valid token information in the cache.
  if (tokenCache.has(token)) {
    isTokenValid = tokenCache.get(token);
    if (isTokenValid) addOrRefreshIP(clientIP);
    return isTokenValid;
  }

  // 2. If not found in cache, check via API as usual.
  let cleanedToken = token;
  const parts = token.split('?token=');
  if (parts.length > 1 && parts[0] === parts[1]) {
    cleanedToken = parts[0];
  }

  // const generateTokenUrl =
  //   'https://dev-geoportal.dfs.un.org/arcgis/sharing/rest/generateToken';
  const params = new URLSearchParams({
    token: cleanedToken,
    // serverUrl: 'https://dev-geoportal.dfs.un.org/unvt/rest/services',
    serverUrl: serverUrl,
    f: 'json',
  }).toString();
  const fullUrl = `${generateTokenUrl}?${params}`;

  try {
    const response = await axios.get(fullUrl);
    if (response.data && !response.data.error) {
      isTokenValid = true;
      addOrRefreshIP(clientIP);
    }
  } catch (error) {
    isTokenValid = false;
  }

  // 3. Save the validation result from the API to the cache.
  tokenCache.set(token, isTokenValid);
  return isTokenValid;
}

function validateTileRequest(t, z, x, y, res) {
  // Input validation - Security enhancement to prevent path traversal and invalid tile requests
  // Restrict tileset name to alphanumeric characters, hyphens, and underscores only
  if (!t || typeof t !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(t)) {
    res.status(400).send('Invalid tileset name');
    return false;
  }
  // Validate zoom level within reasonable bounds (0-30) to prevent resource exhaustion
  if (isNaN(z) || z < 0 || z > 30) {
    res.status(400).send('Invalid zoom level');
    return false;
  }
  // Validate X coordinate is within valid range for the zoom level
  if (isNaN(x) || x < 0 || x >= Math.pow(2, z)) {
    res.status(400).send('Invalid x coordinate');
    return false;
  }
  // Validate Y coordinate is within valid range for the zoom level
  if (isNaN(y) || y < 0 || y >= Math.pow(2, z)) {
    res.status(400).send('Invalid y coordinate');
    return false;
  }

  return true;
}

/* GET Tile. */
router.get(`/zxy/:t/:z/:x/:y.pbf`, async function (req, res) {
  try {
    const t = req.params.t;
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);

    if (!validateTileRequest(t, z, x, y, res)) return;

    const clientIP = getClientIP(req);
    const token = req.query?.token || null;
    const isTokenValid = await validateToken(token, clientIP);

    // if (!req.session.userId) {
    // const whiteList = [
    //   // 'https://ubukawa.github.io/cors-cookie',
    //   'https://dev-geoportal.dfs.un.org/',
    // ];
    const noSession = !req.session?.userId;
    const invalidReferer = !(
      req.headers.referer &&
      whiteList.some(value => req.headers.referer.includes(value))
    );
    const invalidToken = !(token && isTokenValid);
    const ipAllowed = !token && tokenIPSet.has(clientIP);

    if (noSession && invalidReferer && invalidToken && !ipAllowed) {
      // Redirect unauthenticated requests to home page
      // res.redirect('/')
      res
        .status(401)
        .send(`Please log in to get: /zxy/${t}/${z}/${x}/${y}.pbf`);
      return;
    }

    const { pmtiles, lastModified } = await getPMTiles(t, z, x, y);
    const r = await getTile(pmtiles, z, x, y);

    if (r && r.tile) {
      res.set('content-type', 'application/vnd.mapbox-vector-tile');

      if (lastModified) {
        res.set('last-modified', lastModified);
      }

      // pmtiles returns decompressed tiles, so re-compress them (same as the MBTiles version)
      res.set('content-encoding', 'gzip');
      res.send(await gzip(r.tile));
    } else {
      throw new Error(`tile not found: /zxy/${t}/${z}/${x}/${y}.pbf`);
    }
  } catch (err) {
    res.status(404).send(err.message);
  }
});

module.exports = router;
