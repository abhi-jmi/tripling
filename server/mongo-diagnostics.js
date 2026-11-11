// Return only fixed categories/error codes. Driver messages can contain hosts,
// URIs or usernames, so never include them (or stack traces) in probe logs.
const knownCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
]);
const knownTypes = new Set([
  "MongoServerSelectionError",
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerError",
  "MongoParseError",
  "MongoAPIError",
  "MongoInvalidArgumentError",
  "AccessDeniedException",
  "ResourceNotFoundException",
  "DecryptionFailure",
  "CredentialsProviderError",
]);
export function mongoFailureDetails(error) {
  const categories = new Set(),
    codes = new Set(),
    types = new Set(),
    queue = [error],
    seen = new Set();
  while (queue.length && seen.size < 40) {
    const e = queue.shift();
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    if (knownTypes.has(e.name)) types.add(e.name);
    if (typeof e.code === "number" && Number.isSafeInteger(e.code))
      codes.add(e.code);
    else if (knownCodes.has(e.code)) codes.add(e.code);
    // Classify a message internally, but never log the message itself.
    const text = typeof e.message === "string" ? e.message : "";
    if (
      [18, 8000].includes(e.code) ||
      /authentication failed|bad auth/i.test(text)
    )
      categories.add("authentication");
    if (e.code === 13) categories.add("database_permission");
    if (
      ["ENOTFOUND", "EAI_AGAIN"].includes(e.code) ||
      /querySrv|queryTxt/.test(text)
    )
      categories.add("dns");
    if (
      /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/.test(
        String(e.code || ""),
      ) ||
      /certificate|TLS handshake|SSL routines/i.test(text)
    )
      categories.add("tls");
    if (
      [
        "ETIMEDOUT",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "ECONNREFUSED",
        "ECONNRESET",
      ].includes(e.code)
    )
      categories.add("network");
    if (e.name === "MongoServerSelectionError")
      categories.add("server_selection");
    if (e.name === "MongoNetworkTimeoutError" || /timed out/i.test(text))
      categories.add("timeout");
    if (
      [
        "AccessDeniedException",
        "ResourceNotFoundException",
        "DecryptionFailure",
        "CredentialsProviderError",
      ].includes(e.name)
    )
      categories.add("aws_secret_access");
    if (
      ["MongoParseError", "MongoInvalidArgumentError"].includes(e.name) ||
      /Configure MONGODB|MongoDB secret must|requires verified TLS/i.test(text)
    )
      categories.add("configuration");
    if (e.cause) queue.push(e.cause);
    if (e.reason) queue.push(e.reason);
    if (e.servers instanceof Map)
      for (const server of e.servers.values())
        if (server?.error) queue.push(server.error);
  }
  return { categories: [...categories], codes: [...codes], types: [...types] };
}
