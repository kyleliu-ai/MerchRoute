import { createHash } from "crypto";

const CUSTOM_ALPHABET = "u09tbS3UvgDEe6r-ZVMXzLpsAohTn7mdINQlW412GqBjfYiyk8JORCF5/xKHwacP=";
const MASK_32 = 0xffffffff;

const CRYPTO_CONSTANTS = [
  0xffffffff, 138, 1498001188, 211147047, 253, null, 203, 288, 9,
  1196819126, 3212677781, 135, 263, 193, 58, 18, 244, 2931180889, 240, 173,
  268, 2157053261, 261, 175, 14, 5, 171, 270, 156, 258, 13, 15, 3732962506,
  185, 169, 2, 6, 132, 162, 200, 3, 160, 217618912, 62, 2517678443, 44, 164,
  4, 96, 183, 2903579748, 3863347763, 119, 181, 10, 190, 8, 2654435769, 259,
  104, 230, 128, 2633865432, 225, 1, 257, 143, 179, 16, 600974999, 185100057,
  32, 188, 53, 2718276124, 177, 196, 4294967296, 147, 117, 17, 49, 7, 28, 12,
  266, 216, 11, 0, 45, 166, 247, 1451689750,
];

const CHACHA_INITIAL_STATE = [
  CRYPTO_CONSTANTS[9],   // 1196819126
  CRYPTO_CONSTANTS[69],  // 600974999
  CRYPTO_CONSTANTS[51],  // 2903579748
  CRYPTO_CONSTANTS[92],  // 1451689750
];

function ensure32(value: number): number {
  return value & MASK_32;
}

function rotateLeft(value: number, shift: number): number {
  return ensure32((value << shift) | (value >>> (32 - shift)));
}

function chachaQuarterRound(state: number[], a: number, b: number, c: number, d: number): void {
  state[a] = ensure32(state[a] + state[b]);
  state[d] = rotateLeft(state[d] ^ state[a], 16);
  state[c] = ensure32(state[c] + state[d]);
  state[b] = rotateLeft(state[b] ^ state[c], 12);
  state[a] = ensure32(state[a] + state[b]);
  state[d] = rotateLeft(state[d] ^ state[a], 8);
  state[c] = ensure32(state[c] + state[d]);
  state[b] = rotateLeft(state[b] ^ state[c], 7);
}

function chachaBlockFunction(initialState: number[], numRounds: number): number[] {
  const working = [...initialState];
  let roundCount = 0;
  while (roundCount < numRounds) {
    // Column rounds
    chachaQuarterRound(working, 0, 4, 8, 12);
    chachaQuarterRound(working, 1, 5, 9, 13);
    chachaQuarterRound(working, 2, 6, 10, 14);
    chachaQuarterRound(working, 3, 7, 11, 15);
    roundCount++;
    if (roundCount >= numRounds) break;
    // Diagonal rounds
    chachaQuarterRound(working, 0, 5, 10, 15);
    chachaQuarterRound(working, 1, 6, 11, 12);
    chachaQuarterRound(working, 2, 7, 12, 13);
    chachaQuarterRound(working, 3, 4, 13, 14);
    roundCount++;
  }
  for (let i = 0; i < 16; i++) {
    working[i] = ensure32(working[i] + initialState[i]);
  }
  return working;
}

// Module-level PRNG state
let prngState: number[] = initializePrngState();
let stateIndex = CRYPTO_CONSTANTS[88] as number; // 0

function initializePrngState(): number[] {
  const tsMs = Date.now();
  return [
    CRYPTO_CONSTANTS[44] as number,
    CRYPTO_CONSTANTS[74] as number,
    CRYPTO_CONSTANTS[10] as number,
    CRYPTO_CONSTANTS[62] as number,
    CRYPTO_CONSTANTS[42] as number,
    CRYPTO_CONSTANTS[17] as number,
    CRYPTO_CONSTANTS[2] as number,
    CRYPTO_CONSTANTS[21] as number,
    CRYPTO_CONSTANTS[3] as number,
    CRYPTO_CONSTANTS[70] as number,
    CRYPTO_CONSTANTS[50] as number,
    CRYPTO_CONSTANTS[32] as number,
    (CRYPTO_CONSTANTS[0] as number) & tsMs,
    Math.floor(Math.random() * ((CRYPTO_CONSTANTS[77] as number) - 1)),
    Math.floor(Math.random() * ((CRYPTO_CONSTANTS[77] as number) - 1)),
    Math.floor(Math.random() * ((CRYPTO_CONSTANTS[77] as number) - 1)),
  ];
}

