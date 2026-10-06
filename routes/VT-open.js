const express = require('express');
const router = express.Router();
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

/* GET Tile. */
router.get(`/zxy/:t/:z/:x/:y.pbf`, async function (req, res) {
  try {
    const t = req.params.t;
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);

    // Input validation - Security enhancement to prevent path traversal and invalid tile requests
    // Restrict tileset name to alphanumeric characters, hyphens, and underscores only
    if (!t || typeof t !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(t)) {
      res.status(400).send('Invalid tileset name');
      return;
    }
    // Validate zoom level within reasonable bounds (0-30) to prevent resource exhaustion
    if (isNaN(z) || z < 0 || z > 30) {
      res.status(400).send('Invalid zoom level');
      return;
    }
    // Validate X coordinate is within valid range for the zoom level
    if (isNaN(x) || x < 0 || x >= Math.pow(2, z)) {
      res.status(400).send('Invalid x coordinate');
      return;
    }
    // Validate Y coordinate is within valid range for the zoom level
    if (isNaN(y) || y < 0 || y >= Math.pow(2, z)) {
      res.status(400).send('Invalid y coordinate');
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
