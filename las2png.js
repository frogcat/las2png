#!/usr/bin/env node

const fs = require("fs");
const LasStreamReader = require('LasStreamReader').LasStreamReader;
const PNG = require("pngjs").PNG;
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');

const optionDefinitions = [{
  name: 'zoom',
  alias: 'z',
  type: String,
  typeLabel: '{underline zoom_levels}',
  description: 'comma separated value of output zoom levels (default "15,16,17,18")',
  defaultValue: "15-18"
}, {
  name: 'epsg-datum',
  alias: 'e',
  type: String,
  typeLabel: '{underline string}',
  description: 'EPSG code for input las files (default "")',
  defaultValue: "2450"
}, {
  name: 'files',
  alias: 'f',
  type: String,
  multiple: true,
  defaultOption: true,
  typeLabel: '{underline file} ...',
  description: 'input las files (required)'
}, {
  name: 'directory',
  alias: 'd',
  type: String,
  typeLabel: '{underline path}',
  description: 'output directory (default ".")',
  defaultValue: '.'
}];

const options = commandLineArgs(optionDefinitions);
const zoom = [];
options["zoom"].split(",").forEach(a => {
  if (a.match(/^([0-9]+)-([0-9]+)$/)) {
    const i = parseInt(RegExp.$1);
    const j = parseInt(RegExp.$2);
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++)
      if (zoom.indexOf(k) === -1) zoom.push(k);
  } else if (a.match(/^[0-9]+$/)) {
    const k = parseInt(a);
    if (zoom.indexOf(k) === -1) zoom.push(k);
  }
});
const epsgDatum = options["epsg-datum"];
const files = options["files"];
const directory = options["directory"];

if (!files || files.length === 0) {
  const sections = [{
    header: 'las2png',
    content: 'Generate Mapbox Terrain-RGB from LAS files'
  }, {
    header: 'Options',
    optionList: optionDefinitions
  }, {
    header: 'Example',
    content: '$ node las2png.js -z 15,16,17,18 -e 2450 -d tmp -f *.las'
  }]
  const usage = commandLineUsage(sections)
  console.log(usage)
  process.exit(1);
}

class Tile {
  constructor() {
    this.png = new PNG({
      width: 256,
      height: 256
    });
    for (let i = 0; i < 0x40000; i += 4)
      this.png.data.writeUInt32BE(0x00000000, i);
  }
  put(x, y, alt) {
    if (x < 0 || x > 0xff || y < 0 || y > 0xff) return;
    const index = y * 0x400 + x * 4;
    const next = (Math.floor((alt + 10000) * 10) << 8) + 0xff;
    const prev = this.png.data.readUInt32BE(index);
    if (0 <= next && next <= 0xffffffff && (prev === 0 || next < prev)) {
      this.png.data.writeUInt32BE(next, index);
    }
  }
}

const ll2xy = function(lon, lat, z) {
  const r = lat * Math.PI / 180
  const n = Math.pow(2, z);
  return {
    x: Math.floor(n * ((lon + 180) / 360)),
    y: Math.floor(n * (1 - (Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI)) / 2)
  };
};

const bounds = [180, 90, -180, -90];

function read(file, target) {
  let count = 0;
  return new Promise(resolve => {
    fs.createReadStream(file).pipe(new LasStreamReader({
      transform_lnglat: true,
      projection: {
        epsg_datum: epsgDatum
      }
    }).on("data", data => {
      data.filter(a => a.lng_lat).forEach(a => {
        count++;
        if (count % 100000 === 0) process.stdout.write(".");
        const lng = a.lng_lat[0];
        const lat = a.lng_lat[1];
        const alt = a.elevation;
        bounds[0] = Math.min(bounds[0], lng);
        bounds[1] = Math.min(bounds[1], lat);
        bounds[2] = Math.max(bounds[2], lng);
        bounds[3] = Math.max(bounds[3], lat);
        zoom.forEach(z => {
          const xy = ll2xy(lng, lat, z + 8);
          const x = Math.floor(xy.x / 256);
          const y = Math.floor(xy.y / 256);
          let f = target;
          f = f[z] || (f[z] = {});
          f = f[x] || (f[x] = {});
          f = f[y] || (f[y] = new Tile());
          f.put(xy.x % 256, xy.y % 256, alt);
        });
      });
    }).on("end", () => {
      resolve(count);
    }));
  })
}

(async function() {

  const tree = {};

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    process.stdout.write(`[${i+1}/${files.length}] reading ${file} `);
    const count = await read(file, tree);
    process.stdout.write(` ${count} points\n`);
  }

  const tilejson = {
    "tilejson": "2.2.0",
    "scheme": "xyz",
    "tiles": [
      "./{z}/{x}/{y}.png"
    ],
    "minzoom": zoom.reduce((a, b) => Math.min(a, b)),
    "maxzoom": zoom.reduce((a, b) => Math.max(a, b)),
    "bounds": bounds
  };

  fs.writeFileSync(directory + "/tilejson.json", JSON.stringify(tilejson, null, 2), "UTF-8");

  Object.keys(tree).forEach(z => {
    Object.keys(tree[z]).forEach(tx => {
      Object.keys(tree[z][tx]).forEach(ty => {
        const dem = tree[z][tx][ty];
        let path = directory.replace(/[/]+$/, "");
        if (!fs.existsSync(path)) fs.mkdirSync(path);
        path += ("/" + z);
        if (!fs.existsSync(path)) fs.mkdirSync(path);
        path += ("/" + tx);
        if (!fs.existsSync(path)) fs.mkdirSync(path);
        path += ("/" + ty + ".png");
        console.log(`wrote ${path}`);
        dem.png.pack().pipe(fs.createWriteStream(path));
      });
    });
  });

})();
