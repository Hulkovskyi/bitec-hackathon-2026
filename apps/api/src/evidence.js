import Busboy from "busboy";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { transaction } from "./database.js";
import { audit, forbidden, missing } from "./registry.js";
import { assertResultEditor, readResultForUser } from "./result-access.js";
import { ApiError, invalid, keys, positive, uuid } from "./validation.js";

const fileLimit = 5 * 1024 * 1024;
const requestLimit = fileLimit + 64 * 1024;
const recoveryGrace = 24 * 60 * 60 * 1000;
const maxFiles = 10;
const maxRevisions = 20;
const storageId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

const tooLarge = () =>
  new ApiError(413, "payload_too_large", "Доказ має бути не більшим за 5 MiB");
const unsupported = () =>
  new ApiError(400, "validation_error", "Дозволені лише синтетичні PDF, PNG, JPEG і TXT");
const malformed = () =>
  new ApiError(400, "validation_error", "Некоректне завантаження доказу");
const conflict = () =>
  new ApiError(409, "version_conflict", "Версія результату змінилася");

function removeFile(path) {
  try {
    unlinkSync(path);
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

async function copyFile(file, info, path) {
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
  const observe = new Transform({
    transform(chunk, _encoding, done) {
      try {
        byteSize += chunk.length;
        if (byteSize > fileLimit) throw tooLarge();
        if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
        if (decoder) validateText(decoder.decode(chunk, { stream: true }));
        hash.update(chunk);
        done(null, chunk);
      } catch (error) {
        done(error instanceof ApiError ? error : unsupported());
      }
    },
    flush(done) {
      try {
        if (decoder) validateText(decoder.decode());
        done();
      } catch {
        done(unsupported());
      }
    },
  });
  await pipeline(file, observe, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  if (file.truncated) throw tooLarge();
  if (byteSize === 0) throw unsupported();
  validateHeader(prefix, mediaType);
  return { originalName, mediaType, byteSize, sha256: hash.digest("hex") };
}

async function readUpload(req, path) {
  if (!req.is("multipart/form-data")) throw malformed();
  if (Number(req.headers["content-length"]) > requestLimit) throw tooLarge();
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
      done(received > requestLimit ? tooLarge() : null, chunk);
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
    saved = copyFile(file, info, path).catch((error) => stop(error));
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

function recoverFiles(db, directory) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evidence_versions'").get())
    return;
  const olderThan = Date.now() - recoveryGrace;
  const referenced = db.prepare("SELECT 1 FROM evidence_versions WHERE storage_key=?");
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const key = entry.name.endsWith(".tmp") ? entry.name.slice(0, -4) : entry.name;
    if (!entry.isFile() || !storageId.test(key) || referenced.get(entry.name)) continue;
    const path = join(directory, entry.name);
    try {
      if (statSync(path).mtimeMs < olderThan) removeFile(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function inspect(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > fileLimit) return { actualSha256: null, size: null };
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let size = 0;
    let length;
    while ((length = readSync(fd, chunk, 0, chunk.length, null))) {
      size += length;
      if (size > fileLimit) return { actualSha256: null, size: null };
      hash.update(chunk.subarray(0, length));
    }
    return { actualSha256: hash.digest("hex"), size };
  } catch (error) {
    if (error.code === "ENOENT") return { actualSha256: null, size: null, missingFile: true };
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function createEvidenceStore(db, { directory }) {
  const storage = outsidePublicRoot(directory);
  recoverFiles(db, storage);

  function storedPath(row) {
    if (!storageId.test(row.storage_key)) throw new Error("Invalid evidence storage key");
    return join(storage, row.storage_key);
  }

  function integrity(row) {
    const { actualSha256, size, missingFile } = inspect(storedPath(row));
    return {
      id: row.id,
      expectedSha256: row.sha256,
      actualSha256,
      intact: size === row.byte_size && actualSha256 === row.sha256,
      missingFile,
    };
  }

  function history(resultId, user) {
    const owned = user.role === "executor";
    return db.prepare(
      `SELECT * FROM evidence_versions WHERE result_id=? ${owned ? "AND uploaded_by=?" : ""}
       ORDER BY created_at, logical_file_id, revision`,
    ).all(...(owned ? [resultId, user.id] : [resultId])).map(metadata);
  }

  async function upload(req, resultId) {
    const actorId = req.user.id;
    assertResultEditor(db, req.user, readResultForUser(db, req.user, resultId));
    const storageKey = randomUUID();
    const path = join(storage, storageKey);
    const temp = path + ".tmp";
    let moved = false;
    try {
      const file = await readUpload(req, temp);
      return transaction(db, () => {
        const user = db.prepare("SELECT id, role FROM users WHERE id=? AND active=1").get(actorId);
        if (!user) throw new ApiError(401, "unauthenticated", "Користувач недоступний");
        const result = readResultForUser(db, user, resultId);
        assertResultEditor(db, user, result);
        if (result.version !== file.version) throw conflict();

        let revision = 1;
        if (file.logicalFileId) {
          const prior = db.prepare(
            `SELECT * FROM evidence_versions
             WHERE result_id=? AND uploaded_by=? AND logical_file_id=?
             ORDER BY revision DESC LIMIT 1`,
          ).get(resultId, user.id, file.logicalFileId);
          if (!prior) missing();
          revision = prior.revision + 1;
          if (revision > maxRevisions)
            invalid("Для одного доказу доступно не більше 20 версій");
        } else {
          const count = db.prepare(
            "SELECT count(DISTINCT logical_file_id) AS n FROM evidence_versions WHERE result_id=? AND uploaded_by=?",
          ).get(resultId, user.id).n;
          if (count >= maxFiles)
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
          created_at: new Date().toISOString(),
        };
        renameSync(temp, path);
        moved = true;
        db.prepare(
          `INSERT INTO evidence_versions
            (id,result_id,logical_file_id,revision,original_name,storage_key,media_type,byte_size,sha256,uploaded_by,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          row.id, row.result_id, row.logical_file_id, row.revision, row.original_name,
          row.storage_key, row.media_type, row.byte_size, row.sha256, row.uploaded_by, row.created_at,
        );
        const updated = db.prepare(
          "UPDATE results SET version=version+1,updated_at=? WHERE id=? AND version=?",
        ).run(row.created_at, resultId, file.version);
        if (!updated.changes) throw conflict();
        const evidence = metadata(row);
        audit(db, user.id, revision === 1 ? "upload" : "replace", "evidence", row.id, null, evidence);
        return { evidence, resultVersion: file.version + 1 };
      });
    } catch (error) {
      if (moved) removeFile(path);
      if (error.code === "ENOSPC" || error.code === "EDQUOT")
        throw new ApiError(507, "insufficient_storage", "У сховищі доказів бракує місця");
      throw error;
    } finally {
      if (!moved) removeFile(temp);
    }
  }

  return { history, verify: (row) => integrity(row).intact, integrity, storedPath, upload };
}

export function mountEvidenceRoutes(app, db, evidence) {
  function findReadable(req) {
    const row = db.prepare("SELECT * FROM evidence_versions WHERE id=?").get(uuid(req.params.id));
    if (!row || (req.user.role === "executor" && row.uploaded_by !== req.user.id)) missing();
    readResultForUser(db, req.user, row.result_id);
    return row;
  }

  app.post("/api/results/:id/evidence", async (req, res) => {
    keys(req.query, []);
    const result = await evidence.upload(req, uuid(req.params.id));
    res.status(201).json(result);
  });

  app.get("/api/evidence/:id/download", (req, res, next) => {
    keys(req.query, []);
    const row = findReadable(req);
    const { intact, missingFile } = evidence.integrity(row);
    if (missingFile) missing();
    if (!intact) throw new ApiError(409, "evidence_integrity_failed", "Цілісність доказу порушено");
    res.attachment(row.original_name);
    res.type(row.media_type);
    res.set("X-Content-Type-Options", "nosniff");
    res.sendFile(evidence.storedPath(row), {
      acceptRanges: false,
      cacheControl: false,
      lastModified: false,
    }, (error) => {
      if (!error) return;
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        next(error.code === "ENOENT" || error.status === 404
          ? new ApiError(404, "not_found", "Доказ не знайдено")
          : error);
      } else {
        next(error);
      }
    });
  });

  app.get("/api/evidence/:id/integrity", (req, res) => {
    keys(req.query, []);
    if (!["coordinator", "admin"].includes(req.user.role)) forbidden();
    const { id, expectedSha256, actualSha256, intact } = evidence.integrity(findReadable(req));
    res.json({ id, expectedSha256, actualSha256, intact });
  });
}
