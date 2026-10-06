const express = require('express');
const router = express.Router();
const fs = require('node:fs');
const path = require('node:path');
const { PMTiles } = require('pmtiles');

// config constants
const rgbElevDir = 'rgbElev';

// global variables
const pmtilesPool = {};
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

//Get tile functions
const getPMTiles = async (z, x, y) => {
  let pmtilesPath = '';
  const tilesetDir = path.resolve(projectRoot, rgbElevDir);

  if (z < 6) {
    pmtilesPath = `${tilesetDir}/0-0-0.pmtiles`;
  } else {
    pmtilesPath = `${tilesetDir}/6-${x >> (z - 6)}-${y >> (z - 6)}.pmtiles`;
  }

  if (pmtilesPool[pmtilesPath]) return pmtilesPool[pmtilesPath];

  if (fs.existsSync(pmtilesPath)) {
    pmtilesPool[pmtilesPath] = {
      pmtiles: new PMTiles(new LocalPMTilesSource(pmtilesPath)),
      // mtime of the .pmtiles file, used for the Last-Modified header
      lastModified: fs.statSync(pmtilesPath).mtime.toUTCString(),
    };
    return pmtilesPool[pmtilesPath];
  }
  throw new Error(`${pmtilesPath || tilesetDir} was not found.`);
};

const getTile = async (pmtiles, z, x, y) => {
  const r = await pmtiles.getZxyAttempt(z, x, y);
  if (!r) return null;
  return {
    tile: Buffer.from(r.data),
  };
};

/* GET Tile. */
router.get(`/zxy/:z/:x/:y.png`, async function (req, res) {
  try {
    const z = parseInt(req.params.z, 10);
    const x = parseInt(req.params.x, 10);
    const y = parseInt(req.params.y, 10);

    // Input validation - Security enhancement to prevent path traversal and invalid tile requests
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

    const { pmtiles, lastModified } = await getPMTiles(z, x, y);
    const r = await getTile(pmtiles, z, x, y);

    if (r && r.tile) {
      res.set('content-type', 'image/png');

      if (lastModified) {
        res.set('last-modified', lastModified);
      }

      res.send(r.tile);
    } else {
      throw new Error(`tile not found: /zxy/${z}/${x}/${y}.png`);
    }
  } catch (err) {
    res.status(404).send(err.message);
  }
});

module.exports = router;
