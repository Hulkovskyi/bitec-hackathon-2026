import { ApiError } from "./validation.js";

export const hostedEvidenceLimit = 4 * 1024 * 1024;
const storageId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validStorageKey(key) {
  return typeof key === "string" && storageId.test(key);
}

export function assertStorageKey(key) {
  if (!validStorageKey(key)) throw new Error("Invalid evidence storage key");
}

export class OversizedEvidenceObject extends Error {}

const unavailable = () =>
  new ApiError(503, "evidence_storage_unavailable", "Сховище доказів тимчасово недоступне");

function authorize(secretKey) {
  if (typeof secretKey === "string" && secretKey.startsWith("sb_secret_") && secretKey.length > 10)
    return { apikey: secretKey };
  try {
    const [header, payload, signature, extra] = secretKey?.split(".") ?? [];
    if (header && payload && signature && extra === undefined &&
      JSON.parse(Buffer.from(payload, "base64url")).role === "service_role") {
      return { apikey: secretKey, Authorization: "Bearer " + secretKey };
    }
  } catch {
    // A malformed or publishable key must not be used by the server.
  }
  throw new Error("An elevated Supabase secret key is required for evidence storage");
}

async function readBounded(response, maxBytes) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new OversizedEvidenceObject();
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new OversizedEvidenceObject();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function createSupabaseEvidenceStorage({ url, secretKey, bucket, fetch: request = globalThis.fetch }) {
  const project = new URL(url);
  if (project.protocol !== "https:" || project.username || project.password ||
    project.pathname !== "/" || project.search || project.hash)
    throw new Error("Supabase evidence storage requires a project HTTPS origin");
  if (typeof bucket !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(bucket))
    throw new Error("A valid Supabase evidence bucket name is required");
  const root = project.origin + "/storage/v1";
  const headers = authorize(secretKey);
  let bucketCheck;

  async function send(path, options = {}) {
    try {
      return await request(root + path, {
        ...options,
        headers: { ...headers, ...options.headers },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw unavailable();
    }
  }

  async function checkPrivateBucket() {
    bucketCheck ??= (async () => {
      const response = await send("/bucket/" + bucket);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const details = await response.json().catch(() => null);
      if (details?.id !== bucket || details.public !== false) throw unavailable();
    })().catch((error) => {
      bucketCheck = undefined;
      throw error;
    });
    await bucketCheck;
  }

  return {
    maxBytes: hostedEvidenceLimit,
    checkPrivateBucket,
    async put(key, bytes, mediaType) {
      assertStorageKey(key);
      if (bytes.length > hostedEvidenceLimit) throw new OversizedEvidenceObject();
      await checkPrivateBucket();
      const response = await send("/object/" + bucket + "/" + key, {
        method: "POST",
        headers: { "Content-Type": mediaType, "x-upsert": "false" },
        body: bytes,
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw unavailable();
    },
    async get(key) {
      assertStorageKey(key);
      await checkPrivateBucket();
      const response = await send("/object/authenticated/" + bucket + "/" + key);
      if (!response.ok) {
        // The legacy Storage error shape may carry a 404 code in a 400 response.
        const { status } = response;
        if (status === 404 || status === 400) {
          const detail = await response.json().catch(() => null);
          if (detail?.code === "NoSuchKey" ||
            ((status === 404 || String(detail?.statusCode) === "404") &&
              (detail?.error === "not_found" || detail?.error === "Not Found") &&
              /(?:object|key) not found/i.test(detail?.message ?? ""))) return null;
        } else {
          await response.body?.cancel().catch(() => {});
        }
        throw unavailable();
      }
      try {
        return await readBounded(response, hostedEvidenceLimit);
      } catch (error) {
        if (error instanceof OversizedEvidenceObject) throw error;
        throw unavailable();
      }
    },
    async delete(key) {
      assertStorageKey(key);
      await checkPrivateBucket();
      const response = await send("/object/" + bucket, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [key] }),
      });
      await response.body?.cancel().catch(() => {});
      if (!response.ok) throw unavailable();
    },
  };
}
