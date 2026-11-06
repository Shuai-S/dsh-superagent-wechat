/** QR encoder (server-side SVG, zero-dependency).
 *
 *  Algorithm: minimal subset of Nayuki QR-Code-generator (MIT License,
 *  Copyright (c) Project Nayuki, https://www.nayuki.io/page/qr-code-generator-library):
 *  byte mode (UTF-8), automatic version selection, ECC level M (fixed, no boost),
 *  automatic mask selection (lowest penalty score), full format/version info bits.
 *  The two capacity-table rows below are copied verbatim from the reference
 *  implementation (index 0 is padding, indexes 1..40 are versions 1..40); the
 *  code is an independent trimmed rewrite, golden-master checked against the
 *  reference implementation at development time.
 *
 *  MIT license notice (for the reference-algorithm portion embodied here):
 *  Permission is hereby granted, free of charge, to any person obtaining a copy
 *  of this software and associated documentation files (the "Software"), to deal
 *  in the Software without restriction, including without limitation the rights
 *  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *  copies of the Software, and to permit persons to whom the Software is
 *  furnished to do so, subject to the following conditions: the above copyright
 *  notice and this permission notice shall be included in all copies or
 *  substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *  WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 *  TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *  NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 *  LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY.
 */
const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const NUM_ERROR_CORRECTION_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
const FORMAT_BITS_M = 0
const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewordsM(ver: number): number {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK_M[ver] * NUM_ERROR_CORRECTION_BLOCKS_M[ver]
}

function appendBits(val: number, len: number, bb: number[]): void {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1)
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0
}

// GF(2^8/0x11D) multiply (Russian peasant multiplication, same shape as the reference).
function rsMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xFF
}

function rsComputeDivisor(degree: number): number[] {
  const result: number[] = []
  for (let i = 0; i < degree - 1; i++) result.push(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = rsMultiply(root, 0x02)
  }
  return result
}

function rsComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (result.shift() as number)
    result.push(0)
    for (let i = 0; i < divisor.length; i++) result[i] ^= rsMultiply(divisor[i], factor)
  }
  return result
}

function grid(size: number, value: boolean): boolean[][] {
  const rows: boolean[][] = []
  for (let y = 0; y < size; y++) rows.push(new Array<boolean>(size).fill(value))
  return rows
}

