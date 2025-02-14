/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { createProgram, expandFloat32Array, PROJECTION_MATRIX } from './WebglUtils';
import { IRenderModel, IWebGLVertexArrayObject, IWebGL2RenderingContext, ISelectionRenderModel } from './Types';
import { fill } from 'common/TypedArrayUtils';
import { INVERTED_DEFAULT_COLOR } from 'browser/renderer/atlas/Constants';
import { is256Color } from './atlas/CharAtlasUtils';
import { DEFAULT_COLOR } from 'common/buffer/Constants';
import { Terminal } from 'xterm';
import { IColorSet, IColor } from 'browser/Types';
import { IRenderDimensions } from 'browser/renderer/Types';

const enum VertexAttribLocations {
  POSITION = 0,
  SIZE = 1,
  COLOR = 2,
  UNIT_QUAD = 3
}

const vertexShaderSource = `#version 300 es
layout (location = ${VertexAttribLocations.POSITION}) in vec2 a_position;
layout (location = ${VertexAttribLocations.SIZE}) in vec2 a_size;
layout (location = ${VertexAttribLocations.COLOR}) in vec3 a_color;
layout (location = ${VertexAttribLocations.UNIT_QUAD}) in vec2 a_unitquad;

uniform mat4 u_projection;
uniform vec2 u_resolution;

out vec3 v_color;

void main() {
  vec2 zeroToOne = (a_position + (a_unitquad * a_size)) / u_resolution;
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_color = a_color;
}`;

const fragmentShaderSource = `#version 300 es
precision lowp float;

in vec3 v_color;

out vec4 outColor;

void main() {
  outColor = vec4(v_color, 1);
}`;

interface IVertices {
  attributes: Float32Array;
  selection: Float32Array;
  count: number;
}

const INDICES_PER_RECTANGLE = 8;
const BYTES_PER_RECTANGLE = INDICES_PER_RECTANGLE * Float32Array.BYTES_PER_ELEMENT;

const INITIAL_BUFFER_RECTANGLE_CAPACITY = 20 * INDICES_PER_RECTANGLE;

export class RectangleRenderer {

  private _program: WebGLProgram;
  private _vertexArrayObject: IWebGLVertexArrayObject;
  private _resolutionLocation: WebGLUniformLocation;
  private _attributesBuffer: WebGLBuffer;
  private _projectionLocation: WebGLUniformLocation;
  private _bgFloat: Float32Array;
  private _selectionFloat: Float32Array;

  private _vertices: IVertices = {
    count: 0,
    attributes: new Float32Array(INITIAL_BUFFER_RECTANGLE_CAPACITY),
    selection: new Float32Array(3 * INDICES_PER_RECTANGLE)
  };

  constructor(
    private _terminal: Terminal,
    private _colors: IColorSet,
    private _gl: IWebGL2RenderingContext,
    private _dimensions: IRenderDimensions
  ) {
    const gl = this._gl;

    this._program = createProgram(gl, vertexShaderSource, fragmentShaderSource);

    // Uniform locations
    this._resolutionLocation = gl.getUniformLocation(this._program, 'u_resolution');
    this._projectionLocation = gl.getUniformLocation(this._program, 'u_projection');

    // Create and set the vertex array object
    this._vertexArrayObject = gl.createVertexArray();
    gl.bindVertexArray(this._vertexArrayObject);

    // Setup a_unitquad, this defines the 4 vertices of a rectangle
    const unitQuadVertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const unitQuadVerticesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(VertexAttribLocations.UNIT_QUAD);
    gl.vertexAttribPointer(VertexAttribLocations.UNIT_QUAD, 2, this._gl.FLOAT, false, 0, 0);

    // Setup the unit quad element array buffer, this points to indices in
    // unitQuadVertuces to allow is to draw 2 triangles from the vertices
    const unitQuadElementIndices = new Uint8Array([0, 1, 3, 0, 2, 3]);
    const elementIndicesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, unitQuadElementIndices, gl.STATIC_DRAW);

