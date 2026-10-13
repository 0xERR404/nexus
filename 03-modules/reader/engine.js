(() => {
  const copy = (p) => ({chapter: p.chapter, block: p.block, offset: p.offset});
  class ReaderEngine {
    constructor({viewport, text, book, fetchChapter, onChange, onError}) {
      Object.assign(this, {viewport, text, book, fetchChapter, onChange, onError});
      this.cache = new Map();
      this.pending = new Map();
      this.sections = new Map();
      this.generation = 0;
      this.busy = false;
      this.closed = false;
      this.page = null;
      this.pages = new Map();
      this.measure = document.createElement('article');
      this.measure.className = 'reader-text reader-measure';
      this.measure.setAttribute('aria-hidden', 'true');
      viewport.append(this.measure);
      this.scroll = () => {
        if (this.mode !== 'scroll' || this.busy || this.closed) return;
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {
          this.onChange();
          void this.extend().catch(this.onError);
        });
      };
      viewport.addEventListener('scroll', this.scroll, {passive: true});
    }
    async data(i) {
      if (i < 0 || i >= this.book.chapters.length) return null;
      if (this.cache.has(i)) {
        const v = this.cache.get(i);
        this.cache.delete(i);
        this.cache.set(i, v);
        return v;
      }
      if (this.pending.has(i)) return this.pending.get(i);
      const job = this.fetchChapter(i)
        .then((v) => {
          if (!Array.isArray(v.blocks) || !v.blocks.length) throw Error('Пустая часть книги.');
          if (this.closed) return v;
          this.cache.set(i, v);
          while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
          return v;
        })
        .finally(() => this.pending.delete(i));
      this.pending.set(i, job);
      return job;
    }
    prefetch(i) {
      for (const n of [i - 1, i + 1, i + 2]) void this.data(n).catch(() => {});
    }
    element(b, p, start = 0, end = b.text?.length || 0) {
      const n = document.createElement(
        {heading: 'h3', quote: 'blockquote', pre: 'pre', image: 'figure'}[b.type] || 'p'
      );
      n.dataset.chapter = String(p.chapter);
      n.dataset.block = String(p.block);
      if (b.type === 'image') {
        const img = document.createElement('img');
        img.src = '/modules/reader/book/' + this.book.id + '/asset/' + b.asset;
        img.alt = b.text || '';
        img.decoding = 'async';
        img.loading = 'lazy';
        if (b.width && b.height) {
          img.width = b.width;
          img.height = b.height;
        }
        n.append(img);
      } else n.textContent = b.text.slice(start, end);
      return n;
    }
    section(i, data) {
      const s = document.createElement('section');
      s.className = 'reader-part';
      s.dataset.chapter = String(i);
      s.append(...data.blocks.map((b, j) => this.element(b, {chapter: i, block: j})));
      return s;
    }
    last() {
      const chapter = this.book.chapters.length - 1;
      return {chapter, block: this.book.chapters[chapter].blocks - 1, offset: 1};
    }
    end(p) {
      const last = this.last();
      return p.chapter === last.chapter && p.block === last.block && p.offset >= 1;
    }
    start(p) {
      return p.chapter === 0 && p.block === 0 && p.offset <= 0;
    }
    position() {
      if (this.mode === 'pages')
        return copy(
          this.page ? (this.end(this.page.end) ? this.page.end : this.page.start) : this.anchor
        );
      const top = this.viewport.getBoundingClientRect().top;
      const blocks = [...this.text.querySelectorAll('[data-block]')];
      if (!blocks.length) return copy(this.anchor);
      const last = blocks.at(-1);
      if (
        Number(last.dataset.chapter) === this.book.chapters.length - 1 &&
        this.viewport.scrollTop + this.viewport.clientHeight >= this.viewport.scrollHeight - 2
      )
        return this.last();
      const n = blocks.find((n) => n.getBoundingClientRect().bottom > top + 2) || last,
        r = n.getBoundingClientRect();
      return {
        chapter: Number(n.dataset.chapter),
        block: Number(n.dataset.block),
        offset: Math.min(1, Math.max(0, (top - r.top) / Math.max(1, r.height)))
      };
    }
    async open(p, mode = 'scroll') {
      const gen = ++this.generation;
      this.busy = true;
      this.anchor = copy(p);
      this.pages.clear();
      this.mode = mode;
      this.viewport.dataset.mode = mode;
      try {
        if (mode === 'pages') {
          const page = await this.build(p, 1);
          if (gen !== this.generation || this.closed) return;
          this.showPage(page);
          this.warmPages();
        } else {
          const first = Math.max(0, p.chapter - 1),
            last = Math.min(this.book.chapters.length - 1, p.chapter + 2),
            parts = [];
          for (let i = first; i <= last; i++) parts.push(i);
          const data = await Promise.all(parts.map((i) => this.data(i)));
          if (gen !== this.generation || this.closed) return;
          this.sections.clear();
          const nodes = parts.map((i, j) => {
            const s = this.section(i, data[j]);
            this.sections.set(i, s);
            return s;
          });
          this.text.replaceChildren(...nodes);
          let tail = last;
          while (
            this.text.scrollHeight < this.viewport.clientHeight * 2 &&
            tail < this.book.chapters.length - 1 &&
            tail - last < 100
          ) {
            const data = await this.data(++tail);
            if (gen !== this.generation || this.closed) return;
            const section = this.section(tail, data);
            this.sections.set(tail, section);
            this.text.append(section);
          }
          await new Promise((r) => requestAnimationFrame(r));
          const target = this.text.querySelector(
            `[data-chapter="${p.chapter}"][data-block="${p.block}"]`
          );
          this.viewport.scrollTop = 0;
          if (target) {
            const r = target.getBoundingClientRect();
            this.viewport.scrollTop =
              r.top - this.viewport.getBoundingClientRect().top + r.height * p.offset;
          }
        }
        this.prefetch(p.chapter);
      } finally {
        if (gen === this.generation) this.busy = false;
      }
      if (mode === 'scroll') this.scroll();
    }
    async extend() {
      if (this.busy || this.closed || this.mode !== 'scroll') return;
      this.busy = true;
      const gen = this.generation;
      let added = false;
      try {
        const ids = [...this.sections.keys()].sort((a, b) => a - b),
          first = ids[0],
          last = ids.at(-1);
        const top = this.viewport.scrollTop,
          near = this.viewport.clientHeight * 2;
        let i,
          prepend = false;
        if (top < near && first > 0) {
          i = first - 1;
          prepend = true;
        } else if (
          this.viewport.scrollHeight - top - this.viewport.clientHeight < near &&
          last < this.book.chapters.length - 1
        )
          i = last + 1;
        else return;
        const data = await this.data(i);
        if (gen !== this.generation || this.closed) return;
        const section = this.section(i, data);
        if (prepend) {
          const height = this.viewport.scrollHeight;
          this.text.prepend(section);
          this.viewport.scrollTop += this.viewport.scrollHeight - height;
        } else this.text.append(section);
        this.sections.set(i, section);
        added = true;
        const sorted = [...this.sections.keys()].sort((a, b) => a - b);
        if (sorted.length > 7) {
          const drop = prepend ? sorted.at(-1) : sorted[0],
            node = this.sections.get(drop),
            r = node.getBoundingClientRect(),
            vr = this.viewport.getBoundingClientRect();
          if ((prepend && r.top > vr.bottom + near) || (!prepend && r.bottom < vr.top - near)) {
            const h = this.viewport.scrollHeight,
              topBefore = this.viewport.scrollTop;
            node.remove();
            this.sections.delete(drop);
            if (!prepend) this.viewport.scrollTop = topBefore - (h - this.viewport.scrollHeight);
          }
        }
        this.prefetch(i);
        this.onChange();
      } finally {
        if (gen === this.generation) this.busy = false;
        if (added && !this.closed && this.mode === 'scroll') this.scroll();
      }
    }
    async adjacent(p, direction) {
      let {chapter, block} = p;
      block += direction;
      if (block < 0) {
        chapter--;
        if (chapter < 0) return null;
        block = this.book.chapters[chapter].blocks - 1;
      }
      if (block >= this.book.chapters[chapter].blocks) {
        chapter++;
        block = 0;
        if (chapter >= this.book.chapters.length) return null;
      }
      return {chapter, block, offset: direction > 0 ? 0 : 1};
    }
    key(p, d) {
      return [p.chapter, p.block, p.offset, d].join(':');
    }
    build(origin, direction) {
      const job = (this.building || Promise.resolve())
        .catch(() => {})
        .then(() => this.makePage(origin, direction));
      this.building = job;
      return job;
    }
    async makePage(origin, direction) {
      if (this.closed) return null;
      let p = copy(origin);
      const forward = direction > 0;
      if ((forward && p.offset >= 1) || (!forward && p.offset <= 0))
        p = await this.adjacent(p, direction);
      if (!p) return null;
      const initial = copy(p),
        nodes = [];
      let edge = copy(p);
      this.measure.replaceChildren();
      this.measure.style.width = this.text.getBoundingClientRect().width + 'px';
      this.measure.style.height = this.viewport.clientHeight + 'px';
      const fits = () => this.measure.scrollHeight <= this.measure.clientHeight + 1;
      for (let count = 0; p && count < 200 && !this.closed; count++) {
        const {blocks} = await this.data(p.chapter),
          b = blocks[p.block],
          size = b.type === 'image' ? 1 : b.text.length;
        const cursor = Math.max(0, Math.min(size, Math.round(p.offset * size))),
          low = forward ? cursor : 0,
          high = forward ? size : cursor;
        const n = this.element(b, p, low, high);
        forward ? this.measure.append(n) : this.measure.prepend(n);
        if (!fits()) {
          if (b.type === 'image') {
            if (nodes.length) {
              n.remove();
              break;
            }
          } else {
            let left = 0,
              right = high - low;
            while (left < right) {
              const mid = Math.ceil((left + right) / 2);
              n.textContent = forward
                ? b.text.slice(low, low + mid)
                : b.text.slice(high - mid, high);
              if (fits()) left = mid;
              else right = mid - 1;
            }
            if (!left && nodes.length) {
              n.remove();
              break;
            }
            let cut = forward ? low + Math.max(1, left) : high - Math.max(1, left);
            if (cut > 0 && cut < b.text.length && /[\uDC00-\uDFFF]/.test(b.text[cut]))
              cut += forward ? -1 : 1;
            if ((forward ? cut - low : high - cut) <= 0)
              cut = forward ? Math.min(high, low + 2) : Math.max(low, high - 2);
            const segment = forward ? b.text.slice(low, cut) : b.text.slice(cut, high);
            const space = forward ? segment.lastIndexOf(' ') : segment.indexOf(' ');
            if (space > 0 && space < segment.length - 1)
              cut = forward ? low + space + 1 : cut + space + 1;
            n.textContent = forward ? b.text.slice(low, cut) : b.text.slice(cut, high);
            edge = {...p, offset: cut / Math.max(1, size)};
            nodes[forward ? 'push' : 'unshift'](n);
            break;
          }
        }
        nodes[forward ? 'push' : 'unshift'](n);
        edge = {...p, offset: forward ? 1 : 0};
        p = await this.adjacent(p, direction);
      }
      const page = {start: forward ? initial : edge, end: forward ? edge : initial, nodes};
      this.measure.replaceChildren();
      return page;
    }
    showPage(page) {
      if (!page) return false;
      this.page = page;
      this.text.replaceChildren(...page.nodes);
      this.viewport.scrollTop = 0;
      this.prefetch(page.start.chapter);
      return true;
    }
    warmPages() {
      const gen = this.generation,
        page = this.page;
      this.warming = (this.warming || Promise.resolve())
        .catch(() => {})
        .then(
          () =>
            new Promise((r) => {
              if (window.requestIdleCallback) window.requestIdleCallback(r, {timeout: 120});
              else setTimeout(r, 16);
            })
        )
        .then(async () => {
          for (const [p, d] of [
            [page.end, 1],
            [page.start, -1]
          ]) {
            if (gen !== this.generation || this.closed) return;
            const key = this.key(p, d);
            if (this.pages.has(key)) continue;
            const next = await this.build(p, d);
            if (gen !== this.generation || this.closed) return;
            this.pages.set(key, next);
            while (this.pages.size > 8) this.pages.delete(this.pages.keys().next().value);
          }
        })
        .catch(() => {});
    }
    async step(direction) {
      if (this.busy || this.closed) return false;
      if (this.mode === 'scroll') {
        this.viewport.scrollBy({
          top: direction * this.viewport.clientHeight * 0.9,
          behavior: 'smooth'
        });
        return true;
      }
      this.busy = true;
      try {
        const p = direction > 0 ? this.page.end : this.page.start,
          key = this.key(p, direction);
        if (!this.pages.has(key)) await this.warming;
        const next = this.pages.has(key) ? this.pages.get(key) : await this.build(p, direction);
        if (!next) return false;
        this.pages.set(this.key(direction > 0 ? next.start : next.end, -direction), this.page);
        this.showPage(next);
        this.onChange();
        this.warmPages();
        return true;
      } finally {
        this.busy = false;
      }
    }
    close() {
      this.closed = true;
      this.generation++;
      cancelAnimationFrame(this.frame);
      this.viewport.removeEventListener('scroll', this.scroll);
      this.measure.remove();
      this.cache.clear();
      this.pages.clear();
    }
  }
  window.NexusReaderEngine = ReaderEngine;
})();
