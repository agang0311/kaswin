/**
 * Kaswin A-Type Draft Validation & BigInt Accounting Module
 *
 * Implements strict offline parameter validation, canonical sompi conversion,
 * prize pool BigInt arithmetic, and safe draft serialization/deserialization.
 *
 * Notice:
 * - NO floating-point Number is used for any currency amounts or sompi calculations.
 * - All sompi values are represented as BigInt or canonical decimal strings.
 * - Local bounds (e.g. ticketCount 2..1000000) are explicitly local draft bounds, NOT chain consensus limits.
 */

// Signed 64-bit integer limit: 2^63 - 1
export const MAX_INT64 = 9223372036854775807n;

// Sompi per KAS (10^8)
export const SOMPI_PER_KAS = 100000000n;

// Local draft bounds for ticket count (2 to 1,000,000)
// Explicitly local draft limits for parameter exploration, not chain limits.
export const TICKET_COUNT_MIN = 2n;
export const TICKET_COUNT_MAX = 1000000n;

// Bounded length for title
export const TITLE_MIN_LEN = 1;
export const TITLE_MAX_LEN = 64;

// Maximum allowed size for imported JSON payload in bytes (64 KB)
export const MAX_IMPORT_PAYLOAD_BYTES = 65536;

// Draft schema identifier and version
export const DRAFT_SCHEMA = "kaswin/a-type-draft";
export const DRAFT_VERSION = 1;

// Patterns representing private keys, seeds, mnemonics or credentials that must be rejected
const FORBIDDEN_SECRET_KEYS = [
  "privatekey",
  "private_key",
  "privkey",
  "secret",
  "mnemonic",
  "seed",
  "xprv",
  "wif",
  "credential",
  "password"
];

// Regex for canonical non-negative integer string (no leading zeros unless "0")
const CANONICAL_INT_REGEX = /^(0|[1-9]\d*)$/;

// Regex for KAS decimal string: integer part (canonical) and optional 1 to 8 decimals
const KAS_DECIMAL_REGEX = /^(0|[1-9]\d*)(\.\d{1,8})?$/;

/**
 * Format a pure digit string with commas for human readability.
 * Pure string manipulation without converting to Number.
 *
 * @param {string} digitStr - String of digits
 * @returns {string} Formatted string with comma thousand separators
 */
export function formatDigitsWithCommas(digitStr) {
  if (typeof digitStr !== "string") {
    digitStr = String(digitStr);
  }
  const parts = digitStr.split(".");
  const intPart = parts[0];
  const fracPart = parts.length > 1 ? parts[1] : null;

  const isNeg = intPart.startsWith("-");
  const cleanInt = isNeg ? intPart.slice(1) : intPart;

  let formatted = "";
  const len = cleanInt.length;
  for (let i = 0; i < len; i++) {
    if (i > 0 && (len - i) % 3 === 0) {
      formatted += ",";
    }
    formatted += cleanInt[i];
  }
  if (isNeg) {
    formatted = "-" + formatted;
  }
  return fracPart !== null ? `${formatted}.${fracPart}` : formatted;
}

/**
 * Parses a KAS decimal string into exact BigInt sompis.
 *
 * @param {string} kasStr - KAS decimal string (e.g. "10", "0.5", "100.12345678")
 * @returns {bigint} Exact amount in sompis
 * @throws {Error} If invalid format, decimals > 8, negative, zero, or exceeds MAX_INT64
 */
export function parseKasToSompi(kasStr) {
  if (typeof kasStr !== "string") {
    throw new Error("票价必须为字符串形式的十进制数值 (Ticket price must be a string)");
  }
  const trimmed = kasStr.trim();
  if (trimmed === "") {
    throw new Error("票价不能为空 (Ticket price cannot be empty)");
  }
  if (!KAS_DECIMAL_REGEX.test(trimmed)) {
    throw new Error(
      "票价格式无效：必须为规范的十进制正数，且最多支持 8 位小数，不可使用科学计数法或多余前导零 (Invalid KAS format: max 8 decimals, no scientific notation, no leading zeros)"
    );
  }

  const [intPart, fracPart = ""] = trimmed.split(".");
  const paddedFrac = fracPart.padEnd(8, "0");

  const sompi = BigInt(intPart) * SOMPI_PER_KAS + BigInt(paddedFrac);

  if (sompi <= 0n) {
    throw new Error("单票价格必须大于 0 sompi (Ticket price must be strictly greater than 0 sompi)");
  }
  if (sompi > MAX_INT64) {
    throw new Error(
      `单票价格超出 64 位有符号整数上限 (${MAX_INT64} sompis) (Ticket price exceeds signed int64 max)`
    );
  }

  return sompi;
}

