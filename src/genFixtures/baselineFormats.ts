/**
 * Static prerequisite proofs, not a general format validator. Deliberately
 * conservative subsets are documented in USAGE; never widen the mock walker.
 */
function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function dateTime(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !calendarDate(match[1]!)) return false;
  return (
    Number(match[2]) <= 23 &&
    Number(match[3]) <= 59 &&
    Number(match[4]) <= 59 &&
    (match[5] === undefined || (Number(match[5]) <= 23 && Number(match[6]) <= 59))
  );
}

function dnsName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 253 &&
    value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  );
}

function email(value: string): boolean {
  const parts = value.split("@");
  if (parts.length !== 2 || value.length > 254) return false;
  const [local, domain] = parts as [string, string];
  return (
    local.length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) &&
    dnsName(domain) &&
    domain.includes(".") &&
    /^[A-Za-z]{2,63}$/.test(domain.slice(domain.lastIndexOf(".") + 1))
  );
}

function httpUri(value: string): boolean {
  // RFC 3986 ASCII component syntax, not WHATWG's permissive repair rules.
  // No userinfo, IPv6 literals, non-HTTP schemes, IRI conversion, or DNS I/O.
  const match = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value);
  if (!match || /%(?![0-9a-f]{2})/i.test(value)) return false;
  const component = /^[A-Za-z0-9._~!$&'()*+,;=:@/%?-]*$/;
  if (![match[2], match[3] ?? "", match[4] ?? ""].every((part) => component.test(part!))) {
    return false;
  }
  const authority = /^([^:]+)(?::([0-9]+))?$/.exec(match[1]!);
  if (!authority || !dnsName(authority[1]!)) return false;
  if (authority[2] !== undefined && Number(authority[2]) > 65535) return false;
  try {
    const url = new URL(value);
    // Reject URL's alternate/normalized IPv4 spellings rather than proving
    // something other than the authority supplied in the static baseline.
    return url.hostname === authority[1]!.toLowerCase();
  } catch {
    return false;
  }
}

export function validBaselineFormat(value: string, format: string): boolean {
  if (/[^\x21-\x7e]/.test(value)) return false;
  switch (format) {
    case "date":
      return calendarDate(value);
    case "date-time":
      return dateTime(value);
    case "uuid":
      return (
        value.toLowerCase() === "00000000-0000-0000-0000-000000000000" ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      );
    case "email":
      return email(value);
    case "uri":
      return httpUri(value);
    default:
      return false;
  }
}