function alignmentPatternPositions(version: number, size: number): number[] {
  if (version === 1) return []
  const numAlign = Math.floor(version / 7) + 2
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2
  const result: number[] = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

/** Encode the module matrix (false=light, true=dark), modules[y][x].
 *  Byte mode + ECC M + automatic mask. */
export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')]
  // Automatic version selection: byte-mode count field is 8 bits for v1-9
  // (max 255 bytes) and 16 bits for v10+.
  let version = 0
  for (let v = 1; v <= 40; v++) {
    const ccBits = v < 10 ? 8 : 16
    if (bytes.length >= (1 << ccBits)) continue
    const usedBits = 4 + ccBits + bytes.length * 8
    if (usedBits <= numDataCodewordsM(v) * 8) { version = v; break }
  }
  if (version === 0) throw new Error('qr: data too long for byte mode at ECC level M (max 2331 bytes)')
  const size = version * 4 + 17

  // Data codewords: mode indicator 0100 + char count + UTF-8 bytes, terminator,
  // byte alignment, then alternating 0xEC/0x11 pad bytes.
  const ccBits = version < 10 ? 8 : 16
  const bb: number[] = []
  appendBits(0x4, 4, bb)
  appendBits(bytes.length, ccBits, bb)
  for (const b of bytes) appendBits(b, 8, bb)
  const dataCapacityBits = numDataCodewordsM(version) * 8
  appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb)
  appendBits(0, (8 - bb.length % 8) % 8, bb)
  for (let padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11) appendBits(padByte, 8, bb)
  const dataCodewords: number[] = []
  for (let i = 0; i * 8 < bb.length; i++) dataCodewords.push(0)
  bb.forEach((b, i) => { dataCodewords[i >>> 3] = (dataCodewords[i >>> 3] | (b << (7 - (i & 7)))) & 0xFF })

  // Function patterns: timing, three finder patterns (with separators),
  // alignment patterns, format bits (placeholder) and version bits.
  const modules = grid(size, false)
  const isFunction = grid(size, false)
  const setFunctionModule = (x: number, y: number, isDark: boolean): void => {
    modules[y][x] = isDark
    isFunction[y][x] = true
  }
  for (let i = 0; i < size; i++) {
    setFunctionModule(6, i, i % 2 === 0)
    setFunctionModule(i, 6, i % 2 === 0)
  }
  const drawFinderPattern = (cx: number, cy: number): void => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = cx + dx
        const yy = cy + dy
        if (0 <= xx && xx < size && 0 <= yy && yy < size) setFunctionModule(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }
  drawFinderPattern(3, 3)
  drawFinderPattern(size - 4, 3)
  drawFinderPattern(3, size - 4)
  const alignPos = alignmentPatternPositions(version, size)
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      if (i === 0 && j === 0 || i === 0 && j === alignPos.length - 1 || i === alignPos.length - 1 && j === 0) continue
      const cx = alignPos[i]
      const cy = alignPos[j]
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }
  const drawFormatBits = (mask: number): void => {
    const data = FORMAT_BITS_M << 3 | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = (data << 10 | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getBit(bits, i))
    setFunctionModule(8, 7, getBit(bits, 6))
    setFunctionModule(8, 8, getBit(bits, 7))
    setFunctionModule(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) setFunctionModule(14 - i, 8, getBit(bits, i))
    for (let i = 0; i < 8; i++) setFunctionModule(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) setFunctionModule(8, size - 15 + i, getBit(bits, i))
    setFunctionModule(8, size - 8, true) // always-dark module
  }
  drawFormatBits(0) // placeholder; redrawn after the mask is chosen
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25)
    const bits = version << 12 | rem
    for (let i = 0; i < 18; i++) {
      const color = getBit(bits, i)
      const a = size - 11 + i % 3
      const b = Math.floor(i / 3)
      setFunctionModule(a, b, color)
      setFunctionModule(b, a, color)
    }
  }

  // Split into ECC blocks, append RS parity, interleave (short-block rules as
  // in the reference implementation).
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[version]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK_M[version]
  const rawCodewords = Math.floor(numRawDataModules(version) / 8)
  const numShortBlocks = numBlocks - rawCodewords % numBlocks
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const blocks: number[][] = []
  const rsDiv = rsComputeDivisor(blockEccLen)
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = dataCodewords.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = rsComputeRemainder(dat, rsDiv)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const allCodewords: number[] = []
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) allCodewords.push(blocks[j][i])
    }
  }

  // Zigzag codeword placement.
  let bitIndex = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y][x] && bitIndex < allCodewords.length * 8) {
          modules[y][x] = getBit(allCodewords[bitIndex >>> 3], 7 - (bitIndex & 7))
          bitIndex++
        }
      }
    }
  }

  // Automatic mask selection: pick the lowest penalty score.
  const applyMask = (mask: number): void => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = x * y % 2 + x * y % 3 === 0; break
          case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break
          default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break
        }
        if (!isFunction[y][x] && invert) modules[y][x] = !modules[y][x]
      }
    }
  }
  const finderPenaltyCountPatterns = (runHistory: number[]): number => {
    const n = runHistory[1]
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
  }
  const finderPenaltyAddHistory = (currentRunLength: number, runHistory: number[]): void => {
    const len = runHistory[0] === 0 ? currentRunLength + size : currentRunLength
    runHistory.pop()
    runHistory.unshift(len)
  }
  const finderPenaltyTerminateAndCount = (currentRunColor: boolean, currentRunLength: number, runHistory: number[]): number => {
    let runLen = currentRunLength
    if (currentRunColor) {
      finderPenaltyAddHistory(runLen, runHistory)
      runLen = 0
    }
    runLen += size
    finderPenaltyAddHistory(runLen, runHistory)
    return finderPenaltyCountPatterns(runHistory)
  }
  const penaltyScore = (): number => {
    let result = 0
    for (let y = 0; y < size; y++) {
      let runColor = false
      let runLen = 0
      const runHistory = [0, 0, 0, 0, 0, 0, 0]
      for (let x = 0; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          finderPenaltyAddHistory(runLen, runHistory)
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3
          runColor = modules[y][x]
          runLen = 1
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory) * PENALTY_N3
    }
    for (let x = 0; x < size; x++) {
      let runColor = false
      let runLen = 0
      const runHistory = [0, 0, 0, 0, 0, 0, 0]
      for (let y = 0; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLen++
          if (runLen === 5) result += PENALTY_N1
          else if (runLen > 5) result++
        } else {
          finderPenaltyAddHistory(runLen, runHistory)
          if (!runColor) result += finderPenaltyCountPatterns(runHistory) * PENALTY_N3
          runColor = modules[y][x]
          runLen = 1
        }
      }
      result += finderPenaltyTerminateAndCount(runColor, runLen, runHistory) * PENALTY_N3
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x]
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += PENALTY_N2
      }
    }
    let dark = 0
    for (const row of modules) {
      for (const color of row) {
        if (color) dark++
      }
    }
    const total = size * size
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1
    result += k * PENALTY_N4
    return result
  }
  let msk = 0
  let minPenalty = 1000000000
  for (let i = 0; i < 8; i++) {
    applyMask(i)
    drawFormatBits(i)
    const penalty = penaltyScore()
    if (penalty < minPenalty) { msk = i; minPenalty = penalty }
    applyMask(i) // XOR is self-inverse: undo the trial mask
  }
  applyMask(msk)
  drawFormatBits(msk)
  return modules
}

/** Encode to a self-contained SVG string (white background, dark modules;
 *  safe to inject via innerHTML). */
export function encodeQrSvg(text: string, opts?: { border?: number }): string {
  const border = Math.max(0, Math.floor(opts?.border ?? 4))
  const modules = encodeQrMatrix(text)
  const size = modules.length
  const dim = size + border * 2
  const parts: string[] = []
  parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR">')
  parts.push('<rect x="0" y="0" width="' + dim + '" height="' + dim + '" fill="#ffffff"/>')
  parts.push('<g fill="#000000">')
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) parts.push('<rect x="' + (x + border) + '" y="' + (y + border) + '" width="1" height="1"/>')
    }
  }
  parts.push('</g>')
  parts.push('</svg>')
  return parts.join('')
}
