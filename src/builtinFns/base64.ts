import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

/**
 * `base64` — encode and decode.
 *
 * Three things about this name are worth saying out loud.
 *
 * **It shadows coreutils.** `/usr/bin/base64` takes a path and encodes the
 * FILE; crust's `base64` takes a string and encodes the TEXT. `base64 in.ts`
 * is `aW4udHM=`, the five characters of the path, not the file's bytes. Switching
 * on "does this string exist on disk" is not the fix: `read list.txt | base64`
 * would then depend on the caller's cwd, so the same line would encode text
 * here and a file there. The file is an explicit `--file`, and it is worth
 * having because crust has no other binary-safe route — `read logo.png | base64`
 * decodes the file as UTF-8 first, and every invalid byte becomes U+FFFD
 * (measured on a 26-byte PNG: `77+9…` where coreutils gives `iVBORw0…`).
 *
 * **Options are only ever what you typed.** A registered function is called
 * `fn(item, ...args)` mid-pipeline, so the ITEM lands in the same slot an option
 * would, and this file used to scan every argument for `-d`. Data that says `-d`
 * was then read as the mode and the input vanished: `printf '%s' -d | crust -c
 * 'stdin | base64'` printed `base64: missing input` and exited 1 where the
 * obvious answer is `LWQ=`. `base64Stage` takes the line's arguments and the
 * item separately, so an item is data and nothing else; the parser dispatches it
 * by function identity, the way it dispatches `sql`.
 *
 * The surface is therefore `-d`/`--decode`, `-f`/`--file <path>`,
 * `-o`/`--out <path>`, and `--`. Anything else that starts with a dash is
 * refused, not encoded. And decoding checks its input: Node's base64 decoder
 * skips characters it does not know, so `not base64!!!` used to decode into
 * replacement characters with exit 0. See `NOT_BASE64`.
 */

interface Options {
  decode: boolean;
  file?: string;
  out?: string;
}

function needsValue(flag: string, next: unknown): string {
  if (typeof next !== "string" || next.length === 0) {
    throw new Error(`base64: ${flag} needs a path`);
  }
  return next;
}

/** Parse the arguments written on the line. Never call this with a piped item. */
function parseOptions(args: unknown[]): { opts: Options; operands: string[] } {
  const opts: Options = { decode: false };
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined || a === null) continue;
    const s = typeof a === "string" ? a : String(a);
    if (s === "-d" || s === "--decode" || s === "decode") {
      opts.decode = true;
      continue;
    }
    if (s === "-f" || s === "--file") {
      opts.file = needsValue(s, args[++i]);
      continue;
    }
    if (s.startsWith("--file=")) {
      opts.file = s.slice("--file=".length);
      continue;
    }
    if (s === "-o" || s === "--out") {
      opts.out = needsValue(s, args[++i]);
      continue;
    }
    if (s.startsWith("--out=")) {
      opts.out = s.slice("--out=".length);
      continue;
    }
    if (s === "--") {
      // Everything after the terminator is an operand: `base64 -- -d` encodes
      // the two characters `-d`, the way every other crust CLI spells it.
      for (let j = i + 1; j < args.length; j++) {
        const rest = args[j];
        if (rest !== undefined && rest !== null) operands.push(String(rest));
      }
      break;
    }
    // A dash-led word that is not one of ours is a typo, and a typo that is
    // encoded instead of refused turns `base64 --desc hello` into `LS1kZXNj`
    // with the real input dropped and exit 0. A negative number is data.
    if (s.startsWith("-") && s.length > 1 && !/^-\d/.test(s)) {
      throw new Error(
        `base64: unknown option "${s}" — options are -d/--decode, -f/--file <path>, -o/--out <path> ` +
          `(to encode or decode a value that starts with a dash, put it after --)`,
      );
    }
    operands.push(s);
  }
  return { opts, operands };
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The codec itself: `input` is the raw bytes to act on, so encoding is
 * binary-safe by construction and `--decode` reads them as base64 text.
 */
function render(input: Buffer, opts: Options): string {
  if (!opts.decode) {
    const text = input.toString("base64");
    return opts.out === undefined ? text : writeTo(opts.out, Buffer.from(text, "utf8"));
  }
  const decoded = decodeBytes(input);
  return opts.out === undefined ? decoded.toString("utf8") : writeTo(opts.out, decoded);
}