/**
 * Formats exact BigInt sompis into a canonical KAS decimal string.
 *
 * @param {bigint|string} sompiVal - Sompis as BigInt or integer string
 * @returns {string} Canonical KAS decimal string (e.g. "10", "0.5", "100.12345678")
 */
export function formatSompiToKas(sompiVal) {
  if (typeof sompiVal !== "bigint" && (typeof sompiVal !== "string" || !CANONICAL_INT_REGEX.test(sompiVal))) {
    throw new Error("sompi 必须为 bigint 或规范十进制字符串");
  }
  const sompi = typeof sompiVal === "bigint" ? sompiVal : BigInt(sompiVal);
  if (sompi < 0n) {
    throw new Error("sompi 不能为负数 (sompi cannot be negative)");
  }
  const intPart = (sompi / SOMPI_PER_KAS).toString();
  const rem = sompi % SOMPI_PER_KAS;
  if (rem === 0n) {
    return intPart;
  }
  const fracPadded = rem.toString().padStart(8, "0");
  const fracTrimmed = fracPadded.replace(/0+$/, "");
  return `${intPart}.${fracTrimmed}`;
}

/**
 * Formats a BigInt sompi value for clear, accessible display.
 * Includes both human-readable KAS with commas and exact sompi with commas.
 *
 * @param {bigint} sompi - Sompi BigInt
 * @returns {{ kasFormatted: string, sompiFormatted: string, kasCanonical: string, sompiCanonical: string }}
 */
export function formatSompiDisplay(sompi) {
  if (typeof sompi !== "bigint") {
    throw new Error("显示金额必须为 bigint");
  }
  const kasCanonical = formatSompiToKas(sompi);
  const [intPart, fracPart] = kasCanonical.split(".");
  const kasWithCommas = fracPart ? `${formatDigitsWithCommas(intPart)}.${fracPart}` : formatDigitsWithCommas(intPart);
  const sompiCanonical = sompi.toString();
  const sompiWithCommas = formatDigitsWithCommas(sompiCanonical);

  return {
    kasFormatted: kasWithCommas,
    sompiFormatted: sompiWithCommas,
    kasCanonical,
    sompiCanonical
  };
}

/**
 * Validates canonical ticket count.
 * Explicitly validates local draft bounds (2..1000000).
 *
 * @param {string|number|bigint} countInput - Total tickets
 * @returns {bigint} Validated BigInt count
 */
export function validateTicketCount(countInput) {
  const str = String(countInput).trim();
  if (!CANONICAL_INT_REGEX.test(str)) {
    throw new Error(
      "总票数必须为规范的正整数（无多余前导零或小数）(Ticket count must be a canonical positive integer)"
    );
  }
  const count = BigInt(str);
  if (count < TICKET_COUNT_MIN || count > TICKET_COUNT_MAX) {
    throw new Error(
      `总票数超出本地草案设定范围 [${TICKET_COUNT_MIN} ~ ${TICKET_COUNT_MAX}] 张（注意：此为本地推演界限，非链上硬性协议限制）(Ticket count outside local draft bounds [${TICKET_COUNT_MIN}..${TICKET_COUNT_MAX}])`
    );
  }
  return count;
}

/**
 * Validates a local draft DAA threshold, not blue score.
 * This local numeric range does not establish CLTV/network compatibility.
 *
 * @param {string|bigint} daaInput - Refund threshold DAA decimal string
 * @returns {bigint} Validated BigInt DAA
 */
export function validateRefundDaa(daaInput) {
  if (typeof daaInput !== "string" || daaInput !== daaInput.trim()) {
    throw new Error("DAA 必须为规范十进制字符串，不接受 Number");
  }
  const str = daaInput;
  if (!CANONICAL_INT_REGEX.test(str)) {
    throw new Error(
      "未满退款 DAA 阈值必须为规范的十进制整数 (Refund threshold DAA must be a canonical positive integer)"
    );
  }
  const daa = BigInt(str);
  if (daa <= 0n) {
    throw new Error(
      "未满退款 DAA 阈值必须大于 0 (Refund threshold DAA must be strictly greater than 0)"
    );
  }
  if (daa > MAX_INT64) {
    throw new Error(
      `未满退款 DAA 阈值超出 64 位有符号整数上限 (${MAX_INT64}) (Refund threshold DAA exceeds signed int64 max)`
    );
  }
  return daa;
}

