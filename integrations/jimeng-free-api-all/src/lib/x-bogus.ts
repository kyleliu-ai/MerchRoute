import { createHash } from "crypto";

const SHIFT_ARRAY =
  "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe";
const MAGIC = 536919696;

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

function md5Double(input: string): string {
  const first = createHash("md5").update(input).digest();
  return createHash("md5").update(first).digest("hex");
}

function rc4Encrypt(plaintext: string, key: number[]): string {
  const sBox = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + sBox[i] + key[i % key.length]) & 0xff;
    [sBox[i], sBox[j]] = [sBox[j], sBox[i]];
  }
  let i2 = 0;
  let j2 = 0;
  let result = "";
  for (let k = 0; k < plaintext.length; k++) {
    i2 = (i2 + 1) & 0xff;
    j2 = (j2 + sBox[i2]) & 0xff;
    [sBox[i2], sBox[j2]] = [sBox[j2], sBox[i2]];
    const keystream = sBox[(sBox[i2] + sBox[j2]) & 0xff];
    result += String.fromCharCode(plaintext.charCodeAt(k) ^ keystream);
  }
  return result;
}

function b64Encode(
  input: string,
  alphabet: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
): string {
  const result: string[] = [];
  for (let i = 0; i < input.length; i += 3) {
    const num1 = input.charCodeAt(i);
    const num2 = i + 1 < input.length ? input.charCodeAt(i + 1) : -1;
    const num3 = i + 2 < input.length ? input.charCodeAt(i + 2) : -1;

    const arr1 = num1 >> 2;
    const arr2 = num2 >= 0 ? ((3 & num1) << 4) | (num2 >> 4) : (3 & num1) << 4;
    const arr3 = num2 >= 0 ? ((15 & num2) << 2) | (num3! >> 6) : 64;
    const arr4 = num3 >= 0 ? 63 & num3 : 64;

    result.push(alphabet[arr1], alphabet[arr2], alphabet[arr3], alphabet[arr4]);
  }
  return result.join("");
}

function filterList(numList: number[]): number[] {
  const indices = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  return indices.map((x) => numList[x - 1]);
}

function scramble(chars: number[]): string {
  const [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p, q, r, s] = chars;
  return String.fromCharCode(
    a, k, b, l, c, m, d, n, e, o, f, p, g, q, h, r, i, s, j
  );
}

function computeChecksum(saltList: number[]): number {
  let cs = 64;
  for (let i = 3; i < saltList.length; i++) {
    cs ^= saltList[i];
  }
  return cs;
}

function xBogus(params: string, userAgent: string, timestamp: number, data: string = ""): string {
  const md5Data = md5Double(data);
  const md5Params = md5Double(params);

  const rc4Ua = rc4Encrypt(userAgent, [0, 1, 14]);
  const b64Ua = b64Encode(rc4Ua);
  const md5Ua = md5Hex(b64Ua);

  const md5ParamsBytes = Buffer.from(md5Params, "hex");
  const md5DataBytes = Buffer.from(md5Data, "hex");
  const md5UaBytes = Buffer.from(md5Ua, "hex");

  const saltList: number[] = [
    timestamp,
    MAGIC,
    64,
    0,
    1,
    14,
    md5ParamsBytes[md5ParamsBytes.length - 2],
    md5ParamsBytes[md5ParamsBytes.length - 1],
    md5DataBytes[md5DataBytes.length - 2],
    md5DataBytes[md5DataBytes.length - 1],
    md5UaBytes[md5UaBytes.length - 2],
    md5UaBytes[md5UaBytes.length - 1],
  ];

  // Python: range(24, -1, -8) = [24, 16, 8, 0] → 4 bytes
  saltList.push((timestamp >> 24) & 0xff);
  saltList.push((timestamp >> 16) & 0xff);
  saltList.push((timestamp >> 8) & 0xff);
  saltList.push(timestamp & 0xff);

  // Append magic as 4 big-endian bytes
  saltList.push((saltList[1] >> 24) & 0xff);
  saltList.push((saltList[1] >> 16) & 0xff);
  saltList.push((saltList[1] >> 8) & 0xff);
  saltList.push(saltList[1] & 0xff);

  saltList.push(computeChecksum(saltList));
  saltList.push(255);

  const numList = filterList(saltList);
  const rc4Result = rc4Encrypt(scramble(numList), [255]);

  const prefixed = "\x02\xff" + rc4Result;
  return b64Encode(prefixed, SHIFT_ARRAY);
}

/**
 * Sign URL params with X-Bogus
 * @param params Query string (e.g. "aid=513641&device_platform=web")
 * @param userAgent User-Agent string
 * @param data Request body (POST data)
 * @returns params with &X-Bogus=<value> appended
 */
export function signXBogus(params: string, userAgent: string, data: string = ""): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const bogus = xBogus(params, userAgent, timestamp, data);
  return params + "&X-Bogus=" + bogus;
}
