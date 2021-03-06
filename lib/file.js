const { EventEmitter } = require('events')
const { PassThrough } = require('readable-stream')
const eos = require('end-of-stream')
const path = require('path')
const render = require('render-media')
const streamToBlob = require('stream-to-blob')
const streamToBlobURL = require('stream-to-blob-url')
const streamToBuffer = require('stream-with-known-length-to-buffer')
const FileStream = require('./file-stream')
const queueMicrotask = require('queue-microtask')

class File extends EventEmitter {
  constructor (torrent, file) {
    super()

    this._torrent = torrent
    this._destroyed = false

    this.name = file.name
    this.path = file.path
    this.length = file.length
    this.offset = file.offset

    this.done = false

    const start = file.offset
    const end = start + file.length - 1

    this._startPiece = start / this._torrent.pieceLength | 0
    this._endPiece = end / this._torrent.pieceLength | 0

    if (this.length === 0) {
      this.done = true
      this.emit('done')
    }
  }

  get downloaded () {
    if (!this._torrent.bitfield) return 0

    const { pieces, bitfield, pieceLength } = this._torrent
    const { _startPiece: start, _endPiece: end } = this
    const piece = pieces[start]

    // First piece may have an offset, e.g. irrelevant bytes from the end of
    // the previous file
    const irrelevantFirstPieceBytes = this.offset % pieceLength
    let downloaded = bitfield.get(start)
      ? pieceLength - irrelevantFirstPieceBytes
      : Math.max(pieceLength - irrelevantFirstPieceBytes - piece.missing, 0)

    for (let index = start + 1; index <= end; ++index) {
      if (bitfield.get(index)) {
        // verified data
        downloaded += pieceLength
      } else {
        // "in progress" data
        const piece = pieces[index]
        downloaded += pieceLength - piece.missing
      }
    }

    const irrelevantLastPieceBytes = pieceLength - ((this.offset + this.length) % pieceLength)
    downloaded -= irrelevantLastPieceBytes

    return downloaded
  }

  get progress () {
    return this.length ? this.downloaded / this.length : 0
  }

  select (priority) {
    if (this.length === 0) return
    this._torrent.select(this._startPiece, this._endPiece, priority)
  }

  deselect () {
    if (this.length === 0) return
    this._torrent.deselect(this._startPiece, this._endPiece, false)
  }

  createReadStream (opts) {
    if (this.length === 0) {
      const empty = new PassThrough()
      queueMicrotask(() => {
        empty.end()
      })
      return empty
    }

    const fileStream = new FileStream(this, opts)
    this._torrent.select(fileStream._startPiece, fileStream._endPiece, true, () => {
      fileStream._notify()
    })
    eos(fileStream, () => {
      if (this._destroyed) return
      if (!this._torrent.destroyed) {
        this._torrent.deselect(fileStream._startPiece, fileStream._endPiece, true)
      }
    })
    return fileStream
  }

  getBuffer (cb) {
    streamToBuffer(this.createReadStream(), this.length, cb)
  }

  getBlob (cb) {
    if (typeof window === 'undefined') throw new Error('browser-only method')
    streamToBlob(this.createReadStream(), this._getMimeType())
      .then(
        blob => cb(null, blob),
        err => cb(err)
      )
  }

  getBlobURL (cb) {
    if (typeof window === 'undefined') throw new Error('browser-only method')
    streamToBlobURL(this.createReadStream(), this._getMimeType())
      .then(
        blobUrl => cb(null, blobUrl),
        err => cb(err)
      )
  }

  appendTo (elem, opts, cb) {
    if (typeof window === 'undefined') throw new Error('browser-only method')
    render.append(this, elem, opts, cb)
  }

  renderTo (elem, opts, cb) {
    if (typeof window === 'undefined') throw new Error('browser-only method')
    render.render(this, elem, opts, cb)
  }

  _getMimeType () {
    return render.mime[path.extname(this.name).toLowerCase()]
  }

  _destroy () {
    this._destroyed = true
    this._torrent = null
  }
}

module.exports = File
