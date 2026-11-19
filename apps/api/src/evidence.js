import Busboy from "busboy";
import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync, realpathSync } from "node:fs";
import { open, readdir, stat, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { adaptDatabase } from "./database.js";
import { assertStorageKey, OversizedEvidenceObject, validStorageKey } from "./evidence-storage.js";
import { audit, forbidden, missing } from "./registry.js";
import { assertResultEditor, readResultForUser } from "./result-access.js";
import { ApiError, invalid, keys, positive, uuid } from "./validation.js";

const localFileLimit = 5 * 1024 * 1024;
const recoveryGrace = 24 * 60 * 60 * 1000;
const maxFiles = 10;
const maxRevisions = 20;
const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");
const jpegHeader = Buffer.from("ffd8ff", "hex");
const pdfHeader = Buffer.from("%PDF-");
const mediaTypes = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".txt", "text/plain"],
]);

function metadata(row) {
  return {
    id: row.id,
    resultId: row.result_id,
    logicalFileId: row.logical_file_id,
    revision: row.revision,
    originalName: row.original_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

const tooLarge = (limit) =>
  new ApiError(413, "payload_too_large", "Доказ має бути не більшим за " + limit / 1024 ** 2 + " MiB");
const unsupported = () =>
  new ApiError(400, "validation_error", "Дозволені лише синтетичні PDF, PNG, JPEG і TXT");
const malformed = () =>
  new ApiError(400, "validation_error", "Некоректне завантаження доказу");
const conflict = () =>
  new ApiError(409, "version_conflict", "Версія результату змінилася");

async function removeFile(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function normalizeName(filename) {
  const name = (filename ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_")
    .trim();
  if (!name || Buffer.byteLength(name, "utf8") > 255) throw unsupported();
  return name;
}

function validateHeader(prefix, mediaType) {
  const startsWith = (signature) => prefix.subarray(0, signature.length).equals(signature);
  if (mediaType === "application/pdf" && !startsWith(pdfHeader)) throw unsupported();
  if (mediaType === "image/png" && !startsWith(pngHeader)) throw unsupported();
  if (mediaType === "image/jpeg" && !startsWith(jpegHeader)) throw unsupported();
  if (
    mediaType === "text/plain" &&
    (startsWith(pdfHeader) || startsWith(Buffer.from("MZ")) || startsWith(Buffer.from("#!")))
  ) throw unsupported();
}

async function readFileUpload(file, info, fileLimit) {
  // A digest is calculated over the original bytes, including any UTF-8 BOM.
  const originalName = normalizeName(info.filename);
  const mediaType = mediaTypes.get(extname(originalName).toLowerCase());
  if (!mediaType || mediaType !== info.mimeType) throw unsupported();
  if (!["7bit", "8bit", "binary"].includes(info.encoding)) throw unsupported();

  const hash = createHash("sha256");
  const decoder = mediaType === "text/plain" ? new TextDecoder("utf-8", { fatal: true }) : null;
  let byteSize = 0;
  let prefix = Buffer.alloc(0);
  let lastChar = "";
  const validateText = (value) => {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
        /<[!/?a-z]/i.test(lastChar + value)) throw unsupported();
    if (value.length) lastChar = value.at(-1);
  };
  const chunks = [];
  try {
    for await (const chunk of file) {
      byteSize += chunk.length;
      if (byteSize > fileLimit) throw tooLarge(fileLimit);
      if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
      if (decoder) validateText(decoder.decode(chunk, { stream: true }));
      hash.update(chunk);
      chunks.push(chunk);
    }
    if (decoder) validateText(decoder.decode());
  } catch (error) {
    throw error instanceof ApiError ? error : unsupported();
  }
  if (file.truncated) throw tooLarge(fileLimit);
  if (byteSize === 0) throw unsupported();
  validateHeader(prefix, mediaType);
  return { originalName, mediaType, byteSize, sha256: hash.digest("hex"), bytes: Buffer.concat(chunks, byteSize) };
}

async function readUpload(req, fileLimit) {
  const requestLimit = fileLimit + 64 * 1024;
  if (!req.is("multipart/form-data")) throw malformed();
  if (Number(req.headers["content-length"]) > requestLimit) throw tooLarge(fileLimit);
  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: { files: 1, fields: 2, parts: 4, fieldSize: 128, fileSize: fileLimit + 1 },
    });
  } catch {
    throw malformed();
  }

  let failure;
  let received = 0;
  let saved;
  const values = Object.create(null);
  const countBytes = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > requestLimit ? tooLarge(fileLimit) : null, chunk);
    },
  });
  const stop = (error) => {
    failure ??= error;
    countBytes.destroy(error);
  };
  const aborted = () => stop(malformed());

  parser.on("filesLimit", () => stop(malformed()));
  parser.on("fieldsLimit", () => stop(malformed()));
  parser.on("partsLimit", () => stop(malformed()));
  parser.on("field", (name, value, info) => {
    if (!["version", "logicalFileId"].includes(name) || name in values || info.valueTruncated) {
      stop(malformed());
    } else {
      values[name] = value;
    }
  });
  parser.on("file", (name, file, info) => {
    file.on("error", stop);
    if (name !== "file" || saved) {
      file.resume();
      stop(malformed());
      return;
    }
    saved = readFileUpload(file, info, fileLimit).catch((error) => stop(error));
  });

  req.once("aborted", aborted);
  req.once("error", aborted);
  try {
    const parsed = pipeline(countBytes, parser);
    req.pipe(countBytes);
    await parsed;
  } catch (error) {
    failure ??= error instanceof ApiError ? error : malformed();
  } finally {
    req.off("aborted", aborted);
    req.off("error", aborted);
    req.unpipe(countBytes);
    req.resume();
  }
  const file = await saved;
  if (failure) throw failure;
  if (!file || !/^[1-9]\d{0,15}$/.test(values.version ?? "")) throw malformed();
  return {
    ...file,
    version: positive(Number(values.version)),
    logicalFileId: values.logicalFileId === undefined ? null : uuid(values.logicalFileId),
  };
}

