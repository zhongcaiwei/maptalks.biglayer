'use strict';

var maptalks = require('maptalks'),
    glMatrix = require('gl-matrix'),
    shaders = require('../shader/Shader'),
    LinePainter = require('../painter/LinePainter'),
    LineAtlas = require('../painter/LineAtlas'),

    BigDataLayer = require('./BigDataLayer');

var vec2 = glMatrix.vec2,
    mat2 = glMatrix.mat2;

var BigLineLayer = module.exports = BigDataLayer.extend({
    options : {
        'blur' : 2
    }

});


var defaultSymbol = {
    'lineWidth' : 12,
    'lineOpacity' : 1,
    'lineColor' : 'rgb(0, 0, 0)',
    'lineDasharray' : [20, 10, 30, 20]
};

BigLineLayer.registerRenderer('webgl', maptalks.renderer.WebGL.extend({

    initialize: function (layer) {
        this.layer = layer;
        this._needCheckStyle = true;
        this._needCheckSprites = true;
        this._registerEvents();
    },

    checkResources:function () {
        if (!this._needCheckStyle) {
            return null;
        }

        var resources = [];
        if (this.layer._cookedStyles) {
            this.layer._cookedStyles.forEach(function (s) {
                s['symbol'] = maptalks.Util.convertResourceUrl(s['symbol']);
                var res = maptalks.Util.getExternalResources(s['symbol'], true);
                if (res) {
                    resources = resources.concat(res);
                }
            });
        }


        this._needCheckStyle = false;

        this._needCheckSprites = true;

        if (resources.length === 0) {
            resources = null;
        }

        return resources;
    },

    onCanvasCreate: function () {
        var gl = this.context;
        var uniforms = ['u_matrix', 'u_scale', 'u_spritesize', 'u_blur'];
        var program = this.createProgram(shaders.line.vertexSource, shaders.line.fragmentSource, uniforms);
        this.useProgram(program);
    },

    draw: function () {
        console.time('draw lines');
        this.prepareCanvas();
        this._checkSprites();
        var gl = this.context,
            map = this.getMap();
        var data = this.layer.data, sprite;
        if (!this._lineArrays) {
            var texCoords = [];
            var painter = new LinePainter(gl, map),
                n, symbol;
            for (var i = 0, l = data.length; i < l; i++) {
                symbol = this._getLineSymbol(data[i][1]);
                painter.addLine(data[i][0], symbol);
            }
            // TODO 处理纹理坐标
            var lineArrays = painter.getArrays();

            this._bufferData(lineArrays);

            this._elementCount = lineArrays.elementArray.length;

            console.log('lineArrays', lineArrays);
        }

        this._drawLines();
        console.timeEnd('draw lines');
        this.completeRender();
    },

    onRemove: function () {
        this._removeEvents();
        delete this._sprites;
        delete this._lineArrays;
        maptalks.renderer.WebGL.prototype.onRemove.apply(this, arguments);
    },

    _bufferData: function (lineArrays) {
        var gl = this.context;
        //buffer vertex data
        var vertexBuffer = this.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        this.enableVertexAttrib(
            ['a_pos', 2, 'FLOAT']
        );
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineArrays.vertexArray), gl.STATIC_DRAW);

        //buffer normal data
        var normalBuffer = this.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
        this.enableVertexAttrib([
            ['a_corner', 1, 'FLOAT'],
            ['a_linenormal', 2, 'FLOAT'],
            ['a_normal', 2, 'FLOAT'],
            ['a_linesofar', 1, 'FLOAT']
        ]
        );
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineArrays.normalArray), gl.STATIC_DRAW);

        //texture coordinates
        var texBuffer = this.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
        this.enableVertexAttrib([
            ['a_texcoord', 4, 'FLOAT'],
            ['a_opacity', 1, 'FLOAT'],
            ['a_linewidth', 1, 'FLOAT']
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineArrays.styleArray), gl.STATIC_DRAW);

        // release binded buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        //buffer element data
        var elementBuffer = this.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(lineArrays.elementArray), gl.STATIC_DRAW);
    },

    _checkSprites: function () {
        if (!this._needCheckSprites) {
            return;
        }
        var me = this;
        this._atlas = new LineAtlas(this.resources);
        var resources = this.resources;
        var sprites = [];
        if (this.layer._cookedStyles) {
            this.layer._cookedStyles.forEach(function (s) {
                var sprite = me._atlas.getAtlas(s.symbol, false);
                if (sprite) {
                    sprites.push(sprite);
                }
            });
        }

        this._sprites = this.mergeSprites(sprites);

        if (this._sprites && typeof(window) != 'undefined' && window.MAPTALKS_WEBGL_DEBUG_CANVAS) {
            var debugCanvas = window.MAPTALKS_WEBGL_DEBUG_CANVAS;
            debugCanvas.getContext('2d').fillRect(0, 0, debugCanvas.width, debugCanvas.height);
            debugCanvas.getContext('2d').fillStyle = 'rgb(255, 255, 255)';
            debugCanvas.getContext('2d').fillRect(0, 0, this._sprites.canvas.width, this._sprites.canvas.height);
            debugCanvas.getContext('2d').drawImage(this._sprites.canvas, 0, 0);
        }

        this._needCheckSprites = false;

        if (this._sprites && !this._textureLoaded) {
            this.loadTexture(this._sprites.canvas);
            this.enableSampler('u_image');
            this._textureLoaded = true;
        }
    },

    _getLineSymbol: function (props) {
        var count = -1,
            style, texture;
        for (var i = 0, len = this.layer._cookedStyles.length; i < len; i++) {
            style = this.layer._cookedStyles[i];
            texture = this._atlas.getAtlas(style.symbol);
            if (texture) {
                count++;
            }
            if (style.filter(props) === true) {
                if (texture) {
                    return {
                        'symbol' : style.symbol,
                        'texCoord' : this._sprites.texCoords[count]
                    };
                } else {
                    return {
                        'symbol' : style.symbol
                    };
                }

            }
        }
        return null;
    },

    _drawLines: function () {
        var gl = this.context,
            map = this.getMap(),
            program = gl.program;

        var symbol = defaultSymbol;

        var m = this.calcMatrices();
        gl.uniformMatrix4fv(gl.program.u_matrix, false, m);
        gl.uniform1f(program.u_scale, map.getScale());
        // gl.uniform1f(program.u_linewidth, symbol['lineWidth'] / 2);
        // var color = Color(symbol['lineColor']).rgbaArray().map(function (c, i) { if (i===3) { return c; } else {return c / 255;}});
        // gl.uniform4fv(program.u_color, new Float32Array(color));
        // gl.uniform1f(program.u_opacity, symbol['lineOpacity']);
        gl.uniform1f(program.u_blur, this.layer.options['blur']);
        var spriteSize = [0, 0];
        if (this._sprites) {
            spriteSize = [this._sprites.canvas.width, this._sprites.canvas.height];
        }
        console.log(spriteSize);
        gl.uniform2fv(program.u_spritesize, new Float32Array(spriteSize));
        gl.drawElements(gl.TRIANGLES, this._elementCount, gl.UNSIGNED_SHORT, 0);
    },

    _registerEvents: function () {
        this.layer.on('setstyle', this._onStyleChanged, this);
    },

    _removeEvents: function () {
        this.layer.off('setstyle', this._onStyleChanged, this);
    },

    _onStyleChanged: function () {
        this._needCheckStyle = true;
    }
}));