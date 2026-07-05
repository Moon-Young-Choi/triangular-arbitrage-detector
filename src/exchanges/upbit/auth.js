const crypto = require("node:crypto");

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function normalizeQueryPairs(input) {
  if (!input) return [];

  if (typeof input === "string") {
    return input
      .replace(/^\?/u, "")
      .split("&")
      .filter(Boolean)
      .map((part) => {
        const [key, ...valueParts] = part.split("=");
        return [key, valueParts.join("=")];
      });
  }

  if (input instanceof URLSearchParams) {
    return [...input.entries()];
  }

  return Object.entries(input).flatMap(([key, value]) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) {
      return value.map((item) => [key, item]);
    }
    return [[key, value]];
  });
}

function createQueryString(input) {
  return normalizeQueryPairs(input)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function createQueryHash(input) {
  const queryString = createQueryString(input);

  if (!queryString) {
    return null;
  }

  return crypto.createHash("sha512").update(queryString, "utf8").digest("hex");
}

function createJwtToken(options = {}) {
  const {
    accessKey,
    secretKey,
    query,
    nonce = crypto.randomUUID(),
  } = options;

  if (!accessKey) {
    throw new Error("accessKey is required");
  }

  if (!secretKey) {
    throw new Error("secretKey is required");
  }

  const header = {
    alg: "HS512",
    typ: "JWT",
  };
  const payload = {
    access_key: accessKey,
    nonce,
  };
  const queryHash = createQueryHash(query);

  if (queryHash) {
    payload.query_hash = queryHash;
    payload.query_hash_alg = "SHA512";
  }

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha512", secretKey)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

module.exports = {
  base64UrlEncode,
  createQueryString,
  createQueryHash,
  createJwtToken,
};
