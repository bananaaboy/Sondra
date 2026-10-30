/**
 * A QR code for a link, drawn by this page: the code is made here, from the
 * link, and no service is asked. Low error correction on purpose — it is read
 * off a screen, nothing is scratched or folded, and the room it saves is what
 * lets a link of a thousand characters stay a code a phone reads from a
 * little way off.
 */

import qrcode from 'qrcode-generator'

export interface QrCode {
  /** Modules along one side. */
  size: number
  /** An SVG path of the dark modules, in module units, without the quiet zone. */
  path: string
}

/** The code for `text`, or null where it does not fit (about 2 900 bytes is the most a code holds). */
export function makeQr(text: string): QrCode | null {
  try {
    const qr = qrcode(0, 'L')
    qr.addData(text, 'Byte')
    qr.make()
    const size = qr.getModuleCount()
    let path = ''
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (!qr.isDark(row, col)) continue
        // A run of dark modules in one row is one rectangle.
        let end = col
        while (end + 1 < size && qr.isDark(row, end + 1)) end += 1
        path += `M${col} ${row}h${end - col + 1}v1h-${end - col + 1}z`
        col = end
      }
    }
    return { size, path }
  } catch {
    return null
  }
}
