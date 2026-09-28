'use strict';

const fs = require('fs');
const path = require('path');
const { safeFilename, mimeOf, randId } = require('./util');

// 文件存储：流式写入磁盘，内存中只保留元信息，文件大小不受限
class FileStore {
  constructor(dir) {
    this.blobDir = path.join(dir, 'blobs');
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.meta = new Map(); // id -> { id, name, mime, size, storedName, ts }
    this.rescan();
  }

  // 服务重启后从磁盘恢复文件元信息（存储名格式为 "<id>_<原文件名>"）
  rescan() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.blobDir);
    } catch {
      return;
    }
    for (const storedName of entries) {
      const idx = storedName.indexOf('_');
      if (idx <= 0) continue;
      const id = storedName.slice(0, idx);
      const name = storedName.slice(idx + 1);
      try {
        const st = fs.statSync(path.join(this.blobDir, storedName));
        if (!st.isFile()) continue;
        this.meta.set(id, {
          id,
          name,
          mime: mimeOf(name),
          size: st.size,
          storedName,
          ts: st.mtimeMs,
        });
      } catch {
        // 单个文件损坏忽略
      }
    }
  }

  // 开始一次上传，返回写入流与收尾方法
  beginUpload(originalName, mime) {
    const id = randId(12);
    const name = safeFilename(originalName);
    const storedName = id + '_' + name;
    const filePath = path.join(this.blobDir, storedName);
    const stream = fs.createWriteStream(filePath);
    const info = {
      id,
      name,
      mime: mime || mimeOf(name),
      size: 0,
      storedName,
      ts: Date.now(),
    };
    return {
      stream,
      info,
      count(bytes) {
        info.size += bytes;
      },
      finish() {
        // req.pipe() 会在源流结束时自动 end 写入流，这里只等待落盘完成
        return new Promise((resolve, reject) => {
          if (stream.errored) {
            reject(stream.errored);
            return;
          }
          if (stream.writableEnded) {
            resolve(info);
            return;
          }
          const onF = () => {
            stream.off('error', onE);
            resolve(info);
          };
          const onE = err => {
            stream.off('finish', onF);
            reject(err);
          };
          stream.once('finish', onF);
          stream.once('error', onE);
        });
      },
      abort() {
        try {
          stream.destroy();
        } catch {
          // 忽略
        }
        fs.unlink(filePath, () => {});
      },
    };
  }

  register(info) {
    this.meta.set(info.id, info);
  }

  get(id) {
    return this.meta.get(id);
  }

  pathOf(info) {
    return path.join(this.blobDir, info.storedName);
  }

  clear() {
    for (const f of fs.readdirSync(this.blobDir)) {
      try {
        fs.unlinkSync(path.join(this.blobDir, f));
      } catch {
        // 忽略
      }
    }
    this.meta.clear();
  }

  stats() {
    let count = 0;
    let totalSize = 0;
    for (const m of this.meta.values()) {
      count++;
      totalSize += m.size || 0;
    }
    return { count, totalSize };
  }
}

module.exports = { FileStore };
