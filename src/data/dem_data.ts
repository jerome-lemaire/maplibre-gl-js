import {RGBAImage} from '../util/image';

import {warnOnce} from '../util/util';
import {register} from '../util/web_worker_transfer';

// DEMData is a data structure for decoding, backfilling, and storing elevation data for processing in the hillshade shaders
// data can be populated either from a pngraw image tile or from serliazed data sent back from a worker. When data is initially
// loaded from a image tile, we decode the pixel values using the appropriate decoding formula, but we store the
// elevation data as an Int32 value. we add 65536 (2^16) to eliminate negative values and enable the use of
// integer overflow when creating the texture used in the hillshadePrepare step.

// DEMData also handles the backfilling of data from a tile's neighboring tiles. This is necessary because we use a pixel's 8
// surrounding pixel values to compute the slope at that pixel, and we cannot accurately calculate the slope at pixels on a
// tile's edge without backfilling from neighboring tiles.

export class DEMData {
    uid: string;
    data: Uint32Array;
    stride: number;
    dim: number;
    min: number;
    max: number;
    encoding: 'mapbox' | 'terrarium';

    // RGBAImage data has uniform 1px padding on all sides: square tile edge size defines stride
    // and dim is calculated as stride - 2.
    constructor(uid: string, data: RGBAImage, encoding: 'mapbox' | 'terrarium') {
        this.uid = uid;
        if (data.height !== data.width) throw new RangeError('DEM tiles must be square');
        if (encoding && encoding !== 'mapbox' && encoding !== 'terrarium') {
            warnOnce(`"${encoding}" is not a valid encoding type. Valid types include "mapbox" and "terrarium".`);
            return;
        }
        this.stride = data.height;
        const dim = this.dim = data.height - 2;
        this.data = new Uint32Array(data.data.buffer);
        this.encoding = encoding || 'mapbox';

        // in order to avoid flashing seams between tiles, here we are initially populating a 1px border of pixels around the image
        // with the data of the nearest pixel from the image. this data is eventually replaced when the tile's neighboring
        // tiles are loaded and the accurate data can be backfilled using DEMData#backfillBorder
        for (let x = 0; x < dim; x++) {
            // left vertical border
            this.data[this._idx(-1, x)] = this.data[this._idx(0, x)];
            // right vertical border
            this.data[this._idx(dim, x)] = this.data[this._idx(dim - 1, x)];
            // left horizontal border
            this.data[this._idx(x, -1)] = this.data[this._idx(x, 0)];
            // right horizontal border
            this.data[this._idx(x, dim)] = this.data[this._idx(x, dim - 1)];
        }
        // corners
        this.data[this._idx(-1, -1)] = this.data[this._idx(0, 0)];
        this.data[this._idx(dim, -1)] = this.data[this._idx(dim - 1, 0)];
        this.data[this._idx(-1, dim)] = this.data[this._idx(0, dim - 1)];
        this.data[this._idx(dim, dim)] = this.data[this._idx(dim - 1, dim - 1)];

        // calculate min/max values
        this.min = Number.MAX_SAFE_INTEGER;
        this.max = Number.MIN_SAFE_INTEGER;
        for (let x = 0; x < dim; x++) {
            for (let y = 0; y < dim; y++) {
                const ele = this.get(x, y);
                if (ele > this.max) this.max = ele;
                if (ele < this.min) this.min = ele;
            }
        }
    }

    get(x: number, y: number) {
        const pixels = new Uint8Array(this.data.buffer);
        const index = this._idx(x, y) * 4;
        const unpack = this.encoding === 'terrarium' ? this._unpackTerrarium : this._unpackMapbox;
        return unpack(pixels[index], pixels[index + 1], pixels[index + 2]);
    }

    getUnpackVector() {
        return this.encoding === 'terrarium' ? [256.0, 1.0, 1.0 / 256.0, 32768.0] : [6553.6, 25.6, 0.1, 10000.0];
    }

    _idx(x: number, y: number) {
        if (x < -1 || x >= this.dim + 1 ||  y < -1 || y >= this.dim + 1) throw new RangeError('out of range source coordinates for DEM data');
        return (y + 1) * this.stride + (x + 1);
    }

    _unpackMapbox(r: number, g: number, b: number) {
        // unpacking formula for mapbox.terrain-rgb:
        // https://www.mapbox.com/help/access-elevation-data/#mapbox-terrain-rgb
        return ((r * 256 * 256 + g * 256.0 + b) / 10.0 - 10000.0);
    }

    _unpackTerrarium(r: number, g: number, b: number) {
        // unpacking formula for mapzen terrarium:
        // https://aws.amazon.com/public-datasets/terrain/
        return ((r * 256 + g + b / 256) - 32768.0);
    }

    getPixels() {
        return new RGBAImage({width: this.stride, height: this.stride}, new Uint8Array(this.data.buffer));
    }

    backfillBorder(borderTile: DEMData, dx: number, dy: number) {
        if (this.dim !== borderTile.dim) throw new Error('dem dimension mismatch');

        let xMin = dx * this.dim,
            xMax = dx * this.dim + this.dim,
            yMin = dy * this.dim,
            yMax = dy * this.dim + this.dim;

        switch (dx) {
            case -1:
                xMin = xMax - 1;
                break;
            case 1:
                xMax = xMin + 1;
                break;
        }

        switch (dy) {
            case -1:
                yMin = yMax - 1;
                break;
            case 1:
                yMax = yMin + 1;
                break;
        }

        const ox = -dx * this.dim;
        const oy = -dy * this.dim;
        for (let y = yMin; y < yMax; y++) {
            for (let x = xMin; x < xMax; x++) {
                this.data[this._idx(x, y)] = borderTile.data[this._idx(x + ox, y + oy)];
            }
        }
    }
}

register('DEMData', DEMData);
