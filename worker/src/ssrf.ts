function parseIpv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isPrivateIpv4Octets(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

/**
 * Expands any IPv6 string (including `::` shorthand and dotted IPv4 tail)
 * into eight 16-bit integer groups.
 */
function expandIpv6Groups(rawHost: string): number[] | null {
  const stripped =
    rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
  const host = stripped.split("%")[0]!.toLowerCase();
  if (!host.includes(":")) {
    return null;
  }

  let working = host;
  const lastColon = working.lastIndexOf(":");
  const tail = working.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = parseIpv4Octets(tail);
    if (!octets) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = working.split("::");
  if (halves.length > 2) {
    return null;
  }

  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const totalProvided = left.length + right.length;
  if (halves.length === 1 && totalProvided !== 8) {
    return null;
  }
  if (halves.length === 2 && totalProvided >= 8) {
    return null;
  }

  const missing = halves.length === 2 ? 8 - totalProvided : 0;
  const tokens = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (tokens.length !== 8) {
    return null;
  }

  const groups: number[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-f]{1,4}$/.test(token)) {
      return null;
    }
    groups.push(Number.parseInt(token, 16));
  }
  return groups;
}

export function isPrivateOrReservedHost(hostname: string): boolean {
  const bare = (
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname
  )
    .trim()
    .toLowerCase();

  if (!bare) {
    return true;
  }

  if (
    bare === "localhost" ||
    bare.endsWith(".localhost") ||
    bare.endsWith(".local") ||
    bare.endsWith(".internal") ||
    bare.endsWith(".home.arpa")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Octets(bare);
  if (ipv4) {
    return isPrivateIpv4Octets(ipv4);
  }

  const ipv6 = expandIpv6Groups(bare);
  if (ipv6) {
    const allZero = ipv6.every((g) => g === 0);
    const isLoopback = ipv6.slice(0, 7).every((g) => g === 0) && ipv6[7] === 1;
    if (allZero || isLoopback) {
      return true;
    }
    const first = ipv6[0]!;
    // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
    if (
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00
    ) {
      return true;
    }
    // IPv4-mapped IPv6 ::ffff:a.b.c.d
    const isV4Mapped =
      ipv6[0] === 0 &&
      ipv6[1] === 0 &&
      ipv6[2] === 0 &&
      ipv6[3] === 0 &&
      ipv6[4] === 0 &&
      ipv6[5] === 0xffff;
    if (isV4Mapped) {
      const g6 = ipv6[6]!;
      const g7 = ipv6[7]!;
      return isPrivateIpv4Octets([
        (g6 >> 8) & 0xff,
        g6 & 0xff,
        (g7 >> 8) & 0xff,
        g7 & 0xff,
      ]);
    }
  }

  return false;
}
