import { ConfigurationError } from "../errors/index";
import { Result } from "better-result";

export function normalizePeerEndpointIdentityResult(
  raw: string,
  tlsEnabled: boolean,
): Result<string, ConfigurationError> {
  const value = raw.trim();
  if (!value) {
    return endpointConfigurationError("peer endpoint must be a non-empty host:port value");
  }

  const lower = value.toLowerCase();
  let scheme = tlsEnabled ? "grpcs" : "grpc";
  let hostPort = value;
  if (lower.startsWith("grpc://") || lower.startsWith("grpcs://")) {
    const parsed = new URL(value);
    if (parsed.protocol !== "grpc:" && parsed.protocol !== "grpcs:") {
      return endpointConfigurationError(`peer endpoint scheme must be grpc or grpcs: ${raw}`);
    }
    if (!["", "/"].includes(parsed.pathname) || parsed.search || parsed.hash || !parsed.hostname || !parsed.port) {
      return endpointConfigurationError(`peer endpoint must be grpc(s)://host:port: ${raw}`);
    }
    scheme = parsed.protocol.slice(0, -1);
    hostPort = `${parsed.hostname}:${parsed.port}`;
  } else if (value.includes("://")) {
    return endpointConfigurationError(`peer endpoint scheme must be grpc or grpcs: ${raw}`);
  }

  const separator = hostPort.lastIndexOf(":");
  if (separator <= 0 || separator === hostPort.length - 1) {
    return endpointConfigurationError(`peer endpoint must include host:port: ${raw}`);
  }

  const host = hostPort.slice(0, separator).toLowerCase();
  const port = hostPort.slice(separator + 1);
  if (!/^\d+$/.test(port)) {
    return endpointConfigurationError(`peer endpoint port must be numeric: ${raw}`);
  }

  return Result.ok(`${scheme}://${host}:${port}`);
}

export function normalizePeerEndpointIdentity(raw: string, tlsEnabled: boolean): string {
  const normalized = normalizePeerEndpointIdentityResult(raw, tlsEnabled);
  if (!normalized.isOk()) {
    throw normalized.error;
  }
  return normalized.value;
}

export function dedupePeerEndpointInputsResult(
  inputs: string[],
  tlsEnabled: boolean,
): Result<string[], ConfigurationError> {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const canonical = normalizePeerEndpointIdentityResult(input, tlsEnabled);
    if (!canonical.isOk()) {
      return Result.err(canonical.error);
    }
    if (seen.has(canonical.value)) {
      continue;
    }
    out.push(canonical.value);
    seen.add(canonical.value);
  }

  return Result.ok(out);
}

export function dedupePeerEndpointInputs(inputs: string[], tlsEnabled: boolean): string[] {
  const deduped = dedupePeerEndpointInputsResult(inputs, tlsEnabled);
  if (!deduped.isOk()) {
    throw deduped.error;
  }
  return deduped.value;
}

export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    const separator = endpoint.lastIndexOf(":");
    return separator > 0 ? endpoint.slice(0, separator) : endpoint;
  }
}

function endpointConfigurationError(message: string): Result<never, ConfigurationError> {
  return Result.err(
    new ConfigurationError({
      field: "peerEndpoint",
      message,
    }),
  );
}