function writeTo(path: string, bytes: Buffer): string {
  writeFileSync(path, bytes);
  return `wrote ${bytes.length} bytes to ${path}`;
}

function readTheFile(path: string): Buffer {
  if (!isFile(path)) throw new Error(`base64: no such file: ${path}`);
  return readFileSync(path);
}

// The characters a base64 payload may contain: the standard alphabet, the
// URL-safe pair (crust produces it — `salt 32 base64url`), and whitespace,
// which Node's decoder skips. Anything else is not base64, and Node's decoder
// does not say so: it skips the character and decodes what is left, so
// `printf 'not base64!!!' | crust -c 'stdin | base64 -d'` printed three
// replacement characters and exited 0. This is the character that says otherwise.
const NOT_BASE64 = /[^A-Za-z0-9+/=\s\-_]/;

function decodeBytes(input: Buffer): Buffer {
  const text = input.toString("utf8");
  const bad = text.match(NOT_BASE64);
  if (bad) {
    throw new Error(
      `base64: cannot decode ${JSON.stringify(text.trim().slice(0, 32))} — ` +
        `${JSON.stringify(bad[0])} is not a base64 character ` +
        "(A-Za-z0-9+/=, base64url's - and _, and whitespace; for a signed token use `jwt decode`)",
    );
  }
  return Buffer.from(text, "base64");
}

function refuseTwoInputs(operand: string, flag: string): never {
  throw new Error(
    `base64: --${flag} names an input and "${operand}" is another — one input per line`,
  );
}

/**
 * Head of a line (`base64 hello`): every argument was typed by the caller, so
 * every argument is parsed as an option or an operand.
 */
export function base64(...args: unknown[]): string {
  // A caller in JS (`base64(buffer)`) can hand over bytes directly; a crust
  // line can only ever hand over strings. Bytes win, as they did before.
  const binary = args.find((a): a is Uint8Array => a instanceof Uint8Array);
  const { opts, operands } = parseOptions(args.filter((a) => !(a instanceof Uint8Array)));
  if (binary !== undefined) {
    if (opts.file !== undefined) {
      throw new Error(
        `base64: --file ${opts.file} names an input and the bytes you passed are another — one input per line`,
      );
    }
    if (opts.decode) throw new Error("base64: cannot decode a binary input");
    return render(Buffer.from(binary), opts);
  }
  if (opts.file !== undefined) {
    if (operands.length > 0) refuseTwoInputs(operands[0]!, "file");
    return render(readTheFile(opts.file), opts);
  }
  if (operands.length === 0) {
    throw new Error("base64: missing input");
  }
  if (operands.length > 1) {
    throw new Error(
      `base64: more than one input ("${operands[0]}" and "${operands[1]}") — one operand per line, ` +
        "or --file <path>",
    );
  }
  const value = operands[0]!;
  if (isFile(value)) {
    // The shadow, said out loud at the moment someone would be bitten by it.
    // The answer is still the text — that is what this verb means here — so the
    // note goes to stderr and the stdout of a working line does not change.
    process.stderr.write(
      `note: "${value}" is a file here, but crust's base64 encodes the TEXT of its argument — ` +
        `pass --file ${value} to encode the file's bytes.\n`,
    );
  }
  return render(Buffer.from(value, "utf8"), opts);
}

/**
 * Mid-pipeline: the item is data — encoded, never parsed for options — and the
 * options are the arguments written after the pipe on the line.
 */
export function base64Stage(args: unknown[], item: unknown): string {
  const { opts, operands } = parseOptions(args);
  if (operands.length > 0) {
    throw new Error(
      `base64: "${operands[0]}" is not an option, and piped input is already the input — ` +
        "one input per line",
    );
  }
  if (opts.file !== undefined) {
    throw new Error(
      `base64: --file reads a file and does not consume piped input — put \`base64 --file ${opts.file}\` ` +
        "at the head of the line",
    );
  }
  if (item instanceof Uint8Array) {
    if (opts.decode) throw new Error("base64: cannot decode a binary input");
    return render(Buffer.from(item), opts);
  }
  if (item === undefined || item === null) {
    throw new Error("base64: missing input");
  }
  const text = typeof item === "object" ? JSON.stringify(item) : String(item);
  return render(Buffer.from(text, "utf8"), opts);
}
