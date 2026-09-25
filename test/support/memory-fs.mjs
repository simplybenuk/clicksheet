// In-memory stand-in for the File System Access handles the storage adapter
// uses. A shared volume controls permission, removal, and write failures.

export function createVolume(name = "clicksheet-root") {
  const volume = {
    permission: "granted",
    requestResult: "granted",
    removed: false,
    failWritesMatching: null
  };
  volume.root = new MemoryDirectory(name, volume);
  return volume;
}

function domError(name, message = name) {
  return new DOMException(message, name);
}

function assertUsable(volume) {
  if (volume.removed) {
    throw domError("NotFoundError");
  }

  if (volume.permission !== "granted") {
    throw domError("NotAllowedError");
  }
}

async function toBytes(data) {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }

  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

class MemoryFile {
  kind = "file";

  constructor(name, volume) {
    this.name = name;
    this.volume = volume;
    this.bytes = new Uint8Array();
  }

  async getFile() {
    assertUsable(this.volume);
    return new File([this.bytes], this.name);
  }

  async createWritable() {
    assertUsable(this.volume);
    const chunks = [];
    let open = true;

    return {
      write: async (data) => {
        assertUsable(this.volume);

        if (this.volume.failWritesMatching?.test(this.name)) {
          throw domError("InvalidStateError", "Simulated write failure");
        }

        chunks.push(await toBytes(data));
      },
      close: async () => {
        assertUsable(this.volume);
        const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }

        this.bytes = bytes;
        open = false;
      },
      abort: async () => {
        if (!open) {
          throw domError("TypeError");
        }

        open = false;
      }
    };
  }

  async isSameEntry(other) {
    return other === this;
  }
}

class MemoryDirectory {
  kind = "directory";

  constructor(name, volume) {
    this.name = name;
    this.volume = volume;
    this.children = new Map();
  }

  async queryPermission() {
    return this.volume.permission;
  }

  async requestPermission() {
    this.volume.permission = this.volume.requestResult;
    return this.volume.permission;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    return this.#child(name, "directory", create);
  }

  async getFileHandle(name, { create = false } = {}) {
    return this.#child(name, "file", create);
  }

  async removeEntry(name, { recursive = false } = {}) {
    assertUsable(this.volume);
    const child = this.children.get(name);

    if (!child) {
      throw domError("NotFoundError");
    }

    if (child.kind === "directory" && child.children.size && !recursive) {
      throw domError("InvalidModificationError");
    }

    this.children.delete(name);
  }

  async *entries() {
    assertUsable(this.volume);
    yield* [...this.children.entries()];
  }

  async *keys() {
    assertUsable(this.volume);
    yield* [...this.children.keys()];
  }

  async *values() {
    assertUsable(this.volume);
    yield* [...this.children.values()];
  }

  async isSameEntry(other) {
    return other === this;
  }

  async resolve(descendant) {
    const search = (directory, path) => {
      for (const [name, child] of directory.children) {
        if (child === descendant) {
          return [...path, name];
        }

        if (child.kind === "directory") {
          const found = search(child, [...path, name]);

          if (found) {
            return found;
          }
        }
      }

      return null;
    };

    return descendant === this ? [] : search(this, []);
  }

  #child(name, kind, create) {
    assertUsable(this.volume);
    const existing = this.children.get(name);

    if (existing) {
      if (existing.kind !== kind) {
        throw domError("TypeMismatchError");
      }

      return existing;
    }

    if (!create) {
      throw domError("NotFoundError");
    }

    const child = kind === "directory"
      ? new MemoryDirectory(name, this.volume)
      : new MemoryFile(name, this.volume);
    this.children.set(name, child);
    return child;
  }
}

// Returns { "path/to/file": "contents" } for comparisons in tests.
export function snapshot(directory, prefix = "") {
  const files = {};

  for (const [name, child] of directory.children) {
    const path = `${prefix}${name}`;

    if (child.kind === "directory") {
      files[`${path}/`] = "";
      Object.assign(files, snapshot(child, `${path}/`));
    } else {
      files[path] = new TextDecoder().decode(child.bytes);
    }
  }

  return files;
}

export async function readText(directory, path) {
  const parts = path.split("/");
  let current = directory;

  for (const part of parts.slice(0, -1)) {
    current = await current.getDirectoryHandle(part);
  }

  return (await (await current.getFileHandle(parts.at(-1))).getFile()).text();
}
