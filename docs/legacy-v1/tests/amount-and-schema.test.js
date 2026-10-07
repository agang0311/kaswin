import test from "node:test";
import assert from "node:assert/strict";
import {
  parseKasToSompi,
  formatSompiToKas,
  formatSompiDisplay,
  validateTicketCount,
  validateRefundDaa,
  validateTitle,
  calculateGrossPool,
  validateDraftPayload,
  createDraftExportObject,
  validateAndParseDraftJson,
  MAX_INT64,
  SOMPI_PER_KAS,
  TICKET_COUNT_MIN,
  TICKET_COUNT_MAX
} from "../src/validation.js";

test("Kaspa Sompi exact parsing & conversion (no float precision loss)", async (t) => {
  await t.test("parses standard integer KAS values to sompi", () => {
    assert.equal(parseKasToSompi("1"), 100000000n);
    assert.equal(parseKasToSompi("10"), 1000000000n);
    assert.equal(parseKasToSompi("100"), 10000000000n);
  });

  await t.test("parses decimal KAS values up to 8 decimal places", () => {
    assert.equal(parseKasToSompi("0.1"), 10000000n);
    assert.equal(parseKasToSompi("0.01"), 1000000n);
    assert.equal(parseKasToSompi("0.00000001"), 1n); // 1 sompi minimum
    assert.equal(parseKasToSompi("12.34567890"), 1234567890n);
    assert.equal(parseKasToSompi("123.45678901"), 12345678901n);
  });

  await t.test("rejects malformed, zero, negative or oversized KAS values", () => {
    // 0 sompi
    assert.throws(() => parseKasToSompi("0"), /单票价格必须大于 0/);
    assert.throws(() => parseKasToSompi("0.00000000"), /单票价格必须大于 0/);

    // Negative
    assert.throws(() => parseKasToSompi("-1"), /票价格式无效/);
    assert.throws(() => parseKasToSompi("-0.5"), /票价格式无效/);

    // More than 8 decimal places
    assert.throws(() => parseKasToSompi("1.000000001"), /票价格式无效/);
    assert.throws(() => parseKasToSompi("0.123456789"), /票价格式无效/);

    // Scientific notation or non-numeric
    assert.throws(() => parseKasToSompi("1e8"), /票价格式无效/);
    assert.throws(() => parseKasToSompi("1.2e3"), /票价格式无效/);
    assert.throws(() => parseKasToSompi("abc"), /票价格式无效/);
    assert.throws(() => parseKasToSompi(""), /票价不能为空/);
    assert.throws(() => parseKasToSompi("1."), /票价格式无效/);
    assert.throws(() => parseKasToSompi("01"), /票价格式无效/);
    assert.throws(() => parseKasToSompi("00.5"), /票价格式无效/);
  });

  await t.test("formats sompi back to canonical KAS decimal string", () => {
    assert.equal(formatSompiToKas(100000000n), "1");
    assert.equal(formatSompiToKas(10000000n), "0.1");
    assert.equal(formatSompiToKas(1n), "0.00000001");
    assert.equal(formatSompiToKas(12345678901n), "123.45678901");
    assert.equal(formatSompiToKas(1050000000n), "10.5");
  });

  await t.test("display formatter provides comma separated outputs", () => {
    const res = formatSompiDisplay(100050000000n); // 1000.5 KAS
    assert.equal(res.kasCanonical, "1000.5");
    assert.equal(res.kasFormatted, "1,000.5");
    assert.equal(res.sompiCanonical, "100050000000");
    assert.equal(res.sompiFormatted, "100,050,000,000");
  });
});

test("Ticket count bounded range (2..1000000) as local draft limits", async (t) => {
  await t.test("accepts boundary values and typical values", () => {
    assert.equal(validateTicketCount("2"), 2n);
    assert.equal(validateTicketCount("100"), 100n);
    assert.equal(validateTicketCount("1000000"), 1000000n);
  });

  await t.test("rejects out of bound values", () => {
    assert.throws(() => validateTicketCount("1"), /超出本地草案设定范围/);
    assert.throws(() => validateTicketCount("0"), /超出本地草案设定范围/);
    assert.throws(() => validateTicketCount("1000001"), /超出本地草案设定范围/);
  });

  await t.test("rejects floats, negatives, leading zeroes, non-integers", () => {
    assert.throws(() => validateTicketCount("2.5"), /规范的正整数/);
    assert.throws(() => validateTicketCount("-2"), /规范的正整数/);
    assert.throws(() => validateTicketCount("02"), /规范的正整数/);
    assert.throws(() => validateTicketCount("100k"), /规范的正整数/);
  });
});

test("Refund threshold DAA validation", async (t) => {
  await t.test("accepts positive integers within signed int64", () => {
    assert.equal(validateRefundDaa("1"), 1n);
    assert.equal(validateRefundDaa("95000000"), 95000000n);
    assert.equal(validateRefundDaa(MAX_INT64.toString()), MAX_INT64);
  });

  await t.test("rejects 0, negative, floats, or > MAX_INT64", () => {
    assert.throws(() => validateRefundDaa("0"), /必须大于 0/);
    assert.throws(() => validateRefundDaa("-5"), /规范的十进制整数/);
    assert.throws(() => validateRefundDaa("12.34"), /规范的十进制整数/);
    assert.throws(() => validateRefundDaa((MAX_INT64 + 1n).toString()), /超出 64 位有符号整数上限/);
  });
});