    // Setup attributes
    this._attributesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.enableVertexAttribArray(VertexAttribLocations.POSITION);
    gl.vertexAttribPointer(VertexAttribLocations.POSITION, 2, gl.FLOAT, false, BYTES_PER_RECTANGLE, 0);
    gl.vertexAttribDivisor(VertexAttribLocations.POSITION, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.SIZE);
    gl.vertexAttribPointer(VertexAttribLocations.SIZE, 2, gl.FLOAT, false, BYTES_PER_RECTANGLE, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.SIZE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.COLOR);
    gl.vertexAttribPointer(VertexAttribLocations.COLOR, 4, gl.FLOAT, false, BYTES_PER_RECTANGLE, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.COLOR, 1);

    this._updateCachedColors();
  }

  public render(): void {
    const gl = this._gl;

    gl.useProgram(this._program);

    gl.bindVertexArray(this._vertexArrayObject);

    gl.uniformMatrix4fv(this._projectionLocation, false, PROJECTION_MATRIX);
    gl.uniform2f(this._resolutionLocation, gl.canvas.width, gl.canvas.height);

    // Bind attributes buffer and draw
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this._vertices.attributes, gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(this._gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, this._vertices.count);

    // Bind selection buffer and draw
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this._vertices.selection, gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(this._gl.TRIANGLES, 6, gl.UNSIGNED_BYTE, 0, 3);
  }

  public onResize(): void {
    this._updateViewportRectangle();
  }

  public setColors(): void {
    this._updateCachedColors();
    this._updateViewportRectangle();
  }

  private _updateCachedColors(): void {
    this._bgFloat = this._colorToFloat32Array(this._colors.background);
    this._selectionFloat = this._colorToFloat32Array(this._colors.selection);
  }

  private _updateViewportRectangle(): void {
    // Set first rectangle that clears the screen
    this._addRectangleFloat(
      this._vertices.attributes,
      0,
      0,
      0,
      this._terminal.cols * this._dimensions.scaledCellWidth,
      this._terminal.rows * this._dimensions.scaledCellHeight,
      this._bgFloat
    );
  }

  public updateSelection(model: ISelectionRenderModel, columnSelectMode: boolean): void {
    const terminal = this._terminal;

    if (!model.hasSelection) {
      fill(this._vertices.selection, 0, 0);
      return;
    }

    if (columnSelectMode) {
      const startCol = model.startCol;
      const width = model.endCol - startCol;
      const height = model.viewportCappedEndRow - model.viewportCappedStartRow + 1;
      this._addRectangleFloat(
        this._vertices.selection,
        0,
        startCol * this._dimensions.scaledCellWidth,
        model.viewportCappedStartRow * this._dimensions.scaledCellHeight,
        width * this._dimensions.scaledCellWidth,
        height * this._dimensions.scaledCellHeight,
        this._selectionFloat
      );
      fill(this._vertices.selection, 0, INDICES_PER_RECTANGLE);
    } else {
      // Draw first row
      const startCol = model.viewportStartRow === model.viewportCappedStartRow ? model.startCol : 0;
      const startRowEndCol = model.viewportCappedStartRow === model.viewportCappedEndRow ? model.endCol : terminal.cols;
      this._addRectangleFloat(
        this._vertices.selection,
        0,
        startCol * this._dimensions.scaledCellWidth,
        model.viewportCappedStartRow * this._dimensions.scaledCellHeight,
        (startRowEndCol - startCol) * this._dimensions.scaledCellWidth,
        this._dimensions.scaledCellHeight,
        this._selectionFloat
      );

      // Draw middle rows
      const middleRowsCount = Math.max(model.viewportCappedEndRow - model.viewportCappedStartRow - 1, 0);
      this._addRectangleFloat(
        this._vertices.selection,
        INDICES_PER_RECTANGLE,
        0,
        (model.viewportCappedStartRow + 1) * this._dimensions.scaledCellHeight,
        terminal.cols * this._dimensions.scaledCellWidth,
        middleRowsCount * this._dimensions.scaledCellHeight,
        this._selectionFloat
      );

      // Draw final row
      if (model.viewportCappedStartRow !== model.viewportCappedEndRow) {
        // Only draw viewportEndRow if it's not the same as viewportStartRow
        const endCol = model.viewportEndRow === model.viewportCappedEndRow ? model.endCol : terminal.cols;
        this._addRectangleFloat(
          this._vertices.selection,
          INDICES_PER_RECTANGLE * 2,
          0,
          model.viewportCappedEndRow * this._dimensions.scaledCellHeight,
          endCol * this._dimensions.scaledCellWidth,
          this._dimensions.scaledCellHeight,
          this._selectionFloat
        );
      } else {
        fill(this._vertices.selection, 0, INDICES_PER_RECTANGLE * 2);
      }
    }
  }

  public updateBackgrounds(model: IRenderModel): void {
    const terminal = this._terminal;
    const vertices = this._vertices;

    let rectangleCount = 1;

    for (let y = 0; y < terminal.rows; y++) {
      let currentStartX = -1;
      let currentBg = DEFAULT_COLOR;
      for (let x = 0; x < terminal.cols; x++) {
        const modelIndex = ((y * terminal.cols) + x) * 4;
        const bg = model.cells[modelIndex + 2];
        if (bg !== currentBg) {
          // A rectangle needs to be drawn if going from non-default to another color
          if (currentBg !== DEFAULT_COLOR) {
            const offset = rectangleCount++ * INDICES_PER_RECTANGLE;
            this._updateRectangle(vertices, offset, currentBg, currentStartX, x, y);
          }
          currentStartX = x;
          currentBg = bg;
        }
      }
      // Finish rectangle if it's still going
      if (currentBg !== DEFAULT_COLOR) {
        const offset = rectangleCount++ * INDICES_PER_RECTANGLE;
        this._updateRectangle(vertices, offset, currentBg, currentStartX, terminal.cols, y);
      }
    }
    vertices.count = rectangleCount;
  }

  private _updateRectangle(vertices: IVertices, offset: number, bg: number, startX: number, endX: number, y: number): void {
    let color: IColor | null = null;
    if (bg === INVERTED_DEFAULT_COLOR) {
      color = this._colors.foreground;
    } else if (is256Color(bg)) {
      color = this._colors.ansi[bg];
    } else {
      // TODO: Add support for true color
      color = this._colors.foreground;
    }
    if (vertices.attributes.length < offset + 4) {
      vertices.attributes = expandFloat32Array(vertices.attributes, this._terminal.rows * this._terminal.cols * INDICES_PER_RECTANGLE);
    }
    const x1 = startX * this._dimensions.scaledCellWidth;
    const y1 = y * this._dimensions.scaledCellHeight;
    const r = ((color.rgba >> 24) & 0xFF) / 255;
    const g = ((color.rgba >> 16) & 0xFF) / 255;
    const b = ((color.rgba >> 8 ) & 0xFF) / 255;

    this._addRectangle(vertices.attributes, offset, x1, y1, (endX - startX) * this._dimensions.scaledCellWidth, this._dimensions.scaledCellHeight, r, g, b, 1);
  }

  private _addRectangle(array: Float32Array, offset: number, x1: number, y1: number, width: number, height: number, r: number, g: number, b: number, a: number): void {
    array[offset    ] = x1;
    array[offset + 1] = y1;
    array[offset + 2] = width;
    array[offset + 3] = height;
    array[offset + 4] = r;
    array[offset + 5] = g;
    array[offset + 6] = b;
    array[offset + 7] = a;
  }

  private _addRectangleFloat(array: Float32Array, offset: number, x1: number, y1: number, width: number, height: number, color: Float32Array): void {
    array[offset    ] = x1;
    array[offset + 1] = y1;
    array[offset + 2] = width;
    array[offset + 3] = height;
    array[offset + 4] = color[0];
    array[offset + 5] = color[1];
    array[offset + 6] = color[2];
    array[offset + 7] = color[3];
  }

  private _colorToFloat32Array(color: IColor): Float32Array {
    return new Float32Array([
      ((color.rgba >> 24) & 0xFF) / 255,
      ((color.rgba >> 16) & 0xFF) / 255,
      ((color.rgba >> 8 ) & 0xFF) / 255,
      ((color.rgba      ) & 0xFF) / 255
    ]);
  }
}