/**
 * Validates draft title.
 *
 * @param {string} titleInput - Draft title
 * @returns {string} Trimmed title
 */
export function validateTitle(titleInput) {
  if (typeof titleInput !== "string") {
    throw new Error("草案标题必须为字符串 (Title must be a string)");
  }
  const trimmed = titleInput.trim();
  if (trimmed.length < TITLE_MIN_LEN) {
    throw new Error("草案标题不能为空 (Title cannot be empty)");
  }
  if (trimmed.length > TITLE_MAX_LEN) {
    throw new Error(
      `草案标题长度不能超过 ${TITLE_MAX_LEN} 个字符 (Title exceeds max length of ${TITLE_MAX_LEN} characters)`
    );
  }
  return trimmed;
}

/**
 * Computes exact gross prize pool in sompi.
 * Gross pool P = ticketPriceSompi * ticketCount.
 * Platform fee is strictly 0%.
 *
 * @param {bigint} priceSompi - Sompi per ticket
 * @param {bigint} ticketCount - Total tickets
 * @returns {bigint} Gross prize pool sompis
 */
export function calculateGrossPool(priceSompi, ticketCount) {
  if (typeof priceSompi !== "bigint" || typeof ticketCount !== "bigint") {
    throw new Error("价格与票数必须为 BigInt (Price and count must be BigInt)");
  }
  if (priceSompi <= 0n || ticketCount < TICKET_COUNT_MIN || ticketCount > TICKET_COUNT_MAX) {
    throw new Error("价格与票数超出本地草案范围");
  }
  const gross = priceSompi * ticketCount;
  if (gross > MAX_INT64) {
    throw new Error(
      `总奖池总额超出 64 位有符号整数上限 (${MAX_INT64} sompis) (Gross prize pool exceeds signed int64 max)`
    );
  }
  return gross;
}

/**
 * Validates all fields of an A-type draft payload.
 *
 * @param {object} payload - Form inputs { title, ticketPriceKas, ticketCount, refundThresholdDaa }
 * @returns {{
 *   title: string,
 *   ticketPriceKas: string,
 *   ticketCount: number,
 *   refundThresholdDaa: string,
 *   ticketPriceSompi: bigint,
 *   ticketCountBigInt: bigint,
 *   refundThresholdDaaBigInt: bigint,
 *   grossPoolSompi: bigint,
 *   grossPoolKas: string
 * }}
 */
export function validateDraftPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("草案载荷必须为有效对象 (Draft payload must be an object)");
  }

  // Reject unexpected keys in payload
  const allowedPayloadKeys = new Set(["title", "ticketPriceKas", "ticketCount", "refundThresholdDaa"]);
  for (const key of Object.keys(payload)) {
    if (!allowedPayloadKeys.has(key)) {
      throw new Error(`载荷中包含未知字段: ${key} (Unknown field in payload: ${key})`);
    }
  }

  const title = validateTitle(payload.title);
  const ticketPriceSompi = parseKasToSompi(payload.ticketPriceKas);
  const ticketCountBigInt = validateTicketCount(payload.ticketCount);
  const refundThresholdDaaBigInt = validateRefundDaa(payload.refundThresholdDaa);

  const grossPoolSompi = calculateGrossPool(ticketPriceSompi, ticketCountBigInt);
  const grossPoolKas = formatSompiToKas(grossPoolSompi);
  const canonicalPriceKas = formatSompiToKas(ticketPriceSompi);

  return {
    title,
    ticketPriceKas: canonicalPriceKas,
    ticketCount: Number(ticketCountBigInt),
    refundThresholdDaa: refundThresholdDaaBigInt.toString(),
    ticketPriceSompi,
    ticketCountBigInt,
    refundThresholdDaaBigInt,
    grossPoolSompi,
    grossPoolKas
  };
}

/**
 * Builds a versioned exportable draft object.
 *
 * @param {object} rawInputs - Form inputs { title, ticketPriceKas, ticketCount, refundThresholdDaa }
 * @returns {object} Versioned draft object
 */