function generateRandomFloat(): number {
  const blockOutput = chachaBlockFunction(prngState, 8);
  const randomValue = blockOutput[stateIndex];
  const highBits = (blockOutput[stateIndex + 8] & 0xfffffff0) >>> 11;
  if (stateIndex === 7) {
    prngState[12] = ensure32(prngState[12] + 1);
    stateIndex = 0;
  } else {
    stateIndex++;
  }
  return (randomValue + 4294967296 * highBits) / (2 ** 53);
}

function convertNumberToBytes(value: number): number[] {
  if (value < 255 * 255) {
    return [(value >> 8) & 0xff, value & 0xff];
  }
  return [
    (value >> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  ];
}

function stringToBigEndianInt(input: string): number {
  const buf = Buffer.from(input.substring(0, 4), "utf-8");
  let acc = 0;
  for (const byte of buf) {
    acc = ((acc << 8) | byte) >>> 0;
  }
  return acc;
}

function chachaEncryptData(keyWords: number[], rounds: number, data: Buffer): void {
  const fullWordsCount = Math.floor(data.length / 4);
  const remainingBytes = data.length % 4;
  const totalWords = Math.ceil(data.length / 4);
  const wordArray = new Int32Array(totalWords);

  for (let i = 0; i < fullWordsCount; i++) {
    const bi = 4 * i;
    wordArray[i] = ((data[bi]!) | (data[bi + 1]! << 8) | (data[bi + 2]! << 16) | (data[bi + 3]! << 24)) >>> 0;
  }
  if (remainingBytes) {
    let partial = 0;
    const base = 4 * fullWordsCount;
    for (let b = 0; b < remainingBytes; b++) {
      partial |= data[base + b]! << (8 * b);
    }
    wordArray[fullWordsCount] = partial;
  }

  const fullState = [...CHACHA_INITIAL_STATE, ...keyWords];
  let wordOffset = 0;
  while (wordOffset + 16 < wordArray.length) {
    const keystream = chachaBlockFunction(fullState, rounds);
    fullState[12] = ensure32(fullState[12] + 1);
    for (let k = 0; k < 16; k++) {
      wordArray[wordOffset + k] = (wordArray[wordOffset + k] ^ keystream[k]) >>> 0;
    }
    wordOffset += 16;
  }
  const remaining = wordArray.length - wordOffset;
  const keystream = chachaBlockFunction(fullState, rounds);
  for (let k = 0; k < remaining; k++) {
    wordArray[wordOffset + k] = (wordArray[wordOffset + k] ^ keystream[k]) >>> 0;
  }

  for (let i = 0; i < fullWordsCount; i++) {
    const w = wordArray[i]! >>> 0;
    const bi = 4 * i;
    data[bi] = w & 0xff;
    data[bi + 1] = (w >>> 8) & 0xff;
    data[bi + 2] = (w >>> 16) & 0xff;
    data[bi + 3] = (w >>> 24) & 0xff;
  }
  if (remainingBytes) {
    const w = wordArray[fullWordsCount]! >>> 0;
    const base = 4 * fullWordsCount;
    for (let b = 0; b < remainingBytes; b++) {
      data[base + b] = (w >>> (8 * b)) & 0xff;
    }
  }
}

function customBase64Encode(input: string): string {
  const result: string[] = [];
  const fullBlockLength = Math.floor(input.length / 3) * 3;
  for (let i = 0; i < fullBlockLength; i += 3) {
    const block =
      (input.charCodeAt(i) << 16) |
      (input.charCodeAt(i + 1) << 8) |
      input.charCodeAt(i + 2);
    result.push(
      CUSTOM_ALPHABET[(block >>> 18) & 63],
      CUSTOM_ALPHABET[(block >>> 12) & 63],
      CUSTOM_ALPHABET[(block >>> 6) & 63],
      CUSTOM_ALPHABET[block & 63]
    );
  }
  return result.join("");
}

/**
 * Generate X-Gnarly header value
 * @param queryString URL query string
 * @param requestBody Request body (POST data)
 * @param userAgent User-Agent string
 */
export function getXGnarly(
  queryString: string,
  requestBody: string,
  userAgent: string
): string {
  // Reset PRNG state for each call
  prngState = initializePrngState();
  stateIndex = 0;

  const timestampMs = Date.now();
  const md5Query = createHash("md5").update(queryString).digest("hex");
  const md5Body = createHash("md5").update(requestBody).digest("hex");
  const md5Ua = createHash("md5").update(userAgent).digest("hex");

  // Build data object
  const dataObj: Record<number, number | string> = {};
  const keyOrder: number[] = [];

  function add(key: number, value: number | string) {
    dataObj[key] = value;
    if (!keyOrder.includes(key)) keyOrder.push(key);
  }

  add(1, 1);
  add(2, 14);
  add(3, md5Query);
  add(4, md5Body);
  add(5, md5Ua);
  add(6, Math.floor(timestampMs / 1000));
  add(7, 1938040196);
  add(8, timestampMs % 2147483648);
  add(9, "5.1.2");
  add(10, "1.0.0.316");
  add(11, 1);

  let checksum = 0;
  for (let i = 1; i <= 11; i++) {
    const val = dataObj[i];
    const xorVal = typeof val === "number" ? val : stringToBigEndianInt(val);
    checksum ^= xorVal;
  }
  add(12, ensure32(checksum));

  // Final checksum (field 0)
  let finalChecksum = 0;
  for (const key of keyOrder) {
    const val = dataObj[key];
    if (typeof val === "number") {
      finalChecksum ^= val;
    }
  }
  add(0, ensure32(finalChecksum));

  // Serialize to bytes
  const payloadBytes: number[] = [];
  payloadBytes.push(keyOrder.length);
  for (const key of keyOrder) {
    payloadBytes.push(key);
    const val = dataObj[key];
    const valBytes =
      typeof val === "number"
        ? convertNumberToBytes(val)
        : Array.from(Buffer.from(val, "utf-8"));
    payloadBytes.push(...convertNumberToBytes(valBytes.length));
    payloadBytes.push(...valBytes);
  }

  const baseString = String.fromCharCode(...payloadBytes);

  // Generate 12 random key words
  const encryptionKeyWords: number[] = [];
  const keyBytesArray: number[] = [];
  let roundAccumulator = 0;
  for (let i = 0; i < 12; i++) {
    const rv = generateRandomFloat();
    const wordValue = (Math.floor(rv * 4294967296)) >>> 0;
    encryptionKeyWords.push(wordValue);
    roundAccumulator = (roundAccumulator + (wordValue & 15)) & 15;
    keyBytesArray.push(
      wordValue & 0xff,
      (wordValue >>> 8) & 0xff,
      (wordValue >>> 16) & 0xff,
      (wordValue >>> 24) & 0xff
    );
  }
  const encryptionRounds = roundAccumulator + 5;

  // ChaCha20 encrypt
  const dataBuffer = Buffer.from(Array.from(baseString).map((c) => c.charCodeAt(0)));
  const fullState = [...CHACHA_INITIAL_STATE, ...encryptionKeyWords];
  // We need to encrypt using the full state including initial constants
  chachaEncryptData(encryptionKeyWords, encryptionRounds, dataBuffer);

  const encryptedData = String.fromCharCode(...dataBuffer);

  // Calculate insertion position
  let insertionPosition = 0;
  for (const b of keyBytesArray) {
    insertionPosition = (insertionPosition + b) % (encryptedData.length + 1);
  }
  for (let i = 0; i < encryptedData.length; i++) {
    insertionPosition =
      (insertionPosition + encryptedData.charCodeAt(i)) % (encryptedData.length + 1);
  }

  const keyString = String.fromCharCode(...keyBytesArray);

  // Control byte: ((1 << 6) ^ (1 << 3) ^ 3) & 0xFF = 0x4B = 'K'
  const controlByte = String.fromCharCode(((1 << 6) ^ (1 << 3) ^ 3) & 0xff);
  const finalString =
    controlByte +
    encryptedData.substring(0, insertionPosition) +
    keyString +
    encryptedData.substring(insertionPosition);

  return customBase64Encode(finalString);
}