function outsidePublicRoot(directory) {
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  function contains(parent, child) {
    const subpath = relative(parent, child);
    return subpath === "" || (!(subpath === ".." || subpath.startsWith(".." + sep)) && !isAbsolute(subpath));
  }
  const target = resolve(directory);
  if (contains(webRoot, target)) throw new Error("Evidence storage must be outside the web root");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(target);
  let publicPath = webRoot;
  try {
    publicPath = realpathSync(webRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (contains(publicPath, resolved)) throw new Error("Evidence storage must be outside the web root");
  return resolved;
}

async function recoverFiles(db, directory) {
  if (db.dialect !== "sqlite" ||
    !await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_versions'").get())
    return;
  const olderThan = Date.now() - recoveryGrace;
  const referenced = db.prepare("SELECT 1 FROM evidence_versions WHERE storage_key=?");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const key = entry.name.endsWith(".tmp") ? entry.name.slice(0, -4) : entry.name;
    if (!entry.isFile() || !validStorageKey(key) || await referenced.get(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      if ((await stat(path)).mtimeMs < olderThan) await removeFile(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function localStorage(db, directory) {
  const root = outsidePublicRoot(directory);
  let recovery;
  async function ready() {
    recovery ??= recoverFiles(db, root).catch((error) => {
      recovery = undefined;
      throw error;
    });
    await recovery;
  }
  function location(key) {
    assertStorageKey(key);
    return join(root, key);
  }

  return {
    maxBytes: localFileLimit,
    async put(key, bytes) {
      const path = location(key);
      await ready();
      const handle = await open(path, "wx", 0o600);
      try {
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      } catch (error) {
        await removeFile(path);
        throw error;
      }
    },
    async get(key) {
      await ready();
      let handle;
      try {
        handle = await open(location(key), constants.O_RDONLY | constants.O_NOFOLLOW);
        const file = await handle.stat();
        if (!file.isFile() || file.size > localFileLimit) throw new OversizedEvidenceObject();

        // Leave room to detect unexpected growth while keeping reads bounded.
        const buffer = Buffer.alloc(file.size + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) return buffer.subarray(0, size);
          size += bytesRead;
        }
        throw new OversizedEvidenceObject();
      } catch (error) {
        if (error.code === "ENOENT") return null;
        if (error.code === "ELOOP") throw new OversizedEvidenceObject();
        throw error;
      } finally {
        await handle?.close();
      }
    },
    delete: (key) => removeFile(location(key)),
  };
}

export function createEvidenceStore(database, { directory, storage = undefined, fileLimit } = {}) {
  const db = adaptDatabase(database);
  const objects = storage ?? localStorage(db, directory);
  const maxBytes = Math.min(objects.maxBytes ?? localFileLimit, fileLimit ?? localFileLimit);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error("Invalid evidence file limit");

  async function inspect(row) {
    assertStorageKey(row.storage_key);
    let bytes;
    try {
      bytes = await objects.get(row.storage_key);
      if (bytes?.length > maxBytes) bytes = undefined;
    } catch (error) {
      if (!(error instanceof OversizedEvidenceObject)) throw error;
    }
    const missingFile = bytes === null;
    const actualSha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
    return {
      bytes,
      id: row.id,
      expectedSha256: row.sha256,
      actualSha256,
      intact: bytes?.length === row.byte_size && actualSha256 === row.sha256,
      missingFile,
    };
  }

  async function integrity(row) {
    const { bytes: _bytes, ...status } = await inspect(row);
    return status;
  }

  async function download(row) {
    const { intact, missingFile, bytes } = await inspect(row);
    if (missingFile) throw new ApiError(404, "not_found", "Доказ не знайдено");
    if (!intact) throw new ApiError(409, "evidence_integrity_failed", "Цілісність доказу порушено");
    return bytes;
  }

  async function history(resultId, user) {
    const owned = user.role === "executor";
    const rows = await db.prepare(
      `SELECT * FROM evidence_versions WHERE result_id=? ${owned ? "AND uploaded_by=?" : ""}
       ORDER BY created_at, logical_file_id, revision`,
    ).all(...(owned ? [resultId, user.id] : [resultId]));
    return rows.map(metadata);
  }

  async function deleteUncommitted(storageKey) {
    try {
      // A lost connection during COMMIT does not prove that it failed.
      if (!await db.prepare("SELECT 1 FROM evidence_versions WHERE storage_key=?").get(storageKey)) {
        await objects.delete(storageKey);
      }
    } catch {
      console.error("Could not confirm or remove an uncommitted evidence object");
    }
  }

  async function upload(req, resultId) {
    const actorId = req.user.id;
    const current = await readResultForUser(db, req.user, resultId);
    await assertResultEditor(db, req.user, current);
    const file = await readUpload(req, maxBytes);
    if (file.version !== current.version) throw conflict();
    const storageKey = randomUUID();
    try {
      // Store immutable bytes before the transaction publishes their metadata.
      await objects.put(storageKey, file.bytes, file.mediaType);
    } catch (error) {
      if (error instanceof OversizedEvidenceObject) throw tooLarge(maxBytes);
      throw error;
    }

    try {
      return await db.transaction(async (tx) => {
        const user = await tx.prepare("SELECT id, role FROM users WHERE id=? AND active=1").get(actorId);
        if (!user) throw new ApiError(401, "unauthenticated", "Користувач недоступний");
        const result = await readResultForUser(tx, user, resultId);
        await assertResultEditor(tx, user, result);
        if (result.version !== file.version) throw conflict();

        const changedAt = new Date().toISOString();
        const updated = await tx.prepare(
          "UPDATE results SET version=version+1,updated_at=? WHERE id=? AND version=?",
        ).run(changedAt, resultId, file.version);
        if (!updated.changes) throw conflict();

        let revision = 1;
        if (file.logicalFileId) {
          const prior = await tx.prepare(
            `SELECT revision FROM evidence_versions
             WHERE result_id=? AND uploaded_by=? AND logical_file_id=?
             ORDER BY revision DESC LIMIT 1`,
          ).get(resultId, user.id, file.logicalFileId);
          if (!prior) missing();
          revision = prior.revision + 1;
          if (revision > maxRevisions)
            invalid("Для одного доказу доступно не більше 20 версій");
        } else {
          const count = await tx.prepare(
            "SELECT count(DISTINCT logical_file_id) AS n FROM evidence_versions WHERE result_id=? AND uploaded_by=?",
          ).get(resultId, user.id);
          if (count.n >= maxFiles)
            invalid("Для одного результату доступно не більше 10 файлів на виконавця");
        }

        const row = {
          id: randomUUID(),
          result_id: resultId,
          logical_file_id: file.logicalFileId ?? randomUUID(),
          revision,
          original_name: file.originalName,
          storage_key: storageKey,
          media_type: file.mediaType,
          byte_size: file.byteSize,
          sha256: file.sha256,
          uploaded_by: user.id,
          created_at: changedAt,
        };
        await tx.prepare(
          `INSERT INTO evidence_versions
            (id,result_id,logical_file_id,revision,original_name,storage_key,media_type,byte_size,sha256,uploaded_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          row.id, row.result_id, row.logical_file_id, row.revision, row.original_name,
          row.storage_key, row.media_type, row.byte_size, row.sha256, row.uploaded_by, row.created_at,
        );
        const evidence = metadata(row);
        await audit(tx, user.id, revision === 1 ? "upload" : "replace", "evidence", row.id, null, evidence);
        return { evidence, resultVersion: file.version + 1 };
      });
    } catch (error) {
      await deleteUncommitted(storageKey);
      throw error;
    }
  }

  return { history, verify: async (row) => (await integrity(row)).intact, integrity, download, upload, maxBytes };
}

export function mountEvidenceRoutes(app, database, evidence) {
  const db = adaptDatabase(database);

  async function findReadable(req) {
    const row = await db.prepare("SELECT * FROM evidence_versions WHERE id=?").get(uuid(req.params.id));
    if (!row) missing();
    await readResultForUser(db, req.user, row.result_id);
    if (req.user.role === "executor" && row.uploaded_by !== req.user.id) missing();
    return row;
  }

  app.post("/api/results/:id/evidence", async (req, res) => {
    keys(req.query, []);
    const result = await evidence.upload(req, uuid(req.params.id));
    res.status(201).json(result);
  });

  app.get("/api/evidence/:id/download", async (req, res) => {
    keys(req.query, []);
    const row = await findReadable(req);
    const bytes = await evidence.download(row);
    res.attachment(row.original_name);
    res.type(row.media_type);
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Length", String(bytes.length));
    res.end(bytes);
  });

  app.get("/api/evidence/:id/integrity", async (req, res) => {
    keys(req.query, []);
    if (!["coordinator", "admin"].includes(req.user.role)) forbidden();
    const { id, expectedSha256, actualSha256, intact } = await evidence.integrity(await findReadable(req));
    res.json({ id, expectedSha256, actualSha256, intact });
  });
}