test("Title bounded length", async (t) => {
  await t.test("accepts valid titles within 1..64 chars", () => {
    assert.equal(validateTitle("A-Round-1"), "A-Round-1");
    assert.equal(validateTitle("  社区测试轮次  "), "社区测试轮次");
    assert.equal(validateTitle("a".repeat(64)), "a".repeat(64));
  });

  await t.test("rejects empty or oversized titles", () => {
    assert.throws(() => validateTitle(""), /草案标题不能为空/);
    assert.throws(() => validateTitle("   "), /草案标题不能为空/);
    assert.throws(() => validateTitle("a".repeat(65)), /草案标题长度不能超过 64/);
  });
});

test("Exact BigInt gross prize pool calculation", async (t) => {
  await t.test("computes exact prize pool sompi = price * tickets without float error", () => {
    const priceSompi = parseKasToSompi("10.12345678");
    const count = 1000n;
    const gross = calculateGrossPool(priceSompi, count);
    assert.equal(gross, 10123456780n * 1000n / 10n);
    assert.equal(gross, 1012345678000n);
    assert.equal(formatSompiToKas(gross), "10123.45678");
  });

  await t.test("rejects pool exceeding int64 max", () => {
    const hugePrice = MAX_INT64;
    assert.throws(() => calculateGrossPool(hugePrice, 2n), /超出 64 位有符号整数上限/);
  });
});

test("Draft schema export and import round-trip", async (t) => {
  const sample = {
    title: "第一期社区抽奖",
    ticketPriceKas: "2.5",
    ticketCount: 50,
    refundThresholdDaa: "88000000"
  };

  const draftObj = createDraftExportObject(sample);
  assert.equal(draftObj.schema, "kaswin/a-type-draft");
  assert.equal(draftObj.version, 1);
  assert.equal(draftObj.payload.title, "第一期社区抽奖");
  assert.equal(draftObj.payload.ticketPriceKas, "2.5");
  assert.equal(draftObj.payload.ticketCount, 50);
  assert.equal(draftObj.payload.refundThresholdDaa, "88000000");
  assert.equal(draftObj.computed.ticketPriceSompi, "250000000");
  assert.equal(draftObj.computed.grossPoolSompi, "12500000000");
  assert.equal(draftObj.computed.grossPoolKas, "125");

  const serialized = JSON.stringify(draftObj, null, 2);
  const imported = validateAndParseDraftJson(serialized);

  assert.equal(imported.isUnverifiedLocalData, true);
  assert.equal(imported.validatedPayload.title, "第一期社区抽奖");
  assert.equal(imported.validatedPayload.ticketPriceKas, "2.5");
  assert.equal(imported.validatedPayload.ticketCount, 50);
  assert.equal(imported.validatedPayload.grossPoolSompi, 12500000000n);
});

test("Draft import strict security and schema rejection", async (t) => {
  await t.test("rejects payload exceeding 64 KB", () => {
    const bigString = "x".repeat(70000);
    assert.throws(() => validateAndParseDraftJson(bigString), /导入数据大小超出上限/);
  });

  await t.test("rejects drafts containing private keys or secret words", () => {
    const sneakySecret = JSON.stringify({
      schema: "kaswin/a-type-draft",
      version: 1,
      payload: {
        title: "Test",
        ticketPriceKas: "1",
        ticketCount: 10,
        refundThresholdDaa: "100"
      },
      privateKey: "0123456789abcdef"
    });
    assert.throws(() => validateAndParseDraftJson(sneakySecret), /安全性检查拦截/);

    const secretInPayload = JSON.stringify({
      schema: "kaswin/a-type-draft",
      version: 1,
      payload: {
        title: "Test",
        ticketPriceKas: "1",
        ticketCount: 10,
        refundThresholdDaa: "100",
        mnemonic: "word1 word2"
      }
    });
    assert.throws(() => validateAndParseDraftJson(secretInPayload), /安全性检查拦截/);
  });

  await t.test("rejects unknown schema or versions", () => {
    const badSchema = JSON.stringify({
      schema: "unknown/lottery",
      version: 1,
      payload: {
        title: "Test",
        ticketPriceKas: "1",
        ticketCount: 10,
        refundThresholdDaa: "100"
      }
    });
    assert.throws(() => validateAndParseDraftJson(badSchema), /未知协议草案模式/);

    const badVersion = JSON.stringify({
      schema: "kaswin/a-type-draft",
      version: 99,
      payload: {
        title: "Test",
        ticketPriceKas: "1",
        ticketCount: 10,
        refundThresholdDaa: "100"
      }
    });
    assert.throws(() => validateAndParseDraftJson(badVersion), /不支持的草案版本/);
  });

  await t.test("rejects unexpected top-level fields", () => {
    const extraField = JSON.stringify({
      schema: "kaswin/a-type-draft",
      version: 1,
      payload: {
        title: "Test",
        ticketPriceKas: "1",
        ticketCount: 10,
        refundThresholdDaa: "100"
      },
      arbitraryData: "malicious"
    });
    assert.throws(() => validateAndParseDraftJson(extraField), /顶层包含未定义字段/);
  });

  await t.test("rejects extra payload fields", () => {
    const extraPayload = JSON.stringify({
      schema: "kaswin/a-type-draft",
      version: 1,
      payload: {
        title: "Test",
        ticketPriceKas: "1",
        ticketCount: 10,
        refundThresholdDaa: "100",
        adminAddress: "kaspa:qqqq"
      }
    });
    assert.throws(() => validateAndParseDraftJson(extraPayload), /载荷中包含未知字段/);
  });
});