export function createDraftExportObject(rawInputs) {
  const validated = validateDraftPayload(rawInputs);

  return {
    schema: DRAFT_SCHEMA,
    version: DRAFT_VERSION,
    createdAt: new Date().toISOString(),
    payload: {
      title: validated.title,
      ticketPriceKas: validated.ticketPriceKas,
      ticketCount: validated.ticketCount,
      refundThresholdDaa: validated.refundThresholdDaa
    },
    computed: {
      ticketPriceSompi: validated.ticketPriceSompi.toString(),
      grossPoolSompi: validated.grossPoolSompi.toString(),
      grossPoolKas: validated.grossPoolKas
    },
    disclaimer: "UNVERIFIED_LOCAL_DATA_NOT_CHAIN_EVIDENCE"
  };
}

/**
 * Checks an object recursively for forbidden secret keys.
 *
 * @param {any} obj - Object or value to inspect
 * @throws {Error} If any secret-like field name is detected
 */
function scanForForbiddenSecretKeys(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    const lowerKey = key.toLowerCase();
    for (const forbidden of FORBIDDEN_SECRET_KEYS) {
      if (lowerKey.includes(forbidden)) {
        throw new Error(
          `安全性检查拦截：草案中禁止包含私钥、助记词或敏感凭证字段 [${key}]！(Forbidden key detected: ${key})`
        );
      }
    }
    scanForForbiddenSecretKeys(obj[key]);
  }
}

/**
 * Validates and parses raw JSON string imported from a file or text area.
 * Treats all imported content as UNVERIFIED LOCAL DATA.
 *
 * @param {string} rawJson - Raw JSON string
 * @returns {{
 *   isUnverifiedLocalData: true,
 *   draft: object,
 *   validatedPayload: ReturnType<typeof validateDraftPayload>
 * }}
 */
export function validateAndParseDraftJson(rawJson) {
  if (typeof rawJson !== "string") {
    throw new Error("导入数据必须为 JSON 字符串 (Import data must be a JSON string)");
  }

  // Size boundary check
  const byteLength = new TextEncoder().encode(rawJson).length;
  if (byteLength > MAX_IMPORT_PAYLOAD_BYTES) {
    throw new Error(
      `导入数据大小超出上限 (${byteLength} 字节 > 最大 ${MAX_IMPORT_PAYLOAD_BYTES} 字节) (Payload size exceeds ${MAX_IMPORT_PAYLOAD_BYTES} bytes)`
    );
  }

  // Fast pre-scan on raw text for secrets
  const lowerRaw = rawJson.toLowerCase();
  for (const forbidden of FORBIDDEN_SECRET_KEYS) {
    const pattern = new RegExp(`"${forbidden}"\\s*:`, "i");
    if (pattern.test(lowerRaw)) {
      throw new Error(
        `安全性检查拦截：检测到敏感凭据字段 [${forbidden}]，严禁将私钥导入离线草案！(Forbidden secret key detected: ${forbidden})`
      );
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    throw new Error(`JSON 解析失败: ${err.message} (Invalid JSON syntax)`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("草案顶层必须为标准 JSON 对象 (Draft must be a top-level JSON object)");
  }

  // Recursive secret check
  scanForForbiddenSecretKeys(parsed);

  // Schema and version validation
  if (parsed.schema !== DRAFT_SCHEMA) {
    throw new Error(
      `未知协议草案模式: "${parsed.schema}"，期望为 "${DRAFT_SCHEMA}" (Unsupported schema)`
    );
  }
  if (parsed.version !== DRAFT_VERSION) {
    throw new Error(
      `不支持的草案版本: "${parsed.version}"，期望为 ${DRAFT_VERSION} (Unsupported version)`
    );
  }

  // Check allowed top-level keys
  const allowedTopLevelKeys = new Set(["schema", "version", "createdAt", "payload", "computed", "disclaimer"]);
  for (const key of Object.keys(parsed)) {
    if (!allowedTopLevelKeys.has(key)) {
      throw new Error(`顶层包含未定义字段: "${key}" (Unknown top-level field: ${key})`);
    }
  }

  if (!parsed.payload || typeof parsed.payload !== "object" || Array.isArray(parsed.payload)) {
    throw new Error("缺少或无效的 payload 载荷对象 (Missing or invalid payload object)");
  }

  // Validate payload fields
  const validatedPayload = validateDraftPayload(parsed.payload);

  return {
    isUnverifiedLocalData: true,
    draft: parsed,
    validatedPayload
  };
}
