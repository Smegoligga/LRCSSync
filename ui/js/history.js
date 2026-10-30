// Undo / redo of the lyrics.

export class History {
  constructor(limit = 300) { this.undo = []; this.redo = []; this.limit = limit; }
  snapshot(doc) { return JSON.stringify({ meta: doc.meta, lines: doc.lines }); }
  /** Call before changing the document. */
  push(doc) {
    this.undo.push(this.snapshot(doc));
    if (this.undo.length > this.limit) this.undo.shift();
    this.redo.length = 0;
  }
  back(doc) {
    if (!this.undo.length) return null;
    this.redo.push(this.snapshot(doc));
    return JSON.parse(this.undo.pop());
  }
  forward(doc) {
    if (!this.redo.length) return null;
    this.undo.push(this.snapshot(doc));
    return JSON.parse(this.redo.pop());
  }
  clear() { this.undo.length = 0; this.redo.length = 0; }
}
